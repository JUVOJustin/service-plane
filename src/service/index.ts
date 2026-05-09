export {
  capability,
  capabilityAuth,
  capabilityFetch,
  capabilityIdentity,
  capabilityTokenCacheKey,
  createCapabilityTokenProvider,
  defineCapabilities,
  serviceCapabilities,
  tokenExpiresAt,
  verifyCapabilityToken,
  withCapabilityAuthorization,
} from './capabilities.js';
export type {
  CapabilityFetchOptions,
  CapabilityFetchWithProviderOptions,
  CreateCapabilityTokenProviderOptions,
} from './capabilities.js';
export {
  defineNamespace,
  defineService,
  mountDiscovery,
  serviceDiscoveryDocument,
} from './discovery.js';
export {
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_CAPABILITY_CONTEXT,
  SERVICE_PLANE_CAPABILITY_VERIFIER,
} from '../shared/types.js';
export type {
  CapabilityAuthMiddleware,
  CapabilityCatalog,
  CapabilityContextSource,
  CapabilityIdentity,
  CapabilityJwks,
  CapabilityJwksResolver,
  CapabilityScopeDefinition,
  CapabilityTokenCache,
  CapabilityTokenCacheEntry,
  CapabilityTokenProvider,
  CapabilityVerifierOptions,
  DefineServiceOptions,
  HonoAppLike,
  IssueCapabilityTokenInput,
  IssuedCapabilityToken,
  ServiceDefinition,
  ServiceDiscoveryDocument,
  ServiceNamespaceDefinition,
  ServiceRouteDiscovery,
  ServiceRouteVisibility,
} from '../shared/types.js';
