import { RpcTarget } from 'capnweb';
import type { Context, Env } from 'hono';
import * as z from 'zod';
import { AbilityValidationError, CapabilityAuthError } from '../shared/errors.js';
import {
  type AbilityAccess,
  type AbilityExposure,
  type AbilityTransport,
  type CapabilityCatalog,
  type CapabilityIdentity,
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
import { bindCapabilityIdentity, requireScopes } from './capabilities.js';

export type AbilitySchema = z.ZodType;

export type AbilityMethodDefinition<TInput extends AbilitySchema = AbilitySchema, TOutput extends AbilitySchema = AbilitySchema> = {
  input: TInput;
  mcp?: ServiceAbilityMcpProjection;
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  mcpResource?: ServiceAbilityMcpResourceProjection;
  output: TOutput;
  rest?: ServiceAbilityRestProjection;
  scopes?: string[];
};

export type AbilityMethodDefinitions = Record<string, AbilityMethodDefinition>;

export type ServiceAbilityHandlerFactoryInput<TEnv extends Env = Env> = {
  abilityId: string;
  context: Context<TEnv>;
  identity: CapabilityIdentity;
};

export type AbilityImplementation<TAbility extends ServiceAbilityDefinition> = {
  [TMethod in keyof TAbility['methods']]: (
    input: z.output<TAbility['methods'][TMethod]['input']>,
  ) =>
    | Promise<z.input<TAbility['methods'][TMethod]['output']> | z.output<TAbility['methods'][TMethod]['output']>>
    | z.input<TAbility['methods'][TMethod]['output']>
    | z.output<TAbility['methods'][TMethod]['output']>;
};

export type AbilityRpc<TAbility extends ServiceAbilityDefinition> = {
  [TMethod in keyof TAbility['methods']]: (
    input: z.input<TAbility['methods'][TMethod]['input']>,
  ) => Promise<z.output<TAbility['methods'][TMethod]['output']>>;
};

export type ServiceAbilityHandlerFactory<TEnv extends Env = Env> = (
  input: ServiceAbilityHandlerFactoryInput<TEnv>,
) => Promise<RpcTarget & Record<string, unknown>> | (RpcTarget & Record<string, unknown>);

export type ServiceAbilityDefinition<TEnv extends Env = Env, TMethods extends AbilityMethodDefinitions = AbilityMethodDefinitions> = {
  access?: AbilityAccess;
  description?: string;
  exposure?: AbilityExposure;
  id: string;
  methods: TMethods;
  rpc?: {
    path?: string;
    transports?: AbilityTransport[];
  };
  scopes?: string[];
  handler: ServiceAbilityHandlerFactory<TEnv>;
  title?: string;
};

export type AnyServiceAbilityDefinition<TEnv extends Env = Env> = ServiceAbilityDefinition<TEnv, AbilityMethodDefinitions>;

export type NormalizedAbilityMethodDefinition<
  TInput extends AbilitySchema = AbilitySchema,
  TOutput extends AbilitySchema = AbilitySchema,
> = AbilityMethodDefinition<TInput, TOutput> & {
  inputSchema: OpenApiObject;
  outputSchema: OpenApiObject;
  scopes: string[];
};

export type NormalizedServiceAbility<TEnv extends Env = Env> = Omit<
  AnyServiceAbilityDefinition<TEnv>,
  'access' | 'exposure' | 'methods' | 'rpc' | 'scopes'
> & {
  access: AbilityAccess;
  exposure: AbilityExposure;
  methods: Record<string, NormalizedAbilityMethodDefinition>;
  rpc: {
    path: string;
    transports: AbilityTransport[];
  };
  scopes: string[];
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
  requireAbilityScopes?: boolean;
};

export function abilityMethod<TInput extends AbilitySchema, TOutput extends AbilitySchema>(
  definition: AbilityMethodDefinition<TInput, TOutput>,
): AbilityMethodDefinition<TInput, TOutput> {
  return definition;
}

export function defineAbility<TEnv extends Env = Env, TMethods extends AbilityMethodDefinitions = AbilityMethodDefinitions>(
  definition: ServiceAbilityDefinition<TEnv, TMethods>,
): ServiceAbilityDefinition<TEnv, TMethods> {
  return definition;
}

export function defineAbilityService<TEnv extends Env = Env>(
  input: DefineServiceInput<TEnv>,
  options: DefineServiceOptions = {},
): ServiceDefinition<TEnv> {
  const serviceId = normalizeValue(input.id, 'service id');
  const service: ServiceDefinition<TEnv> = {
    abilities: normalizeAbilities(input.abilities, input.capabilities, options.requireAbilityScopes ?? true),
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

export function createValidatingAbilityHandler<TEnv extends Env>(
  ability: NormalizedServiceAbility<TEnv>,
  handler: RpcTarget & Record<string, unknown>,
  identity: CapabilityIdentity,
): RpcTarget {
  bindCapabilityIdentity(handler, identity);

  class ValidatingAbilityHandler extends RpcTarget {
    async invoke(methodName: string, args: unknown[]): Promise<unknown> {
      const method = ability.methods[methodName];
      if (!method) throw new AbilityValidationError(`Unknown Service-Plane ability method: ${methodName}`, 404);
      if (args.length !== 1) {
        throw new AbilityValidationError(`Service-Plane ability method expects a single input object: ${methodName}`, 422);
      }

      requireScopes(this, ...method.scopes);
      const implementation = handler[methodName];
      if (typeof implementation !== 'function') {
        throw new AbilityValidationError(`Service-Plane ability handler does not implement method: ${methodName}`, 500);
      }

      const input = await method.input.parseAsync(args[0]);
      const output = await implementation.call(handler, input);
      return method.output.parseAsync(output);
    }
  }

  for (const methodName of Object.keys(ability.methods)) {
    Object.defineProperty(ValidatingAbilityHandler.prototype, methodName, {
      async value(this: ValidatingAbilityHandler, ...args: unknown[]) {
        return this.invoke(methodName, args);
      },
    });
  }

  return bindCapabilityIdentity(new ValidatingAbilityHandler(), identity);
}

export { SERVICE_DISCOVERY_PATH };

function normalizeAbilities<TEnv extends Env>(
  abilities: Array<AnyServiceAbilityDefinition<TEnv>>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
): NormalizedServiceAbility<TEnv>[] {
  if (abilities.length === 0) {
    throw new CapabilityAuthError('Service-Plane service must define at least one ability', 500);
  }

  const knownScopes = new Set(capabilities?.scopes.map((scope) => normalizeScope(scope.id)) ?? []);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  return abilities.map((ability) => {
    const id = normalizeValue(ability.id, 'ability id');
    if (seenIds.has(id)) throw new CapabilityAuthError(`Duplicate Service-Plane ability: ${id}`, 500);
    seenIds.add(id);
    if (typeof ability.handler !== 'function') {
      throw new CapabilityAuthError(`Service-Plane ability requires a handler factory: ${id}`, 500);
    }

    const scopes = normalizeScopes(ability.scopes ?? []);
    if (requireAbilityScopes && scopes.length === 0) {
      throw new CapabilityAuthError(`Service-Plane ability is missing required scopes: ${id}`, 500);
    }
    validateKnownScopes(scopes, knownScopes, capabilities, `Service-Plane ability requires unknown scope`);

    const methods = normalizeMethods(id, ability.methods, scopes, knownScopes, capabilities, requireAbilityScopes);
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
        transports: normalizeAbilityTransports(ability.rpc?.transports ?? ['http-batch']),
      },
      scopes,
    };
  });
}

function normalizeMethods(
  abilityId: string,
  methods: AbilityMethodDefinitions,
  abilityScopes: string[],
  knownScopes: Set<string>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
): Record<string, NormalizedAbilityMethodDefinition> {
  const names = Object.keys(methods);
  if (names.length === 0) throw new CapabilityAuthError(`Service-Plane ability must define at least one method: ${abilityId}`, 500);

  return Object.fromEntries(
    names.map((methodName) => {
      const name = normalizeValue(methodName, `method name for ${abilityId}`);
      const method = methods[methodName];
      if (!method) throw new CapabilityAuthError(`Service-Plane ability method is missing: ${abilityId}/${methodName}`, 500);
      const scopes = normalizeScopes(method.scopes ?? []);
      if (requireAbilityScopes && scopes.length === 0) {
        throw new CapabilityAuthError(`Service-Plane ability method is missing required scopes: ${abilityId}/${name}`, 500);
      }
      validateKnownScopes(scopes, knownScopes, capabilities, `Service-Plane ability method requires unknown scope`);
      validateMethodScopesDeclaredByAbility(abilityId, name, scopes, abilityScopes);
      const rest = method.rest ? normalizeRestProjection(abilityId, name, method.rest) : undefined;
      const mcp = method.mcp ? normalizeMcpProjection(abilityId, name, method.mcp) : undefined;
      const mcpPrompt = method.mcpPrompt ? normalizeMcpPromptProjection(abilityId, name, method.mcpPrompt) : undefined;
      const mcpResource = method.mcpResource ? normalizeMcpResourceProjection(abilityId, name, method.mcpResource) : undefined;
      return [
        name,
        {
          ...method,
          inputSchema: zodToJsonSchema(method.input, 'input', `${abilityId}/${name}`),
          ...(mcp ? { mcp } : {}),
          ...(mcpPrompt ? { mcpPrompt } : {}),
          ...(mcpResource ? { mcpResource } : {}),
          outputSchema: zodToJsonSchema(method.output, 'output', `${abilityId}/${name}`),
          ...(rest ? { rest } : {}),
          scopes,
        },
      ];
    }),
  );
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
          ...(method.rest ? { rest: method.rest } : {}),
          scopes: method.scopes,
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
    if (transport !== 'cloudflare-binding-rpc' && transport !== 'http-batch' && transport !== 'websocket') {
      throw new CapabilityAuthError(`Unknown Service-Plane ability transport: ${transport as string}`, 500);
    }
  }
  return normalized;
}

function normalizePath(path: string, source: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith('/')) {
    throw new CapabilityAuthError(`Service-Plane path must start with /: ${source}`, 500);
  }
  if (normalized.includes('?') || normalized.includes('#')) {
    throw new CapabilityAuthError(`Service-Plane path must not include query or fragment: ${source}`, 500);
  }
  return normalized.replace(/\/+$/u, '') || '/';
}

function normalizeHttpMethod(method: ServiceHttpMethod): ServiceHttpMethod {
  if (typeof method !== 'string') throw new CapabilityAuthError('Service-Plane REST method cannot be empty', 500);
  const normalized = method.toLowerCase() as ServiceHttpMethod;
  if (normalized !== 'delete' && normalized !== 'get' && normalized !== 'patch' && normalized !== 'post' && normalized !== 'put') {
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
  if (access !== 'plane' && access !== 'service') {
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

function zodToJsonSchema(schema: AbilitySchema, io: 'input' | 'output', source: string): OpenApiObject {
  try {
    return z.toJSONSchema(schema, { io }) as OpenApiObject;
  } catch (error) {
    throw new CapabilityAuthError(
      `Service-Plane ability schema cannot be represented as JSON Schema for ${source}: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}
