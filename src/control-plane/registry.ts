import {
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  SERVICE_DISCOVERY_PATH,
  type CapabilityCatalog,
  type RegistryCache,
  type ServiceCapabilityDescriptor,
  type ServiceCapabilityVisibility,
  type ServiceDiscoveryDocument,
  type ServiceDiscoverySnapshot,
  type ServiceRegistry,
  type ServiceRpcEndpoint,
  type ServiceRpcTransport,
} from '../shared/types.js';
import { serviceDiscoveryRequest } from './endpoints.js';

export type CreateServiceRegistryOptions = {
  cache?: RegistryCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  discoveryPath?: string;
  services: ServiceRpcEndpoint[];
};

/** Discover and cache the set of services + their exported capabilities. */
export function createServiceRegistry(options: CreateServiceRegistryOptions): ServiceRegistry {
  const cacheKey = options.cacheKey ?? 'service-plane:registry';
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
  const discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;
  const endpointsById = new Map(options.services.map((endpoint) => [endpoint.id, endpoint] as const));

  return {
    async discover() {
      const cached = await options.cache?.get(cacheKey);
      if (cached) {
        return { ...cached, endpoints: options.services };
      }
      const services = await discoverServices(options.services, discoveryPath);
      const snapshot: ServiceDiscoverySnapshot = {
        discoveredAt: new Date().toISOString(),
        services,
      };
      await options.cache?.set(cacheKey, snapshot, cacheTtlSeconds);
      return { ...snapshot, endpoints: options.services };
    },
    endpoint(id) {
      return endpointsById.get(id);
    },
  };
}

async function discoverServices(endpoints: ServiceRpcEndpoint[], discoveryPath: string): Promise<ServiceDiscoveryDocument[]> {
  const documents = await Promise.all(
    endpoints.map(async (endpoint) => {
      if (!endpoint.fetch) return undefined;
      try {
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

function isServiceDiscoveryDocument(value: unknown): value is ServiceDiscoveryDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as ServiceDiscoveryDocument;
  return (
    typeof document.id === 'string' &&
    typeof document.title === 'string' &&
    typeof document.version === 'string' &&
    Array.isArray(document.exports) &&
    document.exports.every(isServiceCapabilityDescriptor) &&
    Array.isArray(document.rpcTransports) &&
    document.rpcTransports.every(isServiceRpcTransport) &&
    (document.capabilities === undefined || isCapabilityCatalog(document.capabilities))
  );
}

function isServiceCapabilityDescriptor(value: unknown): value is ServiceCapabilityDescriptor {
  if (!value || typeof value !== 'object') return false;
  const descriptor = value as ServiceCapabilityDescriptor;
  return (
    Array.isArray(descriptor.scopes) &&
    descriptor.scopes.every((scope) => typeof scope === 'string') &&
    isVisibility(descriptor.visibility)
  );
}

function isVisibility(value: unknown): value is ServiceCapabilityVisibility {
  return value === 'public' || value === 'auth' || value === 'internal';
}

function isServiceRpcTransport(value: unknown): value is ServiceRpcTransport {
  return value === 'http-batch' || value === 'websocket';
}

function isCapabilityCatalog(value: unknown): value is CapabilityCatalog {
  if (!value || typeof value !== 'object') return false;
  const catalog = value as CapabilityCatalog;
  return typeof catalog.serviceId === 'string' && Array.isArray(catalog.scopes);
}
