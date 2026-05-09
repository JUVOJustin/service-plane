import type { Context, Hono, MiddlewareHandler } from 'hono';

export const SERVICE_DISCOVERY_PATH = '/.well-known/service-plane/service.json';
export const SERVICE_PLANE_KEY_ID_HEADER = 'Service-Plane-Key-Id';
export const SERVICE_PLANE_TIMESTAMP_HEADER = 'Service-Plane-Timestamp';
export const SERVICE_PLANE_BODY_SHA256_HEADER = 'Service-Plane-Body-Sha256';
export const SERVICE_PLANE_SIGNATURE_HEADER = 'Service-Plane-Signature';
export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const DEFAULT_REGISTRY_CACHE_TTL_SECONDS = 30;
export const SERVICE_PLANE_AUTH_CONTEXT = 'servicePlaneMachine';

export type ServiceRouteVisibility = 'public' | 'auth' | 'internal';

export type RouteSource = {
  routes: Array<{
    method: string;
    path: string;
  }>;
};

export type HonoAppLike = Pick<Hono, 'fetch' | 'get'> & RouteSource;

export type ServiceNamespaceDefinition = {
  app: HonoAppLike;
  openapi?: unknown;
  prefix: string;
  visibility: ServiceRouteVisibility;
};

export type ServiceDefinition = {
  id: string;
  namespaces: ServiceNamespaceDefinition[];
  title: string;
  version: string;
};

export type ServiceRouteDiscovery = {
  method: string;
  path: string;
  visibility: ServiceRouteVisibility;
};

export type ServiceDiscoveryDocument = {
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

export type MachineSecretResolver = (keyId: string, request: Request) => Promise<string | undefined> | string | undefined;

export type SignMachineRequestOptions = {
  keyId?: string;
  now?: Date;
  secret: string;
};

export type VerifyMachineRequestOptions = {
  maxSkewSeconds?: number;
  now?: Date;
  resolveSecret: MachineSecretResolver;
};

export type MachineAuthContext = {
  bodySha256: string;
  keyId: string;
  timestamp: string;
};

export type MachineAuthVariables = {
  Variables: {
    [SERVICE_PLANE_AUTH_CONTEXT]?: MachineAuthContext;
  };
};

export type MachineAuthMiddleware = MiddlewareHandler<MachineAuthVariables>;

export type MachineAuthContextSource = Context<MachineAuthVariables>;
