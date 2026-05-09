import { SERVICE_DISCOVERY_PATH, type FetchLike, type ServiceEndpoint } from '../shared/types.js';

export function cloudflareServiceBinding(input: {
  binding: FetchLike;
  id: string;
  origin?: string;
}): ServiceEndpoint {
  return {
    fetch: (request) => input.binding.fetch(request),
    id: input.id,
    origin: input.origin ?? `https://${input.id}.service-plane.internal`,
  };
}

export function httpsService(input: {
  baseUrl: string;
  fetch?: typeof fetch;
  id: string;
}): ServiceEndpoint {
  const fetcher = input.fetch ?? fetch;
  return {
    fetch: (request) => fetcher(request),
    id: input.id,
    origin: input.baseUrl.replace(/\/+$/u, ''),
  };
}

export function serviceDiscoveryRequest(endpoint: ServiceEndpoint, discoveryPath = SERVICE_DISCOVERY_PATH): Request {
  return new Request(`${endpoint.origin}${discoveryPath}`);
}
