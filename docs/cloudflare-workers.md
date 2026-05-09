# Cloudflare Workers

Cloudflare Workers are a first-class target for `service-plane`.

Use Cloudflare Service Bindings or Worker RPC for Worker-to-Worker calls when services live in the same Cloudflare account. STS tokens keep the authorization model portable while allowing the request itself to stay direct.

Prefer Worker RPC for Cloudflare-native internal APIs. Use Hono `fetch` routes when you want the exact same contract to run over public HTTPS for external services.

## Service Worker

```ts
import { Hono } from 'hono';
import { capability, capabilityAuth, defineCapabilities, defineNamespace, defineService, jwksFromServiceBinding, mountDiscovery } from 'service-plane/service';

type Env = {
  CONTROL_PLANE: Fetcher;
};

const capabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [{ id: 'example.sync.run', title: 'Run example sync' }],
});

const routes = new Hono().post('/providers/example/v1/sync', capability('example.sync.run'), (c) => c.json({ ok: true }));

const service = defineService(
  {
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
    namespaces: [defineNamespace({ app: routes, prefix: '/', visibility: 'internal' })],
  },
  { requireRouteScopes: true },
);

const app = new Hono<{ Bindings: Env }>();
mountDiscovery(app, service);
app.use('*', (c, next) =>
  capabilityAuth({
    expectedAudience: 'example',
    issuer: 'control-plane',
    jwks: jwksFromServiceBinding(c.env.CONTROL_PLANE),
  })(c, next),
);
app.route('/', routes);

export default app;
```

## Control Plane Worker

```ts
import { Hono } from 'hono';
import {
  createCapabilityIssuerFromJwks,
  defineServiceGrants,
  mountCapabilityEndpoints,
} from 'service-plane/control-plane';
import { defineCapabilities } from 'service-plane/service';

type Env = {
  STS_PRIVATE_KEY_JWK: string;
};

const capabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [{ id: 'example.sync.run', title: 'Run example sync' }],
});

const app = new Hono<{ Bindings: Env }>();

mountCapabilityEndpoints(
  app,
  (c) =>
    createCapabilityIssuerFromJwks({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', target: 'example', scopes: ['example.sync.run'] }],
      }),
      issuer: 'control-plane',
      keyId: 'default',
      privateJwk: JSON.parse(c.env.STS_PRIVATE_KEY_JWK),
    }),
  {
    authenticateCaller: (c) => c.req.header('x-service-id') ?? c.json({ error: 'Unauthorized' }, 401),
  },
);

export default app;
```

## Worker RPC Calls

Pass the capability token explicitly to Worker RPC methods:

```ts
export class ExampleEntrypoint extends WorkerEntrypoint<Env> {
  async sync(token: string, payload: SyncPayload) {
    const identity = await verifyCapabilityToken(token, {
      expectedAudience: 'example',
      issuer: 'control-plane',
      jwks: jwksFromServiceBinding(this.env.CONTROL_PLANE),
      requiredScopes: ['example.sync.run'],
    });

    return runSync(identity.serviceId, payload);
  }
}
```

For Hono RPC or Service Binding `fetch`, use `capabilityFetch({ callerServiceId, targetServiceId, scopes, requestToken })` so the token is sent as `Authorization: ServicePlane <token>`.

## Capability Token Cache

`capabilityFetch(...)` and `createCapabilityTokenProvider(...)` cache tokens in memory, but Cloudflare may run requests in different isolates. If that causes repeated STS calls, pass an adapter backed by Cache API:

```ts
import type { CapabilityTokenCache, CapabilityTokenCacheEntry } from 'service-plane/service';

function cloudflareCacheApiTokenCache(cache: Cache, origin: string): CapabilityTokenCache {
  const requestFor = (key: string) => new Request(`${origin}/__service-plane/token-cache/${encodeURIComponent(key)}`);

  return {
    async get(key) {
      const response = await cache.match(requestFor(key));
      if (!response) return undefined;
      return (await response.json()) as CapabilityTokenCacheEntry;
    },
    async set(key, value, ttlSeconds) {
      await cache.put(
        requestFor(key),
        new Response(JSON.stringify(value), {
          headers: {
            'cache-control': `max-age=${ttlSeconds}`,
            'content-type': 'application/json',
          },
        }),
      );
    },
  };
}
```

Then use it in the caller Worker:

```ts
const fetchWithCapability = capabilityFetch({
  cache: cloudflareCacheApiTokenCache(caches.default, 'https://moco.example.com'),
  callerServiceId: 'moco',
  targetServiceId: 'example',
  scopes: ['example.sync.run'],
  requestToken: (input) => requestTokenFromControlPlane(input),
});
```

Cache API entries are local to the data center that wrote them. A miss is safe: the caller asks the control plane for a fresh short-lived token.

## Registry KV Cache

Minimal KV cache adapter:

```ts
import type { RegistryCache, ServiceDiscoverySnapshot } from 'service-plane/control-plane';

function kvRegistryCache(kv: KVNamespace): RegistryCache {
  return {
    async get(key) {
      const value = await kv.get(key, 'json');
      return value as ServiceDiscoverySnapshot | undefined;
    },
    async set(key, value, ttlSeconds) {
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    },
  };
}
```

## Control-Plane Proxying

Control-plane proxying can attach STS tokens for discovered routes that declare `requiredScopes`:

```ts
const registry = createServiceRegistry({
  cache: kvRegistryCache(c.env.SERVICE_REGISTRY_CACHE),
  services: [cloudflareServiceBinding({ id: 'example', binding: c.env.EXAMPLE_SERVICE })],
});

return createControlPlaneProxy({
  capabilityToken: async (_c, route) =>
    (
      await issuer.issueCapabilityToken({
        callerServiceId: 'control-plane',
        scopes: route.requiredScopes ?? [],
        targetServiceId: route.serviceId,
      })
    ).token,
  registry,
})(c, next);
```

## Notes

- Keep STS private keys in Worker secrets, not source code or wrangler config.
- Let the control plane publish JWKS via `mountCapabilityEndpoints(...)`; services normally consume it with `jwksFromServiceBinding(...)` or `jwksFromUrl(...)`.
- `createCapabilityIssuerFromJwks(...)` derives the public JWKS from `privateJwk` by default and validates that the derived key can verify issued tokens.
- Replace the example `x-service-id` check with authenticated service identity in production, such as an OAuth client credential or a platform identity signal.
- Run `wrangler types` after binding changes in your application.
- Service Bindings are private, but STS tokens keep one authorization model across Worker RPC, Service Binding fetch, and external Hono HTTPS services.
