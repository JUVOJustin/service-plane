import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type AbilityStream, createAbilityBuilder } from '../service/ability.js';
import { defineCapabilities } from '../service/capabilities.js';
import { type AbilityNativeBinding, createAbilityClient, createBrokeredAbilityClient } from '../service/client.js';
import { defineAbility, defineAbilityService, serviceDiscoveryDocument } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import { SERVICE_PLANE_TIMEOUT_GRACE_MS } from '../shared/deadline.js';
import { AbilityHandlerError, ServicePlaneClientError } from '../shared/errors.js';
import type { CapabilityJwks, FetchLike, RegistryCache } from '../shared/types.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH, SERVICE_PLANE_MCP_PATH } from '../shared/types.js';
import { memoryWebSocketPair } from '../test-support/index.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { memoryRegistryCache } from './registry.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

describe('Service Plane control-plane broker', () => {
  it('keeps the README control-plane environment pattern fully typed', () => {
    type ReadmeControlPlaneEnv = {
      Bindings: {
        STS_SIGNING_SECRET: string;
        TASKS: AbilityNativeBinding & FetchLike;
      };
    };
    const plane = new ServicePlaneControlPlane<ReadmeControlPlaneEnv>({
      log: false,
      openapi: false,
      rest: false,
      services: (context) => [
        cloudflareServiceBinding({
          abilityRpc: { invokeAbility: (input) => context.env.TASKS.invokeAbility(input) },
          binding: context.env.TASKS,
          id: 'tasks-service',
        }),
      ],
      signingKeys: (bindings) => [{ kid: 'readme', secret: bindings.STS_SIGNING_SECRET }],
    });

    expect(plane.fetch).toBeTypeOf('function');
  });

  it('creates an in-process client synchronously and rejects unsupported calls before discovery', async () => {
    const ability = createAbilityBuilder();
    const read = ability.method({
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      scopes: ['tasks.read'],
    });
    const events = defineAbility({
      id: 'tasks.events',
      methods: {
        apply: read,
        call: read,
        constructor: read,
        name: read,
        read,
        toString: read,
        watch: ability.hibernationStream({
          input: z.object({}),
          output: z.object({ sequence: z.number() }),
          scopes: ['tasks.read'],
        }),
      },
      rpc: { transports: ['websocket'] },
      scopes: ['tasks.read'],
    });
    let serviceResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      log: false,
      openapi: false,
      rest: false,
      services: () => {
        serviceResolutions += 1;
        return [];
      },
      signingKeys: () => [],
    });
    const client = plane.abilityClient({ ability: events, targetServiceId: 'tasks' }, {});
    const surface = client as unknown as Record<PropertyKey, unknown>;

    expect(() => String(client)).not.toThrow();
    expect(Object.getPrototypeOf(client)).toBeNull();
    expect(surface.then).toBeUndefined();
    expect(surface.constructor).toBeTypeOf('function');
    const unsupported = await client.watch({}).catch((error: unknown) => error);
    expect(unsupported).toBeInstanceOf(ServicePlaneClientError);
    expect(unsupported).toMatchObject({ status: 405 });
    await expect(client.read({}, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'timeout', status: 504 });
    for (const method of [client.apply, client.call, client.constructor, client.name, client.toString]) {
      await expect(method({}, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'timeout', status: 504 });
    }
    expect(() => plane.abilityClient({ ability: events, targetServiceId: 'tasks', timeoutMs: -1 }, {})).toThrow(
      'Service-Plane default timeoutMs must be 0 or a positive integer',
    );
    expect(serviceResolutions).toBe(0);
  });

  it('keeps the default ingress broker identity independent from a custom token issuer', async () => {
    const issuer = 'https://issuer.example';
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      id: 'tasks.custom-issuer',
      methods: {
        get: ability.method({
          handler: () => ({ ok: true }),
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          scopes: ['tasks.read'],
        }),
      },
      rpc: { transports: ['fetch', 'service-binding'] },
      scopes: ['tasks.read'],
    });
    let plane: ServicePlaneControlPlane | undefined;
    const service = new ServicePlaneService({
      abilities: [tasks],
      auth: {
        issuer,
        jwks: async () => {
          if (!plane) throw new Error('Control plane is not initialized');
          const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
          return response.json() as Promise<CapabilityJwks>;
        },
      },
      capabilities,
      id: 'tasks',
      ingress: {},
      logger: false,
      title: 'Tasks',
      version: '1.0.0',
    });
    plane = new ServicePlaneControlPlane({
      broker: {},
      issuer,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'headless-front', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      rest: false,
      services: () => [
        cloudflareServiceBinding({
          abilityRpc: { invokeAbility: (input) => service.invokeAbility(input) },
          binding: { fetch: async (request) => service.fetch(request) },
          grants: [{ caller: 'control-plane', scopes: ['tasks.read'] }],
          id: 'tasks',
        }),
      ],
      signingKeys: () => [{ kid: 'custom-issuer', secret: signingSecret }],
    });
    const client = createBrokeredAbilityClient({
      ability: tasks,
      targetServiceId: 'tasks',
      transport: { fetch: async (url, init) => (plane as ServicePlaneControlPlane).fetch(new Request(url, init)) },
    });

    await expect(client.get({})).resolves.toEqual({ ok: true });
  });

  it('enforces the in-process deadline while discovery is still pending', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      id: 'tasks.pending',
      methods: {
        get: ability.method({
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          scopes: ['tasks.read'],
        }),
      },
      scopes: ['tasks.read'],
    });
    const plane = new ServicePlaneControlPlane({
      log: false,
      openapi: false,
      rest: false,
      services: () => new Promise<never>(() => undefined),
      signingKeys: () => [{ kid: 'pending', secret: signingSecret }],
    });
    const client = plane.abilityClient({ ability: tasks, targetServiceId: 'tasks' }, {});

    vi.useFakeTimers();
    try {
      const call = client.get({}, { timeoutMs: 1 });
      const rejected = expect(call).rejects.toMatchObject({ code: 'timeout', status: 504 });
      await vi.advanceTimersByTimeAsync(1 + SERVICE_PLANE_TIMEOUT_GRACE_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the in-process client deadline active for every stream pull', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      id: 'tasks.deadline-stream',
      methods: {
        watch: ability.stream({
          handler: async function* () {
            yield 'unused';
          },
          input: z.object({}),
          output: z.string(),
          scopes: ['tasks.read'],
        }),
      },
      rpc: { transports: ['fetch'] },
      scopes: ['tasks.read'],
    });
    let pullStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    const handler = new RPCHandler({
      watch: os.input(z.unknown()).handler(async function* () {
        yield 'ready';
        pullStarted?.();
        await new Promise(() => undefined);
      }),
    });
    const discovery = serviceDiscoveryDocument(
      defineAbilityService({ abilities: [tasks], capabilities, id: 'tasks', title: 'Tasks', version: '1.0.0' }),
    );
    const plane = new ServicePlaneControlPlane({
      broker: false,
      log: false,
      openapi: false,
      rest: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async (request) => {
              const handled = await handler.handle(request, { prefix: '/rpc/tasks.deadline-stream' });
              return handled.matched ? handled.response : new Response('Not found', { status: 404 });
            },
          },
          discovery,
          grants: [{ caller: 'control-plane', scopes: ['tasks.read'] }],
          id: 'tasks',
        }),
      ],
      signingKeys: () => [{ kid: 'stream-deadline', secret: signingSecret }],
    });
    const client = plane.abilityClient({ ability: tasks, targetServiceId: 'tasks' }, {});

    vi.useFakeTimers();
    try {
      const stream = await client.watch({}, { timeoutMs: 1 });
      await expect(stream.next()).resolves.toEqual({ done: false, value: 'ready' });
      const pending = stream.next();
      await started;
      const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true, status: 504 });

      await vi.advanceTimersByTimeAsync(1 + SERVICE_PLANE_TIMEOUT_GRACE_MS);

      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the control plane as the only public endpoint for typed unary and streaming calls', async () => {
    const cacheBacking = memoryRegistryCache();
    let discoveryCacheReads = 0;
    const discoveryCache: RegistryCache = {
      get: async (key) => {
        discoveryCacheReads += 1;
        return cacheBacking.get(key);
      },
      getStale: (key) => cacheBacking.getStale?.(key) ?? Promise.resolve(undefined),
      set: (key, value, ttlSeconds) => cacheBacking.set(key, value, ttlSeconds),
    };
    let cancelledMcpStreamReturnCalls = 0;
    let closeCancelledMcpStream: (() => void) | undefined;
    const cancelledMcpStreamClosed = new Promise<void>((resolve) => {
      closeCancelledMcpStream = resolve;
    });
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'tasks.items',
      methods: {
        get: ability.method({
          mcp: { name: 'tasks_get' },
          scopes: ['tasks.read'],
          input: z.object({ id: z.string() }),
          output: z.object({ caller: z.string(), id: z.string() }),
          handler: ({ context, input }) => ({ caller: context.identity.serviceId, id: input.id }),
        }),
        fail: ability.method({
          scopes: ['tasks.read'],
          input: z.object({ visible: z.boolean() }),
          output: z.never(),
          handler: ({ input }) => {
            if (input.visible) {
              throw new AbilityHandlerError('Task quota exhausted', { reason: 'quota_exhausted', status: 429 });
            }
            throw new Error('postgres://secret@tasks.internal/database');
          },
        }),
        inspect: ability.method({
          scopes: ['tasks.read'],
          input: z.object({ label: z.string() }),
          output: z.object({
            idempotencyKey: z.string(),
            label: z.string(),
            remoteAddress: z.string(),
            requestId: z.string(),
          }),
          handler: ({ context, input }) => ({
            idempotencyKey: context.idempotencyKey ?? '',
            label: input.label,
            remoteAddress: context.connInfo?.remote.address ?? '',
            requestId: context.request.headers.get('x-request-id') ?? '',
          }),
        }),
        watch: ability.stream({
          mcp: { name: 'tasks_watch' },
          scopes: ['tasks.read'],
          input: z.object({ after: z.number() }),
          output: z.object({ sequence: z.number() }),
          handler: async function* ({ input }) {
            yield { sequence: input.after + 1 };
            yield { sequence: input.after + 2 };
          },
        }),
        watchFailure: ability.stream({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: z.string(),
          handler: async function* () {
            yield 'ready';
            throw new AbilityHandlerError('Stream quota exhausted', { reason: 'stream_quota', status: 429 });
          },
        }),
        watchUntilCancelled: ability.stream({
          mcp: { name: 'tasks_watch_until_cancelled' },
          scopes: ['tasks.read'],
          input: z.object({ after: z.number() }),
          output: z.object({ sequence: z.number() }),
          handler: ({ input }) => {
            const generator = (async function* (): AsyncGenerator<{ sequence: number }, unknown, void> {
              try {
                let sequence = input.after;
                while (true) {
                  sequence += 1;
                  yield { sequence };
                  await new Promise((resolve) => setTimeout(resolve, 1));
                }
              } finally {
                closeCancelledMcpStream?.();
              }
            })();
            const stream: AbilityStream<{ sequence: number }> = {
              [Symbol.asyncIterator]() {
                return stream;
              },
              next: () => generator.next(),
              return: (value) => {
                cancelledMcpStreamReturnCalls += 1;
                return generator.return(value);
              },
            };
            return stream;
          },
        }),
      },
      rpc: { transports: ['fetch', 'service-binding'] },
      scopes: ['tasks.read'],
    });
    let plane: ServicePlaneControlPlane | undefined;
    const service = new ServicePlaneService({
      abilities: [tasks],
      auth: {
        issuer: 'control-plane',
        jwks: async () => {
          if (!plane) throw new Error('Control plane is not initialized');
          const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
          return response.json() as Promise<CapabilityJwks>;
        },
      },
      capabilities,
      id: 'tasks',
      ingress: { brokerServiceIds: ['control-plane'] },
      logger: false,
      title: 'Tasks',
      version: '1.0.0',
    });
    const signingSecret = await generateCapabilitySigningSecret();
    let brokerSigningKeyResolutions = 0;
    let grantsEnabled = true;
    const [planeClientSocket, planeServerSocket] = memoryWebSocketPair();
    const upgradeWebSocket = (async (_context: unknown, events: { onMessage?: (event: unknown, socket: unknown) => void }) => {
      planeServerSocket.addEventListener('message', (event) => {
        void events.onMessage?.(event as never, planeServerSocket as never);
      });
      return new Response(null, { status: 200 });
    }) as unknown as UpgradeWebSocket;
    plane = new ServicePlaneControlPlane({
      broker: { batch: true, upgradeWebSocket },
      controlPlaneServiceId: 'control-plane',
      discoveryCache,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'headless-front', kind: 'service' });
        context.set('servicePlaneConnInfo', {
          remote: { address: '198.51.100.5', addressType: 'IPv4', port: 443, transport: 'tcp' },
        });
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      services: () => [
        cloudflareServiceBinding({
          abilityRpc: {
            invokeAbility: (input) => service.invokeAbility(input),
          },
          binding: { fetch: async (request) => service.fetch(request) },
          grants: grantsEnabled ? [{ caller: 'headless-front', scopes: ['tasks.read'] }] : [],
          id: 'tasks',
          origin: 'https://tasks.internal',
        }),
      ],
      signingKeys: (_bindings, context) => {
        if (new URL(context.req.url).pathname.startsWith('/rpc/broker')) brokerSigningKeyResolutions += 1;
        return [{ kid: 'test-key', secret: signingSecret }];
      },
    });
    const client = createBrokeredAbilityClient({
      ability: tasks,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: async (url, init) => (plane as ServicePlaneControlPlane).fetch(new Request(url, init)),
        origin: 'https://plane.internal',
      },
    });

    const malformedBrokerCall = await plane.fetch(
      new Request('https://plane.internal/rpc/broker/call', {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(malformedBrokerCall.status).toBe(400);

    await expect(client.get({ id: 'task-1' })).resolves.toEqual({ caller: 'headless-front', id: 'task-1' });
    const cacheReadsBeforeBatch = discoveryCacheReads;
    const signingKeyResolutionsBeforeBatch = brokerSigningKeyResolutions;
    let batchFetches = 0;
    const batchClient = createBrokeredAbilityClient({
      ability: tasks,
      targetServiceId: 'tasks',
      transport: {
        batch: true,
        fetch: async (url, init) => {
          batchFetches += 1;
          return (plane as ServicePlaneControlPlane).fetch(new Request(url, init));
        },
        origin: 'https://plane.internal',
      },
    });
    const [firstBatch, secondBatch] = await Promise.all([
      batchClient.inspect({ label: 'first' }, { idempotencyKey: 'broker-attempt-1', requestId: 'broker-request-1', timeoutMs: 6_001 }),
      batchClient.inspect({ label: 'second' }, { idempotencyKey: 'broker-attempt-2', requestId: 'broker-request-2', timeoutMs: 6_002 }),
    ]);
    expect(batchFetches).toBe(1);
    expect(discoveryCacheReads - cacheReadsBeforeBatch).toBe(1);
    expect(brokerSigningKeyResolutions - signingKeyResolutionsBeforeBatch).toBe(1);
    expect(firstBatch).toEqual({
      idempotencyKey: 'broker-attempt-1',
      label: 'first',
      remoteAddress: '198.51.100.5',
      requestId: 'broker-request-1',
    });
    expect(secondBatch).toEqual({
      idempotencyKey: 'broker-attempt-2',
      label: 'second',
      remoteAddress: '198.51.100.5',
      requestId: 'broker-request-2',
    });
    const directToken = await plane
      .capabilityTokenBinding('headless-front', {})
      .issueCapabilityToken({ scopes: ['tasks.read'], targetServiceId: 'tasks' });
    const directClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      requestToken: async () => directToken,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: { fetch: async (request) => service.fetch(request) },
        origin: 'https://tasks.internal',
        type: 'fetch',
      },
    });
    await expect(directClient.get({ id: 'bypass' })).rejects.toMatchObject({ code: 'capability_auth', status: 403 });
    const stream = await client.watch({ after: 8 });
    const values = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([{ sequence: 9 }, { sequence: 10 }]);

    await plane.fetch(
      new Request('https://plane.internal/rpc/broker/ws', {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      }),
    );
    const webSocketClient = createBrokeredAbilityClient({
      ability: tasks,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        createWebSocket: () => planeClientSocket,
        type: 'websocket',
        url: 'wss://plane.internal/rpc/broker/ws',
      },
    });
    await expect(webSocketClient.get({ id: 'task-ws' })).resolves.toEqual({ caller: 'headless-front', id: 'task-ws' });
    const webSocketStream = await webSocketClient.watch({ after: 20 });
    const webSocketValues = [];
    for await (const value of webSocketStream) webSocketValues.push(value);
    expect(webSocketValues).toEqual([{ sequence: 21 }, { sequence: 22 }]);

    const mcp = await plane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { id: 'task-mcp' }, name: 'tasks_get' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(mcp.status).toBe(200);
    await expect(mcp.json()).resolves.toMatchObject({
      id: 1,
      result: {
        structuredContent: { caller: 'headless-front', id: 'task-mcp' },
      },
    });

    const streamingMcp = await plane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
        body: JSON.stringify({
          id: 2,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { after: 30 }, name: 'tasks_watch' },
        }),
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(streamingMcp.status).toBe(200);
    expect(streamingMcp.headers.get('content-type')).toContain('text/event-stream');
    const events = await streamingMcp.text();
    expect(events).toContain('"items":[{"sequence":31},{"sequence":32}]');

    const cancelledStreamingMcp = await plane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
        body: JSON.stringify({
          id: 3,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            _meta: { progressToken: 'cancel-test' },
            arguments: { after: 40 },
            name: 'tasks_watch_until_cancelled',
          },
        }),
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const cancelledReader = cancelledStreamingMcp.body?.getReader();
    expect(cancelledReader).toBeDefined();
    const firstProgress = await cancelledReader?.read();
    expect(new TextDecoder().decode(firstProgress?.value)).toContain('notifications/progress');
    await cancelledReader?.cancel('client disconnected');
    await cancelledMcpStreamClosed;
    expect(cancelledMcpStreamReturnCalls).toBeGreaterThan(0);

    const inProcess = plane.abilityClient(
      {
        ability: tasks,
        caller: { id: 'headless-front', kind: 'service' },
        targetServiceId: 'tasks',
      },
      {},
    );
    await expect(inProcess.get({ id: 'client-call' })).resolves.toEqual({ caller: 'headless-front', id: 'client-call' });
    await expect(
      inProcess.inspect({ label: 'client-metadata' }, { idempotencyKey: 'client-attempt', requestId: 'client-request', timeoutMs: 5_000 }),
    ).resolves.toMatchObject({
      idempotencyKey: 'client-attempt',
      label: 'client-metadata',
      requestId: 'client-request',
    });
    const visible = await inProcess.fail({ visible: true }).catch((error: unknown) => error);
    expect(visible).toBeInstanceOf(ServicePlaneClientError);
    expect(visible).toMatchObject({ code: 'handler', reason: 'quota_exhausted', status: 429 });
    const opaque = await inProcess.fail({ visible: false }).catch((error: unknown) => error);
    expect(opaque).toBeInstanceOf(ServicePlaneClientError);
    expect(opaque).toMatchObject({ code: 'internal', status: 500 });
    expect((opaque as Error).message).not.toContain('postgres');
    const failingStream = await inProcess.watchFailure({});
    await expect(failingStream.next()).resolves.toEqual({ done: false, value: 'ready' });
    const streamError = await failingStream.next().catch((error: unknown) => error);
    expect(streamError).toBeInstanceOf(ServicePlaneClientError);
    expect(streamError).toMatchObject({ code: 'handler', reason: 'stream_quota', status: 429 });
    grantsEnabled = false;
    const revoked = await inProcess.get({ id: 'revoked-call' }).catch((error: unknown) => error);
    expect(revoked).toBeInstanceOf(ServicePlaneClientError);
    expect(revoked).toMatchObject({ status: 403 });
  });
});
