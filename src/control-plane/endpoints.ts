import {
  type FetchLike,
  SERVICE_DISCOVERY_PATH,
  type ServiceAbilityNativeRpcBinding,
  type ServiceDiscoveryDocument,
  type ServiceEndpoint,
  type ServiceEndpointGrant,
} from '../shared/types.js';

export function cloudflareServiceBinding(input: {
  abilityRpc?: ServiceAbilityNativeRpcBinding;
  binding: FetchLike & Partial<ServiceAbilityNativeRpcBinding>;
  createWebSocket?: (url: string) => WebSocket;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  grants?: ServiceEndpointGrant[];
  id: string;
  origin?: string;
}): ServiceEndpoint {
  // Native ability RPC must be opted into explicitly with `abilityRpc`. A Workers service-binding
  // stub returns a callable proxy for *any* property name, so probing for `connectAbility` cannot
  // distinguish a service that forwards it from one that does not.
  return {
    ...(input.abilityRpc ? { abilityRpc: input.abilityRpc } : {}),
    ...(input.createWebSocket ? { createWebSocket: input.createWebSocket } : {}),
    ...(input.discovery ? { discovery: input.discovery } : {}),
    fetch: (request) => input.binding.fetch(request),
    ...(input.grants ? { grants: input.grants } : {}),
    id: input.id,
    origin: input.origin ?? `https://${input.id}.service-plane.internal`,
  };
}

export function httpsService(input: {
  baseUrl: string;
  createWebSocket?: (url: string) => WebSocket;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  fetch?: typeof fetch;
  grants?: ServiceEndpointGrant[];
  id: string;
}): ServiceEndpoint {
  const fetcher = input.fetch ?? fetch;
  return {
    ...(input.createWebSocket ? { createWebSocket: input.createWebSocket } : {}),
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
