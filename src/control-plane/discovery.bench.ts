import { bench, describe } from 'vitest';
import type { ServiceDiscoveryDocument, ServiceEndpoint } from '../shared/types.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { createServiceRegistry, memoryRegistryCache } from './registry.js';

// Discovery is a fan-out: one request per configured service, every time the catalog is resolved.
// That makes the *number of round trips* the cost driver, not the CPU spent parsing them — so these
// benchmarks model a per-service latency instead of pretending a local stub is representative.
//
// BENCH_DISCOVERY_LATENCY_MS is the knob that matters. The default of 1ms stands in for a Cloudflare
// service binding; a cross-region HTTPS service is closer to 10-50ms, and the fan-out multiplies
// nothing — the fetches run concurrently — but every one of them is still load on a target service
// that has to answer it. BENCH_DISCOVERY_SERVICES sizes the catalog (default 20, try 200).
//
// The comparison to watch is `no cache` against `warm cache`: that gap is what the plane's default
// discovery cache is worth on every route that resolves the catalog. `discoveryCache: false` puts a
// deployment back on the `no cache` row, which is what makes it worth measuring rather than assuming.

const SERVICES = Number(process.env.BENCH_DISCOVERY_SERVICES ?? 20);
const LATENCY_MS = Number(process.env.BENCH_DISCOVERY_LATENCY_MS ?? 1);
const DISCOVERY_BENCH = { time: 2_000, warmupTime: 250 };

const document = (id: string): ServiceDiscoveryDocument => ({
  abilities: Array.from({ length: 5 }, (_, index) => ({
    access: 'plane' as const,
    exposure: 'published' as const,
    id: `${id}.a${index}`,
    methods: {
      go: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, scopes: [`${id}.s${index}`] },
    },
    rpc: { path: `/rpc/${id}.a${index}`, transports: ['http-batch' as const] },
    scopes: [`${id}.s${index}`],
  })),
  capabilities: { scopes: Array.from({ length: 5 }, (_, index) => ({ id: `${id}.s${index}` })), serviceId: id },
  id,
  title: id,
  version: '0.1.0',
});

const sleep = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined);

// `etag: true` makes the service answer a conditional request with 304, which is the shape a real
// discovery endpoint has once `httpCache` is enabled on the service side.
const endpoints = (options: { etag?: boolean } = {}): ServiceEndpoint[] =>
  Array.from({ length: SERVICES }, (_, index) => {
    const id = `svc${index}`;
    return cloudflareServiceBinding({
      binding: {
        fetch: async (request: Request) => {
          await sleep(LATENCY_MS);
          if (options.etag && request.headers.get('if-none-match') === `"${id}-v1"`) {
            return new Response(null, { status: 304 });
          }
          return Response.json(document(id), { headers: options.etag ? { etag: `"${id}-v1"` } : {} });
        },
      },
      id,
    });
  });

const uncached = createServiceRegistry({ services: endpoints() });

const warmCache = memoryRegistryCache();
const cached = createServiceRegistry({ cache: warmCache, services: endpoints() });
await cached.discover();

// A cache whose entries are always expired but still readable as stale: `get` misses, `getStale`
// hits, so every call revalidates with `if-none-match` and the services answer 304.
const expiredCache = memoryRegistryCache(() => Number.POSITIVE_INFINITY);
const revalidating = createServiceRegistry({ cache: expiredCache, services: endpoints({ etag: true }) });
await createServiceRegistry({ cache: expiredCache, services: endpoints({ etag: true }) }).discover();

describe(`service discovery (${SERVICES} services, ${LATENCY_MS}ms per service)`, () => {
  // What the token-issuance path does on every request today.
  bench(
    'resolve catalog, no cache',
    async () => {
      await uncached.discover();
    },
    DISCOVERY_BENCH,
  );

  // What the broker path does when a RegistryCache is configured and the entry is fresh.
  bench(
    'resolve catalog, warm cache',
    async () => {
      await cached.discover();
    },
    DISCOVERY_BENCH,
  );

  // Entry expired, documents unchanged: still a round trip per service, but each answers 304 without
  // a body. Cheaper than a cold fetch, and still nothing like a cache hit.
  bench(
    'resolve catalog, expired cache with ETag revalidation',
    async () => {
      await revalidating.discover();
    },
    DISCOVERY_BENCH,
  );
});
