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
import { bindCapabilityIdentity, capabilityIdentity, requireScopes } from './capabilities.js';

export type AbilitySchema = z.ZodType;

export type AbilityMethodDefinition<TInput extends AbilitySchema = AbilitySchema, TOutput extends AbilitySchema = AbilitySchema> = {
  input: TInput;
  mcp?: ServiceAbilityMcpProjection;
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  mcpResource?: ServiceAbilityMcpResourceProjection;
  output: TOutput;
  rest?: ServiceAbilityRestProjection;
  scopes?: string[];
  // Streaming methods return a ReadableStream of `output`-shaped items over the ordinary
  // Cap'n Web session instead of one value; `output` validates each item.
  stream?: true;
};

export type AbilityMethodDefinitions = Record<string, AbilityMethodDefinition>;

export type ServiceAbilityHandlerFactoryInput<TEnv extends Env = Env> = {
  abilityId: string;
  context: Context<TEnv>;
  identity: CapabilityIdentity;
};

// `Iterable & object` keeps plain strings out: a string is Iterable<string>, but handing one
// back from a streaming method is almost certainly a bug, and the runtime rejects it.
export type AbilityStreamSource<TItem> = AsyncIterable<TItem> | (Iterable<TItem> & object) | ReadableStream<TItem>;

// Streamed items are re-validated by `output.parseAsync`, so handlers must yield the schema's
// INPUT shape: for transforming schemas (pipes, coercions) the transformed output would fail
// re-parsing, so unlike unary methods the output side is not accepted here.
type AbilityMethodItem<TMethod extends AbilityMethodDefinition> = z.input<TMethod['output']>;

export type AbilityImplementation<TAbility extends ServiceAbilityDefinition> = {
  [TMethod in keyof TAbility['methods']]: TAbility['methods'][TMethod] extends { stream: true }
    ? (
        input: z.output<TAbility['methods'][TMethod]['input']>,
      ) =>
        | AbilityStreamSource<AbilityMethodItem<TAbility['methods'][TMethod]>>
        | Promise<AbilityStreamSource<AbilityMethodItem<TAbility['methods'][TMethod]>>>
    : (
        input: z.output<TAbility['methods'][TMethod]['input']>,
      ) =>
        | Promise<z.input<TAbility['methods'][TMethod]['output']> | z.output<TAbility['methods'][TMethod]['output']>>
        | z.input<TAbility['methods'][TMethod]['output']>
        | z.output<TAbility['methods'][TMethod]['output']>;
};

// Streaming methods resolve to a native Cap'n Web ReadableStream of validated items; they
// require a session transport (WebSocket, native binding, custom bidirectional).
export type AbilityRpc<TAbility extends ServiceAbilityDefinition> = {
  [TMethod in keyof TAbility['methods']]: TAbility['methods'][TMethod] extends { stream: true }
    ? (input: z.input<TAbility['methods'][TMethod]['input']>) => Promise<ReadableStream<z.output<TAbility['methods'][TMethod]['output']>>>
    : (input: z.input<TAbility['methods'][TMethod]['input']>) => Promise<z.output<TAbility['methods'][TMethod]['output']>>;
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

// Returns the definition's own type (not the widened AbilityMethodDefinition) so the
// `stream: true` discriminator survives into AbilityRpc and AbilityImplementation.
export function abilityMethod<TDefinition extends AbilityMethodDefinition>(definition: TDefinition): TDefinition {
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

export type CreateValidatingAbilityHandlerOptions = {
  // Cap'n Web streams need an ongoing session. HTTP-batch shells must pass false so streaming
  // methods fail with a clear 405 instead of a dangling stream stub after the batch ends.
  allowStreaming?: boolean;
};

export function createValidatingAbilityHandler<TEnv extends Env>(
  ability: NormalizedServiceAbility<TEnv>,
  handler: RpcTarget & Record<string, unknown>,
  identity: CapabilityIdentity,
  options: CreateValidatingAbilityHandlerOptions = {},
): RpcTarget {
  const allowStreaming = options.allowStreaming ?? true;
  // A handler instance carries one caller's identity; a factory that returns a shared
  // instance would let concurrent sessions overwrite each other's identity and scopes.
  if (capabilityIdentity(handler)) {
    throw new CapabilityAuthError(`Service-Plane ability handler factory must return a new instance per call: ${ability.id}`, 500);
  }
  bindCapabilityIdentity(handler, identity);

  class ValidatingAbilityHandler extends RpcTarget {
    async invoke(methodName: string, args: unknown[]): Promise<unknown> {
      const method = ability.methods[methodName];
      if (!method) throw new AbilityValidationError(`Unknown Service-Plane ability method: ${methodName}`, 404);
      if (method.stream && !allowStreaming) {
        throw new AbilityValidationError(
          `Service-Plane streaming method requires a session transport (WebSocket, native binding, or custom bidirectional): ${methodName}`,
          405,
        );
      }
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
      // Streaming methods return their items as a native Cap'n Web ReadableStream, validated
      // one item at a time as the consumer pulls.
      if (method.stream) return validatedAbilityItemStream(method, methodName, output);
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

// Wraps a handler's stream source into a ReadableStream that validates each item lazily, so
// backpressure from the consumer reaches the handler's generator untouched.
function validatedAbilityItemStream(
  method: NormalizedAbilityMethodDefinition,
  methodName: string,
  source: unknown,
): ReadableStream<unknown> {
  const puller = abilityStreamPuller(source, methodName);
  return new ReadableStream<unknown>({
    cancel(reason) {
      // Cancel the underlying source directly and without awaiting: an async generator's
      // return() queues behind an in-flight next(), and a disconnected consumer must not
      // keep the handler pinned while it waits for the next chunk that may never come.
      puller.cancel(reason);
    },
    async pull(controller) {
      const next = await puller.next();
      if (next.done) {
        controller.close();
        return;
      }
      try {
        controller.enqueue(await method.output.parseAsync(next.value));
      } catch (error) {
        // An invalid item errors the stream, and an errored stream can no longer be cancelled
        // by the consumer — release the handler's source here so generator finally blocks and
        // reader locks are not stranded.
        puller.cancel(error);
        throw error;
      }
    },
  });
}

type AbilityStreamPuller = {
  cancel(reason?: unknown): void;
  next(): Promise<IteratorResult<unknown>>;
};

function abilityStreamPuller(source: unknown, methodName: string): AbilityStreamPuller {
  if (source instanceof ReadableStream) {
    const reader = (source as ReadableStream<unknown>).getReader();
    return {
      cancel(reason) {
        void reader.cancel(reason).catch(() => undefined);
      },
      async next() {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
    };
  }
  if (source && typeof source === 'object' && Symbol.asyncIterator in source) {
    const iterator = (source as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    return {
      cancel() {
        void Promise.resolve()
          .then(() => iterator.return?.(undefined))
          .catch(() => undefined);
      },
      next: () => iterator.next(),
    };
  }
  if (source && typeof source === 'object' && Symbol.iterator in source) {
    const iterator = (source as Iterable<unknown>)[Symbol.iterator]();
    return {
      cancel() {
        try {
          iterator.return?.(undefined);
        } catch {
          // best effort: sync iterator cleanup must not fail cancellation
        }
      },
      next: async () => iterator.next(),
    };
  }
  throw new AbilityValidationError(
    `Service-Plane streaming method must return an async iterable, iterable, or ReadableStream: ${methodName}`,
    500,
  );
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
    const transports = normalizeAbilityTransports(ability.rpc?.transports ?? ['http-batch']);
    // Cap'n Web streams need an ongoing session; the one-round-trip HTTP-batch transport
    // cannot carry them, so fail at setup instead of at the first streamed call.
    if (
      Object.values(methods).some((method) => method.stream) &&
      !transports.includes('websocket') &&
      !transports.includes('cloudflare-binding-rpc')
    ) {
      throw new CapabilityAuthError(
        `Service-Plane ability with streaming methods must enable a session transport (websocket or cloudflare-binding-rpc): ${id}`,
        500,
      );
    }

    return {
      ...ability,
      access: normalizeAbilityAccess(ability.access ?? 'plane', id),
      exposure: normalizeAbilityExposure(ability.exposure ?? 'private', id),
      id,
      methods,
      rpc: {
        path,
        transports,
      },
      scopes,
    };
  });
}

// Members of the validating wrapper itself; an ability method with one of these names
// would shadow the dispatcher and recurse instead of reaching the handler.
const RESERVED_METHOD_NAMES = new Set(['constructor', 'invoke']);

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
      if (RESERVED_METHOD_NAMES.has(name)) {
        throw new CapabilityAuthError(`Service-Plane ability method name is reserved: ${abilityId}/${name}`, 500);
      }
      const method = methods[methodName];
      if (!method) throw new CapabilityAuthError(`Service-Plane ability method is missing: ${abilityId}/${methodName}`, 500);
      const scopes = normalizeScopes(method.scopes ?? []);
      if (requireAbilityScopes && scopes.length === 0) {
        throw new CapabilityAuthError(`Service-Plane ability method is missing required scopes: ${abilityId}/${name}`, 500);
      }
      validateKnownScopes(scopes, knownScopes, capabilities, `Service-Plane ability method requires unknown scope`);
      validateMethodScopesDeclaredByAbility(abilityId, name, scopes, abilityScopes);
      if (method.stream && (method.mcpPrompt || method.mcpResource)) {
        // MCP prompts and resources are single-response protocol surfaces; only tools can
        // be backed by streaming methods.
        throw new CapabilityAuthError(`Service-Plane streaming method cannot project an MCP prompt or resource: ${abilityId}/${name}`, 500);
      }
      if (method.stream && method.rest) {
        // The generated OpenAPI documents request/response operations; a streamed return has
        // no REST serving semantics here.
        throw new CapabilityAuthError(`Service-Plane streaming method cannot project a REST operation: ${abilityId}/${name}`, 500);
      }
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
          ...(method.stream ? { stream: true as const } : {}),
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
          ...(method.stream ? { stream: true as const } : {}),
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
