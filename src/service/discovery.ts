import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { Env } from 'hono';
import type { ConnInfo } from '../shared/conn-info.js';
import { DEFAULT_ABILITY_TIMEOUT_MS } from '../shared/deadline.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { jsonSchemaRootProperties } from '../shared/json-schema.js';
import {
  hasOnlySimpleTemplateExpressions,
  isOriginRelativePath,
  normalizeOriginRelativePath,
  pathTemplateVariables,
} from '../shared/paths.js';
import { SERVICE_PLANE_RPC_PREFIX, SERVICE_PLANE_RPC_PROTOCOL } from '../shared/rpc-protocol.js';
import {
  type AbilityAccess,
  type AbilityExposure,
  type AbilityTransport,
  type CapabilityCatalog,
  isAbilityAccess,
  type OpenApiObject,
  type ReadonlyOpenApiObject,
  type ReadonlyServiceCallerAuthDiscovery,
  SERVICE_DISCOVERY_PATH,
  type ServiceAbilityDiscovery,
  type ServiceAbilityMcpProjection,
  type ServiceAbilityMcpPromptProjection,
  type ServiceAbilityMcpResourceProjection,
  type ServiceAbilityMethodDiscovery,
  type ServiceAbilityRestProjection,
  type ServiceCallerAuthDiscovery,
  type ServiceDiscoveryDocument,
  type ServiceHttpMethod,
} from '../shared/types.js';
import {
  type AbilityMethodDefinition,
  type AbilityMethodHandlerFor,
  type AbilityMethodKind,
  type AbilitySchema,
  type AbilityStream,
  type AnyAbilityMethodDefinition,
  implementAbilityMethod,
  isAbilityMethodDefinition,
  isImplementedAbilityMethod,
} from './ability.js';
import { defineCapabilities } from './capabilities.js';

/**
 * Abilities accept any Standard Schema value, so services pick their own validation library.
 * The JSON Schema half of the spec is required rather than optional: every ability method is
 * projected into the discovery document, and OpenAPI/MCP projections read those schemas.
 */
// Discovery documents have always carried draft-2020-12 JSON Schema; naming the target keeps
// that stable across validation libraries instead of inheriting each vendor's default.
const ABILITY_JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = 'draft-2020-12';

// Promise and JSON machinery call these names implicitly. Every other string is safe because the
// public client is a flat null-prototype object rather than a recursive function proxy.
const RESERVED_ABILITY_METHOD_NAMES = new Set(['then', 'toJSON', '__proto__']);

/** Returns whether JavaScript machinery may invoke an ability method implicitly. */
export function isReservedAbilityMethodName(name: string): boolean {
  return RESERVED_ABILITY_METHOD_NAMES.has(name);
}

/** Transport-neutral method contracts forming one ability. */
export type AbilityMethodDefinitions<TEnv extends Env = never> = Readonly<Record<string, AnyAbilityMethodDefinition<TEnv>>>;

/** Service-side handlers inferred from a shared ability contract. */
export type AbilityImplementation<TMethods extends AbilityMethodDefinitions<never>> = {
  readonly [TMethod in keyof TMethods]: AbilityMethodHandlerFor<TMethods[TMethod]>;
};

/** Ability definition consumed by Service Plane independently of its private RPC engine. */
export type ServiceAbilityDefinition<
  _TEnv extends Env = Env,
  TMethods extends AbilityMethodDefinitions<_TEnv> = AbilityMethodDefinitions<_TEnv>,
> = {
  /** Which authenticated caller class may invoke the ability. */
  readonly access?: AbilityAccess;
  /** Human-readable ability description used by projections. */
  readonly description?: string;
  /** Whether user-facing projections may publish the ability. */
  readonly exposure?: AbilityExposure;
  /** Stable ability identifier within the service. */
  readonly id: string;
  /** Service Plane method contracts; implementations are attached privately by the service. */
  readonly methods: Readonly<TMethods>;
  /** Wire path and transports implemented by the owning service. */
  readonly rpc?: {
    /** Origin-relative path prefix for this ability. */
    readonly path?: string;
    /** Transports the deployed service accepts. */
    readonly transports?: ReadonlyArray<AbilityTransport>;
  };
  /** Maximum capability scope surface available to methods in this ability. */
  readonly scopes?: ReadonlyArray<string>;
  /** Human-readable ability title used by projections. */
  readonly title?: string;
};

/** The only supported ability definition shape. */
export type AnyServiceAbilityDefinition<TEnv extends Env = never> = ServiceAbilityDefinition<TEnv>;

/** Per-call controls shared by every generated ability client. */
export type AbilityCallOptions = {
  /** Advisory connection information for this call, overriding the client default. */
  connInfo?: ConnInfo;
  /** Caller-owned key for this logical attempt, overriding the client default. */
  idempotencyKey?: string;
  /** Correlation id for this call, overriding the client default. */
  requestId?: string;
  /** Cancels the local transport call when the selected runtime supports cancellation. */
  signal?: AbortSignal;
  /** End-to-end budget for this call in milliseconds, overriding the client default. */
  timeoutMs?: number;
};

type AbilityClientMethod<TMethod extends AnyAbilityMethodDefinition<never>, TCallOptions extends AbilityCallOptions> = (
  input: StandardSchemaV1.InferInput<TMethod['input']>,
  options?: TCallOptions,
) => Promise<
  TMethod['kind'] extends 'unary'
    ? StandardSchemaV1.InferOutput<TMethod['output']>
    : AbilityStream<StandardSchemaV1.InferOutput<TMethod['output']>>
>;

/** Fully typed client shape derived only from the portable ability contract. */
export type AbilityClient<TAbility extends AnyServiceAbilityDefinition, TCallOptions extends AbilityCallOptions = AbilityCallOptions> = {
  [TMethod in keyof TAbility['methods']]: TAbility['methods'][TMethod] extends AnyAbilityMethodDefinition<never>
    ? AbilityClientMethod<TAbility['methods'][TMethod], TCallOptions>
    : never;
};

export type NormalizedAbilityMethodDefinition<
  TInput extends AbilitySchema = AbilitySchema,
  TOutput extends AbilitySchema = AbilitySchema,
  in TEnv extends Env = Env,
> = {
  /** Whether retrying the same logical operation is declared safe. */
  readonly idempotent?: true;
  /** Validates caller data at the service boundary before the handler runs. */
  readonly input: TInput;
  /** Draft 2020-12 representation emitted into discovery and public projections. */
  readonly inputSchema: ReadonlyOpenApiObject;
  /** Validated metadata emitted when this method is published as an MCP tool. */
  readonly mcp?: ServiceAbilityMcpProjection;
  /** Validated metadata emitted when this method is published as an MCP prompt. */
  readonly mcpPrompt?: ServiceAbilityMcpPromptProjection;
  /** Validated metadata emitted when this method is published as an MCP resource. */
  readonly mcpResource?: ServiceAbilityMcpResourceProjection;
  /** Portable method contract compiled by the private runtime. */
  readonly method: AbilityMethodDefinition<TEnv, TInput, TOutput, AbilityMethodKind>;
  /** Validates a unary result or every yielded stream item before transport. */
  readonly output: TOutput;
  /** Draft 2020-12 representation emitted into discovery and public projections. */
  readonly outputSchema: ReadonlyOpenApiObject;
  /** Validated HTTP method, path, and response metadata emitted into the REST facade. */
  readonly rest?: ServiceAbilityRestProjection;
  /** Minimum capability scopes required by the method. */
  readonly scopes: ReadonlyArray<string>;
  /** When present, `output` and `outputSchema` describe each yielded item rather than one aggregate result. */
  readonly stream?: true;
  /** Effective unary execution ceiling in milliseconds. */
  readonly timeoutMs?: number;
};

export type NormalizedServiceAbility<in TEnv extends Env = Env> = {
  /** Normalized caller access class. */
  readonly access: AbilityAccess;
  /** Definition-authored description copied into discovery and public projections. */
  readonly description?: string;
  /** Normalized projection visibility. */
  readonly exposure: AbilityExposure;
  /** Trimmed service-local key used by routes, tokens, discovery, and typed clients. */
  readonly id: string;
  /** Normalized methods keyed by their public names. */
  readonly methods: Readonly<Record<string, NormalizedAbilityMethodDefinition<AbilitySchema, AbilitySchema, TEnv>>>;
  /** Normalized path and transport declarations. */
  readonly rpc: {
    /** Origin-relative ability path prefix. */
    readonly path: string;
    /** Enabled transports with duplicates removed. */
    readonly transports: ReadonlyArray<AbilityTransport>;
  };
  /** Normalized maximum scope surface. */
  readonly scopes: ReadonlyArray<string>;
  /** Definition-authored title copied into discovery and public projections. */
  readonly title?: string;
};

export type ServiceDefinition<TEnv extends Env = Env> = {
  /** Validated and normalized abilities owned by the service. */
  readonly abilities: ReadonlyArray<NormalizedServiceAbility<TEnv>>;
  /** Optional caller-auth capabilities advertised in discovery. */
  readonly callerAuth?: ReadonlyServiceCallerAuthDiscovery;
  /** Capability scopes issued for this service. */
  readonly capabilities?: CapabilityCatalog;
  /** Trimmed service id used as the capability audience and registry key. */
  readonly id: string;
  /** Non-empty display title emitted into service discovery. */
  readonly title: string;
  /** Non-empty contract version emitted so caches and consumers can identify the deployed shape. */
  readonly version: string;
};

export type DefineServiceInput<TEnv extends Env = Env> = Omit<ServiceDefinition<TEnv>, 'abilities' | 'callerAuth'> & {
  /** Portable ability definitions to validate and normalize. */
  readonly abilities: ReadonlyArray<AnyServiceAbilityDefinition<TEnv>>;
  /** Optional caller-auth capabilities to snapshot and advertise in discovery. */
  readonly callerAuth?: ServiceCallerAuthDiscovery;
};

export type DefineServiceOptions = {
  /**
   * Ceiling applied to every unary method that does not set its own `timeoutMs`. `false` removes it.
   */
  defaultMethodTimeoutMs?: false | number;
  /** Requires non-empty scopes on every ability and method when true. */
  requireAbilityScopes?: boolean;
};

type DefineAbilityInput<TMethods extends AbilityMethodDefinitions<never>> = Omit<ServiceAbilityDefinition<never, TMethods>, 'methods'> & {
  readonly methods: TMethods;
};

/** Returns the definition's exact method contract for typed client inference. */
export function defineAbility<TMethods extends AbilityMethodDefinitions<never>>(
  definition: DefineAbilityInput<TMethods>,
): ServiceAbilityDefinition<never, TMethods> {
  assertAbilityMethodRecord(definition.id, definition.methods);
  return immutableAbilityDefinition<TMethods>(definition);
}

/** Derives the complete capability scope set needed by each client method. */
export function abilityClientScopesByMethod(
  ability: AnyServiceAbilityDefinition,
  additionalScopes: ReadonlyArray<string> | undefined,
): ReadonlyMap<string, string[]> {
  assertAbilityMethodRecord(ability.id, ability.methods);
  const abilityScopes = normalizeClientScopes(ability.scopes ?? [], ability.id);
  const allowedScopes = new Set(abilityScopes);
  const additional = normalizeClientScopes(additionalScopes ?? [], ability.id);
  for (const scope of additional) {
    if (!allowedScopes.has(scope)) {
      throw new CapabilityAuthError(`Service-Plane client scope is not declared by ability: ${ability.id} -> ${scope}`, 500);
    }
  }

  return new Map(
    Object.entries(ability.methods).map(([methodName, method]) => {
      if (isReservedAbilityMethodName(methodName)) {
        throw new CapabilityAuthError(`Service-Plane ability method name is reserved: ${ability.id}/${methodName}`, 500);
      }
      const required = normalizeClientScopes(method.metadata.scopes ?? [], `${ability.id}/${methodName}`);
      for (const scope of required) {
        if (!allowedScopes.has(scope)) {
          throw new CapabilityAuthError(
            `Service-Plane ability method requires scope not declared by ability: ${ability.id}/${methodName} -> ${scope}`,
            500,
          );
        }
      }
      return [methodName, [...new Set([...required, ...additional])]];
    }),
  );
}

/** Reads one method's previously derived capability scopes. */
export function abilityClientScopesForMethod(
  scopesByMethod: ReadonlyMap<string, string[]>,
  abilityId: string,
  methodName: string,
): string[] {
  const scopes = scopesByMethod.get(methodName);
  if (!scopes) throw new CapabilityAuthError(`Service-Plane ability method not found: ${abilityId}/${methodName}`, 404);
  return scopes;
}

function normalizeClientScopes(scopes: ReadonlyArray<string>, source: string): string[] {
  return [...new Set(scopes.map((scope) => normalizeClientScope(scope, source)))];
}

function normalizeClientScope(scope: string, source: string): string {
  const normalized = scope.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane client scope cannot be empty: ${source}`, 500);
  if (normalized.includes('*')) throw new CapabilityAuthError(`Service-Plane client scope wildcard is not supported: ${source}`, 500);
  return normalized;
}

/**
 * Attaches service-only handlers to a portable ability contract. Keep the contract in a shared
 * module and this implementation in the service module so browser clients never bundle handlers.
 */
export function implementAbility<TMethods extends AbilityMethodDefinitions<never>>(
  contract: ServiceAbilityDefinition<never, TMethods>,
  handlers: AbilityImplementation<TMethods>,
): ServiceAbilityDefinition<never, TMethods> {
  const methodNames = Object.keys(contract.methods);
  const handlerNames = Object.keys(handlers);
  const missing = methodNames.find((name) => !Object.hasOwn(handlers, name) || typeof handlers[name] !== 'function');
  if (missing) throw new CapabilityAuthError(`Service-Plane ability implementation is missing method: ${contract.id}/${missing}`, 500);
  const extra = handlerNames.find((name) => !Object.hasOwn(contract.methods, name));
  if (extra) throw new CapabilityAuthError(`Service-Plane ability implementation has unknown method: ${contract.id}/${extra}`, 500);
  return immutableAbilityDefinition<TMethods>({
    ...contract,
    methods: Object.fromEntries(
      methodNames.map((name) => [
        name,
        implementAbilityMethod(contract.methods[name] as AnyAbilityMethodDefinition<never>, handlers[name] as never),
      ]),
    ) as TMethods,
  });
}

function immutableAbilityDefinition<TMethods extends AbilityMethodDefinitions<never>>(
  definition: ServiceAbilityDefinition<never, TMethods>,
): ServiceAbilityDefinition<never, TMethods> {
  return Object.freeze({
    ...definition,
    methods: Object.freeze(Object.fromEntries(Object.entries(definition.methods))) as Readonly<TMethods>,
    ...(definition.rpc
      ? {
          rpc: Object.freeze({
            ...definition.rpc,
            ...(definition.rpc.transports ? { transports: Object.freeze([...definition.rpc.transports]) } : {}),
          }),
        }
      : {}),
    ...(definition.scopes ? { scopes: Object.freeze([...definition.scopes]) } : {}),
  }) as ServiceAbilityDefinition<never, TMethods>;
}

export function defineAbilityService<TEnv extends Env = Env>(
  input: DefineServiceInput<TEnv>,
  options: DefineServiceOptions = {},
): ServiceDefinition<TEnv> {
  const serviceId = normalizeValue(input.id, 'service id');
  const capabilities = input.capabilities ? defineCapabilities(input.capabilities) : undefined;
  if (capabilities && capabilities.serviceId !== serviceId) {
    throw new CapabilityAuthError(`Service-Plane capability catalog belongs to ${capabilities.serviceId}, not service ${serviceId}`, 500);
  }
  const callerAuth = input.callerAuth ? immutableCallerAuthDiscovery(input.callerAuth) : undefined;
  const service: ServiceDefinition<TEnv> = {
    abilities: normalizeAbilities(
      serviceId,
      input.abilities,
      capabilities,
      options.requireAbilityScopes ?? true,
      options.defaultMethodTimeoutMs === undefined ? DEFAULT_ABILITY_TIMEOUT_MS : options.defaultMethodTimeoutMs,
    ),
    ...(callerAuth ? { callerAuth } : {}),
    ...(capabilities ? { capabilities } : {}),
    id: serviceId,
    title: normalizeValue(input.title, 'service title'),
    version: normalizeValue(input.version, 'service version'),
  };
  validateCallerAuthDiscovery(service);
  return Object.freeze(service);
}

export function serviceDiscoveryDocument<TEnv extends Env = Env>(service: ServiceDefinition<TEnv>): ServiceDiscoveryDocument {
  return {
    abilities: service.abilities.map(abilityDiscovery),
    ...(service.callerAuth ? { callerAuth: mutableJsonSnapshot(service.callerAuth) as unknown as ServiceCallerAuthDiscovery } : {}),
    ...(service.capabilities ? { capabilities: service.capabilities } : {}),
    id: service.id,
    title: service.title,
    version: service.version,
  };
}

export function defaultAbilityRpcPath(abilityId: string): string {
  return `${SERVICE_PLANE_RPC_PREFIX}/${abilityId}`;
}

export { SERVICE_DISCOVERY_PATH };

function normalizeAbilities<TEnv extends Env>(
  serviceId: string,
  abilities: ReadonlyArray<AnyServiceAbilityDefinition<TEnv>>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
  defaultMethodTimeoutMs: false | number,
): ReadonlyArray<NormalizedServiceAbility<TEnv>> {
  if (abilities.length === 0) {
    throw new CapabilityAuthError('Service-Plane service must define at least one ability', 500);
  }
  const methodTimeoutDefault = validateDefaultMethodTimeoutMs(defaultMethodTimeoutMs);
  const knownScopes = new Set(capabilities?.scopes.map((scope) => normalizeScope(scope.id)) ?? []);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  return Object.freeze(
    abilities.map((ability) => {
      const id = normalizeValue(ability.id, 'ability id');
      if (seenIds.has(id)) throw new CapabilityAuthError(`Duplicate Service-Plane ability: ${id}`, 500);
      seenIds.add(id);
      const scopes = normalizeScopes(ability.scopes ?? []);
      if (requireAbilityScopes && scopes.length === 0) {
        throw new CapabilityAuthError(`Service-Plane ability is missing required scopes: ${id}`, 500);
      }
      validateKnownScopes(scopes, knownScopes, capabilities, 'Service-Plane ability requires unknown scope');
      const methods = normalizeAbilityMethods(
        serviceId,
        id,
        ability.methods,
        scopes,
        knownScopes,
        capabilities,
        requireAbilityScopes,
        methodTimeoutDefault,
      );
      const path = normalizePath(ability.rpc?.path ?? defaultAbilityRpcPath(id), id);
      if (seenPaths.has(path)) throw new CapabilityAuthError(`Duplicate Service-Plane ability RPC path: ${path}`, 500);
      const overlappingPath = [...seenPaths].find((existing) => routePathsOverlap(existing, path));
      if (overlappingPath) {
        throw new CapabilityAuthError(`Overlapping Service-Plane ability RPC paths: ${overlappingPath} and ${path}`, 500);
      }
      seenPaths.add(path);
      const transports = normalizeAbilityTransports(ability.rpc?.transports ?? ['fetch']);
      if (Object.values(methods).some((method) => method.method.kind === 'hibernation') && !transports.includes('websocket')) {
        throw new CapabilityAuthError(`Service-Plane hibernation ability must enable the websocket transport: ${id}`, 500);
      }

      return Object.freeze({
        ...ability,
        access: normalizeAbilityAccess(ability.access ?? 'plane', id),
        exposure: normalizeAbilityExposure(ability.exposure ?? 'private', id),
        id,
        methods,
        rpc: Object.freeze({
          path,
          transports: Object.freeze(transports),
        }),
        scopes: Object.freeze(scopes),
      });
    }),
  );
}

function routePathsOverlap(left: string, right: string): boolean {
  return routePathContains(left, right) || routePathContains(right, left);
}

function routePathContains(parent: string, child: string): boolean {
  return parent === '/' ? child.startsWith('/') : child.startsWith(`${parent}/`);
}

function normalizeAbilityMethods<TEnv extends Env>(
  serviceId: string,
  abilityId: string,
  methods: AbilityMethodDefinitions<TEnv>,
  abilityScopes: ReadonlyArray<string>,
  knownScopes: Set<string>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
  defaultMethodTimeoutMs: false | number,
): Readonly<Record<string, NormalizedAbilityMethodDefinition<AbilitySchema, AbilitySchema, TEnv>>> {
  assertAbilityMethodRecord(abilityId, methods);
  const names = Object.keys(methods);
  if (names.length === 0) throw new CapabilityAuthError(`Service-Plane ability must define at least one method: ${abilityId}`, 500);

  const seenNames = new Set<string>();
  return Object.freeze(
    Object.fromEntries(
      names.map((methodName) => {
        const name = normalizeValue(methodName, `method name for ${abilityId}`);
        if (isReservedAbilityMethodName(name)) {
          throw new CapabilityAuthError(`Service-Plane ability method name is reserved: ${abilityId}/${name}`, 500);
        }
        if (seenNames.has(name)) {
          throw new CapabilityAuthError(`Service-Plane ability method name is duplicated: ${abilityId}/${name}`, 500);
        }
        seenNames.add(name);
        const method = methods[methodName];
        if (!method || !isAbilityMethodDefinition(method)) {
          throw new CapabilityAuthError(
            `Service-Plane ability method must be created with createAbilityBuilder: ${abilityId}/${name}`,
            500,
          );
        }
        if (!isImplementedAbilityMethod(method)) {
          throw new CapabilityAuthError(`Service-Plane ability method has no implementation: ${abilityId}/${name}`, 500);
        }

        const definition = method.metadata;
        const input = method.input;
        const output = method.output;
        const stream = method.kind !== 'unary';
        const scopes = normalizeScopes(definition.scopes ?? []);
        if (requireAbilityScopes && scopes.length === 0) {
          throw new CapabilityAuthError(`Service-Plane ability method is missing required scopes: ${abilityId}/${name}`, 500);
        }
        validateKnownScopes(scopes, knownScopes, capabilities, `Service-Plane ability method requires unknown scope`);
        validateMethodScopesDeclaredByAbility(abilityId, name, scopes, abilityScopes);
        if (method.kind === 'hibernation' && definition.mcp) {
          throw new CapabilityAuthError(`Service-Plane hibernation method cannot project an MCP tool: ${abilityId}/${name}`, 500);
        }
        if (stream && (definition.mcpPrompt || definition.mcpResource)) {
          throw new CapabilityAuthError(
            `Service-Plane streaming method cannot project an MCP prompt or resource: ${abilityId}/${name}`,
            500,
          );
        }
        if (stream && definition.rest) {
          throw new CapabilityAuthError(`Service-Plane streaming method cannot project a REST operation: ${abilityId}/${name}`, 500);
        }
        const timeoutMs = stream ? undefined : resolveMethodTimeoutMs(abilityId, name, definition.timeoutMs, defaultMethodTimeoutMs);
        const inputSchema = abilityJsonSchema(
          input as AbilitySchema,
          'input',
          `${abilityId}/${name}`,
          schemaResourceId(serviceId, abilityId, name, 'input'),
        );
        const rest = definition.rest ? normalizeRestProjection(serviceId, abilityId, name, definition.rest, inputSchema) : undefined;
        const mcp = definition.mcp ? normalizeMcpProjection(abilityId, name, definition.mcp) : undefined;
        const mcpPrompt = definition.mcpPrompt ? normalizeMcpPromptProjection(abilityId, name, definition.mcpPrompt) : undefined;
        const mcpResource = definition.mcpResource ? normalizeMcpResourceProjection(abilityId, name, definition.mcpResource) : undefined;

        return [
          name,
          Object.freeze({
            ...(definition.idempotent ? { idempotent: true as const } : {}),
            input: input as AbilitySchema,
            inputSchema,
            ...(mcp ? { mcp } : {}),
            ...(mcpPrompt ? { mcpPrompt } : {}),
            ...(mcpResource ? { mcpResource } : {}),
            method: method as AbilityMethodDefinition<TEnv, AbilitySchema, AbilitySchema, AbilityMethodKind>,
            output: output as AbilitySchema,
            outputSchema: abilityJsonSchema(
              output as AbilitySchema,
              'output',
              `${abilityId}/${name}`,
              schemaResourceId(serviceId, abilityId, name, 'output'),
            ),
            ...(rest ? { rest } : {}),
            scopes: Object.freeze(scopes),
            ...(stream ? { stream: true as const } : {}),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          } satisfies NormalizedAbilityMethodDefinition<AbilitySchema, AbilitySchema, TEnv>),
        ];
      }),
    ),
  );
}

function assertAbilityMethodRecord(abilityId: string, methods: AbilityMethodDefinitions<never>): void {
  const prototype = Object.getPrototypeOf(methods);
  if (isAbilityMethodDefinition(prototype)) {
    throw new CapabilityAuthError(`Service-Plane ability method name is reserved: ${abilityId}/__proto__`, 500);
  }
}

// setTimeout clamps delays above 2^31-1 to 1ms, so a huge ceiling would fire instantly instead of
// never — the definition-time bound exists to keep that footgun out of production.
const MAX_METHOD_TIMEOUT_MS = 2 ** 31 - 1;

// A method's own ceiling is trusted definition-time config, not hostile wire input, so mistakes
// throw here like every other definition error instead of being silently normalized away. `0` is
// the documented opt-out; the 10-minute wire clamp deliberately does not apply — a batch export may
// legitimately run longer than any forwarded deadline is allowed to promise.
function resolveMethodTimeoutMs(
  abilityId: string,
  methodName: string,
  declared: number | undefined,
  serviceDefault: false | number,
): number | undefined {
  if (declared !== undefined) {
    if (declared === 0) return undefined;
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_METHOD_TIMEOUT_MS) {
      throw new CapabilityAuthError(
        `Service-Plane ability method timeoutMs must be 0 or a positive integer no greater than ${MAX_METHOD_TIMEOUT_MS}: ${abilityId}/${methodName}`,
        500,
      );
    }
    return declared;
  }
  return serviceDefault === false ? undefined : serviceDefault;
}

// The service-wide ceiling is validated once, at definition: `0` is refused with a pointer at the
// explicit opt-out so "disable" is spelled one way, not two.
function validateDefaultMethodTimeoutMs(value: false | number): false | number {
  if (value === false) return value;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_METHOD_TIMEOUT_MS) {
    throw new CapabilityAuthError(
      `Service-Plane timeout.methodMs must be false or a positive integer no greater than ${MAX_METHOD_TIMEOUT_MS}`,
      500,
    );
  }
  return value;
}

function validateMethodScopesDeclaredByAbility(
  abilityId: string,
  methodName: string,
  methodScopes: ReadonlyArray<string>,
  abilityScopes: ReadonlyArray<string>,
): void {
  const declared = new Set(abilityScopes);
  const missing = methodScopes.find((scope) => !declared.has(scope));
  if (missing) {
    throw new CapabilityAuthError(
      `Service-Plane ability method requires scope not declared by ability: ${abilityId}/${methodName} -> ${missing}`,
      500,
    );
  }
}

function abilityDiscovery<TEnv extends Env>(ability: NormalizedServiceAbility<TEnv>): ServiceAbilityDiscovery {
  return {
    access: ability.access,
    ...(ability.description ? { description: ability.description } : {}),
    exposure: ability.exposure,
    id: ability.id,
    methods: Object.fromEntries(
      Object.entries(ability.methods).map(([methodName, method]) => [
        methodName,
        {
          inputSchema: mutableJsonSnapshot(method.inputSchema) as unknown as OpenApiObject,
          ...(method.mcp ? { mcp: method.mcp } : {}),
          ...(method.mcpPrompt ? { mcpPrompt: method.mcpPrompt } : {}),
          ...(method.mcpResource ? { mcpResource: method.mcpResource } : {}),
          outputSchema: mutableJsonSnapshot(method.outputSchema) as unknown as OpenApiObject,
          ...(method.idempotent ? { idempotent: true as const } : {}),
          ...(method.rest ? { rest: method.rest } : {}),
          scopes: [...method.scopes],
          ...(method.stream ? { stream: true as const } : {}),
          ...(method.timeoutMs === undefined ? {} : { timeoutMs: method.timeoutMs }),
        } satisfies ServiceAbilityMethodDiscovery,
      ]),
    ),
    rpc: { path: ability.rpc.path, protocol: SERVICE_PLANE_RPC_PROTOCOL, transports: [...ability.rpc.transports] },
    scopes: [...ability.scopes],
    ...(ability.title ? { title: ability.title } : {}),
  };
}

function normalizeRestProjection(
  serviceId: string,
  abilityId: string,
  methodName: string,
  rest: ServiceAbilityRestProjection,
  inputSchema: ReadonlyOpenApiObject,
): ServiceAbilityRestProjection {
  const path = normalizePath(rest.path, `${abilityId}/${methodName}`);
  const pathVariables = validateRestPathTemplate(path, abilityId, methodName);
  validateRestPathInputFields(inputSchema, pathVariables, abilityId, methodName);
  return Object.freeze({
    ...rest,
    method: normalizeHttpMethod(rest.method),
    operationId: rest.operationId
      ? normalizeValue(rest.operationId, `REST operation id for ${abilityId}/${methodName}`)
      : `${serviceId}.${abilityId}.${methodName}`,
    path,
    ...(rest.status === undefined ? {} : { status: normalizeRestStatus(rest.status, abilityId, methodName) }),
    ...(rest.tags ? { tags: Object.freeze(normalizeTags(rest.tags, `${abilityId}/${methodName}`)) } : {}),
  });
}

function validateRestPathTemplate(path: string, abilityId: string, methodName: string): string[] {
  const variables = pathTemplateVariables(path);
  if (!variables) {
    throw new CapabilityAuthError(`Service-Plane REST path has an invalid or duplicate template variable: ${abilityId}/${methodName}`, 500);
  }
  return variables;
}

function validateRestPathInputFields(
  inputSchema: ReadonlyOpenApiObject,
  pathVariables: string[],
  abilityId: string,
  methodName: string,
): void {
  const properties = jsonSchemaRootProperties(inputSchema);
  const missing = pathVariables.find((name) => !properties || !Object.hasOwn(properties, name));
  if (missing) {
    throw new CapabilityAuthError(
      `Service-Plane REST path template variable must name a top-level input field: ${abilityId}/${methodName} -> ${missing}`,
      500,
    );
  }
}

function normalizeRestStatus(status: number, abilityId: string, methodName: string): number {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new CapabilityAuthError(
      `Service-Plane REST success status must be an integer from 200 through 299: ${abilityId}/${methodName}`,
      500,
    );
  }
  return status;
}

function normalizeMcpProjection(abilityId: string, methodName: string, mcp: ServiceAbilityMcpProjection): ServiceAbilityMcpProjection {
  return Object.freeze({
    ...mcp,
    name: normalizeValue(mcp.name, `MCP tool name for ${abilityId}/${methodName}`),
  });
}

function normalizeMcpPromptProjection(
  abilityId: string,
  methodName: string,
  prompt: ServiceAbilityMcpPromptProjection,
): ServiceAbilityMcpPromptProjection {
  return Object.freeze({
    ...prompt,
    ...(prompt.arguments
      ? {
          arguments: Object.freeze(
            prompt.arguments.map((argument) =>
              Object.freeze({
                ...argument,
                name: normalizeValue(argument.name, `MCP prompt argument name for ${abilityId}/${methodName}`),
              }),
            ),
          ),
        }
      : {}),
    name: normalizeValue(prompt.name, `MCP prompt name for ${abilityId}/${methodName}`),
  });
}

function normalizeMcpResourceProjection(
  abilityId: string,
  methodName: string,
  resource: ServiceAbilityMcpResourceProjection,
): ServiceAbilityMcpResourceProjection {
  const uri = normalizeValue(resource.uri, `MCP resource URI for ${abilityId}/${methodName}`);
  validateMcpResourceUriTemplate(uri, abilityId, methodName);
  return Object.freeze({
    ...resource,
    name: normalizeValue(resource.name, `MCP resource name for ${abilityId}/${methodName}`),
    uri,
  });
}

function immutableCallerAuthDiscovery(callerAuth: ServiceCallerAuthDiscovery): ReadonlyServiceCallerAuthDiscovery {
  return Object.freeze({
    jwks: Object.freeze({
      keys: Object.freeze(callerAuth.jwks.keys.map((key) => immutableJsonSnapshot(key))),
    }),
  }) as unknown as ReadonlyServiceCallerAuthDiscovery;
}

// Only simple `{var}` template expressions are supported; the plane matches them and passes variables as method input.
function validateMcpResourceUriTemplate(uri: string, abilityId: string, methodName: string): void {
  if (!hasOnlySimpleTemplateExpressions(uri)) {
    throw new CapabilityAuthError(`Service-Plane MCP resource URI has an invalid template expression: ${abilityId}/${methodName}`, 500);
  }
}

function validateCallerAuthDiscovery(service: Pick<ServiceDefinition, 'callerAuth'>): void {
  if (!service.callerAuth) return;
  for (const key of service.callerAuth.jwks.keys) {
    if (containsPrivateJwkMaterial(key)) {
      throw new CapabilityAuthError('Service-Plane caller-auth JWKS must not include private key material', 500);
    }
  }
}

function containsPrivateJwkMaterial(key: ReadonlyServiceCallerAuthDiscovery['jwks']['keys'][number]): boolean {
  return (
    typeof key.d === 'string' ||
    typeof key.dp === 'string' ||
    typeof key.dq === 'string' ||
    typeof key.k === 'string' ||
    key.oth !== undefined ||
    typeof key.p === 'string' ||
    typeof key.q === 'string' ||
    typeof key.qi === 'string'
  );
}

function normalizeAbilityTransports(transports: ReadonlyArray<AbilityTransport>): AbilityTransport[] {
  if (transports.length === 0) throw new CapabilityAuthError('Service-Plane ability must enable at least one transport', 500);
  const normalized = [...new Set(transports)];
  for (const transport of normalized) {
    if (transport !== 'fetch' && transport !== 'service-binding' && transport !== 'websocket') {
      throw new CapabilityAuthError(`Unknown Service-Plane ability transport: ${transport as string}`, 500);
    }
  }
  return normalized;
}

function normalizePath(path: string, source: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('\\')) {
    throw new CapabilityAuthError(`Service-Plane path must be origin-relative and start with a single /: ${source}`, 500);
  }
  if (!isOriginRelativePath(normalized)) {
    throw new CapabilityAuthError(`Service-Plane path must not include query or fragment: ${source}`, 500);
  }
  return normalizeOriginRelativePath(normalized) as string;
}

function normalizeHttpMethod(method: ServiceHttpMethod): ServiceHttpMethod {
  if (typeof method !== 'string') throw new CapabilityAuthError('Service-Plane REST method cannot be empty', 500);
  const normalized = method.toLowerCase() as ServiceHttpMethod;
  if (
    normalized !== 'delete' &&
    normalized !== 'get' &&
    normalized !== 'patch' &&
    normalized !== 'post' &&
    normalized !== 'put' &&
    normalized !== 'query'
  ) {
    throw new CapabilityAuthError(`Unknown Service-Plane REST method: ${method as string}`, 500);
  }
  return normalized;
}

function normalizeAbilityExposure(exposure: AbilityExposure, abilityId: string): AbilityExposure {
  if (exposure !== 'private' && exposure !== 'published') {
    throw new CapabilityAuthError(`Unknown Service-Plane ability exposure for ${abilityId}: ${String(exposure)}`, 500);
  }
  return exposure;
}

function normalizeAbilityAccess(access: AbilityAccess, abilityId: string): AbilityAccess {
  if (!isAbilityAccess(access)) {
    throw new CapabilityAuthError(`Unknown Service-Plane ability access for ${abilityId}: ${String(access)}`, 500);
  }
  return access;
}

function normalizeTags(tags: ReadonlyArray<string>, source: string): string[] {
  const normalized = [...new Set(tags.map((tag) => normalizeValue(tag, `REST tag for ${source}`)))];
  if (normalized.length === 0) throw new CapabilityAuthError(`Service-Plane REST projection has an empty tag list: ${source}`, 500);
  return normalized;
}

function normalizeScopes(scopes: ReadonlyArray<string>): string[] {
  return [...new Set(scopes.map(normalizeScope))];
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim();
  if (!normalized) throw new CapabilityAuthError('Service-Plane capability scope cannot be empty', 500);
  if (normalized.includes('*')) throw new CapabilityAuthError('Service-Plane capability wildcards are not supported', 500);
  return normalized;
}

function validateKnownScopes(
  scopes: ReadonlyArray<string>,
  knownScopes: Set<string>,
  capabilities: CapabilityCatalog | undefined,
  message: string,
): void {
  if (scopes.length > 0 && !capabilities) {
    throw new CapabilityAuthError('Service-Plane ability requires scopes but service has no capability catalog', 500);
  }
  for (const scope of scopes) {
    if (!knownScopes.has(scope)) throw new CapabilityAuthError(`${message}: ${scope}`, 500);
  }
}

function normalizeValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane ${field} cannot be empty`, 500);
  return normalized;
}

// Both halves of the Standard Schema contract are checked here, at setup, so a schema that
// cannot validate fails while the service is being defined rather than on a caller's first
// request. `AbilitySchema` is structural, and JS consumers get no compile-time check at all,
// so anything may arrive in an `input`/`output` slot.
function assertAbilitySchemaContract(
  schema: AbilitySchema,
  source: string,
): StandardSchemaV1.Props<unknown, unknown> & StandardJSONSchemaV1.Props {
  const props = (schema as { '~standard'?: unknown } | null | undefined)?.['~standard'];
  if (!props || typeof props !== 'object') {
    throw new CapabilityAuthError(`Service-Plane ability schema is not a Standard Schema (https://standardschema.dev) for ${source}`, 500);
  }
  const typed = props as Partial<StandardSchemaV1.Props<unknown, unknown> & StandardJSONSchemaV1.Props>;
  const vendor = typeof typed.vendor === 'string' ? typed.vendor : 'unknown vendor';
  if (typeof typed.validate !== 'function') {
    throw new CapabilityAuthError(
      `Service-Plane ability schema does not implement Standard Schema validation (${vendor}) for ${source}`,
      500,
    );
  }
  if (typeof typed.jsonSchema?.input !== 'function' || typeof typed.jsonSchema?.output !== 'function') {
    // Naming the version floor matters: with no validation peer dependency, an outdated
    // library installs cleanly and only fails here.
    throw new CapabilityAuthError(
      `Service-Plane ability schema does not implement Standard JSON Schema (https://standardschema.dev/json-schema) for ${source}: ` +
        `${vendor} must expose \`~standard.jsonSchema\` (Zod 4.2+, ArkType 2.1.28+, VineJS 4.3+, or Valibot 1.2+ wrapped in \`toStandardJsonSchema()\`)`,
      500,
    );
  }
  return typed as StandardSchemaV1.Props<unknown, unknown> & StandardJSONSchemaV1.Props;
}

function abilityJsonSchema(schema: AbilitySchema, io: 'input' | 'output', source: string, resourceId: string): ReadonlyOpenApiObject {
  const converter = assertAbilitySchemaContract(schema, source).jsonSchema;
  let rendered: unknown;
  try {
    rendered = converter[io]({ target: ABILITY_JSON_SCHEMA_TARGET });
  } catch (error) {
    throw new CapabilityAuthError(
      `Service-Plane ability schema cannot be represented as JSON Schema for ${source}: ${errorMessage(error)}`,
      500,
    );
  }
  // Boolean and null are legal JSON Schema documents but not projectable: the control plane
  // drops a whole discovery document whose method schemas are not objects, so reject here
  // where the offending ability and method can still be named.
  if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) {
    throw new CapabilityAuthError(
      `Service-Plane ability schema rendered a non-object JSON Schema for ${source}: ${JSON.stringify(rendered) ?? String(rendered)}`,
      500,
    );
  }
  const anchored = withSchemaResourceId(rendered as ReadonlyOpenApiObject, resourceId);
  try {
    const serialized = JSON.stringify(anchored);
    if (serialized === undefined) throw new TypeError('schema has no JSON representation');
    return immutableJsonSnapshot(JSON.parse(serialized) as ReadonlyOpenApiObject);
  } catch (error) {
    throw new CapabilityAuthError(
      `Service-Plane ability schema rendered a non-serializable JSON Schema for ${source}: ${errorMessage(error)}`,
      500,
    );
  }
}

function immutableJsonSnapshot<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => immutableJsonSnapshot(entry))) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableJsonSnapshot(entry)]))) as T;
}

function mutableJsonSnapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => mutableJsonSnapshot(entry)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mutableJsonSnapshot(entry)])) as T;
}

// JSON Schema 2020-12 resource identity: a schema whose fragment `$ref`s point at itself
// (`#`, `#/$defs/...`, `#anchor`) resolves those pointers against the nearest enclosing
// resource. Standalone that is the schema itself, but embedded into a larger document — the
// generated OpenAPI, an MCP tool listing — the pointers would re-anchor to the embedding
// document and dangle. Declaring `$id` makes the schema its own resource wherever it travels,
// so vendor output needs no rewriting. Schemas without local refs are left byte-identical.
function schemaResourceId(serviceId: string, abilityId: string, methodName: string, io: 'input' | 'output'): string {
  const segment = (value: string) => encodeURIComponent(value);
  return `urn:service-plane:${segment(serviceId)}/${segment(abilityId)}/${segment(methodName)}/${io}`;
}

function withSchemaResourceId(schema: ReadonlyOpenApiObject, resourceId: string): ReadonlyOpenApiObject {
  // A vendor-declared `$id` already anchors the schema's own refs; overriding it would break them.
  if (typeof schema.$id === 'string' && schema.$id.length > 0) return schema;
  if (!containsLocalRef(schema)) return schema;
  return { $id: resourceId, ...schema };
}

function containsLocalRef(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      if (typeof record.$ref === 'string' && record.$ref.startsWith('#')) return true;
    }
    pending.push(...Object.values(current));
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
