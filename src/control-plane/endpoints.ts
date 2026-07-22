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
  binding: FetchLike;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  grants?: ServiceEndpointGrant[];
  id: string;
  origin?: string;
}): ServiceEndpoint {
  // Workers RPC bindings expose class methods next to fetch; when the target service forwards
  // connectAbility (e.g. ServicePlaneService behind a WorkerEntrypoint), the plane can open
  // session-shaped ability connections — the transport streaming methods need.
  const abilityRpc =
    input.abilityRpc ??
    (typeof (input.binding as Partial<ServiceAbilityNativeRpcBinding>).connectAbility === 'function'
      ? (input.binding as FetchLike & ServiceAbilityNativeRpcBinding)
      : undefined);
  return {
    ...(abilityRpc ? { abilityRpc } : {}),
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
