// Stable paths used over HTTP. RPC traffic itself uses Cap'n Web; only the
// out-of-band control-plane endpoints (token issuance, JWKS, services manifest)
// remain HTTP.
export const SERVICE_DISCOVERY_PATH = '/.well-known/service-plane/services.json';
export const SERVICE_PLANE_CAPABILITY_JWKS_PATH = '/.well-known/service-plane/jwks.json';
export const SERVICE_PLANE_CAPABILITY_TOKEN_PATH = '/.well-known/service-plane/capability-token';

export const DEFAULT_REGISTRY_CACHE_TTL_SECONDS = 30;
export const DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS = 120;
export const DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS = 300;

// Cap'n Web RPC sessions carry the bootstrap token in-band, not in HTTP
// headers. The legacy ServicePlane authorization scheme is still emitted on
// HTTP-batch transport for backwards compatibility with reverse proxies that
// inspect the Authorization header. Servers do not require it.
export const SERVICE_PLANE_AUTHORIZATION_SCHEME = 'ServicePlane';

// Visibility levels for capabilities exposed by a service. The control-plane
// broker uses these to decide which root capability to hand out to which
// caller.
export type ServiceCapabilityVisibility = 'public' | 'auth' | 'internal';

export type CapabilityScopeDefinition = {
  description?: string;
  id: string;
  title?: string;
};

export type CapabilityCatalog = {
  scopes: CapabilityScopeDefinition[];
  serviceId: string;
};

// Discovery descriptor for a service. Replaces the old per-route OpenAPI/JSON
// list. Surfaces only what tooling needs to know about an RPC service.
export type ServiceCapabilityDescriptor = {
  scopes: string[];
  visibility: ServiceCapabilityVisibility;
};

export type ServiceDiscoveryDocument = {
  capabilities?: CapabilityCatalog;
  exports: ServiceCapabilityDescriptor[];
  id: string;
  rpcTransports: ServiceRpcTransport[];
  title: string;
  version: string;
};

export type ServiceRpcTransport = 'http-batch' | 'websocket';

export type ServiceDiscoverySnapshot = {
  discoveredAt: string;
  services: ServiceDiscoveryDocument[];
  stale?: boolean;
};

export type RegistryCache = {
  get(key: string): Promise<ServiceDiscoverySnapshot | undefined>;
  set(key: string, value: ServiceDiscoverySnapshot, ttlSeconds: number): Promise<void>;
};

// A registered RPC service endpoint. Used by both the broker and the registry.
export type ServiceRpcEndpoint = {
  // Optional HTTP fetcher for the discovery document and for HTTP-batch RPC
  // sessions when no `connect` factory is supplied.
  fetch?(request: Request): Promise<Response>;
  id: string;
  // Cap'n Web origin used to address the service over HTTP-batch. Defaults to
  // `https://<id>.service-plane.internal`.
  origin?: string;
  // The set of root capability paths supported by the service. Defaults to
  // `['/rpc']` when omitted.
  rpcPath?: string;
};

export type ServiceRegistry = {
  discover(): Promise<ServiceDiscoverySnapshot & { endpoints: ServiceRpcEndpoint[] }>;
  endpoint(id: string): ServiceRpcEndpoint | undefined;
};

export type ServiceGrant = {
  caller: string;
  scopes: string[];
  target: string;
};

export type ServiceGrantDefinition = {
  grants: ServiceGrant[];
};

export type CapabilityClaims = {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  scp: string[];
  sub: string;
};

export type CapabilityIdentity = {
  audience: string;
  expiresAt: Date;
  issuer: string;
  scopes: string[];
  serviceId: string;
  tokenId: string;
};

export type CapabilityJwks = {
  keys: Array<JsonWebKey & { kid?: string }>;
};

export type CapabilityJwksResolver = CapabilityJwks | (() => Promise<CapabilityJwks> | CapabilityJwks);

export type VerifyCapabilityTokenOptions = {
  expectedAudience: string;
  issuer?: string;
  jwks: CapabilityJwksResolver;
  now?: Date;
  requiredScopes?: string[];
};

export type CapabilityVerifierOptions = Omit<VerifyCapabilityTokenOptions, 'requiredScopes'>;

export type IssueCapabilityTokenInput = {
  callerServiceId: string;
  scopes: string[];
  targetServiceId: string;
  ttlSeconds?: number;
};

export type IssuedCapabilityToken = {
  expiresAt: Date;
  token: string;
};

export type CapabilityTokenCacheEntry = {
  expiresAt: Date | string;
  token: string;
};

export type CapabilityTokenCache = {
  get(key: string): Promise<CapabilityTokenCacheEntry | undefined>;
  set(key: string, value: CapabilityTokenCacheEntry, ttlSeconds: number): Promise<void>;
};

export type CapabilityTokenProvider = {
  token(): Promise<string>;
};

// Lightweight fetch-like contract used for JWKS lookup over Cloudflare Service
// Bindings. Matches the shape of the Workers `Fetcher` binding.
export type FetchLike = {
  fetch(request: Request): Promise<Response>;
};
