export const SERVICE_DISCOVERY_PATH = '/.well-known/service-plane/service.json';
export const SERVICE_PLANE_OPENAPI_PATH = '/openapi.json';
export const SERVICE_PLANE_CAPABILITY_JWKS_PATH = '/.well-known/service-plane/jwks.json';
export const SERVICE_PLANE_CAPABILITY_TOKEN_PATH = '/.well-known/service-plane/capability-token';
export const SERVICE_PLANE_MCP_PATH = '/rpc/mcp';

export const DEFAULT_REGISTRY_CACHE_TTL_SECONDS = 30;
export const DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS = 120;
export const MAX_CAPABILITY_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS = 300;

export const SERVICE_PLANE_AUTHORIZATION_SCHEME = 'ServicePlane';
export const SERVICE_PLANE_REQUEST_ID_HEADER = 'X-Request-Id';
// WebSocket upgrades cannot carry custom headers portably, so request ids ride a query parameter there.
export const SERVICE_PLANE_REQUEST_ID_QUERY_PARAM = 'request_id';

export type AbilityAccess = 'plane' | 'service';
export type AbilityExposure = 'private' | 'published';
export type AbilityTransport = 'cloudflare-binding-rpc' | 'http-batch' | 'websocket';
export type ServiceHttpMethod = 'delete' | 'get' | 'patch' | 'post' | 'put';

export type CapabilityScopeDefinition = {
  description?: string;
  id: string;
  title?: string;
};

export type CapabilityCatalog = {
  scopes: CapabilityScopeDefinition[];
  serviceId: string;
};

export type OpenApiObject = Record<string, unknown>;

export type ServiceAbilityRpcDiscovery = {
  path: string;
  transports: AbilityTransport[];
};

export type ServiceAbilityRestProjection = {
  description?: string;
  method: ServiceHttpMethod;
  operationId?: string;
  path: string;
  summary?: string;
  tags?: string[];
};

export type ServiceAbilityMcpProjection = {
  description?: string;
  name: string;
};

// A `{var}` URI declares a resource template; template variables become the method input.
export type ServiceAbilityMcpResourceProjection = {
  description?: string;
  mimeType?: string;
  name: string;
  title?: string;
  uri: string;
};

export type ServiceAbilityMcpPromptArgument = {
  description?: string;
  name: string;
  required?: boolean;
};

// Prompt arguments default to the method input schema's top-level properties when omitted.
export type ServiceAbilityMcpPromptProjection = {
  arguments?: ServiceAbilityMcpPromptArgument[];
  description?: string;
  name: string;
  title?: string;
};

export type ServiceAbilityMethodDiscovery = {
  inputSchema: OpenApiObject;
  mcp?: ServiceAbilityMcpProjection;
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  mcpResource?: ServiceAbilityMcpResourceProjection;
  outputSchema: OpenApiObject;
  rest?: ServiceAbilityRestProjection;
  scopes: string[];
  // Streaming methods return a ReadableStream of output items over a Cap'n Web session
  // transport; `outputSchema` then describes one streamed item, not the whole response.
  stream?: true;
};

export type ServiceAbilityDiscovery = {
  access: AbilityAccess;
  description?: string;
  exposure: AbilityExposure;
  id: string;
  methods: Record<string, ServiceAbilityMethodDiscovery>;
  rpc: ServiceAbilityRpcDiscovery;
  scopes: string[];
  title?: string;
};

export type ServiceCallerAuthDiscovery = {
  jwks: CapabilityJwks;
};

export type ServiceDiscoveryDocument = {
  abilities: ServiceAbilityDiscovery[];
  callerAuth?: ServiceCallerAuthDiscovery;
  capabilities?: CapabilityCatalog;
  id: string;
  ingress?: ServiceIngressDiscovery;
  title: string;
  version: string;
};

export type FetchLike = {
  fetch(request: Request): Promise<Response>;
};

export type ServiceGrant = {
  caller: string;
  scopes: string[];
  target: string;
};

export type ServiceEndpointGrant = Omit<ServiceGrant, 'target'> & {
  target?: string;
};

export type ServiceGrantDefinition = {
  grants: ServiceGrant[];
};

// Native ability RPC surface a service can expose next to `fetch` (e.g. a Cloudflare
// WorkerEntrypoint forwarding to ServicePlaneService.connectAbility). Session-shaped, so
// streaming method returns flow through it natively.
export type ServiceAbilityNativeRpcBinding = {
  connectAbility(input: {
    abilityId: string;
    requestId?: string;
    token: string;
  }): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type ServiceEndpoint = {
  abilityRpc?: ServiceAbilityNativeRpcBinding;
  discovery?: ServiceDiscoveryDocument | (() => Promise<ServiceDiscoveryDocument> | ServiceDiscoveryDocument);
  fetch(request: Request): Promise<Response>;
  grants?: ServiceEndpointGrant[];
  id: string;
  origin: string;
};

export type DiscoveredServiceAbility = ServiceAbilityDiscovery & {
  service: ServiceEndpoint;
  serviceId: string;
  serviceIngress?: ServiceIngressDiscovery;
  serviceTitle: string;
  serviceVersion: string;
};

export type ServiceIngressDiscovery = {
  required: true;
};

export type ServiceDiscoverySnapshot = {
  discoveredAt: string;
  etags?: Record<string, string>;
  services: ServiceDiscoveryDocument[];
  stale?: boolean;
};

export type ServiceRegistrySnapshot = ServiceDiscoverySnapshot & {
  abilities: DiscoveredServiceAbility[];
};

export type RegistryCache = {
  get(key: string): Promise<ServiceDiscoverySnapshot | undefined>;
  getStale?(key: string): Promise<ServiceDiscoverySnapshot | undefined>;
  set(key: string, value: ServiceDiscoverySnapshot, ttlSeconds: number): Promise<void>;
};

export type ServiceRegistry = {
  abilities(): Promise<DiscoveredServiceAbility[]>;
  ability(serviceId: string, abilityId: string): Promise<DiscoveredServiceAbility | undefined>;
  discover(): Promise<ServiceRegistrySnapshot>;
  endpoint(id: string): ServiceEndpoint | undefined;
};

export type OpenApiDocument = {
  components?: OpenApiObject;
  info: {
    description?: string;
    title: string;
    version: string;
  };
  openapi: '3.1.0';
  paths: Record<string, Record<string, OpenApiObject>>;
  servers?: OpenApiObject[];
  tags?: Array<{ description?: string; name: string }>;
};

export type OpenApiDocumentCache = {
  get(key: string): Promise<OpenApiDocument | undefined>;
  set(key: string, value: OpenApiDocument, ttlSeconds: number): Promise<void>;
};

// Spec-shaped MCP projections: only `_meta` carries Service-Plane routing data so stock clients see standard objects.
export type McpServicePlaneMeta = {
  servicePlane: {
    abilityId: string;
    method: string;
    scopes: string[];
    serviceId: string;
    // The projected method streams; tools/call answers over SSE per MCP Streamable HTTP.
    stream?: true;
  };
};

export type McpToolDiscovery = {
  _meta: McpServicePlaneMeta;
  description?: string;
  inputSchema: OpenApiObject;
  name: string;
  outputSchema: OpenApiObject;
};

export type McpResourceDiscovery = {
  _meta: McpServicePlaneMeta;
  description?: string;
  mimeType?: string;
  name: string;
  title?: string;
  uri: string;
};

export type McpResourceTemplateDiscovery = {
  _meta: McpServicePlaneMeta;
  description?: string;
  mimeType?: string;
  name: string;
  title?: string;
  uriTemplate: string;
};

export type McpPromptDiscovery = {
  _meta: McpServicePlaneMeta;
  arguments?: ServiceAbilityMcpPromptArgument[];
  description?: string;
  name: string;
  title?: string;
};

export type McpDiscoveryDocument = {
  prompts: McpPromptDiscovery[];
  resourceTemplates: McpResourceTemplateDiscovery[];
  resources: McpResourceDiscovery[];
  tools: McpToolDiscovery[];
};

// Control-plane-verified end-user delegation following RFC 8693: on delegated tokens `sub` is the
// end user the call is made on behalf of, `act` names the acting service, and `spo` carries the
// subject's org. Attribution for audit and per-user decisions; never a substitute for scope or
// grant authorization.
export type CapabilitySubject = {
  id: string;
  orgId?: string;
};

export type CapabilityActorClaim = {
  sub: string;
};

export type CapabilityClaims = {
  act?: CapabilityActorClaim;
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  scp: string[];
  spb?: string;
  spo?: string;
  sub: string;
};

export type CapabilityIdentity = {
  audience: string;
  brokerServiceId?: string;
  expiresAt: Date;
  issuer: string;
  scopes: string[];
  serviceId: string;
  subject?: CapabilitySubject;
  tokenId: string;
};

export type CapabilityJwks = {
  keys: Array<JsonWebKey & { kid?: string }>;
};

export type CapabilityJwksResolver = CapabilityJwks | (() => Promise<CapabilityJwks> | CapabilityJwks);

export type CapabilityJwksCacheEntry = {
  expiresAt: Date | string;
  jwks: CapabilityJwks;
};

export type CapabilityJwksCache = {
  get(key: string): Promise<CapabilityJwksCacheEntry | undefined>;
  set(key: string, value: CapabilityJwksCacheEntry, ttlSeconds: number): Promise<void>;
};

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
  subject?: CapabilitySubject;
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
