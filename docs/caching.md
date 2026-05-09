# Registry Caching

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

The package does not ship Redis, database, D1, Workers KV, or Durable Object adapters in v0.0.1. This keeps runtime dependencies out of user applications.

## Recommended Defaults

- No cache for tests and small local setups.
- 30-second TTL for production discovery caches.
- Cache only discovery documents, not authorization decisions.

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
