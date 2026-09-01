import { type AnyNestedClient, createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createControlPlaneRpcBroker } from '../control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { ServicePlaneClientError } from '../shared/errors.js';
import { memoryWebSocketPair, testKeys } from '../test-support/index.js';
import { AbilityHibernationStream, createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient } from './client.js';
import { type AbilityClient, defineAbility } from './discovery.js';
import { encodeAbilityHibernationEvent } from './hibernation.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2099-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2099-05-09T12:00:01.000Z');
const RAW_RPC_SECRET = 'rpc-secret://tasks.internal/database';

function rawHandlerRpcError(): ORPCError<string, unknown> {
  return new ORPCError('BAD_REQUEST', {
    data: {
      servicePlane: {
        code: 'handler',
        message: RAW_RPC_SECRET,
        reason: RAW_RPC_SECRET,
        retryable: false,
        status: 400,
      },
    },
    message: RAW_RPC_SECRET,
  });
}

describe('ServicePlaneService private RPC runtime', () => {
  it('rejects a hibernation contract that does not advertise WebSocket transport', () => {
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const method = createAbilityBuilder().hibernationStream({
      handler: () => new AbilityHibernationStream<string>(() => undefined),
      input: z.object({}),
      output: z.string(),
      scopes: ['tasks.read'],
    });

    expect(
      () =>
        new ServicePlaneService({
          abilities: [
            defineAbility({
              id: 'tasks.events',
              methods: { watch: method },
              rpc: { transports: ['fetch'] },
              scopes: ['tasks.read'],
            }),
          ],
          auth: { issuer: 'control-plane', jwks: { keys: [] } },
          capabilities,
          id: 'tasks',
          logger: false,
          title: 'Tasks',
          version: '1.0.0',
        }),
    ).toThrow('Service-Plane hibernation ability must enable the websocket transport: tasks.events');
  });

  it('serves unary and streaming methods over Fetch with capability checks before validation', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'tasks.read' }],
      serviceId: 'tasks',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'headless-front', scopes: ['tasks.read'], target: 'tasks' }],
      }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'headless-front',
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
    });
    const ability = createAbilityBuilder();
    const eventSchema = z.object({ sequence: z.number() });
    let hibernationIteratorId: string | undefined;
    const tasks = defineAbility({
      id: 'tasks.items',
      methods: {
        cloudflareMetadata: ability.method({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: z.object({ colo: z.string() }),
          handler: ({ context }) => ({
            colo: String((context.request as Request & { cf?: { colo?: unknown } }).cf?.colo ?? ''),
          }),
        }),
        get: ability.method({
          scopes: ['tasks.read'],
          input: z.object({ id: z.string() }),
          output: z.object({ caller: z.string(), id: z.string() }),
          handler: ({ context, input }) => ({ caller: context.identity.serviceId, id: input.id }),
        }),
        failRawRpc: ability.method({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: z.never(),
          handler: () => {
            throw rawHandlerRpcError();
          },
        }),
        inspect: ability.method({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: z.object({
            hasSignal: z.boolean(),
            hasTimeout: z.boolean(),
            idempotencyKey: z.string(),
            requestId: z.string(),
          }),
          handler: ({ context }) => ({
            hasSignal: context.signal !== undefined,
            hasTimeout: context.remainingTimeoutMs !== undefined && context.remainingTimeoutMs() > 0,
            idempotencyKey: context.idempotencyKey ?? '',
            requestId: context.request.headers.get('x-request-id') ?? '',
          }),
        }),
        watch: ability.stream({
          scopes: ['tasks.read'],
          input: z.object({ after: z.number() }),
          output: z.object({ sequence: z.number() }),
          handler: async function* ({ input }) {
            yield { sequence: input.after + 1 };
            yield { sequence: input.after + 2 };
          },
        }),
        watchRawRpc: ability.stream({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: z.string(),
          handler: async function* () {
            yield 'ready';
            throw rawHandlerRpcError();
          },
        }),
        watchHibernating: ability.hibernationStream({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: eventSchema,
          handler: ({ context }) =>
            new AbilityHibernationStream<{ sequence: number }>((id) => {
              hibernationIteratorId = id;
              context.webSocket?.serializeAttachment?.({ id });
            }),
        }),
      },
      rpc: { transports: ['fetch', 'service-binding', 'websocket'] },
      scopes: ['tasks.read'],
    });
    const naturalNames = defineAbility({
      id: 'tasks.natural-names',
      methods: {
        constructor: ability.method({
          scopes: ['tasks.read'],
          input: z.object({ id: z.string() }),
          output: z.object({ caller: z.string(), id: z.string() }),
          handler: ({ context, input }) => ({ caller: context.identity.serviceId, id: input.id }),
        }),
      },
      rpc: { transports: ['fetch', 'service-binding'] },
      scopes: ['tasks.read'],
    });
    const service = new ServicePlaneService({
      abilities: [tasks, naturalNames],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'tasks',
      logger: false,
      rpc: { batch: true, compression: true, manualWebSocket: true },
      title: 'Tasks',
      version: '1.0.0',
    });
    const createClient = (authorization?: string) => {
      const link = new RPCLink({
        fetch: async (url, init) => service.fetch(new Request(url, init)),
        ...(authorization ? { headers: { authorization } } : {}),
        origin: 'https://tasks.internal',
        url: '/rpc/tasks.items',
      });
      return createORPCClient<AnyNestedClient>(link) as unknown as AbilityClient<typeof tasks>;
    };

    await expect(createClient(servicePlaneAuthorization(issued.token)).watchHibernating({})).rejects.toMatchObject({
      code: 'METHOD_NOT_SUPPORTED',
      message: 'Service-Plane hibernation method requires a WebSocket transport: tasks.items/watchHibernating',
    });

    const denied = createClient();
    const deniedError = await denied.get({ id: 42 } as never).catch((error: unknown) => error);
    expect(deniedError).toBeInstanceOf(ORPCError);
    expect(deniedError).toMatchObject({ code: 'UNAUTHORIZED' });

    const client = createClient(servicePlaneAuthorization(issued.token));
    await expect(client.get({ id: 'task-1' })).resolves.toEqual({ caller: 'headless-front', id: 'task-1' });
    const cloudflareClient = createORPCClient<AnyNestedClient>(
      new RPCLink({
        fetch: async (url, init) => {
          const request = new Request(url, init);
          Object.defineProperty(request, 'cf', { configurable: true, enumerable: true, value: { colo: 'FRA' } });
          return service.fetch(request);
        },
        headers: { authorization: servicePlaneAuthorization(issued.token) },
        origin: 'https://tasks.internal',
        url: '/rpc/tasks.items',
      }),
    ) as unknown as AbilityClient<typeof tasks>;
    await expect(cloudflareClient.cloudflareMetadata({})).resolves.toEqual({ colo: 'FRA' });
    const stream = await client.watch({ after: 2 });
    const values = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([{ sequence: 3 }, { sequence: 4 }]);

    const binding = {
      fetch: async (request: Request) => service.fetch(request),
      invokeAbility: (input: Parameters<ServicePlaneService['invokeAbility']>[0]) => service.invokeAbility(input),
    };
    const nativeClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: { binding, origin: 'https://tasks.internal', type: 'service-binding' },
    });
    await expect(nativeClient.get({ id: 'task-native' })).resolves.toEqual({
      caller: 'headless-front',
      id: 'task-native',
    });
    await expect(
      service.invokeAbility({
        abilityId: naturalNames.id,
        input: { id: 'task-constructor' },
        method: 'constructor',
        token: issued.token,
      }),
    ).resolves.toEqual({ caller: 'headless-front', id: 'task-constructor' });
    const naturalFetchClient = createAbilityClient({
      ability: naturalNames,
      callerServiceId: 'headless-front',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: async (url, init) => service.fetch(new Request(url, init)),
        origin: 'https://tasks.internal',
        type: 'fetch',
      },
    });
    await expect(naturalFetchClient.constructor({ id: 'task-constructor-fetch' })).resolves.toEqual({
      caller: 'headless-front',
      id: 'task-constructor-fetch',
    });
    for (const method of ['constructor', 'hasOwnProperty', 'toString', '__proto__']) {
      await expect(
        service.invokeAbility({
          abilityId: tasks.id,
          input: {},
          method,
          token: 'not-a-token',
        }),
      ).rejects.toMatchObject({ code: 'capability_auth', status: 404 });
    }
    const nativeFailure = await nativeClient.failRawRpc({}).catch((error: unknown) => error);
    expect(nativeFailure).toBeInstanceOf(ServicePlaneClientError);
    expect(nativeFailure).toMatchObject({ code: 'internal', status: 500 });
    expect(JSON.stringify(nativeFailure)).not.toContain(RAW_RPC_SECRET);
    expect((nativeFailure as Error).message).not.toContain(RAW_RPC_SECRET);

    const bindingFailureStream = await nativeClient.watchRawRpc({});
    await expect(bindingFailureStream.next()).resolves.toEqual({ done: false, value: 'ready' });
    const bindingStreamFailure = await bindingFailureStream.next().catch((error: unknown) => error);
    expect(bindingStreamFailure).toBeInstanceOf(ServicePlaneClientError);
    expect(bindingStreamFailure).toMatchObject({ code: 'internal', status: 500 });
    expect(JSON.stringify(bindingStreamFailure)).not.toContain(RAW_RPC_SECRET);
    const metadataClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      idempotencyKey: 'attempt-1',
      requestId: 'request-1',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      timeoutMs: 1_000,
      transport: { binding, origin: 'https://tasks.internal', type: 'service-binding' },
    });
    await expect(metadataClient.inspect({})).resolves.toEqual({
      hasSignal: true,
      hasTimeout: true,
      idempotencyKey: 'attempt-1',
      requestId: 'request-1',
    });
    const bindingStream = await nativeClient.watch({ after: 4 });
    const bindingValues = [];
    for await (const value of bindingStream) bindingValues.push(value);
    expect(bindingValues).toEqual([{ sequence: 5 }, { sequence: 6 }]);

    const [clientSocket, serviceSocket] = memoryWebSocketPair();
    serviceSocket.addEventListener('message', (event) => {
      const message = (event as MessageEvent<string | ArrayBuffer>).data;
      void service.webSocketMessage('tasks.items', serviceSocket, message);
    });
    const webSocketClient = createORPCClient<AnyNestedClient>(
      new WebSocketRpcLink({
        connect: () => clientSocket,
        headers: { authorization: servicePlaneAuthorization(issued.token) },
        url: '/rpc/tasks.items',
      }),
    ) as unknown as AbilityClient<typeof tasks>;
    await expect(webSocketClient.get({ id: 'task-ws' })).resolves.toEqual({ caller: 'headless-front', id: 'task-ws' });
    const webSocketStream = await webSocketClient.watch({ after: 10 });
    const webSocketValues = [];
    for await (const value of webSocketStream) webSocketValues.push(value);
    expect(webSocketValues).toEqual([{ sequence: 11 }, { sequence: 12 }]);

    const hibernatingStream = await webSocketClient.watchHibernating({});
    expect(hibernationIteratorId).toBeTypeOf('string');
    const iteratorId = hibernationIteratorId as string;
    serviceSocket.send(await encodeAbilityHibernationEvent(eventSchema, iteratorId, { sequence: 30 }));
    await expect(hibernatingStream.next()).resolves.toEqual({ done: false, value: { sequence: 30 } });
    serviceSocket.send(await encodeAbilityHibernationEvent(eventSchema, iteratorId, undefined, { event: 'close' }));
    await expect(hibernatingStream.next()).resolves.toMatchObject({ done: true });
    await service.webSocketClose('tasks.items', serviceSocket);

    let batchFetches = 0;
    const batchClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: {
          async fetch(request) {
            batchFetches += 1;
            return service.fetch(request);
          },
        },
        origin: 'https://tasks.internal',
        batch: true,
        compression: true,
        type: 'fetch',
      },
    });
    await expect(Promise.all([batchClient.get({ id: 'batch-1' }), batchClient.get({ id: 'batch-2' })])).resolves.toEqual([
      { caller: 'headless-front', id: 'batch-1' },
      { caller: 'headless-front', id: 'batch-2' },
    ]);
    expect(batchFetches).toBe(1);
    const [firstMetadata, secondMetadata] = await Promise.all([
      batchClient.inspect({}, { idempotencyKey: 'attempt-batch-1', requestId: 'request-batch-1', timeoutMs: 4_001 }),
      batchClient.inspect({}, { idempotencyKey: 'attempt-batch-2', requestId: 'request-batch-2', timeoutMs: 4_002 }),
    ]);
    expect(batchFetches).toBe(2);
    expect(firstMetadata).toMatchObject({ idempotencyKey: 'attempt-batch-1', requestId: 'request-batch-1' });
    expect(secondMetadata).toMatchObject({ idempotencyKey: 'attempt-batch-2', requestId: 'request-batch-2' });
    expect(firstMetadata.hasTimeout).toBe(true);
    expect(secondMetadata.hasTimeout).toBe(true);

    const fetchFailure = await batchClient.failRawRpc({}).catch((error: unknown) => error);
    expect(fetchFailure).toBeInstanceOf(ServicePlaneClientError);
    expect(fetchFailure).toMatchObject({ code: 'internal', status: 500 });
    expect(JSON.stringify(fetchFailure)).not.toContain(RAW_RPC_SECRET);
    expect((fetchFailure as Error).message).not.toContain(RAW_RPC_SECRET);

    const fetchFailureStream = await batchClient.watchRawRpc({});
    await expect(fetchFailureStream.next()).resolves.toEqual({ done: false, value: 'ready' });
    const fetchStreamFailure = await fetchFailureStream.next().catch((error: unknown) => error);
    expect(fetchStreamFailure).toBeInstanceOf(ServicePlaneClientError);
    expect(fetchStreamFailure).toMatchObject({ code: 'internal', status: 500 });
    expect(JSON.stringify(fetchStreamFailure)).not.toContain(RAW_RPC_SECRET);

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        {
          abilityRpc: {
            invokeAbility: (input) => service.invokeAbility(input),
          },
          fetch: async (request) => service.fetch(request),
          id: 'tasks',
          origin: 'https://tasks.internal',
        },
      ],
    });
    await expect(
      broker.callAbility({
        abilityId: 'tasks.items',
        caller: { id: 'headless-front', kind: 'service' },
        input: { id: 'brokered-1' },
        method: 'get',
        scopes: ['tasks.read'],
        targetServiceId: 'tasks',
      }),
    ).resolves.toEqual({ caller: 'headless-front', id: 'brokered-1' });
    const brokeredStream = (await broker.callAbility({
      abilityId: 'tasks.items',
      caller: { id: 'headless-front', kind: 'service' },
      input: { after: 6 },
      method: 'watch',
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
    })) as AsyncIterable<{ sequence: number }>;
    const brokeredValues = [];
    for await (const value of brokeredStream) brokeredValues.push(value);
    expect(brokeredValues).toEqual([{ sequence: 7 }, { sequence: 8 }]);
  });

  it('preserves a 404 when a stale Fetch contract calls a removed method', async () => {
    const ability = createAbilityBuilder();
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const current = defineAbility({
      id: 'tasks.versioned',
      methods: {
        get: ability.method({
          scopes: ['tasks.read'],
          input: z.object({}),
          output: z.object({}),
          handler: () => ({}),
        }),
      },
      rpc: { transports: ['fetch'] },
      scopes: ['tasks.read'],
    });
    const stale = defineAbility({
      id: current.id,
      methods: {
        removed: ability.method({ scopes: ['tasks.read'], input: z.object({}), output: z.object({}) }),
      },
      rpc: { transports: ['fetch'] },
      scopes: ['tasks.read'],
    });
    const service = new ServicePlaneService({
      abilities: [current],
      auth: { issuer: 'control-plane', jwks: { keys: [] } },
      capabilities,
      id: 'tasks',
      logger: false,
      title: 'Tasks',
      version: '1.0.0',
    });
    const client = createAbilityClient({
      ability: stale,
      targetServiceId: 'tasks',
      tokenProvider: { token: async () => 'not-a-token' },
      transport: {
        fetch: async (url, init) => service.fetch(new Request(url, init)),
        origin: 'https://tasks.internal',
        type: 'fetch',
      },
    });

    const error = await client.removed({}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    expect(error).toMatchObject({ code: 'internal', message: 'Not Found', status: 404 });
  });
});
