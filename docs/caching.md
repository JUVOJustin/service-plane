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

**Durable Object**

Good for Cloudflare deployments that need stronger coordination or centralized cache invalidation.

**Database**

Useful when service registration is tied to existing operational state.
