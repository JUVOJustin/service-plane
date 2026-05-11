# Caching

`service-plane` caches three things: capability tokens (caller-side), JWKS material (verifier-side), and discovery documents (registry-side). All are optional for correctness; they exist to reduce round trips.

## Token Cache

`createCapabilityTokenProvider({...})` always keeps an in-memory cache for the current isolate. Pass an external `CapabilityTokenCache` to share tokens across isolates:

```ts
const provider = createCapabilityTokenProvider({
  cache: workersKvTokenCache(env.TOKEN_CACHE),
  callerServiceId: 'moco',
  scopes: ['example.sync.run'],
  targetServiceId: 'example',
  requestToken: (input) => fetchTokenFromControlPlane(input),
});
```

The cache key is built from `(callerServiceId, sortedScopes, targetServiceId, ttlSeconds?)` and is stable across orderings — see `capabilityTokenCacheKey(...)`. Tokens are refreshed `refreshSkewSeconds` (default 10s) before they expire so callers never observe a hard 401.

Adapters you can implement:

```ts
type CapabilityTokenCache = {
  get(key: string): Promise<CapabilityTokenCacheEntry | undefined>;
  set(key: string, value: CapabilityTokenCacheEntry, ttlSeconds: number): Promise<void>;
};
```

Cloudflare KV, the Cache API, Upstash Redis, and `memoryCapabilityTokenCache()` (in `service-plane/testing`) all satisfy the contract.

## JWKS Cache

`jwksFromUrl(...)` and `jwksFromServiceBinding(...)` cache the fetched JWKS in memory for `DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS` (300s by default). Override via `cacheTtlSeconds`. Concurrent calls during a refresh share the same in-flight Promise so a JWKS rotation only triggers one network hit per isolate.

There is intentionally no shared JWKS cache: JWKS material is small, public, and cheap to fetch, and an isolate-local cache avoids the consistency window of a distributed store.

## Registry Cache

`createServiceRegistry({ cache, cacheTtlSeconds })` caches the `ServiceDiscoverySnapshot` keyed by `cacheKey` (default `service-plane:registry`). Same `RegistryCache` shape as the token cache; pass any KV-like adapter:

```ts
type RegistryCache = {
  get(key: string): Promise<ServiceDiscoverySnapshot | undefined>;
  set(key: string, value: ServiceDiscoverySnapshot, ttlSeconds: number): Promise<void>;
};
```

Default TTL is 30 seconds. Bump it for stable deployments; reduce it during rollout.

## In-Memory Test Adapters

`service-plane/testing` exports `memoryCapabilityTokenCache()` and `memoryRegistryCache()`. They expire entries with a virtual clock (passed in via the `now` constructor arg), making cache-related tests deterministic.
