import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createControlPlaneRpcBroker } from '../control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { cloudflareServiceBinding } from '../control-plane/endpoints.js';
import { normalizeIdempotencyKey, SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER } from '../shared/idempotency.js';
import { SERVICE_DISCOVERY_PATH } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { abilitySession, cloudflareServiceBindingRpc, defineCapabilities, RpcTarget } from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

const capabilities = defineCapabilities({ scopes: [{ id: 'example.work.run' }], serviceId: 'example' });

let seenIdempotencyKey: string | undefined;

const workAbility = defineAbility({
  id: 'example.work',
  methods: {
    // A read: safe to call again, so it advertises itself as such.
    lookup: abilityMethod({
      idempotent: true,
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
    }),
    // A write with no dedup story: deliberately unmarked.
    charge: abilityMethod({
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
    }),
  },
  rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
  scopes: ['example.work.run'],
  handler: ({ idempotencyKey }) => {
    seenIdempotencyKey = idempotencyKey;
    class WorkApi extends RpcTarget {
      async lookup() {
        return { ok: true as const };
      }
      async charge() {
        return { ok: true as const };
      }
    }
    return new WorkApi() as WorkApi & Record<string, unknown>;
  },
});

async function fixture() {
  const keys = await testKeys();
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.work.run'], target: 'example' }] }),
    issuer: 'control-plane',
    now: () => ISSUED_AT,
    privateJwks: [keys.privateJwk],
  });
  const service = new ServicePlaneService({
    abilities: [workAbility],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });
  const issued = await issuer.issueCapabilityToken({
    callerServiceId: 'worker-a',
    scopes: ['example.work.run'],
    targetServiceId: 'example',
  });
  return { issued, issuer, service };
}

describe('idempotent method marker', () => {
  it('advertises which methods are safe to call again', async () => {
    const { service } = await fixture();
    const discovery = (await (await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`))).json()) as {
      abilities: Array<{ methods: Record<string, { idempotent?: true }> }>;
    };

    const methods = discovery.abilities[0]?.methods ?? {};
    expect(methods.lookup?.idempotent).toBe(true);
    // Absent rather than false: an unmarked method makes no claim, which is the safe reading.
    expect(methods.charge && 'idempotent' in methods.charge).toBe(false);
  });
});

describe('idempotency key propagation', () => {
  it('forwards the caller key to the handler', async () => {
    const { issued, service } = await fixture();
    seenIdempotencyKey = undefined;
    const binding = { fetch: async (request: Request) => service.fetch(request) };

    let forwardedHeader: string | null = null;
    const api = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      idempotencyKey: 'attempt-7f3a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(
        {
          fetch: async (request: Request) => {
            forwardedHeader = request.headers.get(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER);
            return binding.fetch(request);
          },
        },
        undefined,
        'https://example.internal',
      ),
    });

    await expect(api.charge({})).resolves.toEqual({ ok: true });
    expect(forwardedHeader).toBe('attempt-7f3a');
    expect(seenIdempotencyKey).toBe('attempt-7f3a');
  });

  it('gives the handler nothing when the caller sent nothing', async () => {
    const { issued, service } = await fixture();
    seenIdempotencyKey = 'stale';
    const api = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc({ fetch: async (r: Request) => service.fetch(r) }, undefined, 'https://example.internal'),
    });

    await expect(api.charge({})).resolves.toEqual({ ok: true });
    expect(seenIdempotencyKey).toBeUndefined();
  });

  it('drops a key the service would refuse rather than forwarding it', async () => {
    const { issued, service } = await fixture();
    seenIdempotencyKey = 'stale';
    let forwardedHeader: string | null = null;
    const api = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      // Header separators and whitespace would land in logs and a service's store key.
      idempotencyKey: 'bad key\r\nX-Injected: 1',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(
        {
          fetch: async (request: Request) => {
            forwardedHeader = request.headers.get(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER);
            return service.fetch(request);
          },
        },
        undefined,
        'https://example.internal',
      ),
    });

    await expect(api.charge({})).resolves.toEqual({ ok: true });
    expect(forwardedHeader).toBeNull();
    expect(seenIdempotencyKey).toBeUndefined();
  });

  it('carries the key across the broker hop', async () => {
    const { issuer, service } = await fixture();
    seenIdempotencyKey = undefined;
    const endpoint = cloudflareServiceBinding({
      binding: { fetch: async (request: Request) => service.fetch(request) },
      id: 'example',
    });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      idempotencyKey: 'attempt-9c21',
      issuer,
      services: [endpoint],
    });

    const root = broker.rootCapability({ id: 'worker-a', kind: 'service' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<{ connect(scopes: string[]): Promise<AbilityRpc<typeof workAbility>> }>;
    };
    const api = await (await root.ability('example', 'example.work')).connect(['example.work.run']);

    await expect(api.charge({})).resolves.toEqual({ ok: true });
    expect(seenIdempotencyKey).toBe('attempt-9c21');
  });
});

describe('normalizeIdempotencyKey', () => {
  it('accepts a key that is safe in a header and a store key', () => {
    expect(normalizeIdempotencyKey('attempt-7f3a')).toBe('attempt-7f3a');
    expect(normalizeIdempotencyKey('  attempt_7f3a=  ')).toBe('attempt_7f3a=');
  });

  it('refuses anything that could smuggle a separator or blow up a log line', () => {
    for (const value of ['', '   ', 'a b', 'a\nb', 'a\r\nX: 1', 'a:b', 'a/b', 'x'.repeat(256), 42, null, undefined]) {
      expect(normalizeIdempotencyKey(value)).toBeUndefined();
    }
  });
});
