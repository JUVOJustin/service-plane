import { SERVICE_DISCOVERY_PATH, type FetchLike, type ServiceRpcEndpoint } from '../shared/types.js';

export function cloudflareServiceBinding(input: {
  binding: FetchLike;
  id: string;
  origin?: string;
  rpcPath?: string;
}): ServiceRpcEndpoint {
  return {
    fetch: (request) => input.binding.fetch(request),
    id: input.id,
    origin: input.origin ?? `https://${input.id}.service-plane.internal`,
    ...(input.rpcPath ? { rpcPath: input.rpcPath } : {}),
  };
}

export function httpsService(input: {
  baseUrl: string;
  fetch?: typeof fetch;
  id: string;
  rpcPath?: string;
}): ServiceRpcEndpoint {
  const fetcher = input.fetch ?? fetch;
  return {
    fetch: (request) => fetcher(request),
    id: input.id,
    origin: input.baseUrl.replace(/\/+$/u, ''),
    ...(input.rpcPath ? { rpcPath: input.rpcPath } : {}),
  };
}

/** Build the discovery `Request` to send to the service's
 * `/.well-known/service-plane/services.json`. */
export function serviceDiscoveryRequest(endpoint: ServiceRpcEndpoint, discoveryPath = SERVICE_DISCOVERY_PATH): Request {
  return new Request(`${endpoint.origin ?? ''}${discoveryPath}`);
}
