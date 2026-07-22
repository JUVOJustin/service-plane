import { RpcSession } from 'capnweb';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { memoryRpcTransportPair } from '../testing/memory-transport.js';
import {
  abilitySession,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  customRpcTransport,
  defineCapabilities,
  RpcTarget,
  requireScopes,
} from './capabilities.js';
import {
  type AbilityImplementation,
  type AbilityRpc,
  type AbilityStreamSource,
  abilityMethod,
  defineAbility,
  defineAbilityService,
} from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-07-22T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-22T12:00:01.000Z');

type StreamItem = { caller: string; index: number };

// The real consumer projection: proves `stream: true` survives abilityMethod/defineAbility.
type StreamAbilityRpc = AbilityRpc<ReturnType<typeof streamAbility>>;

class StreamApi extends RpcTarget {
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

  async *badItem(_input: Record<string, never>) {
    yield { caller: 42, index: 'nope' };
  }

  async *hang(_input: Record<string, never>) {
    yield { caller: 'example', index: 0 };
    await new Promise(() => undefined); // never settles; only cancellation ends this stream
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
      failMid: abilityMethod({
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
  const capabilities = defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({
      grants: [{ caller: 'worker-a', scopes: ['example.read'], target: 'example' }],
    }),
    issuer: 'control-plane',
    keyId: 'test-key',
    now: () => ISSUED_AT,
    privateJwk: keys.privateJwk,
  });
  const service = new ServicePlaneService({
    abilities: [streamAbility()],
    auth: {
      issuer: 'control-plane',
      jwks: { keys: [keys.publicJwk] },
      now: () => VERIFIED_AT,
    },
    capabilities,
    id: 'example',
    ...(options.ingress ? { ingress: { brokerServiceIds: ['control-plane'] } } : {}),
    title: 'Example',
    version: '0.1.0',
  });
  const issued = await issuer.issueCapabilityToken({
    callerServiceId: 'worker-a',
    scopes: ['example.read'],
    targetServiceId: 'example',
  });
  return { issued, issuer, service };
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
      async *failMid() {
        yield { caller: 'x', index: 1 };
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

  it('rejects streaming connections without a brokered token when ingress protection is enabled', async () => {
    const fixture = await createFixture({ ingress: true });
    await expect(fixture.service.connectAbility({ abilityId: 'example.stream', token: fixture.issued.token })).rejects.toThrow(
      'Service-Plane brokered capability token is required',
    );
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
