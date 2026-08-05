import { isOriginRelativePath } from '../shared/paths.js';
import {
  type AbilityAccess,
  type AbilityExposure,
  type AbilityTransport,
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  type DiscoveredServiceAbility,
  type RegistryCache,
  SERVICE_DISCOVERY_PATH,
  type ServiceAbilityDiscovery,
  type ServiceAbilityMethodDiscovery,
  type ServiceDiscoveryDocument,
  type ServiceDiscoverySnapshot,
  type ServiceEndpoint,
  type ServiceHttpMethod,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import { serviceDiscoveryRequest } from './endpoints.js';

export type CreateServiceRegistryOptions = {
  cache?: RegistryCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  discoveryPath?: string;
  services: ServiceEndpoint[];
};

export function createServiceRegistry(options: CreateServiceRegistryOptions): ServiceRegistry {
  const discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;
  const cacheKey = options.cacheKey ?? serviceRegistryCacheKey(options.services, discoveryPath);
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
  const endpointsById = new Map(options.services.map((endpoint) => [endpoint.id, endpoint] as const));

  return {
    async abilities() {
      return (await this.discover()).abilities;
    },

    async ability(serviceId: string, abilityId: string) {
      const snapshot = await this.discover();
      return snapshot.abilities.find((candidate) => candidate.serviceId === serviceId && candidate.id === abilityId);
    },

    async discover() {
      const cached = await options.cache?.get(cacheKey);
      if (cached) return withAbilities(cached, options.services);

      // Coalesced per cache key: without this, every request that arrives before the first one
      // finishes writing observes the same miss and fans out independently, so a cold start or a
      // TTL boundary costs services × concurrent requests rather than one fan-out. That is the load
      // this cache exists to prevent, at exactly the moment it is highest. The fetched documents are
      // a function of the services and the discovery path — which is what the key covers — so
      // sharing one resolution between callers is sound even when their caches differ; each still
      // writes its own entry below.
      const { complete, etags, services } = await coalescedDiscovery(options.cache, cacheKey, async () => {
        const stale = await options.cache?.getStale?.(cacheKey);
        return discoverServices(options.services, discoveryPath, stale);
      });
      const snapshot: ServiceDiscoverySnapshot = {
        discoveredAt: new Date().toISOString(),
        ...(Object.keys(etags).length > 0 ? { etags } : {}),
        services,
      };
      // A service that was unreachable is simply missing from this snapshot, and storing that would
      // turn a momentary outage into a catalog gap that outlives it by the full TTL — the service
      // comes back and the plane keeps refusing it until the entry expires. An incomplete discovery
      // is therefore used for this request and not written; the next request retries.
      //
      // Two things this deliberately does not do yet, both tracked in #28:
      //
      // `complete` is consumed here and then discarded. `ServiceDiscoverySnapshot` carries a `stale`
      // flag that nothing currently sets or reads, and it is the natural place to hand this to
      // callers — one that knows the catalog is partial can say so instead of leaving an operator to
      // infer it from a missing target. Combined with the bare `catch` in `discoverServices`, which
      // swallows every per-endpoint failure, a degraded catalog is invisible: nothing reports which
      // service dropped out, or that one did at all.
      //
      // And the retry has no ceiling. One service unreachable for good — decommissioned but still
      // configured, or serving a document that stopped validating — keeps `complete` false forever,
      // so nothing is ever cached again and every route fans out over the whole catalog on every
      // request. Right for a blip, unbounded for a permanent failure, and silent either way.
      if (complete) await options.cache?.set(cacheKey, snapshot, cacheTtlSeconds);
      return withAbilities(snapshot, options.services);
    },

    endpoint(id) {
      return endpointsById.get(id);
    },
  };
}

export function serviceRegistryCacheKey(services: ServiceEndpoint[], discoveryPath = SERVICE_DISCOVERY_PATH): string {
  return JSON.stringify({
    discoveryPath,
    namespace: 'service-plane:registry',
    services: services
      .map((service) => ({
        id: service.id,
        origin: service.origin,
      }))
      .sort((left, right) => `${left.id}\u0000${left.origin}`.localeCompare(`${right.id}\u0000${right.origin}`)),
  });
}

type DiscoveredDocument = {
  document: ServiceDiscoveryDocument;
  endpointId: string;
  etag?: string;
};

// Scoped per cache instance, never module-wide: two planes in one process can share endpoint ids
// and origins (the default origin is derived from the id) while resolving genuinely different
// catalogs behind them, and a global map would hand the second plane the first one's result — and
// write it into the second plane's cache, bypassing exactly the isolation separate caches exist
// for. Sharing a fill is only sound between callers that already share the entry it fills, and the
// cache instance is what defines that group. Entries only ever hold a resolution that is still
// running — dropped as soon as it settles — so this is a stampede guard, not a second cache.
const inFlightDiscovery = new WeakMap<RegistryCache, Map<string, Promise<DiscoveryResult>>>();

function coalescedDiscovery(
  cache: RegistryCache | undefined,
  cacheKey: string,
  resolve: () => Promise<DiscoveryResult>,
): Promise<DiscoveryResult> {
  // No cache, no coalescing: without an instance there is nothing safe to group callers by, and a
  // plane configured with `discoveryCache: false` has chosen freshness over shared work anyway.
  if (!cache) return resolve();

  let inFlight = inFlightDiscovery.get(cache);
  if (!inFlight) {
    inFlight = new Map();
    inFlightDiscovery.set(cache, inFlight);
  }
  const running = inFlight.get(cacheKey);
  if (running) return running;

  const pending = resolve();
  inFlight.set(cacheKey, pending);
  const settle = () => {
    if (inFlight.get(cacheKey) === pending) inFlight.delete(cacheKey);
  };
  // Both handlers, so a rejection clears the entry without becoming an unhandled rejection here —
  // the callers awaiting `pending` are the ones that see it.
  pending.then(settle, settle);
  return pending;
}

type DiscoveryResult = { complete: boolean; etags: Record<string, string>; services: ServiceDiscoveryDocument[] };

async function discoverServices(
  endpoints: ServiceEndpoint[],
  discoveryPath: string,
  previous?: ServiceDiscoverySnapshot,
): Promise<DiscoveryResult> {
  const previousServices = new Map(previous?.services.map((service) => [service.id, service]));
  const discovered = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        if (endpoint.discovery) {
          const discovery = typeof endpoint.discovery === 'function' ? await endpoint.discovery() : endpoint.discovery;
          return isServiceDiscoveryDocument(discovery) ? { document: discovery, endpointId: endpoint.id } : undefined;
        }

        const request = serviceDiscoveryRequest(endpoint, discoveryPath);
        const previousEtag = previous?.etags?.[endpoint.id];
        if (previousEtag) request.headers.set('if-none-match', previousEtag);

        const response = await endpoint.fetch(request);
        if (response.status === 304) {
          const document = previousServices.get(endpoint.id);
          return document ? { document, endpointId: endpoint.id, etag: previousEtag } : undefined;
        }
        if (!response.ok) return undefined;

        const value = await response.json();
        if (!isServiceDiscoveryDocument(value)) return undefined;
        const etag = response.headers.get('etag') ?? undefined;
        return { document: value, endpointId: endpoint.id, ...(etag ? { etag } : {}) };
      } catch {
        return undefined;
      }
    }),
  );

  const documents = discovered.filter((entry): entry is DiscoveredDocument => !!entry);
  return {
    complete: documents.length === endpoints.length,
    etags: documents.reduce<Record<string, string>>((metadata, entry) => {
      if (entry.etag) metadata[entry.endpointId] = entry.etag;
      return metadata;
    }, {}),
    services: documents.map((entry) => entry.document),
  };
}

function withAbilities(snapshot: ServiceDiscoverySnapshot, endpoints: ServiceEndpoint[]): ServiceRegistrySnapshot {
  const endpointsById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const abilities = snapshot.services.flatMap((service) => {
    const endpoint = endpointsById.get(service.id);
    if (!endpoint) return [];
    return service.abilities.map((ability) => discoveredAbility(service, ability, endpoint));
  });
  return {
    ...snapshot,
    abilities,
  };
}

function discoveredAbility(
  service: ServiceDiscoveryDocument,
  ability: ServiceAbilityDiscovery,
  endpoint: ServiceEndpoint,
): DiscoveredServiceAbility {
  return {
    ...ability,
    service: endpoint,
    serviceId: service.id,
    ...(service.ingress ? { serviceIngress: service.ingress } : {}),
    serviceTitle: service.title,
    serviceVersion: service.version,
  };
}

function isServiceDiscoveryDocument(value: unknown): value is ServiceDiscoveryDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as ServiceDiscoveryDocument;
  return (
    typeof document.id === 'string' &&
    typeof document.title === 'string' &&
    typeof document.version === 'string' &&
    Array.isArray(document.abilities) &&
    document.abilities.every(isAbilityDiscovery) &&
    (document.capabilities === undefined ||
      (typeof document.capabilities === 'object' &&
        typeof document.capabilities.serviceId === 'string' &&
        Array.isArray(document.capabilities.scopes))) &&
    (!document.callerAuth ||
      (!!document.callerAuth &&
        typeof document.callerAuth === 'object' &&
        !!document.callerAuth.jwks &&
        typeof document.callerAuth.jwks === 'object' &&
        Array.isArray(document.callerAuth.jwks.keys))) &&
    (document.ingress === undefined || (!!document.ingress && typeof document.ingress === 'object' && document.ingress.required === true))
  );
}

function isAbilityDiscovery(value: unknown): value is ServiceAbilityDiscovery {
  if (!value || typeof value !== 'object') return false;
  const ability = value as ServiceAbilityDiscovery;
  return (
    typeof ability.id === 'string' &&
    isAbilityAccess(ability.access) &&
    isAbilityExposure(ability.exposure) &&
    Array.isArray(ability.scopes) &&
    ability.scopes.every((scope) => typeof scope === 'string') &&
    !!ability.rpc &&
    typeof ability.rpc === 'object' &&
    typeof ability.rpc.path === 'string' &&
    isOriginRelativePath(ability.rpc.path) &&
    Array.isArray(ability.rpc.transports) &&
    ability.rpc.transports.every(isAbilityTransport) &&
    isRecord(ability.methods) &&
    Object.values(ability.methods).every(isAbilityMethodDiscovery)
  );
}

function isAbilityMethodDiscovery(value: unknown): value is ServiceAbilityMethodDiscovery {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string') &&
    isRecord(value.inputSchema) &&
    isRecord(value.outputSchema) &&
    (value.stream === undefined || value.stream === true) &&
    // Mirrors defineAbilityService: streaming methods cannot claim single-response projections,
    // and foreign discovery documents do not get to bypass that.
    (value.stream !== true || (value.mcpPrompt === undefined && value.mcpResource === undefined && value.rest === undefined)) &&
    (value.rest === undefined ||
      (isRecord(value.rest) &&
        isHttpMethod(value.rest.method) &&
        typeof value.rest.path === 'string' &&
        isOriginRelativePath(value.rest.path) &&
        (value.rest.operationId === undefined || typeof value.rest.operationId === 'string'))) &&
    (value.mcp === undefined || (isRecord(value.mcp) && typeof value.mcp.name === 'string'))
  );
}

function isAbilityExposure(value: unknown): value is AbilityExposure {
  return value === 'private' || value === 'published';
}

function isAbilityAccess(value: unknown): value is AbilityAccess {
  return value === 'plane' || value === 'service';
}

function isAbilityTransport(value: unknown): value is AbilityTransport {
  return value === 'cloudflare-binding-rpc' || value === 'http-batch' || value === 'websocket';
}

function isHttpMethod(value: unknown): value is ServiceHttpMethod {
  return value === 'delete' || value === 'get' || value === 'patch' || value === 'post' || value === 'put' || value === 'query';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The default discovery cache, and the one a plane uses unless it is given another. Process-local by
// nature: on Cloudflare that means per isolate, on Node per process. That is the bulk of the win —
// it turns a catalog fan-out per request into one per process per TTL — while a shared store (KV,
// Redis) additionally collapses it to one for the whole fleet. Both are worth having; only this one
// needs no infrastructure, which is why it is the default rather than an opt-in.
//
// Deliberately unbounded, and the TTL is not what bounds it: expiry only makes `get` miss, while the
// entry itself stays for `getStale` to revalidate against. Nothing here ever deletes, so an entry
// written once is retained for the life of the process. The TTL bounds freshness, not memory.
//
// What bounds memory is the number of distinct *service sets* resolved, which is a configuration
// dimension rather than a per-request one: `serviceRegistryCacheKey` covers ids and origins only, so
// per-caller grants resolve to a single entry and the ordinary plane holds exactly one. The two
// dimensions also trade against each other — a 200-service catalog is one entry at ~800 KB, while a
// plane with many distinct sets has small ones at ~4 KB each — so the product stays modest in any
// shape that corresponds to a real deployment.
//
// A capacity bound was tried and removed. A miss here is a network fan-out over every configured
// service, so any cap low enough to fire produces the eviction thrashing that made the issuer
// cache's bound not worth carrying, and worse: that miss cost microseconds, this one costs round
// trips. A cap set high enough never to fire would be a memory backstop rather than a cache policy —
// defensible, but it guards a shape we could not construct without inventing hundreds of distinct
// large catalogs.
export function memoryRegistryCache(now: () => number = () => Date.now()): RegistryCache {
  const entries = new Map<string, { expiresAt: number; value: ServiceDiscoverySnapshot }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) return undefined;
      return entry.value;
    },
    // Kept past expiry on purpose: an expired entry is still the right thing to revalidate against
    // with `if-none-match`, which is what turns a refresh into a 304 instead of a full document.
    async getStale(key) {
      return entries.get(key)?.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { expiresAt: now() + ttlSeconds * 1000, value });
    },
  };
}
