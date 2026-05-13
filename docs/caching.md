# Caching

`service-plane` has two cache surfaces: service discovery snapshots on the control plane and issued capability tokens on caller services. Both are optional callback caches, so applications can use Redis, Workers KV, Cache API, D1, or their own storage without pulling those dependencies into the package.

## Registry Caching

The service registry can use an optional callback cache.

```ts
createServiceRegistry({
  cache: {
    get: async (key) => snapshot,
    set: async (key, snapshot, ttlSeconds) => {},
  },
  services,
});
```

When `ServicePlaneControlPlane` proxying uses a registry cache, it derives the cache key from the current service set by default. If your `services(context)` callback depends on tenant, account, deployment, or another value that is not visible in the service ids, origins, static discovery documents, or grants, pass `proxy.cacheKey`:

```ts
const controlPlane = new ServicePlaneControlPlane({
  proxy: {
    cache: kvRegistryCache(env.SERVICE_REGISTRY_CACHE),
    cacheKey: (context) => `tenant:${context.req.header('x-tenant-id') ?? 'default'}`,
  },
  services: (context) => servicesForTenant(context),
  signingSecret: (env) => env.STS_SIGNING_SECRET,
});
```

## Recommended Defaults

- No cache for tests and small local setups.
- 30-second TTL for production discovery caches.
- Do not cache grant decisions. Issued STS tokens may be cached because they are already signed, scoped, and short-lived.

## Storage Options

**In-memory**

Useful for local development and single-process Node.js. Not shared across instances.

**Redis**

Good for external Node.js deployments with multiple instances.

**Workers KV**

Acceptable for low-risk discovery document caching. Do not use KV for strict replay prevention.

Minimal Cloudflare KV adapter:

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

Use it in the control plane:

```ts
const registry = createServiceRegistry({
  cache: kvRegistryCache(env.SERVICE_REGISTRY_CACHE),
  services,
});
```

**Durable Object**

Good for Cloudflare deployments that need stronger coordination or centralized cache invalidation.

**Database**

Useful when service registration is tied to existing operational state.

## Capability Token Caching

`capabilityFetch(...)` and `createCapabilityTokenProvider(...)` have an in-memory cache by default. That is enough for local Node.js and warm Cloudflare Worker isolates, but Cloudflare may run different requests in different isolates. For high-throughput Workers, pass a shared cache adapter:

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

Use it in a caller service:

```ts
const fetchWithCapability = capabilityFetch({
  cache: cloudflareCacheApiTokenCache(caches.default, 'https://moco.example.com'),
  callerServiceId: 'moco',
  targetServiceId: 'fizzy',
  scopes: ['fizzy.users.lookup'],
  requestToken: (input) => requestTokenFromControlPlane(input),
});
```

Cache API is edge-local and does not replicate cached entries to other data centers. That is usually acceptable for STS tokens: a miss only means the caller asks the control plane for a fresh token.

Workers KV can also be used when cross-isolate reuse matters more than read-after-write behavior:

```ts
import type { CapabilityTokenCache } from 'service-plane/service';

function kvCapabilityTokenCache(kv: KVNamespace): CapabilityTokenCache {
  return {
    async get(key) {
      const value = await kv.get(key, 'json');
      return value as { expiresAt: string; token: string } | undefined;
    },
    async set(key, value, ttlSeconds) {
      if (ttlSeconds < 60) return;
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    },
  };
}
```

KV expiration TTL has a 60-second minimum. For very short token TTLs, use in-memory or Cache API instead.
