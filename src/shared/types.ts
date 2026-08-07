import type { ConnInfo } from './conn-info.js';

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
/**
 * WebSocket upgrades cannot carry custom headers portably, so request ids ride a query parameter there.
 */
export const SERVICE_PLANE_REQUEST_ID_QUERY_PARAM = 'request_id';

export type AbilityAccess = 'plane' | 'service';

/**
 * The one membership test for `AbilityAccess`. Registry validation, discovery normalization, token
 * issuance, and claim parsing all gate on this union; a single predicate next to the type keeps a
 * future widening from needing four synchronized hand-written checks.
 */
export function isAbilityAccess(value: unknown): value is AbilityAccess {
  return value === 'plane' || value === 'service';
}
export type AbilityExposure = 'private' | 'published';
export type AbilityTransport = 'cloudflare-binding-rpc' | 'http-batch' | 'websocket';
/**
 * `query` is the HTTP QUERY method (RFC 10008): a safe, idempotent request that carries its
 * parameters in a body. OpenAPI 3.2 gives it a fixed `query` field on the Path Item Object,
 * and Hono 4.13+ routes it first-class (`app.query()`), which is why hono >=4.13 is the peer floor.
 */
export type ServiceHttpMethod = 'delete' | 'get' | 'patch' | 'post' | 'put' | 'query';

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

/**
 * A `{var}` URI declares a resource template; template variables become the method input.
 */
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

/**
 * Prompt arguments default to the method input schema's top-level properties when omitted.
 */
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
  /**
   * The method is safe to call again with the same input: a retry after an ambiguous failure
   * cannot double its effect. Advertised so callers and gateways can decide whether retrying is
   * safe — this package never retries on its own.
   */
  idempotent?: true;
  scopes: string[];
  /**
   * Streaming methods return a ReadableStream of output items over a Cap'n Web session
   * transport; `outputSchema` then describes one streamed item, not the whole response.
   */
  stream?: true;
  /**
   * How long this method may run, in milliseconds, independent of any caller budget. Advertised so
   * a gateway can size its own wait against it. Absent on streaming methods, which are not bounded
   * this way.
   */
  timeoutMs?: number;
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

/**
 * Native ability RPC surface a service can expose next to `fetch` (e.g. a Cloudflare
 * WorkerEntrypoint forwarding to ServicePlaneService.connectAbility). Session-shaped, so
 * streaming method returns flow through it natively.
 */
export type ServiceAbilityNativeRpcBinding = {
  connectAbility(input: {
    abilityId: string;
    connInfo?: ConnInfo;
    /**
     * The caller's key for this attempt, surfaced to handlers as `idempotencyKey`.
     */
    idempotencyKey?: string;
    requestId?: string;
    /**
     * Milliseconds of the caller's budget. Native binding sessions are opened once and cached, so
     * this bounds the whole session, not each call on it.
     */
    timeoutMs?: number;
    token: string;
  }): Promise<object> | object;
};

export type ServiceEndpoint = {
  abilityRpc?: ServiceAbilityNativeRpcBinding;
  createWebSocket?: (url: string) => WebSocket;
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
  openapi: '3.2.0';
  paths: Record<string, Record<string, OpenApiObject>>;
  servers?: OpenApiObject[];
  tags?: Array<{ description?: string; name: string }>;
};

export type OpenApiDocumentCache = {
  get(key: string): Promise<OpenApiDocument | undefined>;
  set(key: string, value: OpenApiDocument, ttlSeconds: number): Promise<void>;
};

/**
 * Spec-shaped MCP projections: only `_meta` carries Service-Plane routing data so stock clients see standard objects.
 */
export type McpServicePlaneMeta = {
  servicePlane: {
    abilityId: string;
    method: string;
    scopes: string[];
    serviceId: string;
    /**
     * The projected method streams; tools/call answers over SSE per MCP Streamable HTTP.
     */
    stream?: true;
  };
};

export type McpToolDiscovery = {
  _meta: McpServicePlaneMeta;
  description?: string;
  inputSchema: OpenApiObject;
  name: string;
  /**
   * MCP structured tool output is object-shaped. Primitive/array ability outputs are returned as
   * text content and intentionally do not advertise an incompatible output schema.
   */
  outputSchema?: OpenApiObject;
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

/**
 * Control-plane-verified end-user delegation following RFC 8693: on delegated tokens `sub` is the
 * end user the call is made on behalf of, `act` names the acting service, and `spo` carries the
 * subject's org. Attribution for audit and per-user decisions; never a substitute for scope or
 * grant authorization.
 */
export type CapabilitySubject = {
  id: string;
  orgId?: string;
};

export type CapabilityActorClaim = {
  sub: string;
};

/**
 * RFC 7800 `cnf` (confirmation) claim: the issuer states which key the presenter must prove it holds.
 * RFC 7800 itself defines jwk/jwe/jku/kid; `jkt` is the JWK SHA-256 thumbprint (RFC 7638) registered
 * as a confirmation method by RFC 9449 (DPoP). Only `jkt` is supported here — it is 32 bytes and the
 * proof carries the public key, so a service needs no key distribution to verify one.
 */
export type CapabilityConfirmation = {
  jkt: string;
};

export type CapabilityClaims = {
  act?: CapabilityActorClaim;
  aud: string;
  cnf?: CapabilityConfirmation;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  nbf: number;
  scp: string[];
  /**
   * Service Plane-specific: the access class the control plane authenticated for the caller. Optional
   * on the wire only so a token from a control plane that predates the claim still verifies — it then
   * reads as `plane`, the class that can reach the least.
   */
  spa?: AbilityAccess;
  spb?: string;
  spo?: string;
  sub: string;
};

export type CapabilityIdentity = {
  audience: string;
  brokerServiceId?: string;
  /**
   * The access class the control plane vouched for: `service` when it authenticated the caller as
   * another service, `plane` for every caller it fronts itself — end users, API keys, anonymous.
   * Abilities declared `access: 'service'` accept only `service`, and a token carrying no such claim
   * reads as `plane`, so an unattested caller is never mistaken for a service.
   */
  callerAccess: AbilityAccess;
  /**
   * Present when the token is sender-constrained. A verified identity only ever carries this after a
   * matching proof of possession was checked, so handlers can treat it as proof the caller was present.
   */
  confirmation?: CapabilityConfirmation;
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
  /**
   * Required to check a proof of possession, because a proof is bound to the ability whose session it
   * opens. A sender-constrained token presented without both of these is rejected.
   */
  abilityId?: string;
  expectedAudience: string;
  issuer?: string;
  jwks: CapabilityJwksResolver;
  now?: Date;
  proof?: string;
  requiredScopes?: string[];
};

export type CapabilityVerifierOptions = Omit<VerifyCapabilityTokenOptions, 'requiredScopes'>;

export type IssueCapabilityTokenInput = {
  callerServiceId: string;
  /**
   * Binds the issued token to a caller key. Set by the plane from the key that actually authenticated
   * the request, never by the caller — a caller-chosen confirmation would bind a key of its choosing.
   */
  confirmation?: CapabilityConfirmation;
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
