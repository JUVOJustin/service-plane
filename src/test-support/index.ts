// Internal test harness. Not part of the published surface — `src/testing` is what consumers get.
// Excluded from the build in tsconfig.json, still typechecked by tsconfig.test.json.
export {
  DEMO_CALLER_ID,
  DEMO_CONTROL_PLANE_ID,
  DEMO_PLANE_ISSUER,
  DEMO_PLANE_ORIGIN,
  DEMO_SIGNING_KEY_ID,
  type DemoApp,
  type DemoAppOptions,
  type DemoBrokerRoot,
  type DemoReplica,
  type DemoReplicaSpec,
  type DemoService,
  type DemoServiceOptions,
  type DemoServiceSpec,
  demoApp,
  demoReplicaOrigin,
  demoService,
  demoSigningKey,
} from './app.js';
export {
  type DemoEndpointInput,
  type DemoEnvironment,
  type DemoEnvironmentName,
  type DemoServiceHost,
  demoEnvironments,
  httpBatchEnv,
  nativeRpcEnv,
  websocketEnv,
} from './env.js';
export { type TestKeys, testKeys } from './keys.js';
export { drainStream } from './streams.js';
