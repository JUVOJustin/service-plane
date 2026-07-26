import { RpcSession } from 'capnweb';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { demoService, nativeRpcEnv, testKeys } from '../test-support/index.js';
import { memoryRpcTransportPair } from '../testing/memory-transport.js';
import {
  abilitySession,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  customRpcTransport,
  defineCapabilities,
  disposeAbilitySession,
  RpcTarget,
  requireScopes,
} from './capabilities.js';
import {
  type AbilityImplementation,
  type AbilityRpc,
  type AbilityStreamSource,
  abilityMethod,
  createValidatingAbilityHandler,
  defineAbility,
  defineAbilityService,
} from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-07-22T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-22T12:00:01.000Z');

type StreamItem = { caller: string; index: number };

// The real consumer projection: proves `stream: true` survives abilityMethod/defineAbility.
type StreamAbilityRpc = AbilityRpc<ReturnType<typeof streamAbility>>;

let badItemSourceClosed = false;
let failingIteratorReturned = false;
let readableSourceCancelled = false;

class StreamApi extends RpcTarget {
  cancellable(_input: Record<string, never>) {
    return new ReadableStream<StreamItem>({
      cancel() {
        readableSourceCancelled = true;
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      start(controller) {
        controller.enqueue({ caller: 'example', index: 0 });
      },
    });
  }

  async *listChunks(input: { count: number }) {
    const caller = requireScopes(this, 'example.read');
    for (let index = 0; index < input.count; index += 1) {
      yield { caller: caller.serviceId, index };
    }
  }

  async *failMid(_input: Record<string, never>) {
    yield { caller: 'example', index: 0 };
    throw new Error('stream exploded');
  }

  failingNext(_input: Record<string, never>): AsyncIterable<StreamItem> {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error('iterator next exploded');
          },
          async return() {
            failingIteratorReturned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async *badItem(_input: Record<string, never>) {
    try {
      yield { caller: 42, index: 'nope' };
      yield { caller: 'never-reached', index: 1 };
    } finally {
      badItemSourceClosed = true;
    }
  }

  async *hang(_input: Record<string, never>) {
    yield { caller: 'example', index: 0 };
    await new Promise(() => undefined); // never settles; generator return() queues behind it
  }

  async single(_input: Record<string, never>) {
    return { ok: true };
  }
}

function streamAbility() {
  return defineAbility({
    id: 'example.stream',
    methods: {
      badItem: abilityMethod({
        input: z.object({}),
        output: z.object({ caller: z.string(), index: z.number() }),
        scopes: ['example.read'],
        stream: true,
      }),
      cancellable: abilityMethod({
        input: z.object({}),
        output: z.object({ caller: z.string(), index: z.number() }),
        scopes: ['example.read'],
        stream: true,
      }),
      failMid: abilityMethod({
        input: z.object({}),
        output: z.object({ caller: z.string(), index: z.number() }),
        scopes: ['example.read'],
        stream: true,
      }),
      failingNext: abilityMethod({
        input: z.object({}),
        output: z.object({ caller: z.string(), index: z.number() }),
        scopes: ['example.read'],
        stream: true,
      }),
      hang: abilityMethod({
        input: z.object({}),
        output: z.object({ caller: z.string(), index: z.number() }),
        scopes: ['example.read'],
        stream: true,
      }),
      listChunks: abilityMethod({
        input: z.object({ count: z.number() }),
        output: z.object({ caller: z.string(), index: z.number() }),
        scopes: ['example.read'],
        stream: true,
      }),
      single: abilityMethod({
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        scopes: ['example.read'],
      }),
    },
    rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
    scopes: ['example.read'],
    handler: () => new StreamApi() as StreamApi & Record<string, unknown>,
  });
}

async function createFixture(options: { ingress?: boolean } = {}) {
  const keys = await testKeys();
  const deployed = demoService({
    env: nativeRpcEnv(),
    issuer: 'control-plane',
    jwks: { keys: [keys.publicJwk] },
    now: () => VERIFIED_AT,
    spec: {
      abilities: () => [streamAbility()],
      id: 'example',
      ingress: options.ingress ?? false,
      scopes: ['example.read'],
      title: 'Example',
    },
  });
  const issuer = createCapabilityIssuer({
    capabilities: [deployed.capabilities],
    grants: defineServiceGrants({
      grants: [{ caller: 'worker-a', scopes: ['example.read'], target: 'example' }],
    }),
    issuer: 'control-plane',
    keyId: 'test-key',
    now: () => ISSUED_AT,
    privateJwk: keys.privateJwk,
  });
  const issued = await issuer.issueCapabilityToken({
    callerServiceId: 'worker-a',
    scopes: ['example.read'],
    targetServiceId: 'example',
  });
  return { issued, issuer, service: deployed.service };
}

async function drainStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return items;
    items.push(value as T);
  }
}

describe('streaming ability methods', () => {
  it('advertises streaming methods in discovery', () => {
    const definition = defineAbilityService({
      abilities: [streamAbility()],
      capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const ability = definition.abilities[0];
    expect(ability?.methods.listChunks?.stream).toBe(true);
    expect(ability?.methods.single?.stream).toBeUndefined();
  });

  it('rejects streaming methods that project MCP prompts, resources, or REST', () => {
    const define = (extra: Record<string, unknown>) => () =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.bad',
            methods: {
              stream: abilityMethod({
                input: z.object({}),
                output: z.object({}),
                scopes: ['example.read'],
                stream: true,
                ...extra,
              }),
            },
            rpc: { transports: ['websocket'] },
            scopes: ['example.read'],
            handler: () => new StreamApi() as StreamApi & Record<string, unknown>,
          }),
        ],
        capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      });
    expect(define({ mcpResource: { name: 'nope', uri: 'example://nope' } })).toThrow(
      'Service-Plane streaming method cannot project an MCP prompt or resource',
    );
    expect(define({ mcpPrompt: { name: 'nope' } })).toThrow('Service-Plane streaming method cannot project an MCP prompt or resource');
    expect(define({ rest: { method: 'post', path: '/nope' } })).toThrow('Service-Plane streaming method cannot project a REST operation');
  });

  it('requires a session transport for abilities with streaming methods', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.batch-only',
            methods: {
              stream: abilityMethod({
                input: z.object({}),
                output: z.object({}),
                scopes: ['example.read'],
                stream: true,
              }),
            },
            rpc: { transports: ['http-batch'] },
            scopes: ['example.read'],
            handler: () => new StreamApi() as StreamApi & Record<string, unknown>,
          }),
        ],
        capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane ability with streaming methods must enable a session transport');
  });

  it('streams validated items natively over the binding RPC session', async () => {
    const fixture = await createFixture();
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });

    const stream = await api.listChunks({ count: 3 });
    expect(stream).toBeInstanceOf(ReadableStream);
    await expect(drainStream(stream)).resolves.toEqual([
      { caller: 'worker-a', index: 0 },
      { caller: 'worker-a', index: 1 },
      { caller: 'worker-a', index: 2 },
    ]);
  });

  it('streams validated items over a real Cap’n Web session transport', async () => {
    const fixture = await createFixture();

    class SessionRoot extends RpcTarget {
      authenticate(token: string) {
        return fixture.service.connectAbility({ abilityId: 'example.stream', token });
      }
    }
    const { left, right } = memoryRpcTransportPair();
    new RpcSession(right, new SessionRoot());

    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: customRpcTransport(left),
    });

    await expect(api.single({})).resolves.toEqual({ ok: true });
    const stream = await api.listChunks({ count: 2 });
    await expect(drainStream(stream)).resolves.toEqual([
      { caller: 'worker-a', index: 0 },
      { caller: 'worker-a', index: 1 },
    ]);
  });

  it('rejects streaming methods over the one-round-trip HTTP-batch transport', async () => {
    const fixture = await createFixture();
    const binding = { fetch: async (request: Request) => fixture.service.fetch(request) };
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(binding, undefined, 'https://example.internal'),
    });

    await expect(api.single({})).resolves.toEqual({ ok: true });
    await expect(api.listChunks({ count: 1 })).rejects.toThrow('Service-Plane streaming method requires a session transport');
  });

  it('propagates mid-stream handler failures and output validation errors through the stream', async () => {
    const fixture = await createFixture();
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });

    const failing = await api.failMid({});
    const failingReader = failing.getReader();
    await expect(failingReader.read()).resolves.toEqual({ done: false, value: { caller: 'example', index: 0 } });
    await expect(failingReader.read()).rejects.toThrow('stream exploded');

    const invalid = await api.badItem({});
    await expect(drainStream(invalid)).rejects.toThrow();
  });

  it('preserves the stream discriminator through abilityMethod for consumers', () => {
    type Ability = ReturnType<typeof streamAbility>;
    expectTypeOf<Awaited<ReturnType<StreamAbilityRpc['listChunks']>>>().toEqualTypeOf<ReadableStream<StreamItem>>();
    expectTypeOf<Awaited<ReturnType<StreamAbilityRpc['single']>>>().toEqualTypeOf<{ ok: boolean }>();

    // Generator-based handlers satisfy the implementation contract for streaming methods.
    const implementation: AbilityImplementation<Ability> = {
      async *badItem() {
        yield { caller: 'x', index: 1 };
      },
      cancellable() {
        return new ReadableStream<StreamItem>();
      },
      async *failMid() {
        yield { caller: 'x', index: 1 };
      },
      failingNext() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { caller: 'x', index: 1 };
          },
        };
      },
      async *hang() {
        yield { caller: 'x', index: 0 };
      },
      async *listChunks(input) {
        yield { caller: 'x', index: input.count };
      },
      async single() {
        return { ok: true };
      },
    };
    expect(implementation).toBeDefined();

    // A bare string is not a stream source, even though strings are Iterable<string>.
    expectTypeOf<string>().not.toExtend<AbilityStreamSource<string>>();
  });

  it('cancels promptly even while the handler is awaiting its next chunk', async () => {
    const fixture = await createFixture();
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });

    const stream = await api.hang({});
    const reader = stream.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: { caller: 'example', index: 0 } });

    // The handler is now parked on a never-settling await; cancellation must not wait for it.
    const outcome = await Promise.race([
      reader.cancel('client went away').then(() => 'cancelled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 500)),
    ]);
    expect(outcome).toBe('cancelled');
  });

  it('runs a ReadableStream handler source cancellation hook while its next pull is pending', async () => {
    readableSourceCancelled = false;
    const fixture = await createFixture();
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });
    const reader = (await api.cancellable({})).getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: { caller: 'example', index: 0 } });

    await reader.cancel('client went away');
    expect(readableSourceCancelled).toBe(true);
  });

  it('releases the handler source when an item fails output validation', async () => {
    badItemSourceClosed = false;
    const fixture = await createFixture();
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });
    await expect(drainStream(await api.badItem({}))).rejects.toThrow();
    // The generator's finally block runs once the wrapper cancels the source.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badItemSourceClosed).toBe(true);
  });

  it('releases an async iterator when its next call rejects', async () => {
    failingIteratorReturned = false;
    const fixture = await createFixture();
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(fixture.service),
    });
    await expect(drainStream(await api.failingNext({}))).rejects.toThrow('iterator next exploded');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failingIteratorReturned).toBe(true);
  });

  it('rejects a websocket transport declaration without an upgrade helper at construction', async () => {
    const keys = await testKeys();
    expect(
      () =>
        new ServicePlaneService({
          abilities: [
            defineAbility({
              id: 'example.ws',
              methods: {
                ping: abilityMethod({ input: z.object({}), output: z.object({}), scopes: ['example.read'] }),
              },
              rpc: { transports: ['websocket'] },
              scopes: ['example.read'],
              handler: () => new StreamApi() as StreamApi & Record<string, unknown>,
            }),
          ],
          auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
          capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
          id: 'example',
          title: 'Example',
          version: '0.1.0',
        }),
    ).toThrow('rpc.upgradeWebSocket is not configured');
  });

  it('fails closed: createValidatingAbilityHandler rejects streaming methods unless allowStreaming is set', () => {
    const definition = defineAbilityService({
      abilities: [streamAbility()],
      capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const ability = definition.abilities[0];
    if (!ability) throw new Error('missing ability');
    const identity = {
      audience: 'example',
      expiresAt: new Date(VERIFIED_AT.getTime() + 60_000),
      issuer: 'control-plane',
      scopes: ['example.read'],
      serviceId: 'worker-a',
      tokenId: 't',
    };
    // No options → allowStreaming defaults to false (fail-closed for custom shells).
    const handler = createValidatingAbilityHandler(
      ability,
      new StreamApi() as StreamApi & Record<string, unknown>,
      identity,
    ) as unknown as Record<string, ((input: unknown) => Promise<unknown>) | undefined>;
    return expect(handler.listChunks?.({ count: 1 })).rejects.toThrow('requires a session transport');
  });

  it('exposes a working disposer that closes the underlying session', async () => {
    const fixture = await createFixture();

    class SessionRoot extends RpcTarget {
      authenticate(token: string) {
        return fixture.service.connectAbility({ abilityId: 'example.stream', token });
      }
    }
    const { left, right } = memoryRpcTransportPair();
    new RpcSession(right, new SessionRoot());
    const api = await abilitySession<StreamAbilityRpc>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: customRpcTransport(left),
    });

    expectTypeOf(api).toExtend<Disposable>();
    await expect(api.single({})).resolves.toEqual({ ok: true });
    // Disposal is wired (previously the proxy returned undefined for symbol keys) and idempotent.
    await expect(disposeAbilitySession(api)).resolves.toBeUndefined();
    await expect(disposeAbilitySession(api)).resolves.toBeUndefined();
    await expect(api.single({})).rejects.toThrow('session has been disposed');
  });

  it('disposes an asynchronous native binding once and cannot invoke it after disposal', async () => {
    let resolveBinding: ((target: object) => void) | undefined;
    let markConnectionStarted: (() => void) | undefined;
    const connectionStarted = new Promise<void>((resolve) => {
      markConnectionStarted = resolve;
    });
    const bindingReady = new Promise<object>((resolve) => {
      resolveBinding = resolve;
    });
    let targetDisposals = 0;
    let targetInvocations = 0;
    const target = {
      [Symbol.dispose]() {
        targetDisposals += 1;
      },
      async single() {
        targetInvocations += 1;
        return { ok: true };
      },
    };
    const api = await abilitySession<{ single(input: Record<string, never>): Promise<{ ok: boolean }> }>({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      scopes: ['example.read'],
      targetServiceId: 'example',
      tokenProvider: { token: async () => 'capability-token' },
      transport: cloudflareNativeRpc({
        connectAbility() {
          markConnectionStarted?.();
          return bindingReady;
        },
      }),
    });

    const capturedMethod = api.single;
    const inFlight = capturedMethod({});
    await connectionStarted;
    await disposeAbilitySession(api);
    resolveBinding?.(target);

    await expect(inFlight).rejects.toThrow('session has been disposed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(targetDisposals).toBe(1);
    expect(targetInvocations).toBe(0);
    await expect(capturedMethod({})).rejects.toThrow('session has been disposed');
    await expect(disposeAbilitySession(api)).resolves.toBeUndefined();
    expect(targetDisposals).toBe(1);
  });

  it('releases a nested session when a remote Cap’n Web caller disposes its returned stub', async () => {
    const fixture = await createFixture();

    class SessionRoot extends RpcTarget {
      authenticate(token: string) {
        return fixture.service.connectAbility({ abilityId: 'example.stream', token });
      }
    }

    const inner = memoryRpcTransportPair();
    new RpcSession(inner.right, new SessionRoot());
    let markAborted: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const trackedInnerTransport = {
      ...inner.left,
      abort(reason?: unknown) {
        inner.left.abort?.(reason);
        markAborted?.();
      },
    };

    class OuterRoot extends RpcTarget {
      connect() {
        return abilitySession<StreamAbilityRpc>({
          abilityId: 'example.stream',
          callerServiceId: 'worker-a',
          requestToken: async () => fixture.issued,
          scopes: ['example.read'],
          targetServiceId: 'example',
          transport: customRpcTransport(trackedInnerTransport),
        });
      }
    }

    const outer = memoryRpcTransportPair();
    new RpcSession(outer.right, new OuterRoot());
    const remote = new RpcSession<{ connect(): Promise<StreamAbilityRpc> }>(outer.left).getRemoteMain();
    const api = await remote.connect();
    await expect(api.single({})).resolves.toEqual({ ok: true });

    // A remotely received Cap'n Web stub exposes only the standard synchronous disposer;
    // the public helper must fall back to it and release the nested transport.
    await disposeAbilitySession(api);
    await expect(
      Promise.race([aborted.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]),
    ).resolves.toBe(true);
  });

  it('rejects streaming connections without a brokered token when ingress protection is enabled', async () => {
    const fixture = await createFixture({ ingress: true });
    await expect(fixture.service.connectAbility({ abilityId: 'example.stream', token: fixture.issued.token })).rejects.toThrow(
      'Service-Plane brokered capability token is required',
    );
  });
});
