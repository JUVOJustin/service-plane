import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk, servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { ServicePlaneError } from '../shared/errors.js';
import { SERVICE_PLANE_STREAM_CONTENT_TYPE } from '../shared/stream.js';
import {
  abilitySession,
  abilityStream,
  cloudflareServiceBindingRpc,
  defineCapabilities,
  RpcTarget,
  requireScopes,
} from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility, defineAbilityService } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-07-22T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-22T12:00:01.000Z');

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
  const binding = { fetch: (request: Request) => service.fetch(request) };
  return { binding, issued, issuer, service };
}

function streamOptions(fixture: Awaited<ReturnType<typeof createFixture>>, method: string, input?: unknown) {
  return {
    abilityId: 'example.stream',
    callerServiceId: 'worker-a',
    ...(input === undefined ? {} : { input }),
    method,
    requestToken: async () => fixture.issued,
    scopes: ['example.read'],
    targetServiceId: 'example',
    transport: cloudflareServiceBindingRpc(fixture.binding, undefined, 'https://example.internal'),
  };
}

async function collect<T>(iterable: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('streaming ability methods', () => {
  it('advertises the stream contract in discovery', () => {
    const definition = defineAbilityService({
      abilities: [streamAbility()],
      capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const ability = definition.abilities[0];
    expect(ability?.rpc.streamPath).toBe('/rpc/example.stream/stream');
    expect(ability?.methods.listChunks?.stream).toBe(true);
    expect(ability?.methods.single?.stream).toBeUndefined();
  });

  it('rejects streaming methods that project MCP prompts or resources', () => {
    expect(() =>
      defineAbilityService({
        abilities: [
          defineAbility({
            id: 'example.bad',
            methods: {
              stream: abilityMethod({
                input: z.object({}),
                mcpResource: { name: 'nope', uri: 'example://nope' },
                output: z.object({}),
                scopes: ['example.read'],
                stream: true,
              }),
            },
            scopes: ['example.read'],
            handler: () => new StreamApi() as StreamApi & Record<string, unknown>,
          }),
        ],
        capabilities: defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' }),
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane streaming method cannot project an MCP prompt or resource');
  });

  it('streams validated items and a terminal done frame end to end', async () => {
    const fixture = await createFixture();
    const items = await collect(abilityStream(streamOptions(fixture, 'listChunks', { count: 3 })));
    expect(items).toEqual([
      { caller: 'worker-a', index: 0 },
      { caller: 'worker-a', index: 1 },
      { caller: 'worker-a', index: 2 },
    ]);
  });

  it('rejects streaming methods over the Cap’n Web transport', async () => {
    const fixture = await createFixture();
    const api = await abilitySession<
      AbilityRpc<ReturnType<typeof streamAbility>> & { listChunks(input: { count: number }): Promise<unknown> }
    >({
      abilityId: 'example.stream',
      callerServiceId: 'worker-a',
      requestToken: async () => fixture.issued,
      scopes: ['example.read'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(fixture.binding, undefined, 'https://example.internal'),
    });
    await expect(api.single({})).resolves.toEqual({ ok: true });
    await expect(api.listChunks({ count: 1 })).rejects.toThrow('Service-Plane streaming method requires the ability stream transport');
  });

  it('fails before the stream starts with real HTTP statuses', async () => {
    const fixture = await createFixture();
    const post = (body: unknown, token = fixture.issued.token) =>
      fixture.service.fetch(
        new Request('https://example.internal/rpc/example.stream/stream', {
          body: JSON.stringify(body),
          headers: { authorization: servicePlaneAuthorization(token), 'content-type': 'application/json' },
          method: 'POST',
        }),
      );

    const unauthorized = await fixture.service.fetch(
      new Request('https://example.internal/rpc/example.stream/stream', {
        body: JSON.stringify({ input: { count: 1 }, method: 'listChunks' }),
        method: 'POST',
      }),
    );
    expect(unauthorized.status).toBe(401);

    expect((await post({ input: {}, method: 'unknown' })).status).toBe(404);
    expect((await post({ input: {}, method: 'single' })).status).toBe(405);
    expect((await post({ input: { count: 'NaN' }, method: 'listChunks' })).status).toBe(422);
    expect((await post({ input: {} })).status).toBe(400);
  });

  it('reports mid-stream handler failures as terminal error frames', async () => {
    const fixture = await createFixture();
    const iterator = abilityStream(streamOptions(fixture, 'failMid', {}));
    const first = await iterator.next();
    expect(first.value).toEqual({ caller: 'example', index: 0 });
    await expect(iterator.next()).rejects.toThrow('stream exploded');
  });

  it('reports invalid output items as terminal error frames with status 500', async () => {
    const fixture = await createFixture();
    const iterator = abilityStream(streamOptions(fixture, 'badItem', {}));
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServicePlaneError);
    expect((error as ServicePlaneError).status).toBe(500);
    expect((error as ServicePlaneError).message).toContain('output validation');
  });

  it('rejects direct stream calls when ingress protection is enabled', async () => {
    const fixture = await createFixture({ ingress: true });
    const response = await fixture.service.fetch(
      new Request('https://example.internal/rpc/example.stream/stream', {
        body: JSON.stringify({ input: { count: 1 }, method: 'listChunks' }),
        headers: { authorization: servicePlaneAuthorization(fixture.issued.token), 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('serves the stream with the NDJSON content type', async () => {
    const fixture = await createFixture();
    const response = await fixture.service.fetch(
      new Request('https://example.internal/rpc/example.stream/stream', {
        body: JSON.stringify({ input: { count: 1 }, method: 'listChunks' }),
        headers: { authorization: servicePlaneAuthorization(fixture.issued.token), 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(SERVICE_PLANE_STREAM_CONTENT_TYPE);
    const body = await response.text();
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ item: { caller: 'worker-a', index: 0 } });
    expect(JSON.parse(lines[1] ?? '')).toEqual({ done: true });
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
