import { pathMatches } from '../shared/paths.js';
import {
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  type DiscoveredServiceRoute,
  type RegistryCache,
  SERVICE_DISCOVERY_PATH,
  type ServiceDiscoveryDocument,
  type ServiceDiscoverySnapshot,
  type ServiceEndpoint,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
  type ServiceRouteDiscovery,
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

  return {
    async discover() {
      const cached = await options.cache?.get(cacheKey);
      if (cached) return withRoutes(cached, options.services);

      const services = await discoverServices(options.services, discoveryPath);
      const snapshot: ServiceDiscoverySnapshot = {
        discoveredAt: new Date().toISOString(),
        services,
      };
      await options.cache?.set(cacheKey, snapshot, cacheTtlSeconds);
      return withRoutes(snapshot, options.services);
    },

    async match(method: string, path: string) {
      const snapshot = await this.discover();
      return snapshot.routes.find((route) => route.method === method.toUpperCase() && pathMatches(route.path, path));
    },
  };
}

async function discoverServices(endpoints: ServiceEndpoint[], discoveryPath: string): Promise<ServiceDiscoveryDocument[]> {
  const documents = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        if (endpoint.discovery) {
          const discovery = typeof endpoint.discovery === 'function' ? await endpoint.discovery() : endpoint.discovery;
          return isServiceDiscoveryDocument(discovery) ? discovery : undefined;
        }
        const response = await endpoint.fetch(serviceDiscoveryRequest(endpoint, discoveryPath));
        if (!response.ok) return undefined;
        const value = await response.json();
        return isServiceDiscoveryDocument(value) ? value : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return documents.filter((document): document is ServiceDiscoveryDocument => !!document);
}

function withRoutes(snapshot: ServiceDiscoverySnapshot, endpoints: ServiceEndpoint[]): ServiceRegistrySnapshot {
  const endpointsById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const routes = snapshot.services.flatMap((service) => {
    const endpoint = endpointsById.get(service.id);
    if (!endpoint) return [];
    return service.routes.map((route) => discoveredRoute(service, route, endpoint));
  });
  return {
    ...snapshot,
    routes,
  };
}

function discoveredRoute(
  service: ServiceDiscoveryDocument,
  route: ServiceRouteDiscovery,
  endpoint: ServiceEndpoint,
): DiscoveredServiceRoute {
  return {
    ...route,
    method: route.method.toUpperCase(),
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
    Array.isArray(document.routes) &&
    document.routes.every(isRouteDiscovery)
  );
}

function isRouteDiscovery(value: unknown): value is ServiceRouteDiscovery {
  if (!value || typeof value !== 'object') return false;
  const route = value as ServiceRouteDiscovery;
  return (
    typeof route.method === 'string' &&
    typeof route.path === 'string' &&
    (!route.requiredScopes || (Array.isArray(route.requiredScopes) && route.requiredScopes.every((scope) => typeof scope === 'string'))) &&
    (route.visibility === 'public' || route.visibility === 'auth' || route.visibility === 'internal')
  );
}
