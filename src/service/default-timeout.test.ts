import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { DEFAULT_ABILITY_TIMEOUT_MS } from '../shared/deadline.js';
import { SERVICE_DISCOVERY_PATH } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { defineCapabilities, RpcTarget } from './capabilities.js';
import { abilityMethod, defineAbility } from './discovery.js';
import { ServicePlaneService, type ServicePlaneServiceOptions } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const capabilities = defineCapabilities({ scopes: [{ id: 'example.work.run' }], serviceId: 'example' });

const workAbility = defineAbility({
  id: 'example.work',
  methods: {
    // Nothing declared: picks up whatever ceiling the service applies.
    plain: abilityMethod({
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
    }),
    // The slow export that should not force the whole service's ceiling upward.
    bigExport: abilityMethod({
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
      timeoutMs: 120_000,
    }),
    // A stream is never bounded this way — the bound that suits a request is wrong for a stream.
    follow: abilityMethod({
      input: z.object({}),
      output: z.object({ tick: z.number() }),
      scopes: ['example.work.run'],
      stream: true,
    }),
  },
  rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
  scopes: ['example.work.run'],
  handler: () => {
    class WorkApi extends RpcTarget {
      async plain() {
        await sleep(200);
        return { ok: true as const };
      }
      async bigExport() {
        return { ok: true as const };
      }
      async *follow() {
        yield { tick: 1 };
      }
    }
    return new WorkApi() as WorkApi & Record<string, unknown>;
  },
});

function buildService(timeout?: ServicePlaneServiceOptions['timeout'], publicJwk?: JsonWebKey) {
  return new ServicePlaneService({
    abilities: [workAbility],
    auth: { issuer: 'control-plane', jwks: { keys: publicJwk ? [publicJwk] : [] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
    ...(timeout ? { timeout } : {}),
  });
}

async function methodDiscovery(service: ServicePlaneService) {
  const document = (await (await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`))).json()) as {
    abilities: Array<{ methods: Record<string, { stream?: true; timeoutMs?: number }> }>;
  };
  return document.abilities[0]?.methods ?? {};
}

describe('a service is bounded without anyone configuring it', () => {
  it('applies the built-in ceiling to a method that declares nothing', async () => {
    const methods = await methodDiscovery(buildService());
    expect(methods.plain?.timeoutMs).toBe(DEFAULT_ABILITY_TIMEOUT_MS);
    expect(DEFAULT_ABILITY_TIMEOUT_MS).toBe(10_000);
  });

  it('lets one slow method opt up without raising the ceiling for the rest', async () => {
    const methods = await methodDiscovery(buildService());
    expect(methods.bigExport?.timeoutMs).toBe(120_000);
    expect(methods.plain?.timeoutMs).toBe(DEFAULT_ABILITY_TIMEOUT_MS);
  });

  it('never bounds a streaming method this way', async () => {
    const methods = await methodDiscovery(buildService());
    expect(methods.follow?.stream).toBe(true);
    expect(methods.follow?.timeoutMs).toBeUndefined();
  });

  it('takes a service-wide ceiling in place of the built-in one', async () => {
    const methods = await methodDiscovery(buildService({ methodMs: 2_500 }));
    expect(methods.plain?.timeoutMs).toBe(2_500);
    // An explicit per-method value still wins over the service-wide one.
    expect(methods.bigExport?.timeoutMs).toBe(120_000);
  });

  it('opts out entirely when asked', async () => {
    const methods = await methodDiscovery(buildService({ methodMs: false }));
    expect(methods.plain?.timeoutMs).toBeUndefined();
  });
});

describe('enforcement of the ceiling', () => {
  it('fails a method that outruns it, with no caller deadline in play', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.work.run'], target: 'example' }] }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    });
    const service = buildService({ methodMs: 30 }, keys.publicJwk);
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    // No timeoutMs anywhere on the caller side: the bound can only be the service's own.
    const target = (await service.connectAbility({ abilityId: 'example.work', token: issued.token })) as unknown as {
      plain(input: unknown): Promise<unknown>;
    };

    await expect(target.plain({})).rejects.toThrow(/exceeded its 30ms limit/u);
  });
});
