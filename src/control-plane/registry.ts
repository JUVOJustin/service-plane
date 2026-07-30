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

      const stale = await options.cache?.getStale?.(cacheKey);
      const { complete, etags, services } = await discoverServices(options.services, discoveryPath, stale);
      const snapshot: ServiceDiscoverySnapshot = {
        discoveredAt: new Date().toISOString(),
        ...(Object.keys(etags).length > 0 ? { etags } : {}),
        services,
      };
      // A service that was unreachable is simply missing from this snapshot, and storing that would
      // turn a momentary outage into a catalog gap that outlives it by the full TTL — the service
      // comes back and the plane keeps refusing it until the entry expires. An incomplete discovery
      // is therefore used for this request and not written; the next request retries.
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

async function discoverServices(
  endpoints: ServiceEndpoint[],
  discoveryPath: string,
  previous?: ServiceDiscoverySnapshot,
): Promise<{ complete: boolean; etags: Record<string, string>; services: ServiceDiscoveryDocument[] }> {
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
  return value === 'delete' || value === 'get' || value === 'patch' || value === 'post' || value === 'put';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const MAX_REGISTRY_CACHE_ENTRIES = 32;

// The default discovery cache, and the one a plane uses unless it is given another. Process-local by
// nature: on Cloudflare that means per isolate, on Node per process. That is the bulk of the win —
// it turns a catalog fan-out per request into one per process per TTL — while a shared store (KV,
// Redis) additionally collapses it to one for the whole fleet. Both are worth having; only this one
// needs no infrastructure, which is why it is the default rather than an opt-in.
export function memoryRegistryCache(now: () => number = () => Date.now()): RegistryCache {
  const entries = new Map<string, { expiresAt: number; value: ServiceDiscoverySnapshot }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) return undefined;
      // Re-inserted so the hit moves to the most-recently-used end, which is what the bound in
      // `set` evicts from.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    // Kept past expiry on purpose: an expired entry is still the right thing to revalidate against
    // with `if-none-match`, which is what turns a refresh into a 304 instead of a full document.
    async getStale(key) {
      return entries.get(key)?.value;
    },
    async set(key, value, ttlSeconds) {
      entries.delete(key);
      entries.set(key, { expiresAt: now() + ttlSeconds * 1000, value });
      // A backstop, not a tuning knob. One entry is the normal case, because the key is derived from
      // the resolved service list — but a plane that hands different callers different services has
      // one entry per distinct list, and each holds every document in that catalog. Without a bound
      // that grows for the life of the process.
      while (entries.size > MAX_REGISTRY_CACHE_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}
