import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, defineCapabilities, RpcTarget, requireScopes, ServicePlaneService } from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { createControlPlaneRpcBroker } from './broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { cloudflareServiceBinding } from './endpoints.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('control-plane RPC broker', () => {
  it('mints a token and brokers a published anonymous ability stub', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.events.ingest' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['example.events.ingest'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });

    const ingestAbility = defineAbility({
      auth: 'anonymous',
      exposure: 'published',
      id: 'example.events',
      methods: {
        ingest: abilityMethod({
          input: z.object({ payload: z.string() }),
          output: z.object({ caller: z.string(), payload: z.string() }),
          scopes: ['example.events.ingest'],
        }),
      },
      scopes: ['example.events.ingest'],
      handler: () => new PublicApi() as PublicApi & Record<string, unknown>,
    });

    const service = new ServicePlaneService({
      abilities: [ingestAbility],
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

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
    });

    type Brokered = {
      connect(scopes: string[]): Promise<{ ingest(input: { payload: string }): Promise<{ caller: string; payload: string }> }>;
    };
    const root = broker.rootCapability() as unknown as { ability(serviceId: string, abilityId: string): Promise<Brokered> };
    const brokered = await root.ability('example', 'example.events');
    const api = await brokered.connect(['example.events.ingest']);

    await expect(api.ingest({ payload: 'hello' })).resolves.toEqual({ caller: 'control-plane', payload: 'hello' });
  });

  it('rejects private ability access without a service caller', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [defineCapabilities({ scopes: [{ id: 'example.sync.run' }], serviceId: 'example' })],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.sync.run'], target: 'example' }] }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateJwk: keys.privateJwk,
    });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        cloudflareServiceBinding({
          binding: { fetch: async () => Response.json(privateDiscovery) },
          id: 'example',
        }),
      ],
    });

    await expect(
      (broker.rootCapability() as unknown as { ability(serviceId: string, abilityId: string): Promise<unknown> }).ability(
        'example',
        'example.sync',
      ),
    ).rejects.toThrow('only exposes private abilities');
    await expect(
      (
        broker.rootCapability({ id: 'user-1', kind: 'user' }) as unknown as {
          ability(serviceId: string, abilityId: string): Promise<unknown>;
        }
      ).ability('example', 'example.sync'),
    ).rejects.toThrow('only exposes private abilities');
  });
});

class PublicApi extends RpcTarget {
  async ingest(input: { payload: string }) {
    const caller = requireScopes(this, 'example.events.ingest');
    return { caller: caller.serviceId, payload: input.payload };
  }
}

const privateDiscovery = {
  abilities: [
    {
      auth: 'service',
      exposure: 'private',
      id: 'example.sync',
      methods: {
        runSync: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scopes: ['example.sync.run'],
        },
      },
      rpc: { path: '/rpc/example.sync', transports: ['http-batch'] },
      scopes: ['example.sync.run'],
    },
  ],
  capabilities: { scopes: [{ id: 'example.sync.run' }], serviceId: 'example' },
  id: 'example',
  title: 'Example',
  version: '0.1.0',
};

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
