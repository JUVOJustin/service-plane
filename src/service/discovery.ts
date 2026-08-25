import type { AnyProcedure, RouterClient } from '@orpc/server';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { Env } from 'hono';
import { DEFAULT_ABILITY_TIMEOUT_MS } from '../shared/deadline.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { isOriginRelativePath } from '../shared/paths.js';
import {
  type AbilityAccess,
  type AbilityExposure,
  type AbilityTransport,
  type CapabilityCatalog,
  isAbilityAccess,
  type OpenApiObject,
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
  abilityProcedureDefinition,
  abilityProcedureInputSchema,
  abilityProcedureOutputSchema,
  abilityProcedureStreams,
  isServicePlaneAbilityProcedure,
} from './orpc.js';

/**
 * Abilities accept any Standard Schema value, so services pick their own validation library.
 * The JSON Schema half of the spec is required rather than optional: every ability method is
 * projected into the discovery document, and OpenAPI/MCP projections read those schemas.
 */
export type AbilitySchema = StandardSchemaV1 & StandardJSONSchemaV1;

// Discovery documents have always carried draft-2020-12 JSON Schema; naming the target keeps
// that stable across validation libraries instead of inheriting each vendor's default.
const ABILITY_JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = 'draft-2020-12';

/** Implemented oRPC procedures forming one ability router. */
export type AbilityProcedureDefinitions = Record<string, AnyProcedure>;

/** WebSocket capabilities exposed to a procedure, including optional Durable Object attachments. */
export type ServiceAbilityWebSocket = {
  /** Reads a Durable Object Hibernation attachment when the runtime supports it. */
  deserializeAttachment?: () => unknown;
  /** Sends a WebSocket frame. */
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): unknown;
  /** Stores a Durable Object Hibernation attachment when the runtime supports it. */
  serializeAttachment?: (attachment: unknown) => void;
};

/** Procedure-first ability definition used by the oRPC runtime. */
export type OrpcServiceAbilityDefinition<
  _TEnv extends Env = Env,
  TMethods extends AbilityProcedureDefinitions = AbilityProcedureDefinitions,
> = {
  access?: AbilityAccess;
  description?: string;
  exposure?: AbilityExposure;
  id: string;
  /** Implemented oRPC procedures; schemas, metadata, middleware, errors, and handlers stay together. */
  methods: TMethods;
  rpc?: {
    path?: string;
    transports?: AbilityTransport[];
  };
  scopes?: string[];
  title?: string;
};

/** The only supported ability definition shape. */
export type ServiceAbilityDefinition<
  TEnv extends Env = Env,
  TMethods extends AbilityProcedureDefinitions = AbilityProcedureDefinitions,
> = OrpcServiceAbilityDefinition<TEnv, TMethods>;

/** The only supported ability definition shape. */
export type AnyServiceAbilityDefinition<TEnv extends Env = Env> = OrpcServiceAbilityDefinition<TEnv>;

/** Fully typed client shape derived from an ability router. */
export type AbilityRpc<TAbility extends OrpcServiceAbilityDefinition> = RouterClient<TAbility['methods']>;

export type NormalizedAbilityMethodDefinition<
  TInput extends AbilitySchema = AbilitySchema,
  TOutput extends AbilitySchema = AbilitySchema,
> = {
  idempotent?: true;
  input: TInput;
  inputSchema: OpenApiObject;
  mcp?: ServiceAbilityMcpProjection;
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  mcpResource?: ServiceAbilityMcpResourceProjection;
  output: TOutput;
  outputSchema: OpenApiObject;
  procedure: AnyProcedure;
  rest?: ServiceAbilityRestProjection;
  scopes: string[];
  stream?: true;
  timeoutMs?: number;
};

export type NormalizedServiceAbility<_TEnv extends Env = Env> = {
  access: AbilityAccess;
  description?: string;
  exposure: AbilityExposure;
  id: string;
  methods: Record<string, NormalizedAbilityMethodDefinition>;
  rpc: {
    path: string;
    transports: AbilityTransport[];
  };
  scopes: string[];
  title?: string;
};

export type ServiceDefinition<TEnv extends Env = Env> = {
  abilities: NormalizedServiceAbility<TEnv>[];
  callerAuth?: ServiceCallerAuthDiscovery;
  capabilities?: CapabilityCatalog;
  id: string;
  title: string;
  version: string;
};

export type DefineServiceInput<TEnv extends Env = Env> = Omit<ServiceDefinition<TEnv>, 'abilities'> & {
  abilities: Array<AnyServiceAbilityDefinition<TEnv>>;
};

export type DefineServiceOptions = {
  /**
   * Ceiling applied to every unary method that does not set its own `timeoutMs`. `false` removes it.
   */
  defaultMethodTimeoutMs?: false | number;
  requireAbilityScopes?: boolean;
};

/** Returns the definition's exact router type for typed client inference. */
export function defineAbility<TEnv extends Env = Env, TMethods extends AbilityProcedureDefinitions = AbilityProcedureDefinitions>(
  definition: OrpcServiceAbilityDefinition<TEnv, TMethods>,
): OrpcServiceAbilityDefinition<TEnv, TMethods> {
  return definition;
}

export function defineAbilityService<TEnv extends Env = Env>(
  input: DefineServiceInput<TEnv>,
  options: DefineServiceOptions = {},
): ServiceDefinition<TEnv> {
  const serviceId = normalizeValue(input.id, 'service id');
  const service: ServiceDefinition<TEnv> = {
    abilities: normalizeAbilities(
      serviceId,
      input.abilities,
      input.capabilities,
      options.requireAbilityScopes ?? true,
      options.defaultMethodTimeoutMs === undefined ? DEFAULT_ABILITY_TIMEOUT_MS : options.defaultMethodTimeoutMs,
    ),
    ...(input.callerAuth ? { callerAuth: input.callerAuth } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    id: serviceId,
    title: normalizeValue(input.title, 'service title'),
    version: normalizeValue(input.version, 'service version'),
  };
  validateCallerAuthDiscovery(service);
  return service;
}

export function serviceDiscoveryDocument<TEnv extends Env = Env>(service: ServiceDefinition<TEnv>): ServiceDiscoveryDocument {
  return {
    abilities: service.abilities.map(abilityDiscovery),
    ...(service.callerAuth ? { callerAuth: service.callerAuth } : {}),
    ...(service.capabilities ? { capabilities: service.capabilities } : {}),
    id: service.id,
    title: service.title,
    version: service.version,
  };
}

export function defaultAbilityRpcPath(abilityId: string): string {
  return `/rpc/${abilityId}`;
}

export { SERVICE_DISCOVERY_PATH };

function normalizeAbilities<TEnv extends Env>(
  serviceId: string,
  abilities: Array<AnyServiceAbilityDefinition<TEnv>>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
  defaultMethodTimeoutMs: false | number,
): NormalizedServiceAbility<TEnv>[] {
  if (abilities.length === 0) {
    throw new CapabilityAuthError('Service-Plane service must define at least one ability', 500);
  }
  const methodTimeoutDefault = validateDefaultMethodTimeoutMs(defaultMethodTimeoutMs);
  const knownScopes = new Set(capabilities?.scopes.map((scope) => normalizeScope(scope.id)) ?? []);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  return abilities.map((ability) => {
    const id = normalizeValue(ability.id, 'ability id');
    if (seenIds.has(id)) throw new CapabilityAuthError(`Duplicate Service-Plane ability: ${id}`, 500);
    seenIds.add(id);
    const scopes = normalizeScopes(ability.scopes ?? []);
    if (requireAbilityScopes && scopes.length === 0) {
      throw new CapabilityAuthError(`Service-Plane ability is missing required scopes: ${id}`, 500);
    }
    validateKnownScopes(scopes, knownScopes, capabilities, 'Service-Plane ability requires unknown scope');
    const methods = normalizeProcedureMethods(
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
    seenPaths.add(path);

    return {
      ...ability,
      access: normalizeAbilityAccess(ability.access ?? 'plane', id),
      exposure: normalizeAbilityExposure(ability.exposure ?? 'private', id),
      id,
      methods,
      rpc: {
        path,
        transports: normalizeAbilityTransports(ability.rpc?.transports ?? ['fetch']),
      },
      scopes,
    };
  });
}

function normalizeProcedureMethods(
  serviceId: string,
  abilityId: string,
  methods: AbilityProcedureDefinitions,
  abilityScopes: string[],
  knownScopes: Set<string>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
  defaultMethodTimeoutMs: false | number,
): Record<string, NormalizedAbilityMethodDefinition> {
  const names = Object.keys(methods);
  if (names.length === 0) throw new CapabilityAuthError(`Service-Plane ability must define at least one method: ${abilityId}`, 500);

  const seenNames = new Set<string>();
  return Object.fromEntries(
    names.map((methodName) => {
      const name = normalizeValue(methodName, `method name for ${abilityId}`);
      if (seenNames.has(name)) {
        throw new CapabilityAuthError(`Service-Plane ability method name is duplicated: ${abilityId}/${name}`, 500);
      }
      seenNames.add(name);
      const procedure = methods[methodName];
      if (!procedure || !isServicePlaneAbilityProcedure(procedure)) {
        throw new CapabilityAuthError(
          `Service-Plane ability procedure must be created with createAbilityBuilder: ${abilityId}/${name}`,
          500,
        );
      }

      const definition = abilityProcedureDefinition(procedure);
      const input = abilityProcedureInputSchema(procedure);
      const output = abilityProcedureOutputSchema(procedure);
      if (!input || !output) {
        throw new CapabilityAuthError(
          `Service-Plane ability procedure requires exactly one input and one output schema: ${abilityId}/${name}`,
          500,
        );
      }
      const stream = abilityProcedureStreams(procedure);
      const scopes = normalizeScopes(definition.scopes ?? []);
      if (requireAbilityScopes && scopes.length === 0) {
        throw new CapabilityAuthError(`Service-Plane ability method is missing required scopes: ${abilityId}/${name}`, 500);
      }
      validateKnownScopes(scopes, knownScopes, capabilities, `Service-Plane ability method requires unknown scope`);
      validateMethodScopesDeclaredByAbility(abilityId, name, scopes, abilityScopes);
      if (stream && (definition.mcpPrompt || definition.mcpResource)) {
        throw new CapabilityAuthError(`Service-Plane streaming method cannot project an MCP prompt or resource: ${abilityId}/${name}`, 500);
      }
      if (stream && definition.rest) {
        throw new CapabilityAuthError(`Service-Plane streaming method cannot project a REST operation: ${abilityId}/${name}`, 500);
      }

      const timeoutMs = stream ? undefined : resolveMethodTimeoutMs(abilityId, name, definition.timeoutMs, defaultMethodTimeoutMs);
      const rest = definition.rest ? normalizeRestProjection(abilityId, name, definition.rest) : undefined;
      const mcp = definition.mcp ? normalizeMcpProjection(abilityId, name, definition.mcp) : undefined;
      const mcpPrompt = definition.mcpPrompt ? normalizeMcpPromptProjection(abilityId, name, definition.mcpPrompt) : undefined;
      const mcpResource = definition.mcpResource ? normalizeMcpResourceProjection(abilityId, name, definition.mcpResource) : undefined;

      return [
        name,
        {
          ...(definition.idempotent ? { idempotent: true as const } : {}),
          input: input as AbilitySchema,
          inputSchema: abilityJsonSchema(
            input as AbilitySchema,
            'input',
            `${abilityId}/${name}`,
            schemaResourceId(serviceId, abilityId, name, 'input'),
          ),
          ...(mcp ? { mcp } : {}),
          ...(mcpPrompt ? { mcpPrompt } : {}),
          ...(mcpResource ? { mcpResource } : {}),
          output: output as AbilitySchema,
          outputSchema: abilityJsonSchema(
            output as AbilitySchema,
            'output',
            `${abilityId}/${name}`,
            schemaResourceId(serviceId, abilityId, name, 'output'),
          ),
          procedure,
          ...(rest ? { rest } : {}),
          scopes,
          ...(stream ? { stream: true as const } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        } satisfies NormalizedAbilityMethodDefinition,
      ];
    }),
  );
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
  methodScopes: string[],
  abilityScopes: string[],
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
          inputSchema: method.inputSchema,
          ...(method.mcp ? { mcp: method.mcp } : {}),
          ...(method.mcpPrompt ? { mcpPrompt: method.mcpPrompt } : {}),
          ...(method.mcpResource ? { mcpResource: method.mcpResource } : {}),
          outputSchema: method.outputSchema,
          ...(method.idempotent ? { idempotent: true as const } : {}),
          ...(method.rest ? { rest: method.rest } : {}),
          scopes: method.scopes,
          ...(method.stream ? { stream: true as const } : {}),
          ...(method.timeoutMs === undefined ? {} : { timeoutMs: method.timeoutMs }),
        } satisfies ServiceAbilityMethodDiscovery,
      ]),
    ),
    rpc: ability.rpc,
    scopes: ability.scopes,
    ...(ability.title ? { title: ability.title } : {}),
  };
}

function normalizeRestProjection(abilityId: string, methodName: string, rest: ServiceAbilityRestProjection): ServiceAbilityRestProjection {
  return {
    ...rest,
    method: normalizeHttpMethod(rest.method),
    operationId: rest.operationId
      ? normalizeValue(rest.operationId, `REST operation id for ${abilityId}/${methodName}`)
      : `${abilityId}.${methodName}`,
    path: normalizePath(rest.path, `${abilityId}/${methodName}`),
    ...(rest.tags ? { tags: normalizeTags(rest.tags, `${abilityId}/${methodName}`) } : {}),
  };
}

function normalizeMcpProjection(abilityId: string, methodName: string, mcp: ServiceAbilityMcpProjection): ServiceAbilityMcpProjection {
  return {
    ...mcp,
    name: normalizeValue(mcp.name, `MCP tool name for ${abilityId}/${methodName}`),
  };
}

function normalizeMcpPromptProjection(
  abilityId: string,
  methodName: string,
  prompt: ServiceAbilityMcpPromptProjection,
): ServiceAbilityMcpPromptProjection {
  return {
    ...prompt,
    ...(prompt.arguments
      ? {
          arguments: prompt.arguments.map((argument) => ({
            ...argument,
            name: normalizeValue(argument.name, `MCP prompt argument name for ${abilityId}/${methodName}`),
          })),
        }
      : {}),
    name: normalizeValue(prompt.name, `MCP prompt name for ${abilityId}/${methodName}`),
  };
}

function normalizeMcpResourceProjection(
  abilityId: string,
  methodName: string,
  resource: ServiceAbilityMcpResourceProjection,
): ServiceAbilityMcpResourceProjection {
  const uri = normalizeValue(resource.uri, `MCP resource URI for ${abilityId}/${methodName}`);
  validateMcpResourceUriTemplate(uri, abilityId, methodName);
  return {
    ...resource,
    name: normalizeValue(resource.name, `MCP resource name for ${abilityId}/${methodName}`),
    uri,
  };
}

// Only simple `{var}` template expressions are supported; the plane matches them and passes variables as method input.
function validateMcpResourceUriTemplate(uri: string, abilityId: string, methodName: string): void {
  const expressions = uri.match(/\{[^}]*\}|\{|\}/gu) ?? [];
  let balance = 0;
  for (const char of uri) {
    if (char === '{') balance += 1;
    if (char === '}') balance -= 1;
    if (balance < 0) break;
  }
  const allSimple = expressions.every((expression) => /^\{[A-Za-z_][\w]*\}$/u.test(expression));
  if (balance !== 0 || !allSimple) {
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

function containsPrivateJwkMaterial(key: JsonWebKey): boolean {
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

function normalizeAbilityTransports(transports: AbilityTransport[]): AbilityTransport[] {
  if (transports.length === 0) throw new CapabilityAuthError('Service-Plane ability must enable at least one transport', 500);
  const normalized = [...new Set(transports)];
  for (const transport of normalized) {
    if (transport !== 'cloudflare-service-binding' && transport !== 'fetch' && transport !== 'websocket') {
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
  return normalized.replace(/\/+$/u, '') || '/';
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

function normalizeTags(tags: string[], source: string): string[] {
  const normalized = [...new Set(tags.map((tag) => normalizeValue(tag, `REST tag for ${source}`)))];
  if (normalized.length === 0) throw new CapabilityAuthError(`Service-Plane REST projection has an empty tag list: ${source}`, 500);
  return normalized;
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map(normalizeScope))];
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim();
  if (!normalized) throw new CapabilityAuthError('Service-Plane capability scope cannot be empty', 500);
  if (normalized.includes('*')) throw new CapabilityAuthError('Service-Plane capability wildcards are not supported', 500);
  return normalized;
}

function validateKnownScopes(
  scopes: string[],
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

function abilityJsonSchema(schema: AbilitySchema, io: 'input' | 'output', source: string, resourceId: string): OpenApiObject {
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
  return withSchemaResourceId(rendered as OpenApiObject, resourceId);
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

function withSchemaResourceId(schema: OpenApiObject, resourceId: string): OpenApiObject {
  // A vendor-declared `$id` already anchors the schema's own refs; overriding it would break them.
  if (typeof schema.$id === 'string' && schema.$id.length > 0) return schema;
  if (!containsLocalRef(schema)) return schema;
  return { $id: resourceId, ...schema };
}

function containsLocalRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsLocalRef);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#')) return true;
  return Object.values(record).some(containsLocalRef);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
