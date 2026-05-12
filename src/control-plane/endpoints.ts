import {
  type FetchLike,
  SERVICE_DISCOVERY_PATH,
  type ServiceDiscoveryDocument,
  type ServiceEndpoint,
  type ServiceEndpointGrant,
} from '../shared/types.js';

export function cloudflareServiceBinding(input: {
  binding: FetchLike;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  grants?: ServiceEndpointGrant[];
  id: string;
  origin?: string;
}): ServiceEndpoint {
  return {
    ...(input.discovery ? { discovery: input.discovery } : {}),
    fetch: (request) => input.binding.fetch(request),
    ...(input.grants ? { grants: input.grants } : {}),
    id: input.id,
    origin: input.origin ?? `https://${input.id}.service-plane.internal`,
  };
}

export function httpsService(input: {
  baseUrl: string;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  fetch?: typeof fetch;
  grants?: ServiceEndpointGrant[];
  id: string;
}): ServiceEndpoint {
  const fetcher = input.fetch ?? fetch;
  return {
    ...(input.discovery ? { discovery: input.discovery } : {}),
    fetch: (request) => fetcher(request),
    ...(input.grants ? { grants: input.grants } : {}),
    id: input.id,
    origin: input.baseUrl.replace(/\/+$/u, ''),
  };
}

export function serviceDiscoveryRequest(endpoint: ServiceEndpoint, discoveryPath = SERVICE_DISCOVERY_PATH): Request {
  return new Request(`${endpoint.origin}${discoveryPath}`);
}
