import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, defineCapabilities, RpcTarget, ServicePlaneService } from '../service/index.js';
import { SERVICE_PLANE_CAPABILITY_TOKEN_PATH } from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

const PLANE_ORIGIN = 'https://plane.internal';

const capabilities = defineCapabilities({ scopes: [{ id: 'example.work.run' }], serviceId: 'example' });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function buildService() {
  return new ServicePlaneService({
    abilities: [
      defineAbility({
        id: 'example.work',
        methods: {
          run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.literal(true) }), scopes: ['example.work.run'] }),
        },
        rpc: { transports: ['http-batch'] },
        scopes: ['example.work.run'],
        handler: () => {
          class Api extends RpcTarget {
            async run() {
              return { ok: true as const };
            }
          }
          return new Api() as Api & Record<string, unknown>;
        },
      }),
    ],
    auth: { issuer: PLANE_ORIGIN, jwks: { keys: [] } },
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });
}

// Interlock instead of timing: the signing-key resolver only completes once services() has been
// invoked. Sequential resolution (keys first, catalog after) would deadlock on the interlock and
// time the test out, so completing at all is a deterministic proof of concurrency — never a race
// that merely usually wins. Both entries into issuerFor are covered: the broker mount and the STS
// token endpoint.
describe('key derivation overlaps catalog resolution after authentication', () => {
  function interlockedPlane(secret: string, extra: { authenticateCaller?: () => Promise<string> | string } = {}) {
    const servicesStarted = deferred();
    const service = buildService();
    return new ServicePlaneControlPlane({
      ...(extra.authenticateCaller ? { authenticateCaller: extra.authenticateCaller } : {}),
      broker: { caller: () => ({ id: 'gateway', kind: 'service' as const }) },
      discoveryCache: false,
      issuer: PLANE_ORIGIN,
      log: false,
      services: () => {
        servicesStarted.resolve();
        return [
          cloudflareServiceBinding({
            binding: { fetch: async (request: Request) => service.fetch(request) },
            grants: [
              { caller: 'gateway', scopes: ['example.work.run'] },
              { caller: 'worker-a', scopes: ['example.work.run'] },
            ],
            id: 'example',
          }),
        ];
      },
      signingKeys: async () => {
        await servicesStarted.promise;
        return [{ kid: 'k1', secret }];
      },
    });
  }

  it('on the broker mount', async () => {
    const secret = await generateCapabilitySigningSecret();
    const plane = interlockedPlane(secret);
    // The interlock sits inside issuerFor, which resolveBrokeredRequest awaits before the RPC body
    // is parsed — so any POST that completes proves the two halves ran together.
    const response = await plane.fetch(new Request(`${PLANE_ORIGIN}/rpc/broker`, { body: '[]', method: 'POST' }));
    expect(response.status).toBeGreaterThan(0);
  });

  it('on the token endpoint', async () => {
    const secret = await generateCapabilitySigningSecret();
    const plane = interlockedPlane(secret, { authenticateCaller: () => 'worker-a' });
    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['example.work.run'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    const issued = (await response.json()) as { token?: string };
    expect(issued.token).toBeTruthy();
  });

  it('surfaces a key failure immediately even while the catalog fetch hangs', async () => {
    // The regression the first-rejection join exists to prevent: a rejected signingKeys must answer
    // the request now, not wait behind a discovery fetch that may never settle.
    let releaseCatalog!: () => void;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      broker: false,
      discoveryCache: false,
      issuer: PLANE_ORIGIN,
      log: false,
      mcp: false,
      services: () =>
        new Promise((resolve) => {
          releaseCatalog = () => resolve([]);
        }),
      signingKeys: () => Promise.reject(new Error('signing keys unavailable')),
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['example.work.run'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(500);
    releaseCatalog();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('surfaces a catalog failure without leaving the pending key work as an unhandled rejection', async () => {
    const secret = await generateCapabilitySigningSecret();
    let releaseKeys!: () => void;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      broker: false,
      discoveryCache: false,
      issuer: PLANE_ORIGIN,
      log: false,
      mcp: false,
      services: () => Promise.reject(new Error('catalog exploded')),
      signingKeys: () =>
        new Promise((resolve) => {
          releaseKeys = () => resolve([{ kid: 'k1', secret }]);
        }),
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['example.work.run'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    // The catalog failure answers the request; the still-pending key derivation must stay handled.
    expect(response.status).toBeGreaterThanOrEqual(500);
    releaseKeys();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
