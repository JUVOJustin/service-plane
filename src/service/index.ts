export {
  defineNamespace,
  defineService,
  mountDiscovery,
  serviceDiscoveryDocument,
} from './discovery.js';
export {
  machineAuth,
  machineIdentity,
  verifyMachineRequest,
} from './auth.js';
export {
  DEFAULT_MAX_SKEW_SECONDS,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_BODY_SHA256_HEADER,
  SERVICE_PLANE_KEY_ID_HEADER,
  SERVICE_PLANE_SIGNATURE_HEADER,
  SERVICE_PLANE_TIMESTAMP_HEADER,
} from '../shared/types.js';
export type {
  HonoAppLike,
  MachineAuthContext,
  MachineAuthMiddleware,
  MachineSecretResolver,
  ServiceDefinition,
  ServiceDiscoveryDocument,
  ServiceNamespaceDefinition,
  ServiceRouteDiscovery,
  ServiceRouteVisibility,
  VerifyMachineRequestOptions,
} from '../shared/types.js';
