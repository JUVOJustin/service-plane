import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { SERVICE_DISCOVERY_PATH } from '../shared/types.js';
import {
  abilitySession,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  defineCapabilities,
  RpcTarget,
  requireScopes,
} from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('ServicePlaneService', () => {
  it('mounts discovery and serves a schema-backed ability over HTTP-batch', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'worker-a', scopes: ['example.sync.run'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });

    const syncAbility = defineAbility({
      id: 'example.sync',
      methods: {
        runSync: abilityMethod({
          input: z.object({ since: z.string().optional() }),
          output: z.object({ caller: z.string(), ok: z.literal(true), since: z.string().nullable() }),
          scopes: ['example.sync.run'],
        }),
      },
      scopes: ['example.sync.run'],
      handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
    });

    const service = new ServicePlaneService({
      abilities: [syncAbility],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    const discovery = await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      abilities: [{ id: 'example.sync', rpc: { path: '/rpc/example.sync' }, scopes: ['example.sync.run'] }],
      id: 'example',
    });

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
    });
    const binding = { fetch: (request: Request) => service.fetch(request) };

    const api = await abilitySession<AbilityRpc<typeof syncAbility>>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(binding, undefined, 'https://example.internal'),
    });

    await expect(api.runSync({ since: '2026-05-09T00:00:00.000Z' })).resolves.toEqual({
      caller: 'worker-a',
      ok: true,
      since: '2026-05-09T00:00:00.000Z',
    });
    await expect(api.runSync({ since: 123 } as never)).rejects.toThrow('Invalid input');

    const nativeApi = await abilitySession<AbilityRpc<typeof syncAbility>>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(service),
    });

    await expect(nativeApi.runSync({ since: '2026-05-10T00:00:00.000Z' })).resolves.toMatchObject({
      caller: 'worker-a',
      since: '2026-05-10T00:00:00.000Z',
    });
  });
});

class ExampleApi extends RpcTarget {
  async runSync(input: { since?: string }) {
    const caller = requireScopes(this, 'example.sync.run');
    return { caller: caller.serviceId, ok: true, since: input.since ?? null };
  }
}

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
