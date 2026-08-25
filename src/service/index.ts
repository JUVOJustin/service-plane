export { isDefinedError, ORPCError, safe } from '@orpc/client';
export type {
  BatchLinkPluginOptions,
  DedupeLinkPluginOptions,
  RequestCompressionLinkPluginOptions,
  ResponseCompressionLinkPluginOptions,
  RetryLinkPluginOptions,
} from '@orpc/client/plugins';
export {
  BatchLinkPlugin,
  DedupeLinkPlugin,
  RequestCompressionLinkPlugin,
  ResponseCompressionLinkPlugin,
  RetryLinkPlugin,
} from '@orpc/client/plugins';
export type { EncodeHibernationRPCEventOptions } from '@orpc/hibernation';
export {
  HibernationAsyncIteratorClass,
  HibernationHandlerPlugin,
} from '@orpc/hibernation';
export type {
  BatchHandlerPluginOptions,
  ResponseCompressionHandlerPluginOptions,
} from '@orpc/server/plugins';
export {
  BatchHandlerPlugin,
  RequestCompressionHandlerPlugin,
  ResponseCompressionHandlerPlugin,
} from '@orpc/server/plugins';
export { type ConnInfo, SERVICE_PLANE_CONN_INFO_HEADER, SERVICE_PLANE_CONN_INFO_QUERY_PARAM } from '../shared/conn-info.js';
export {
  DEFAULT_ABILITY_TIMEOUT_MS,
  MAX_SERVICE_PLANE_TIMEOUT_MS,
  SERVICE_PLANE_TIMEOUT_GRACE_MS,
  SERVICE_PLANE_TIMEOUT_HEADER,
  SERVICE_PLANE_TIMEOUT_QUERY_PARAM,
  type ServicePlaneTimeoutPolicy,
} from '../shared/deadline.js';
export {
  AbilityHandlerError,
  type AbilityHandlerErrorOptions,
  AbilityValidationError,
  type AbilityValidationIssue,
  CapabilityAuthError,
  handlerFailureCause,
  ServicePlaneError,
  type ServicePlaneErrorCode,
  type ServicePlaneErrorInfo,
  type ServicePlaneErrorOptions,
  ServicePlaneTimeoutError,
  servicePlaneErrorInfo,
} from '../shared/errors.js';
export {
  DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS,
  DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS,
  type ServicePlaneHttpCacheOption,
  type ServicePlaneHttpCacheOptions,
  servicePlaneHttpCacheHeaders,
} from '../shared/http-cache.js';
export {
  normalizeIdempotencyKey,
  SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER,
  SERVICE_PLANE_IDEMPOTENCY_KEY_QUERY_PARAM,
} from '../shared/idempotency.js';
export {
  defaultServicePlaneLogSink,
  type ServicePlaneLoggableEvent,
  type ServicePlaneLogSink,
} from '../shared/logging.js';
export type {
  AbilityAccess,
  AbilityExposure,
  AbilityTransport,
  CapabilityCatalog,
  CapabilityIdentity,
  CapabilityJwks,
  CapabilityJwksCache,
  CapabilityJwksCacheEntry,
  CapabilityJwksResolver,
  CapabilityScopeDefinition,
  CapabilitySubject,
  CapabilityTokenCache,
  CapabilityTokenCacheEntry,
  CapabilityTokenProvider,
  CapabilityVerifierOptions,
  FetchLike,
  IssueCapabilityTokenInput,
  IssuedCapabilityToken,
  McpDiscoveryDocument,
  McpPromptDiscovery,
  McpResourceDiscovery,
  McpResourceTemplateDiscovery,
  McpServicePlaneMeta,
  McpToolDiscovery,
  OpenApiObject,
  ServiceAbilityDiscovery,
  ServiceAbilityMcpProjection,
  ServiceAbilityMcpPromptArgument,
  ServiceAbilityMcpPromptProjection,
  ServiceAbilityMcpResourceProjection,
  ServiceAbilityMethodDiscovery,
  ServiceAbilityRestProjection,
  ServiceCallerAuthDiscovery,
  ServiceDiscoveryDocument,
  ServiceHttpMethod,
  ServiceIngressDiscovery,
} from '../shared/types.js';
export {
  DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_MCP_PATH,
  SERVICE_PLANE_OPENAPI_PATH,
  SERVICE_PLANE_PROOF_HEADER,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  SERVICE_PLANE_REQUEST_ID_QUERY_PARAM,
} from '../shared/types.js';
export {
  type GenerateServiceCallerSigningJwkOptions,
  generateServiceCallerSigningJwk,
  publicJwkFromServiceCallerSigningJwk,
} from './caller-auth.js';
export type {
  CapabilityProofSigner,
  CapabilityTokenRequester,
  ControlPlaneHmacTokenRequesterOptions,
  ControlPlaneJwkTokenRequesterOptions,
  ControlPlaneRpcCallerTokenBinding,
  ControlPlaneRpcTokenBinding,
  ControlPlaneRpcTokenRequesterOptions,
  CreateCapabilityTokenProviderOptions,
  JwkCapabilityProofSignerOptions,
  JwksFromServiceBindingOptions,
  JwksFromUrlOptions,
  RemoteJwksFetch,
} from './capabilities.js';
export {
  capabilityTokenCacheKey,
  controlPlaneHmacTokenRequester,
  controlPlaneJwkTokenRequester,
  controlPlaneRpcTokenRequester,
  createCapabilityTokenProvider,
  defineCapabilities,
  jwkCapabilityProofSigner,
  jwksFromServiceBinding,
  jwksFromUrl,
  tokenExpiresAt,
  verifyAuthenticationToken,
} from './capabilities.js';
export type {
  AbilityClientTransport,
  AbilityNativeBinding,
  BrokeredAbilityTransport,
  CreateAbilityClientOptions,
  CreateBrokeredAbilityClientOptions,
  NativeAbilityCall,
} from './client.js';
export { createAbilityClient, createBrokeredAbilityClient } from './client.js';
export type {
  AbilityProcedureDefinitions,
  AbilityRpc,
  AbilitySchema,
  AnyServiceAbilityDefinition,
  DefineServiceInput,
  DefineServiceOptions,
  NormalizedAbilityMethodDefinition,
  NormalizedServiceAbility,
  OrpcServiceAbilityDefinition,
  ServiceAbilityDefinition,
  ServiceAbilityWebSocket,
  ServiceDefinition,
} from './discovery.js';
export {
  defaultAbilityRpcPath,
  defineAbility,
  defineAbilityService,
  serviceDiscoveryDocument,
} from './discovery.js';
export {
  type ServicePlaneLogEvent,
  type ServicePlaneLoggerOptions,
  type ServicePlaneLogLevel,
  type ServicePlaneLogVariables,
  servicePlaneLogEvents,
  servicePlaneLogger,
} from './logger.js';
export type {
  AbilityHibernationStream,
  AbilityProcedureContext,
  AbilityProcedureMetadata,
  AuthorizeAbilityProcedureInput,
} from './orpc.js';
export { createAbilityBuilder, encodeAbilityHibernationEvent } from './orpc.js';
export {
  ServicePlaneService,
  type ServicePlaneServiceAuthOptions,
  type ServicePlaneServiceIngressOptions,
  type ServicePlaneServiceOptions,
} from './service.js';
