import { os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { BatchHandlerPlugin } from '@orpc/server/plugins';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SERVICE_PLANE_CONN_INFO_HEADER } from '../shared/conn-info.js';
import { MAX_SERVICE_PLANE_TIMEOUT_MS, SERVICE_PLANE_TIMEOUT_GRACE_MS, SERVICE_PLANE_TIMEOUT_HEADER } from '../shared/deadline.js';
import { SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER } from '../shared/idempotency.js';
import type { IssueCapabilityTokenInput, ServiceAbilityNativeCall } from '../shared/types.js';
import { SERVICE_PLANE_REQUEST_ID_HEADER } from '../shared/types.js';
import { AbilityHibernationStream, createAbilityBuilder } from './ability.js';
import {
  type AbilityClientTransport,
  type BrokeredAbilityTransport,
  type CreateAbilityClientOptions,
  createAbilityClient,
  createBrokeredAbilityClient,
} from './client.js';
import { defineAbility } from './discovery.js';

const builder = createAbilityBuilder();
const metadataOutput = z.object({
  connInfo: z.string(),
  idempotencyKey: z.string(),
  label: z.string(),
  requestId: z.string(),
  scopes: z.array(z.string()),
  timeoutMs: z.string(),
});
const clientAbility = defineAbility({
  id: 'client.metadata',
  methods: {
    hibernate: builder.hibernationStream({
      scopes: ['metadata.read'],
      input: z.object({}),
      output: z.string(),
      handler: () => new AbilityHibernationStream<string>(() => undefined),
    }),
    inspect: builder.method({
      scopes: ['metadata.read'],
      input: z.object({ label: z.string() }),
      output: metadataOutput,
      handler: ({ input }) => ({
        connInfo: '',
        idempotencyKey: '',
        label: input.label,
        requestId: '',
        scopes: [],
        timeoutMs: '',
      }),
    }),
    watch: builder.stream({
      scopes: ['metadata.read'],
      input: z.object({ label: z.string() }),
      output: metadataOutput,
      handler: async function* ({ input }) {
        yield {
          connInfo: '',
          idempotencyKey: '',
          label: input.label,
          requestId: '',
          scopes: [],
          timeoutMs: '',
        };
      },
    }),
  },
  rpc: { transports: ['fetch', 'service-binding', 'websocket'] },
  scopes: ['metadata.read', 'metadata.audit'],
});

type RequestContext = { headers: Record<string, string | string[] | undefined> };

describe('stable ability client call options', () => {
  it('requires callerServiceId only when the client owns token requests', () => {
    const existingProvider: CreateAbilityClientOptions<typeof clientAbility> = {
      ability: clientAbility,
      targetServiceId: 'metadata',
      tokenProvider: { token: async () => 'test-token' },
      transport: { type: 'fetch' },
    };
    // @ts-expect-error A requestToken client must identify the service asking for its capability.
    const requesterWithoutIdentity: CreateAbilityClientOptions<typeof clientAbility> = {
      ability: clientAbility,
      requestToken: async () => ({ expiresAt: new Date(), token: 'test-token' }),
      targetServiceId: 'metadata',
      transport: { type: 'fetch' },
    };

    expect(existingProvider.tokenProvider).toBeDefined();
    expect(requesterWithoutIdentity).toBeDefined();
  });

  it('derives method scopes and keeps distinct per-call metadata inside a direct Fetch batch', async () => {
    const requests: IssueCapabilityTokenInput[] = [];
    let fetches = 0;
    const handler = metadataHandler(false);
    const client = createAbilityClient({
      ability: clientAbility,
      callerServiceId: 'workflow',
      requestToken: async (input) => {
        requests.push(input);
        return { expiresAt: new Date(Date.now() + 60_000), token: 'test-token' };
      },
      scopes: ['metadata.audit'],
      targetServiceId: 'metadata',
      transport: {
        batch: true,
        fetch: async (url, init) => {
          fetches += 1;
          return handle(handler, new Request(url, init), '/rpc/client.metadata');
        },
        origin: 'https://metadata.internal',
        type: 'fetch',
      },
    });

    const [first, second] = await Promise.all([
      client.inspect(
        { label: 'first' },
        {
          connInfo: { remote: { address: '203.0.113.1', addressType: 'IPv4', port: 4101, transport: 'tcp' } },
          idempotencyKey: 'attempt-first',
          requestId: 'request-first',
          timeoutMs: 3_001,
        },
      ),
      client.inspect(
        { label: 'second' },
        {
          connInfo: { remote: { address: '203.0.113.2', addressType: 'IPv4', port: 4102, transport: 'tcp' } },
          idempotencyKey: 'attempt-second',
          requestId: 'request-second',
          timeoutMs: 3_002,
        },
      ),
    ]);

    expect(fetches).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.scopes).toEqual(['metadata.read', 'metadata.audit']);
    expect(first).toMatchObject({
      connInfo: JSON.stringify({ address: '203.0.113.1', addressType: 'IPv4', port: 4101, transport: 'tcp' }),
      idempotencyKey: 'attempt-first',
      label: 'first',
      requestId: 'request-first',
      scopes: [],
    });
    expect(second).toMatchObject({
      connInfo: JSON.stringify({ address: '203.0.113.2', addressType: 'IPv4', port: 4102, transport: 'tcp' }),
      idempotencyKey: 'attempt-second',
      label: 'second',
      requestId: 'request-second',
      scopes: [],
    });
    expectForwardedTimeout(first.timeoutMs, 3_001);
    expectForwardedTimeout(second.timeoutMs, 3_002);
  });

  it('propagates per-call signal and metadata through ordinary Fetch', async () => {
    const handler = metadataHandler(false);
    let transportSignal: AbortSignal | null | undefined;
    const client = createAbilityClient({
      ability: clientAbility,
      connInfo: { remote: { address: '198.51.100.10', addressType: 'IPv4', port: 4300, transport: 'tcp' } },
      idempotencyKey: 'default-attempt',
      requestId: 'default-request',
      tokenProvider: { token: async () => 'test-token' },
      targetServiceId: 'metadata',
      timeoutMs: 4_000,
      transport: {
        fetch: async (url, init) => {
          transportSignal = init?.signal;
          return handle(handler, new Request(url, init), '/rpc/client.metadata');
        },
        origin: 'https://metadata.internal',
        type: 'fetch',
      },
    });
    const controller = new AbortController();

    const result = await client.inspect({ label: 'signal' }, { signal: controller.signal });
    expect(result).toMatchObject({
      connInfo: JSON.stringify({ address: '198.51.100.10', addressType: 'IPv4', port: 4300, transport: 'tcp' }),
      idempotencyKey: 'default-attempt',
      requestId: 'default-request',
    });
    expectForwardedTimeout(result.timeoutMs, 4_000);
    expect(transportSignal).toBeDefined();
    expect(transportSignal).not.toBe(controller.signal);
    controller.abort('after completion');
    expect(transportSignal?.aborted).toBe(false);
  });

  it('normalizes direct and broker RPC paths before the first request', async () => {
    const directAbility = defineAbility({
      ...clientAbility,
      id: 'client.normalized',
      rpc: { path: ' /rpc/client.normalized/// ', transports: ['fetch'] },
    });
    const directHandler = metadataHandler(false);
    let directPath = '';
    const direct = createAbilityClient({
      ability: directAbility,
      targetServiceId: 'metadata',
      tokenProvider: { token: async () => 'test-token' },
      transport: {
        fetch: async (url, init) => {
          directPath = new URL(new Request(url).url).pathname;
          return handle(directHandler, new Request(url, init), '/rpc/client.normalized');
        },
        origin: 'https://metadata.internal',
        type: 'fetch',
      },
    });
    await expect(direct.inspect({ label: 'direct' })).resolves.toMatchObject({ label: 'direct' });
    expect(directPath).toBe('/rpc/client.normalized/inspect');

    const brokerHandler = metadataHandler(true);
    let brokerPath = '';
    const brokered = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      transport: {
        fetch: async (url, init) => {
          brokerPath = new URL(new Request(url).url).pathname;
          return handle(brokerHandler, new Request(url, init), '/custom-broker');
        },
        origin: 'https://plane.internal',
        path: ' /custom-broker/// ',
      },
    });
    await expect(brokered.inspect({ label: 'broker' })).resolves.toMatchObject({ label: 'broker' });
    expect(brokerPath).toBe('/custom-broker/call');
  });

  it('rejects RPC paths that can escape or alter their configured route', () => {
    const invalidAbility = defineAbility({
      ...clientAbility,
      rpc: { path: '//other.example/rpc', transports: ['fetch'] },
    });
    expect(() =>
      createAbilityClient({
        ability: invalidAbility,
        targetServiceId: 'metadata',
        tokenProvider: { token: async () => 'test-token' },
        transport: { type: 'fetch' },
      }),
    ).toThrow('Service-Plane RPC path must be origin-relative: client.metadata');
    expect(() =>
      createBrokeredAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        transport: { path: '/rpc/broker?target=other' },
      }),
    ).toThrow('Service-Plane RPC path must be origin-relative: control-plane broker');
  });

  it('propagates per-call metadata through Cloudflare native RPC', async () => {
    const calls: ServiceAbilityNativeCall[] = [];
    let providerScopes: readonly string[] | undefined;
    const client = createAbilityClient({
      ability: clientAbility,
      tokenProvider: {
        token: async (scopes) => {
          providerScopes = scopes;
          return 'test-token';
        },
      },
      targetServiceId: 'metadata',
      transport: {
        binding: {
          invokeAbility(input) {
            calls.push(input);
            return {
              connInfo: '',
              idempotencyKey: input.idempotencyKey ?? '',
              label: (input.input as { label: string }).label,
              requestId: input.requestId ?? '',
              scopes: [],
              timeoutMs: String(input.timeoutMs ?? ''),
            };
          },
        },
        type: 'service-binding',
      },
    });

    const result = await client.inspect(
      { label: 'native' },
      {
        connInfo: { remote: { address: '2001:db8::1', addressType: 'IPv6', port: 4200, transport: 'tcp' } },
        idempotencyKey: 'attempt-native',
        requestId: 'request-native',
        timeoutMs: 5_000,
      },
    );
    expect(result).toMatchObject({
      idempotencyKey: 'attempt-native',
      label: 'native',
      requestId: 'request-native',
    });
    expectForwardedTimeout(result.timeoutMs, 5_000);
    expect(calls).toHaveLength(1);
    expect(providerScopes).toEqual(['metadata.read']);
    expect(calls[0]).toMatchObject({
      connInfo: { remote: { address: '2001:db8::1', addressType: 'IPv6', port: 4200, transport: 'tcp' } },
      idempotencyKey: 'attempt-native',
      requestId: 'request-native',
    });
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it('derives broker scopes and preserves distinct metadata in broker Fetch batches', async () => {
    let fetches = 0;
    const handler = metadataHandler(true);
    const client = createBrokeredAbilityClient({
      ability: clientAbility,
      scopes: ['metadata.audit'],
      targetServiceId: 'metadata',
      transport: {
        batch: true,
        fetch: async (url, init) => {
          fetches += 1;
          return handle(handler, new Request(url, init), '/rpc/broker');
        },
        origin: 'https://plane.internal',
      },
    });

    const [first, second] = await Promise.all([
      client.inspect(
        { label: 'broker-first' },
        {
          idempotencyKey: 'broker-attempt-first',
          requestId: 'broker-request-first',
          timeoutMs: 6_001,
        },
      ),
      client.inspect(
        { label: 'broker-second' },
        {
          idempotencyKey: 'broker-attempt-second',
          requestId: 'broker-request-second',
          timeoutMs: 6_002,
        },
      ),
    ]);

    expect(fetches).toBe(1);
    expect(first).toMatchObject({
      connInfo: '',
      idempotencyKey: 'broker-attempt-first',
      requestId: 'broker-request-first',
      scopes: ['metadata.read', 'metadata.audit'],
    });
    expect(second).toMatchObject({
      connInfo: '',
      idempotencyKey: 'broker-attempt-second',
      requestId: 'broker-request-second',
      scopes: ['metadata.read', 'metadata.audit'],
    });
    expectForwardedTimeout(first.timeoutMs, 6_001);
    expectForwardedTimeout(second.timeoutMs, 6_002);
  });

  it('refuses scopes outside the ability contract', () => {
    expect(() =>
      createBrokeredAbilityClient({
        ability: clientAbility,
        scopes: ['metadata.admin'],
        targetServiceId: 'metadata',
        transport: { origin: 'https://plane.internal' },
      }),
    ).toThrow('Service-Plane client scope is not declared by ability: client.metadata -> metadata.admin');
  });

  it.each(['then', 'toJSON', '__proto__'])('rejects reserved method name %s before creating a client', (methodName) => {
    const invalid = defineAbility({
      id: 'client.invalid',
      methods: { [methodName]: clientAbility.methods.inspect },
      scopes: ['metadata.read'],
    });

    expect(() =>
      createBrokeredAbilityClient({
        ability: invalid,
        targetServiceId: 'metadata',
        transport: {},
      }),
    ).toThrow(`Service-Plane ability method name is reserved: client.invalid/${methodName}`);
  });

  it('routes natural JavaScript property names through direct and brokered Fetch clients', async () => {
    const method = builder.method({
      input: z.object({ value: z.string() }),
      output: z.string(),
      scopes: ['metadata.read'],
    });
    const naturalNames = defineAbility({
      id: 'client.natural-names',
      methods: {
        apply: method,
        call: method,
        constructor: method,
        name: method,
        toString: method,
      },
      rpc: { transports: ['fetch'] },
      scopes: ['metadata.read'],
    });
    const directRouter = Object.fromEntries(
      Object.keys(naturalNames.methods).map((methodName) => [
        methodName,
        os
          .$context<RequestContext>()
          .input(z.object({ value: z.string() }))
          .handler(({ input }) => `${methodName}:${input.value}`),
      ]),
    );
    const directHandler = new RPCHandler(directRouter);
    let directFetches = 0;
    const direct = createAbilityClient({
      ability: naturalNames,
      targetServiceId: 'metadata',
      tokenProvider: { token: async () => 'test-token' },
      transport: {
        fetch: async (url, init) => {
          directFetches += 1;
          return handle(directHandler, new Request(url, init), '/rpc/client.natural-names');
        },
        origin: 'https://metadata.internal',
        type: 'fetch',
      },
    });
    const brokerHandler = new RPCHandler({
      call: os
        .$context<RequestContext>()
        .input(z.unknown())
        .handler(({ input }) => {
          const envelope = input as { input: { value: string }; method: string };
          return `${envelope.method}:${envelope.input.value}`;
        }),
    });
    const brokered = createBrokeredAbilityClient({
      ability: naturalNames,
      targetServiceId: 'metadata',
      transport: {
        fetch: async (url, init) => handle(brokerHandler, new Request(url, init), '/rpc/broker'),
        origin: 'https://plane.internal',
      },
    });

    expect(String(direct)).toBe('[object ServicePlaneAbilityClient]');
    expect(directFetches).toBe(0);
    const calls = [
      ['apply', direct.apply, brokered.apply],
      ['call', direct.call, brokered.call],
      ['constructor', direct.constructor, brokered.constructor],
      ['name', direct.name, brokered.name],
      ['toString', direct.toString, brokered.toString],
    ] as const;
    for (const [methodName, directCall, brokeredCall] of calls) {
      await expect(directCall({ value: 'direct' })).resolves.toBe(`${methodName}:direct`);
      await expect(brokeredCall({ value: 'brokered' })).resolves.toBe(`${methodName}:brokered`);
    }
  });

  it('exposes only declared methods on a null-prototype client', () => {
    let fetches = 0;
    const client = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      timeoutMs: 5_000,
      transport: {
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
      },
    });
    const surface = client as unknown as Record<PropertyKey, unknown>;
    const unknownSymbol = Symbol('inspect-client');

    expect(Object.getPrototypeOf(client)).toBeNull();
    expect(surface.then).toBeUndefined();
    expect(surface.toJSON).toBeUndefined();
    expect(surface.bind).toBeUndefined();
    expect(surface.constructor).toBeUndefined();
    expect(surface.toString).toBeUndefined();
    expect(surface.valueOf).toBeUndefined();
    expect(surface[unknownSymbol]).toBeUndefined();
    expect(() => String(client)).not.toThrow();
    expect(fetches).toBe(0);
  });

  it('keeps caller-auth headers on Fetch broker transports only', () => {
    const fetchTransport: BrokeredAbilityTransport = { headers: { authorization: 'Bearer test' } };
    const webSocketTransport: BrokeredAbilityTransport = {
      // @ts-expect-error WebSocket handshake authentication belongs in the URL or socket factory.
      headers: { authorization: 'Bearer test' },
      type: 'websocket',
      url: 'wss://plane.example/rpc/broker/ws',
    };

    expect(fetchTransport.headers).toBeDefined();
    expect(webSocketTransport.type).toBe('websocket');
  });

  it('does not expose batching on native service-binding transports', () => {
    const transport: AbilityClientTransport = {
      // @ts-expect-error Native unary calls bypass Fetch and stream fallbacks must not be batched.
      batch: true,
      binding: { invokeAbility: () => undefined },
      type: 'service-binding',
    };

    expect(transport.type).toBe('service-binding');
  });

  it('fails hibernation calls before Fetch, batching, or a service-binding fallback can run', async () => {
    let fetches = 0;
    let nativeCalls = 0;
    let socketCreates = 0;
    const directFetch = createAbilityClient({
      ability: clientAbility,
      tokenProvider: { token: async () => 'test-token' },
      targetServiceId: 'metadata',
      transport: {
        batch: true,
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
        type: 'fetch',
      },
    });
    const serviceBinding = createAbilityClient({
      ability: clientAbility,
      tokenProvider: { token: async () => 'test-token' },
      targetServiceId: 'metadata',
      transport: {
        binding: {
          fetch: async () => {
            fetches += 1;
            return new Response();
          },
          invokeAbility() {
            nativeCalls += 1;
          },
        },
        type: 'service-binding',
      },
    });
    const brokeredFetch = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      transport: {
        batch: true,
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
      },
    });
    const brokeredWebSocket = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      transport: {
        createWebSocket: () => {
          socketCreates += 1;
          throw new Error('socket must not be created');
        },
        type: 'websocket',
        url: 'wss://plane.example/rpc/broker/ws',
      },
    });

    for (const call of [directFetch.hibernate({}), serviceBinding.hibernate({})]) {
      await expect(call).rejects.toMatchObject({ code: 'capability_auth', status: 405 });
      await expect(call).rejects.toThrow('Service-Plane hibernation method requires a WebSocket transport: client.metadata/hibernate');
    }
    for (const call of [brokeredFetch.hibernate({}), brokeredWebSocket.hibernate({})]) {
      await expect(call).rejects.toMatchObject({ code: 'capability_auth', status: 405 });
      await expect(call).rejects.toThrow(
        'Service-Plane hibernation method cannot run through the control-plane broker; connect to the service WebSocket: client.metadata/hibernate',
      );
    }
    expect(fetches).toBe(0);
    expect(nativeCalls).toBe(0);
    expect(socketCreates).toBe(0);
  });

  it('keeps streams out of direct, service-binding fallback, and broker Fetch batches', async () => {
    const directHandler = metadataHandler(false);
    let directFetches = 0;
    const direct = createAbilityClient({
      ability: clientAbility,
      tokenProvider: { token: async () => 'test-token' },
      targetServiceId: 'metadata',
      transport: {
        batch: true,
        fetch: async (url, init) => {
          directFetches += 1;
          return handle(directHandler, new Request(url, init), '/rpc/client.metadata');
        },
        type: 'fetch',
      },
    });
    const bindingHandler = metadataHandler(false);
    let bindingFetches = 0;
    const binding = createAbilityClient({
      ability: clientAbility,
      tokenProvider: { token: async () => 'test-token' },
      targetServiceId: 'metadata',
      transport: {
        binding: {
          fetch: async (request) => {
            bindingFetches += 1;
            return handle(bindingHandler, request, '/rpc/client.metadata');
          },
          invokeAbility: () => undefined,
        },
        type: 'service-binding',
      },
    });
    const brokerHandler = metadataHandler(true);
    let brokerFetches = 0;
    const brokered = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      transport: {
        batch: true,
        fetch: async (url, init) => {
          brokerFetches += 1;
          return handle(brokerHandler, new Request(url, init), '/rpc/broker');
        },
      },
    });

    const clients = [
      { client: direct, fetches: () => directFetches },
      { client: binding, fetches: () => bindingFetches },
      { client: brokered, fetches: () => brokerFetches },
    ];
    for (const { client, fetches } of clients) {
      const [first, second] = await Promise.all([client.watch({ label: 'first' }), client.watch({ label: 'second' })]);
      await expect(Promise.all([first.next(), second.next()])).resolves.toMatchObject([
        { done: false, value: { label: 'first' } },
        { done: false, value: { label: 'second' } },
      ]);
      expect(fetches()).toBe(2);
    }
  });

  it('treats a per-call zero timeout as exhausted even when the client has a default', async () => {
    let fetches = 0;
    const client = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      timeoutMs: 5_000,
      transport: {
        fetch: async () => {
          fetches += 1;
          return new Response();
        },
      },
    });

    await expect(client.inspect({ label: 'late' }, { timeoutMs: 0 })).rejects.toMatchObject({ code: 'timeout', status: 504 });
    expect(fetches).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid default timeout (%s)', (timeoutMs) => {
    expect(() =>
      createBrokeredAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        timeoutMs,
        transport: {},
      }),
    ).toThrow('Service-Plane client default timeoutMs must be 0 or a positive safe integer');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid per-call timeout (%s) before transport',
    async (timeoutMs) => {
      let fetches = 0;
      const client = createBrokeredAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        transport: {
          fetch: async () => {
            fetches += 1;
            return new Response();
          },
        },
      });

      await expect(client.inspect({ label: 'invalid' }, { timeoutMs })).rejects.toMatchObject({
        code: 'capability_auth',
        status: 500,
      });
      expect(fetches).toBe(0);
    },
  );

  it('clamps a timeout above the package maximum', async () => {
    const handler = metadataHandler(true);
    const client = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      transport: {
        fetch: (url, init) => handle(handler, new Request(url, init), '/rpc/broker'),
      },
    });

    const result = await client.inspect({ label: 'clamped' }, { timeoutMs: MAX_SERVICE_PLANE_TIMEOUT_MS + 1 });
    expectForwardedTimeout(result.timeoutMs, MAX_SERVICE_PLANE_TIMEOUT_MS);
  });

  it('maps a locally aborted unary call to the stable cancelled classification', async () => {
    let transportStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      transportStarted = resolve;
    });
    const client = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      timeoutMs: 5_000,
      transport: {
        fetch: async (_url, init) => {
          const signal = init?.signal;
          if (!signal) throw new Error('missing transport signal');
          transportStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const controller = new AbortController();
    const call = client.inspect({ label: 'cancelled' }, { signal: controller.signal });
    await started;
    controller.abort(new DOMException('caller stopped', 'AbortError'));

    await expect(call).rejects.toMatchObject({
      code: 'cancelled',
      message: 'caller stopped',
      retryable: false,
      status: 499,
    });
  });

  it('aborts a hung transport when the local caller deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      let transportSignal: AbortSignal | undefined;
      let transportStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        transportStarted = resolve;
      });
      const client = createBrokeredAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        timeoutMs: 1,
        transport: {
          fetch: async (_url, init) => {
            transportSignal = init?.signal ?? undefined;
            if (!transportSignal) throw new Error('missing transport signal');
            transportStarted?.();
            return new Promise<Response>((_resolve, reject) => {
              transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true });
            });
          },
        },
      });

      const call = client.inspect({ label: 'deadline' });
      const rejected = expect(call).rejects.toMatchObject({ code: 'timeout', retryable: true, status: 504 });
      await started;
      await vi.advanceTimersByTimeAsync(1 + SERVICE_PLANE_TIMEOUT_GRACE_MS);

      await rejected;
      expect(transportSignal?.aborted).toBe(true);
      expect(transportSignal?.reason).toMatchObject({ code: 'timeout', status: 504 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('subtracts token resolution from the deadline forwarded over native RPC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let forwardedTimeoutMs: number | undefined;
      const client = createAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        timeoutMs: 100,
        tokenProvider: {
          token: () => new Promise<string>((resolve) => setTimeout(() => resolve('test-token'), 40)),
        },
        transport: {
          binding: {
            invokeAbility: (input) => {
              forwardedTimeoutMs = input.timeoutMs;
              return {
                connInfo: '',
                idempotencyKey: '',
                label: 'budget',
                requestId: '',
                scopes: [],
                timeoutMs: String(input.timeoutMs),
              };
            },
          },
          type: 'service-binding',
        },
      });

      const call = client.inspect({ label: 'budget' });
      await vi.advanceTimersByTimeAsync(40);
      await call;

      expect(forwardedTimeoutMs).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start broker transport after header resolution exhausts the forwarded budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let fetches = 0;
      const client = createBrokeredAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        timeoutMs: 20,
        transport: {
          fetch: async () => {
            fetches += 1;
            return new Response();
          },
          headers: () => new Promise<HeadersInit>((resolve) => setTimeout(() => resolve({}), 25)),
        },
      });

      const call = client.inspect({ label: 'budget' });
      const rejected = expect(call).rejects.toMatchObject({ code: 'timeout', retryable: true, status: 504 });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;

      expect(fetches).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['token', 'binding'] as const)('settles a native call promptly when aborted during %s resolution', async (stage) => {
    let startedCall: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedCall = resolve;
    });
    const pending = () =>
      new Promise<never>(() => {
        startedCall?.();
      });
    const client = createAbilityClient({
      ability: clientAbility,
      tokenProvider: { token: stage === 'token' ? pending : async () => 'test-token' },
      targetServiceId: 'metadata',
      transport: {
        binding: { invokeAbility: stage === 'binding' ? pending : () => undefined },
        type: 'service-binding',
      },
    });
    const controller = new AbortController();
    const call = client.inspect({ label: stage }, { signal: controller.signal });
    await started;
    controller.abort(`${stage} cancelled`);

    await expect(call).rejects.toMatchObject({
      code: 'cancelled',
      message: `${stage} cancelled`,
      retryable: false,
      status: 499,
    });
  });

  it('maps iterator failures through the call signal after the stream has started', async () => {
    const controller = new AbortController();
    const client = createAbilityClient({
      ability: clientAbility,
      tokenProvider: { token: async () => 'test-token' },
      targetServiceId: 'metadata',
      transport: {
        binding: {
          invokeAbility: () =>
            (async function* () {
              yield 'ready';
              throw new Error('private iterator failure');
            })(),
        },
        type: 'service-binding',
      },
    });
    const stream = (await client.inspect({ label: 'stream' }, { signal: controller.signal })) as unknown as AsyncIterator<string>;

    await expect(stream.next()).resolves.toEqual({ done: false, value: 'ready' });
    controller.abort('stream cancelled');
    await expect(stream.next()).rejects.toMatchObject({
      code: 'cancelled',
      message: 'stream cancelled',
      retryable: false,
      status: 499,
    });
  });

  it('locally cancels a pending stream pull even when the call also has a deadline', async () => {
    let pullStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      pullStarted = resolve;
    });
    const handler = new RPCHandler({
      stream: os.input(z.unknown()).handler(async function* () {
        yield {
          connInfo: '',
          idempotencyKey: '',
          label: 'ready',
          requestId: '',
          scopes: [],
          timeoutMs: '',
        };
        pullStarted?.();
        await new Promise(() => undefined);
      }),
    });
    const client = createBrokeredAbilityClient({
      ability: clientAbility,
      targetServiceId: 'metadata',
      timeoutMs: 5_000,
      transport: {
        fetch: (url, init) => handle(handler, new Request(url, init), '/rpc/broker'),
      },
    });
    const controller = new AbortController();
    const stream = await client.watch({ label: 'ready' }, { signal: controller.signal });
    await expect(stream.next()).resolves.toMatchObject({ done: false, value: { label: 'ready' } });
    const pending = stream.next();
    await started;
    const rejection = expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false, status: 499 });

    controller.abort('stream cancelled');

    await rejection;
  });

  it('keeps the local deadline active for stream pulls after setup', async () => {
    vi.useFakeTimers();
    try {
      let pullStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        pullStarted = resolve;
      });
      const handler = new RPCHandler({
        stream: os.input(z.unknown()).handler(async function* () {
          yield {
            connInfo: '',
            idempotencyKey: '',
            label: 'ready',
            requestId: '',
            scopes: [],
            timeoutMs: '',
          };
          pullStarted?.();
          await new Promise(() => undefined);
        }),
      });
      const client = createBrokeredAbilityClient({
        ability: clientAbility,
        targetServiceId: 'metadata',
        timeoutMs: 1,
        transport: {
          fetch: (url, init) => handle(handler, new Request(url, init), '/rpc/broker'),
        },
      });
      const stream = await client.watch({ label: 'ready' });
      await expect(stream.next()).resolves.toMatchObject({ done: false, value: { label: 'ready' } });
      const pending = stream.next();
      await started;
      const rejection = expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true, status: 504 });

      await vi.advanceTimersByTimeAsync(1 + SERVICE_PLANE_TIMEOUT_GRACE_MS);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

function expectForwardedTimeout(value: string, requested: number): void {
  const timeoutMs = Number(value);
  expect(Number.isSafeInteger(timeoutMs)).toBe(true);
  expect(timeoutMs).toBeGreaterThan(0);
  expect(timeoutMs).toBeLessThanOrEqual(requested);
}

function metadataHandler(brokered: boolean): RPCHandler<RequestContext> {
  const procedure = os
    .$context<RequestContext>()
    .input(z.unknown())
    .handler(({ context, input }) => {
      const envelope = brokered
        ? (input as { input: { label: string }; scopes: string[] })
        : { input: input as { label: string }, scopes: [] };
      return {
        connInfo: header(context.headers, SERVICE_PLANE_CONN_INFO_HEADER),
        idempotencyKey: header(context.headers, SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER),
        label: envelope.input.label,
        requestId: header(context.headers, SERVICE_PLANE_REQUEST_ID_HEADER),
        scopes: envelope.scopes,
        timeoutMs: header(context.headers, SERVICE_PLANE_TIMEOUT_HEADER),
      };
    });
  const streamProcedure = os
    .$context<RequestContext>()
    .input(z.unknown())
    .handler(async function* ({ context, input }) {
      const envelope = brokered
        ? (input as { input: { label: string }; scopes: string[] })
        : { input: input as { label: string }, scopes: [] };
      yield {
        connInfo: header(context.headers, SERVICE_PLANE_CONN_INFO_HEADER),
        idempotencyKey: header(context.headers, SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER),
        label: envelope.input.label,
        requestId: header(context.headers, SERVICE_PLANE_REQUEST_ID_HEADER),
        scopes: envelope.scopes,
        timeoutMs: header(context.headers, SERVICE_PLANE_TIMEOUT_HEADER),
      };
    });
  const router = brokered ? { call: procedure, stream: streamProcedure } : { inspect: procedure, watch: streamProcedure };
  return new RPCHandler(router, {
    interceptors: [({ request, next, ...options }) => next({ ...options, context: { headers: request.headers }, request })],
    plugins: [new BatchHandlerPlugin()],
  });
}

async function handle(handler: RPCHandler<RequestContext>, request: Request, prefix: `/${string}`): Promise<Response> {
  const handled = await handler.handle(request, { context: { headers: {} }, prefix });
  return handled.matched ? handled.response : new Response('Not found', { status: 404 });
}

function header(headers: RequestContext['headers'], name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}
