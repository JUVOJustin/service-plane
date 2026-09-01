// Typechecks the built public declarations as a consumer that has only the documented peer and
// schema dependency available. Keeping the private RPC engine out of this fixture makes a leaked
// oRPC declaration fail even when the repository's own devDependencies would hide it.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'service-plane-type-consumer-'));

try {
  const fixtureModules = join(fixture, 'node_modules');
  const fixturePackage = join(fixtureModules, 'service-plane');
  await mkdir(fixturePackage, { recursive: true });
  await cp(join(root, 'dist'), join(fixturePackage, 'dist'), { recursive: true });
  await writeFile(join(fixturePackage, 'package.json'), await readFile(join(root, 'package.json')));

  await symlink(join(root, 'node_modules', 'hono'), join(fixtureModules, 'hono'), 'junction');
  await mkdir(join(fixtureModules, '@standard-schema'), { recursive: true });
  await symlink(join(root, 'node_modules', '@standard-schema', 'spec'), join(fixtureModules, '@standard-schema', 'spec'), 'junction');

  await writeFile(
    join(fixture, 'consumer.ts'),
    `import { ServicePlaneControlPlane as RootControlPlane } from 'service-plane';
import {
  type BrokerCaller,
  type ControlPlaneAbilityClientOptions,
  type ControlPlaneMcpInvocation,
  type ServiceGrant,
  ServicePlaneControlPlane,
} from 'service-plane/control-plane';
import {
  type AbilityImplementation,
  type AbilityMethodDefinitions,
  type AbilityMethodEnvironment,
  type AbilitySchema,
  type AnyAbilityMethodDefinition,
  type AnyServiceAbilityDefinition,
  type CreateAbilityClientOptions,
  type CreateBrokeredAbilityClientOptions,
  type CreateCapabilityTokenProviderOptions,
  type DefineServiceInput,
  type IssueCapabilityTokenInput,
  type NormalizedAbilityMethodDefinition,
  type ReadonlyOpenApiObject,
  ServicePlaneService,
  capabilityTokenCacheKey,
  createAbilityBuilder,
  defineAbility,
  defineCapabilities,
  implementAbility,
} from 'service-plane/service';

type ConsumerEnv = { Bindings: { SIGNING_SECRET: string } };
type RequiredServiceEnv = { Bindings: { CONTROL_PLANE: { fetch(request: Request): Promise<Response> } } };
type ServiceEnv = { Bindings: RequiredServiceEnv['Bindings'] & { EXTRA: string } };
type WrongEnv = { Bindings: { OTHER: string } };
type Expect<T extends true> = T;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;
type ReadonlySchemaIndexIncludesUndefined = Expect<undefined extends ReadonlyOpenApiObject[string] ? true : false>;
declare const schema: AbilitySchema;
declare const ordinaryUnknown: unknown;
if (Array.isArray(ordinaryUnknown)) ordinaryUnknown.push('ordinary arrays remain mutable');
declare const mcpInvocation: ControlPlaneMcpInvocation;
// @ts-expect-error MCP observation metadata cannot widen the scopes used for dispatch.
mcpInvocation.scopes.push('admin');

const portableBuilder = createAbilityBuilder();
const portableContract = defineAbility({
  id: 'portable',
  methods: { read: portableBuilder.method({ input: schema, output: schema, scopes: ['portable.read'] }) },
  scopes: ['portable.read'],
});
const readonlyContractScopes = portableContract.scopes ?? [];
const directScopesOption = { scopes: readonlyContractScopes } satisfies Pick<
  CreateAbilityClientOptions<typeof portableContract>,
  'scopes'
>;
const brokeredScopesOption = { scopes: readonlyContractScopes } satisfies Pick<
  CreateBrokeredAbilityClientOptions<typeof portableContract>,
  'scopes'
>;
const controlPlaneScopesOption = { scopes: readonlyContractScopes } satisfies Pick<
  ControlPlaneAbilityClientOptions<typeof portableContract>,
  'scopes'
>;
const providerScopesOption = { scopes: readonlyContractScopes } satisfies Pick<CreateCapabilityTokenProviderOptions, 'scopes'>;
const issueScopesOption = { scopes: readonlyContractScopes } satisfies Pick<IssueCapabilityTokenInput, 'scopes'>;
const grantScopesOption = { scopes: readonlyContractScopes } satisfies Pick<ServiceGrant, 'scopes'>;
const readonlyScopesCacheKey = capabilityTokenCacheKey({
  callerServiceId: 'consumer',
  scopes: readonlyContractScopes,
  targetServiceId: 'portable-service',
});
const portableImplementation = implementAbility(portableContract, { read: ({ input }) => input });
type PortableContractMountsInSpecificEnv = Expect<
  typeof portableImplementation extends AnyServiceAbilityDefinition<ServiceEnv> ? true : false
>;

const boundBuilder = createAbilityBuilder<RequiredServiceEnv>();
const boundContract = defineAbility({
  id: 'bound',
  methods: {
    read: boundBuilder.method({
      input: schema,
      output: schema,
      scopes: ['bound.read'],
    }),
  },
  scopes: ['bound.read'],
});
const boundHandlers: AbilityImplementation<typeof boundContract.methods> = {
  read: ({ context, input }) => context.env.CONTROL_PLANE.fetch(new Request(String(input))),
};
const boundImplementation = implementAbility(boundContract, boundHandlers);
type BindingRequirementsRemainEnforced = Expect<
  typeof boundImplementation extends AnyServiceAbilityDefinition<WrongEnv> ? false : true
>;
type ExtractedBindingEnvironment = Expect<Equal<AbilityMethodEnvironment<typeof boundContract.methods.read>, RequiredServiceEnv>>;
type BoundMethodMatchesAnyMethod = Expect<
  typeof boundImplementation.methods.read extends AnyAbilityMethodDefinition ? true : false
>;
type BoundMethodsMatchAnyMethods = Expect<
  typeof boundImplementation.methods extends AbilityMethodDefinitions ? true : false
>;

const serviceEnvBuilder = createAbilityBuilder<ServiceEnv>();
const serviceEnvMethod = serviceEnvBuilder.method({ input: schema, output: schema });
const serviceEnvContract = defineAbility({ id: 'service-env', methods: { read: serviceEnvMethod } });
const widenedAbilityView: AnyServiceAbilityDefinition<ServiceEnv> = boundImplementation;
// @ts-expect-error A contravariant view must not inject a handler requiring a narrower environment.
widenedAbilityView.methods.extra = serviceEnvMethod;
// @ts-expect-error The method container itself is immutable for the same reason.
widenedAbilityView.methods = serviceEnvContract.methods;
const widenedMethodView: AnyAbilityMethodDefinition<ServiceEnv> = boundContract.methods.read;
// @ts-expect-error A widened method view must not rewrite the original schema contract.
widenedMethodView.input = schema;
// @ts-expect-error A widened method view must not change unary execution into streaming.
widenedMethodView.kind = 'stream';
// @ts-expect-error Method policy is immutable after construction.
widenedMethodView.metadata = { scopes: [] };
// @ts-expect-error Method scope policy is deeply readonly.
widenedMethodView.metadata.scopes?.splice(0);
// @ts-expect-error A widened method view must not rewrite the original output schema.
widenedMethodView.output = schema;

const serviceEnvHandlers: AbilityImplementation<typeof serviceEnvContract.methods> = boundHandlers;
// @ts-expect-error A contravariant handler-map view must not replace a broadly safe handler.
serviceEnvHandlers.read = ({ context }) => context.env.EXTRA;

const boundServiceInput: DefineServiceInput<RequiredServiceEnv> = {
  abilities: [boundImplementation],
  id: 'bound-input',
  title: 'Bound input',
  version: '1.0.0',
};
const widenedServiceInput: DefineServiceInput<ServiceEnv> = boundServiceInput;
// @ts-expect-error A contravariant service-input view must not append a narrower ability.
widenedServiceInput.abilities.push(serviceEnvContract);

const service = new ServicePlaneService<ServiceEnv>({
  abilities: [portableImplementation, boundImplementation],
  auth: { issuer: 'control-plane', jwks: { keys: [] } },
  callerAuth: { jwks: { keys: [{ key_ops: ['verify'], kid: 'caller', kty: 'EC' }] } },
  capabilities: defineCapabilities({
    serviceId: 'consumer-service',
    scopes: [{ id: 'portable.read' }, { id: 'bound.read' }],
  }),
  id: 'consumer-service',
  logger: false,
  title: 'Consumer Service',
  version: '1.0.0',
});
const normalizedBoundMethod = service.definition.abilities[1]!.methods.read!.method;
type NormalizedBindingRequirementsRemainEnforced = Expect<
  typeof normalizedBoundMethod extends AnyAbilityMethodDefinition<WrongEnv> ? false : true
>;
const normalizedBound = service.definition.abilities[1]!.methods.read!;
const widenedNormalized: NormalizedAbilityMethodDefinition<
  typeof normalizedBound.input,
  typeof normalizedBound.output,
  ServiceEnv
> = normalizedBound;
// @ts-expect-error A normalized contravariant view must not replace the retained handler contract.
widenedNormalized.method = serviceEnvMethod;
// @ts-expect-error Normalized service definitions expose an immutable ability collection.
service.definition.abilities.push(serviceEnvContract);
const liveAbility = service.definition.abilities[1]!;
// @ts-expect-error Live access policy cannot be weakened after service construction.
liveAbility.access = 'plane';
// @ts-expect-error Live RPC paths cannot diverge from mounted Hono routes.
liveAbility.rpc.path = '/changed';
// @ts-expect-error Live transport declarations cannot enable an unmounted transport.
liveAbility.rpc.transports.push('service-binding');
// @ts-expect-error Live ability scopes cannot be removed after validation.
liveAbility.scopes.splice(0);
// @ts-expect-error Live method scopes cannot be removed after validation.
normalizedBound.scopes.splice(0);
// @ts-expect-error Normalized schemas cannot diverge from the compiled method contract.
normalizedBound.input = schema;
// @ts-expect-error Generated JSON Schema snapshots are readonly like the normalized contract.
normalizedBound.inputSchema.type = 'string';
const normalizedRequired = normalizedBound.inputSchema.required;
if (Array.isArray(normalizedRequired)) {
  const firstRequiredValue = normalizedRequired[0];
  normalizedRequired.map((value) => value);
  // @ts-expect-error Deep-frozen JSON Schema arrays remain immutable after Array.isArray narrowing.
  normalizedRequired.push('changed');
  void firstRequiredValue;
}
// @ts-expect-error Normalized REST projection policy cannot diverge from mounted routes.
normalizedBound.rest!.path = '/changed';
// @ts-expect-error Capability catalogs attached to the live service are immutable snapshots.
service.definition.capabilities!.scopes.splice(0);
const liveCallerKey = service.definition.callerAuth!.jwks.keys[0]!;
// @ts-expect-error Caller-auth keys attached to the live service are immutable snapshots.
liveCallerKey.kid = 'changed';
// @ts-expect-error Nested JWK collections are immutable like their frozen runtime value.
liveCallerKey.key_ops?.push('sign');
const remountedNormalizedContract = defineAbility({
  id: 'remounted-bound',
  methods: { read: normalizedBoundMethod },
});
new ServicePlaneService<WrongEnv>({
  // @ts-expect-error A normalized method must retain the environment required by its handler.
  abilities: [remountedNormalizedContract],
  auth: { jwks: { keys: [] } },
  id: 'wrong-service',
  logger: false,
  requireAbilityScopes: false,
  title: 'Wrong Service',
  version: '1.0.0',
});
declare const nativeInput: Parameters<typeof service.invokeAbility>[0];
declare const webSocket: Parameters<typeof service.webSocketMessage>[1];
const serviceBindings: ServiceEnv['Bindings'] = {
  CONTROL_PLANE: { fetch: async () => new Response() },
  EXTRA: 'consumer',
};
void service.invokeAbility(nativeInput, serviceBindings);
void service.webSocketMessage('bound', webSocket, 'message', serviceBindings);
// @ts-expect-error A service whose handlers require bindings cannot run native RPC without them.
void service.invokeAbility(nativeInput);
// @ts-expect-error Manual WebSocket delivery must receive the environment promised to handlers.
void service.webSocketMessage('bound', webSocket, 'message');
const caller = { id: 'consumer', kind: 'user' } satisfies BrokerCaller;
const plane = new ServicePlaneControlPlane<ConsumerEnv>({
  broker: false,
  invocationMiddleware: async (context, next) => {
    context.set('servicePlaneCaller', caller);
    await next();
  },
  services: () => [],
  signingKeys: (bindings) => [{ kid: 'consumer', secret: bindings.SIGNING_SECRET }],
});
void RootControlPlane;
void plane;
void service;
void directScopesOption;
void brokeredScopesOption;
void controlPlaneScopesOption;
void providerScopesOption;
void issueScopesOption;
void grantScopesOption;
void readonlyScopesCacheKey;
void (undefined as unknown as PortableContractMountsInSpecificEnv);
void (undefined as unknown as BindingRequirementsRemainEnforced);
void (undefined as unknown as ExtractedBindingEnvironment);
void (undefined as unknown as BoundMethodMatchesAnyMethod);
void (undefined as unknown as BoundMethodsMatchAnyMethods);
void (undefined as unknown as NormalizedBindingRequirementsRemainEnforced);
`,
  );
  await writeFile(
    join(fixture, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );

  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'], {
    cwd: fixture,
    stdio: 'inherit',
  });
  console.log('public declaration smoke ok: root, service, and control-plane entrypoints');
} finally {
  await rm(fixture, { force: true, recursive: true });
}
