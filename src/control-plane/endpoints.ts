import {
  type FetchLike,
  SERVICE_DISCOVERY_PATH,
  type ServiceAbilityNativeRpcBinding,
  type ServiceDiscoveryDocument,
  type ServiceEndpoint,
  type ServiceEndpointGrant,
} from '../shared/types.js';

// Factory wrappers are request-local; their underlying fetch authority remains stable.
const endpointFetchSources = new WeakMap<ServiceEndpoint['fetch'], object>();

export function cloudflareServiceBinding(input: {
  /** Enables native unary RPC on `binding`, or supplies a separate native RPC adapter. */
  abilityRpc?: true | ServiceAbilityNativeRpcBinding;
  binding: FetchLike & Partial<ServiceAbilityNativeRpcBinding>;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  grants?: ServiceEndpointGrant[];
  id: string;
  origin?: string;
}): ServiceEndpoint {
  // Native ability RPC must be opted into explicitly with `abilityRpc`. A Workers service-binding
  // stub returns a callable proxy for any property name, so feature probing cannot distinguish a
  // service that implements `invokeAbility` from one that does not. `true` is the caller's explicit
  // assertion that the same binding implements it; an object remains available for custom adapters.
  const abilityRpc = input.abilityRpc === true ? (input.binding as ServiceAbilityNativeRpcBinding) : input.abilityRpc;
  const endpoint: ServiceEndpoint = {
    ...(abilityRpc ? { abilityRpc } : {}),
    ...(input.discovery ? { discovery: input.discovery } : {}),
    fetch: (request) => input.binding.fetch(request),
    ...(input.grants ? { grants: input.grants } : {}),
    id: input.id,
    origin: input.origin ?? `https://${input.id}.service-plane.internal`,
  };
  endpointFetchSources.set(endpoint.fetch, input.binding);
  return endpoint;
}

export function httpsService(input: {
  baseUrl: string;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  fetch?: typeof fetch;
  grants?: ServiceEndpointGrant[];
  id: string;
}): ServiceEndpoint {
  const fetcher = input.fetch ?? fetch;
  const endpoint: ServiceEndpoint = {
    ...(input.discovery ? { discovery: input.discovery } : {}),
    fetch: (request) => fetcher(request),
    ...(input.grants ? { grants: input.grants } : {}),
    id: input.id,
    origin: input.baseUrl.replace(/\/+$/u, ''),
  };
  endpointFetchSources.set(endpoint.fetch, fetcher);
  return endpoint;
}

/** Identifies the authority behind discovery without equating unrelated bindings by origin. */
export function serviceEndpointDiscoverySource(endpoint: ServiceEndpoint): object {
  return endpoint.discovery ?? endpointFetchSources.get(endpoint.fetch) ?? endpoint.fetch;
}

export function serviceDiscoveryRequest(endpoint: ServiceEndpoint, discoveryPath = SERVICE_DISCOVERY_PATH): Request {
  return new Request(`${endpoint.origin}${discoveryPath}`);
}
