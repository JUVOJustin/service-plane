import { describe, expect, it } from 'vitest';
import { SERVICE_PLANE_CAPABILITY_TOKEN_PATH, SERVICE_PLANE_OPENAPI_PATH, type ServiceDiscoveryDocument } from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { memoryRegistryCache } from './registry.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

// Resolving the catalog is a fan-out: one request per configured service. Token issuance needs it on
// every request, so without a shared cache a plane asks every service it knows about just to mint
// one token. These tests count those requests rather than timing them — the round trips are the
// cost, and a count is the only part of that which is stable enough to assert.

const discovery = (id: string): ServiceDiscoveryDocument => ({
  abilities: [
    {
      access: 'plane',
      exposure: 'published',
      id: `${id}.run`,
      methods: { go: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, scopes: [`${id}.use`] } },
      rpc: { path: `/rpc/${id}.run`, transports: ['http-batch'] },
      scopes: [`${id}.use`],
    },
  ],
  capabilities: { scopes: [{ id: `${id}.use` }], serviceId: id },
  id,
  title: id,
  version: '0.1.0',
});

const SERVICES = 5;

function planeWith(options: { cache?: false | ReturnType<typeof memoryRegistryCache>; secret: string }) {
  const counter = { fetches: 0 };
  const plane = new ServicePlaneControlPlane({
    authenticateCaller: () => 'worker-a',
    ...(options.cache === undefined ? {} : { discoveryCache: options.cache }),
    log: false,
    services: () =>
      Array.from({ length: SERVICES }, (_, index) =>
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              counter.fetches += 1;
              return Response.json(discovery(`svc${index}`));
            },
          },
          grants: [{ caller: 'worker-a', scopes: [`svc${index}.use`] }],
          id: `svc${index}`,
        }),
      ),
    signingKeys: () => [{ kid: 'test-key', secret: options.secret }],
  });
  return { counter, plane };
}

const tokenRequest = () =>
  new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
    body: JSON.stringify({ scopes: ['svc0.use'], targetServiceId: 'svc0' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

describe('discovery cache on the token path', () => {
  it('caches the catalog by default, without any cache being configured', async () => {
    const { counter, plane } = planeWith({ secret: await generateCapabilitySigningSecret() });

    for (let index = 0; index < 3; index += 1) {
      expect((await plane.fetch(tokenRequest())).status).toBe(200);
    }

    // The out-of-the-box behaviour: a plane that is handed no cache still resolves the catalog once
    // rather than fanning out on every token request.
    expect(counter.fetches).toBe(SERVICES);
  });

  it('re-resolves the whole catalog per request when caching is turned off', async () => {
    const { counter, plane } = planeWith({ cache: false, secret: await generateCapabilitySigningSecret() });

    for (let index = 0; index < 3; index += 1) {
      expect((await plane.fetch(tokenRequest())).status).toBe(200);
    }

    // `discoveryCache: false` is the escape hatch for a plane that must see every catalog change
    // immediately and would rather pay the fan-out for it.
    expect(counter.fetches).toBe(SERVICES * 3);
  });

  it('resolves the catalog once across many token requests when a cache is configured', async () => {
    const { counter, plane } = planeWith({ cache: memoryRegistryCache(), secret: await generateCapabilitySigningSecret() });

    for (let index = 0; index < 10; index += 1) {
      expect((await plane.fetch(tokenRequest())).status).toBe(200);
    }

    expect(counter.fetches).toBe(SERVICES);
  });

  it('keeps issuing tokens once the cached catalog expires', async () => {
    let now = 0;
    const { counter, plane } = planeWith({
      cache: memoryRegistryCache(() => now),
      secret: await generateCapabilitySigningSecret(),
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(counter.fetches).toBe(SERVICES);

    // Past the registry TTL: the catalog is resolved again rather than served stale forever, and
    // issuance keeps working across the boundary.
    now = 60_000;
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(counter.fetches).toBe(SERVICES * 2);
  });

  it('does not cache a catalog that a service outage left incomplete', async () => {
    const secret = await generateCapabilitySigningSecret();
    let unavailable = true;
    let fetches = 0;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              fetches += 1;
              return unavailable ? new Response('Service Unavailable', { status: 503 }) : Response.json(discovery('svc0'));
            },
          },
          grants: [{ caller: 'worker-a', scopes: ['svc0.use'] }],
          id: 'svc0',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    // Fails closed while the service is down: an undiscoverable target cannot be granted.
    expect((await plane.fetch(tokenRequest())).status).toBe(500);
    expect(fetches).toBe(1);

    // An unreachable service is simply absent from the snapshot, so caching that snapshot would
    // outlive the outage by the full TTL and keep refusing a service that is already healthy again.
    unavailable = false;
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(fetches).toBe(2);

    // Recovery is cached normally once it is complete.
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(fetches).toBe(2);
  });

  it('still refuses a withdrawn grant while the catalog is cached', async () => {
    const secret = await generateCapabilitySigningSecret();
    const cache = memoryRegistryCache();
    let granted = true;
    let fetches = 0;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      discoveryCache: cache,
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              fetches += 1;
              return Response.json(discovery('svc0'));
            },
          },
          grants: granted ? [{ caller: 'worker-a', scopes: ['svc0.use'] }] : [],
          id: 'svc0',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(200);

    // The cache holds the *discovered* catalog. Grants are plane-side configuration and are re-read
    // per request, so revoking one takes effect immediately instead of waiting out the TTL — the
    // distinction that makes caching this safe.
    granted = false;
    expect((await plane.fetch(tokenRequest())).status).toBe(403);
    expect(fetches).toBe(1);
  });

  it('gives each route its own store when configured per route', async () => {
    const secret = await generateCapabilitySigningSecret();
    const tokenCache = memoryRegistryCache();
    const openapiCache = memoryRegistryCache();
    let fetches = 0;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      // What a real split looks like: issuance on a fast store, OpenAPI on a slower shared one.
      discoveryCache: { openapi: openapiCache, token: tokenCache },
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              fetches += 1;
              return Response.json(discovery('svc0'));
            },
          },
          grants: [{ caller: 'worker-a', scopes: ['svc0.use'] }],
          id: 'svc0',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(fetches).toBe(1);
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(fetches).toBe(1);

    // Separate stores warm separately: OpenAPI does not inherit the snapshot issuance just wrote.
    // That is the cost of splitting, and the reason one shared cache is the default.
    expect((await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`))).status).toBe(200);
    expect(fetches).toBe(2);
    expect((await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`))).status).toBe(200);
    expect(fetches).toBe(2);
  });

  it('turns caching off for a single route while the rest stay cached', async () => {
    const secret = await generateCapabilitySigningSecret();
    let fetches = 0;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      discoveryCache: { token: false },
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              fetches += 1;
              return Response.json(discovery('svc0'));
            },
          },
          grants: [{ caller: 'worker-a', scopes: ['svc0.use'] }],
          id: 'svc0',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    // Issuance opted out and resolves fresh every time; everything else keeps the default.
    for (let index = 0; index < 3; index += 1) {
      expect((await plane.fetch(tokenRequest())).status).toBe(200);
    }
    expect(fetches).toBe(3);
  });

  it('shares one default cache between token issuance and OpenAPI', async () => {
    const secret = await generateCapabilitySigningSecret();
    let fetches = 0;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              fetches += 1;
              return Response.json(discovery('svc0'));
            },
          },
          grants: [{ caller: 'worker-a', scopes: ['svc0.use'] }],
          id: 'svc0',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    // The OpenAPI route used to resolve the catalog on its own, uncached. On the shared default it
    // reads what issuance already fetched.
    expect((await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`))).status).toBe(200);
    expect(fetches).toBe(1);
  });

  it('resolves a brokered request once, not once per half', async () => {
    const secret = await generateCapabilitySigningSecret();
    let fetches = 0;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      broker: { caller: () => ({ id: 'gateway', kind: 'user' }) },
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async (request: Request) => {
              if (new URL(request.url).pathname.endsWith('service.json')) fetches += 1;
              return Response.json(discovery('svc0'));
            },
          },
          grants: [{ caller: 'gateway', scopes: ['svc0.use'] }],
          id: 'svc0',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    const brokerRequest = () =>
      new Request('https://plane.internal/rpc/broker', {
        body: JSON.stringify([]),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

    // A brokered call needs an issuer *and* a registry. Both are the call path, so both read the
    // same store: one resolution for the request, not one per half.
    await plane.fetch(brokerRequest());
    expect(fetches).toBe(1);

    await plane.fetch(brokerRequest());
    expect(fetches).toBe(1);
  });
});
