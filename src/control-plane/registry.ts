import {
  type AbilityAuth,
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
  const cacheKey = options.cacheKey ?? 'service-plane:registry';
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
  const discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;
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
      const { etags, services } = await discoverServices(options.services, discoveryPath, stale);
      const snapshot: ServiceDiscoverySnapshot = {
        discoveredAt: new Date().toISOString(),
        ...(Object.keys(etags).length > 0 ? { etags } : {}),
        services,
      };
      await options.cache?.set(cacheKey, snapshot, cacheTtlSeconds);
      return withAbilities(snapshot, options.services);
    },

    endpoint(id) {
      return endpointsById.get(id);
    },
  };
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
): Promise<{ etags: Record<string, string>; services: ServiceDiscoveryDocument[] }> {
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
        Array.isArray(document.callerAuth.jwks.keys)))
  );
}

function isAbilityDiscovery(value: unknown): value is ServiceAbilityDiscovery {
  if (!value || typeof value !== 'object') return false;
  const ability = value as ServiceAbilityDiscovery;
  return (
    typeof ability.id === 'string' &&
    isAbilityExposure(ability.exposure) &&
    isAbilityAuth(ability.auth) &&
    Array.isArray(ability.scopes) &&
    ability.scopes.every((scope) => typeof scope === 'string') &&
    !!ability.rpc &&
    typeof ability.rpc === 'object' &&
    typeof ability.rpc.path === 'string' &&
    ability.rpc.path.startsWith('/') &&
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
    (value.rest === undefined ||
      (isRecord(value.rest) &&
        isHttpMethod(value.rest.method) &&
        typeof value.rest.path === 'string' &&
        value.rest.path.startsWith('/') &&
        (value.rest.operationId === undefined || typeof value.rest.operationId === 'string'))) &&
    (value.mcp === undefined || (isRecord(value.mcp) && typeof value.mcp.name === 'string'))
  );
}

function isAbilityExposure(value: unknown): value is AbilityExposure {
  return value === 'private' || value === 'published';
}

function isAbilityAuth(value: unknown): value is AbilityAuth {
  return value === 'anonymous' || value === 'service' || value === 'user';
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
