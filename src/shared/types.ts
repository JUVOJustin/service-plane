import type { Context, MiddlewareHandler } from 'hono';

export const SERVICE_DISCOVERY_PATH = '/.well-known/service-plane/service.json';
export const SERVICE_PLANE_CAPABILITY_JWKS_PATH = '/.well-known/service-plane/jwks.json';
export const SERVICE_PLANE_CAPABILITY_TOKEN_PATH = '/.well-known/service-plane/capability-token';
export const DEFAULT_REGISTRY_CACHE_TTL_SECONDS = 30;
export const DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS = 120;
export const DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS = 300;
export const SERVICE_PLANE_CAPABILITY_CONTEXT = 'servicePlaneCapability';
export const SERVICE_PLANE_CAPABILITY_VERIFIER = 'servicePlaneCapabilityVerifier';
export const SERVICE_PLANE_AUTHORIZATION_SCHEME = 'ServicePlane';

export type ServiceRouteVisibility = 'public' | 'auth' | 'internal';

export type RouteSource = {
  routes: Array<{
    handler?: unknown;
    method: string;
    path: string;
  }>;
};

export type HonoAppLike = RouteSource;

export type ServiceNamespaceDefinition = {
  app: HonoAppLike;
  openapi?: unknown;
  prefix: string;
  visibility: ServiceRouteVisibility;
};

export type ServiceDefinition = {
  capabilities?: CapabilityCatalog;
  id: string;
  namespaces: ServiceNamespaceDefinition[];
  title: string;
  version: string;
};

export type DefineServiceOptions = {
  requireRouteScopes?: boolean;
};

export type ServiceRouteDiscovery = {
  method: string;
  path: string;
  requiredScopes?: string[];
  visibility: ServiceRouteVisibility;
};

export type ServiceDiscoveryDocument = {
  capabilities?: CapabilityCatalog;
  id: string;
  routes: ServiceRouteDiscovery[];
  title: string;
  version: string;
};

export type DiscoveredServiceRoute = ServiceRouteDiscovery & {
  service: ServiceEndpoint;
  serviceId: string;
  serviceTitle: string;
  serviceVersion: string;
};

export type FetchLike = {
  fetch(request: Request): Promise<Response>;
};

export type ServiceEndpoint = {
  fetch(request: Request): Promise<Response>;
  id: string;
  origin: string;
};

export type ServiceRegistrySnapshot = {
  discoveredAt: string;
  routes: DiscoveredServiceRoute[];
  services: ServiceDiscoveryDocument[];
  stale?: boolean;
};

export type ServiceDiscoverySnapshot = {
  discoveredAt: string;
  services: ServiceDiscoveryDocument[];
  stale?: boolean;
};

export type RegistryCache = {
  get(key: string): Promise<ServiceDiscoverySnapshot | undefined>;
  set(key: string, value: ServiceDiscoverySnapshot, ttlSeconds: number): Promise<void>;
};

export type ServiceRegistry = {
  discover(): Promise<ServiceRegistrySnapshot>;
  match(method: string, path: string): Promise<DiscoveredServiceRoute | undefined>;
};

export type CapabilityScopeDefinition = {
  description?: string;
  id: string;
  title?: string;
};

export type CapabilityCatalog = {
  scopes: CapabilityScopeDefinition[];
  serviceId: string;
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

export type CapabilityAuthVariables = {
  Variables: {
    [SERVICE_PLANE_CAPABILITY_CONTEXT]?: CapabilityIdentity;
    [SERVICE_PLANE_CAPABILITY_VERIFIER]?: CapabilityVerifierOptions;
  };
};

export type CapabilityAuthMiddleware = MiddlewareHandler<CapabilityAuthVariables>;

export type CapabilityContextSource = Context<CapabilityAuthVariables>;

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
