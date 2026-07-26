// Internal test harness. Not part of the published surface — `src/testing` is what consumers get.
// Excluded from the build in tsconfig.json, still typechecked by tsconfig.test.json.
export {
  DEMO_CALLER_ID,
  DEMO_CONTROL_PLANE_ID,
  DEMO_PLANE_ISSUER,
  DEMO_PLANE_ORIGIN,
  type DemoApp,
  type DemoAppOptions,
  type DemoBrokerRoot,
  type DemoService,
  type DemoServiceOptions,
  type DemoServiceSpec,
  demoApp,
  demoService,
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
