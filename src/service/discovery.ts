import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { RpcPromise, RpcTarget } from 'capnweb';
import type { Context, Env } from 'hono';
import type { ConnInfo } from '../shared/conn-info.js';
import {
  AbilityValidationError,
  type AbilityValidationIssue,
  CapabilityAuthError,
  rememberHandlerFailureCause,
  ServicePlaneError,
  ServicePlaneTimeoutError,
} from '../shared/errors.js';
import { isOriginRelativePath } from '../shared/paths.js';
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

/**
 * Abilities accept any Standard Schema value, so services pick their own validation library.
 * The JSON Schema half of the spec is required rather than optional: every ability method is
 * projected into the discovery document, and OpenAPI/MCP projections read those schemas.
 */
export type AbilitySchema = StandardSchemaV1 & StandardJSONSchemaV1;

// Discovery documents have always carried draft-2020-12 JSON Schema; naming the target keeps
// that stable across validation libraries instead of inheriting each vendor's default.
const ABILITY_JSON_SCHEMA_TARGET: StandardJSONSchemaV1.Target = 'draft-2020-12';

type AbilitySchemaInput<TSchema extends AbilitySchema> = StandardSchemaV1.InferInput<TSchema>;
type AbilitySchemaOutput<TSchema extends AbilitySchema> = StandardSchemaV1.InferOutput<TSchema>;

export type AbilityMethodDefinition<TInput extends AbilitySchema = AbilitySchema, TOutput extends AbilitySchema = AbilitySchema> = {
  /**
   * Declares that calling this method again with the same input cannot double its effect, so a
   * caller may safely retry an ambiguous failure. Projected into discovery for callers and
   * gateways to read; this package never retries on its own.
   */
  idempotent?: true;
  input: TInput;
  mcp?: ServiceAbilityMcpProjection;
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  mcpResource?: ServiceAbilityMcpResourceProjection;
  output: TOutput;
  rest?: ServiceAbilityRestProjection;
  scopes?: string[];
  /**
   * Streaming methods return a ReadableStream of `output`-shaped items over the ordinary
   * Cap'n Web session instead of one value; `output` validates each item.
   */
  stream?: true;
};

export type AbilityMethodDefinitions = Record<string, AbilityMethodDefinition>;

export type ServiceAbilityHandlerFactoryInput<TEnv extends Env = Env> = {
  abilityId: string;
  /**
   * Advisory connection info about the original client, forwarded by the control plane. Present
   * only for brokered calls into an ingress-protected service; unlike `identity` it is not
   * signature-verified, so use it for audit and logging, never for authorization.
   */
  connInfo?: ConnInfo;
  context: Context<TEnv>;
  identity: CapabilityIdentity;
  /**
   * The caller's key for this attempt, when it sent one. It identifies the attempt, not the
   * individual method call, so a handler that stores results must scope it by method name —
   * `${idempotencyKey}:createTask` — or two different methods on one session would collide.
   * Storing and expiring those results is the service's job; this package only forwards the key.
   */
  idempotencyKey?: string;
  /**
   * Aborts when the caller's forwarded deadline elapses. Present only when the caller sent one.
   * Pass it to outbound `fetch` calls and long-running work so a handler stops doing work nobody is
   * waiting for; the wrapper also fails the method on abort, so ignoring it costs the work, not
   * correctness. Over a session transport the budget is fixed when the session opens and therefore
   * bounds every call on it, not each call separately.
   */
  signal?: AbortSignal;
};

/**
 * `Iterable & object` keeps plain strings out: a string is Iterable<string>, but handing one
 * back from a streaming method is almost certainly a bug, and the runtime rejects it.
 */
export type AbilityStreamSource<TItem> = AsyncIterable<TItem> | (Iterable<TItem> & object) | ReadableStream<TItem>;

// Streamed items are re-validated against `output`, so handlers must yield the schema's INPUT
// shape: for transforming schemas (pipes, coercions) the transformed output would fail
// re-validation, so unlike unary methods the output side is not accepted here.
type AbilityMethodItem<TMethod extends AbilityMethodDefinition> = AbilitySchemaInput<TMethod['output']>;

export type AbilityImplementation<TAbility extends ServiceAbilityDefinition> = {
  [TMethod in keyof TAbility['methods']]: TAbility['methods'][TMethod] extends { stream: true }
    ? (
        input: AbilitySchemaOutput<TAbility['methods'][TMethod]['input']>,
      ) =>
        | AbilityStreamSource<AbilityMethodItem<TAbility['methods'][TMethod]>>
        | Promise<AbilityStreamSource<AbilityMethodItem<TAbility['methods'][TMethod]>>>
    : (
        input: AbilitySchemaOutput<TAbility['methods'][TMethod]['input']>,
      ) =>
        | Promise<AbilitySchemaInput<TAbility['methods'][TMethod]['output']> | AbilitySchemaOutput<TAbility['methods'][TMethod]['output']>>
        | AbilitySchemaInput<TAbility['methods'][TMethod]['output']>
        | AbilitySchemaOutput<TAbility['methods'][TMethod]['output']>;
};

/**
 * Streaming methods resolve to a native Cap'n Web ReadableStream of validated items; they
 * require a session transport (WebSocket, native binding, custom bidirectional).
 */
export type AbilityRpc<TAbility extends ServiceAbilityDefinition> = {
  [TMethod in keyof TAbility['methods']]: TAbility['methods'][TMethod] extends { stream: true }
    ? (
        input: AbilitySchemaInput<TAbility['methods'][TMethod]['input']>,
      ) => Promise<ReadableStream<AbilitySchemaOutput<TAbility['methods'][TMethod]['output']>>>
    : (
        input: AbilitySchemaInput<TAbility['methods'][TMethod]['input']>,
      ) => Promise<AbilitySchemaOutput<TAbility['methods'][TMethod]['output']>>;
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

/**
 * Returns the definition's own type (not the widened AbilityMethodDefinition) so the
 * `stream: true` discriminator survives into AbilityRpc and AbilityImplementation.
 */
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
    abilities: normalizeAbilities(serviceId, input.abilities, input.capabilities, options.requireAbilityScopes ?? true),
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
  /**
   * Cap'n Web streams need an ongoing session. Defaults to false (fail-closed): a caller must
   * opt in only for a session transport (WebSocket upgrade, native binding). Over HTTP-batch,
   * streaming methods then fail with a clear 405 instead of a dangling stub after the batch ends.
   */
  allowStreaming?: boolean;
  /**
   * The caller's forwarded deadline. A method whose handler outlives it fails with a timeout error
   * rather than resolving late, so a handler that ignores its `signal` still cannot exceed the
   * budget the caller was promised.
   */
  signal?: AbortSignal;
};

type ValidatingAbilityHandlerState = {
  abilityId: string;
  allowStreaming: boolean;
  disposed: boolean;
  handler: RpcTarget & Record<string, unknown>;
  methods: Record<string, NormalizedAbilityMethodDefinition>;
  signal?: AbortSignal;
};

type ValidatingAbilityHandlerConstructor = new () => RpcTarget;

// Ability definitions are long-lived while handler instances are created per session. Reusing
// the generated class avoids rebuilding an identical prototype on every authenticated call while
// WeakMap state keeps caller-specific data out of Cap'n Web's remotely visible object surface.
const validatingHandlerConstructorByAbility = new WeakMap<object, ValidatingAbilityHandlerConstructor>();
const validatingHandlerStateByTarget = new WeakMap<object, ValidatingAbilityHandlerState>();

export function createValidatingAbilityHandler<TEnv extends Env>(
  ability: NormalizedServiceAbility<TEnv>,
  handler: RpcTarget & Record<string, unknown>,
  identity: CapabilityIdentity,
  options: CreateValidatingAbilityHandlerOptions = {},
): RpcTarget {
  // A handler instance carries one caller's identity; a factory that returns a shared
  // instance would let concurrent sessions overwrite each other's identity and scopes.
  if (capabilityIdentity(handler)) {
    throw new CapabilityAuthError(`Service-Plane ability handler factory must return a new instance per call: ${ability.id}`, 500);
  }
  bindCapabilityIdentity(handler, identity);

  const ValidatingAbilityHandler = validatingAbilityHandlerConstructor(ability);
  const target = new ValidatingAbilityHandler();
  validatingHandlerStateByTarget.set(target, {
    abilityId: ability.id,
    allowStreaming: options.allowStreaming ?? false,
    disposed: false,
    handler,
    methods: ability.methods,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return bindCapabilityIdentity(target, identity);
}

function validatingAbilityHandlerConstructor<TEnv extends Env>(
  ability: NormalizedServiceAbility<TEnv>,
): ValidatingAbilityHandlerConstructor {
  const cached = validatingHandlerConstructorByAbility.get(ability);
  if (cached) return cached;

  class ValidatingAbilityHandler extends RpcTarget {
    [Symbol.dispose](): void {
      disposeValidatingAbilityHandler(this);
    }
  }

  for (const methodName of Object.keys(ability.methods)) {
    Object.defineProperty(ValidatingAbilityHandler.prototype, methodName, {
      async value(this: RpcTarget, ...args: unknown[]) {
        return invokeValidatingAbilityMethod(this, methodName, args);
      },
    });
  }

  validatingHandlerConstructorByAbility.set(ability, ValidatingAbilityHandler);
  return ValidatingAbilityHandler;
}

async function invokeValidatingAbilityMethod(target: RpcTarget, methodName: string, args: unknown[]): Promise<unknown> {
  const state = activeValidatingAbilityHandlerState(target);
  const method = state.methods[methodName];
  if (!method) throw new AbilityValidationError(`Unknown Service-Plane ability method: ${methodName}`, 404);
  if (method.stream && !state.allowStreaming) {
    throw new AbilityValidationError(
      `Service-Plane streaming method requires a session transport (WebSocket, native binding, or custom bidirectional): ${methodName}`,
      405,
    );
  }
  if (args.length !== 1) {
    throw new AbilityValidationError(`Service-Plane ability method expects a single input object: ${methodName}`, 422);
  }

  requireScopes(target, ...method.scopes);
  const implementation = state.handler[methodName];
  if (typeof implementation !== 'function') {
    throw new AbilityValidationError(`Service-Plane ability handler does not implement method: ${methodName}`, 500);
  }

  const input = await validateAbilityValue(method.input, args[0], `input for ${methodName}`, 422);
  activeValidatingAbilityHandlerState(target);
  // Checked after validation rather than before: a budget already gone means the caller stopped
  // waiting, so there is nothing to gain by running the handler.
  assertDeadlineNotExceeded(state.signal, methodName);
  let output: unknown;
  try {
    output = await abortableAbilityCall(implementation.call(state.handler, input), state.signal, methodName);
  } catch (error) {
    throw abilityHandlerFailure(error, methodName);
  }
  // Streaming methods return their items as a native Cap'n Web ReadableStream, validated
  // one item at a time as the consumer pulls.
  if (method.stream) return validatedAbilityItemStream(method, methodName, output);
  return validateAbilityValue(method.output, output, `output for ${methodName}`, 500);
}

/**
 * The one place a handler's failure becomes what the caller sees.
 *
 * Errors this package raised are deliberate — a scope refusal, a schema failure, a deadline — and
 * already say only what a caller should know, so they pass through. `AbilityHandlerError` is a
 * service author making the same choice explicitly. Everything else is whatever the handler's
 * dependencies threw: those messages and properties were written for an operator, not a caller, and
 * routinely carry connection strings, internal hostnames, SQL, or row data. Only the fact of the
 * failure crosses the boundary; the original stays reachable in-process through
 * `handlerFailureCause` for logging.
 */
function abilityHandlerFailure(error: unknown, methodName: string): unknown {
  if (error instanceof ServicePlaneError) return error;
  const opaque = new ServicePlaneError(`Service-Plane ability handler failed: ${methodName}`, 500);
  rememberHandlerFailureCause(opaque, error);
  return opaque;
}

function assertDeadlineNotExceeded(signal: AbortSignal | undefined, methodName: string): void {
  if (signal?.aborted) {
    throw new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its caller's deadline: ${methodName}`);
  }
}

// The handler keeps running after an abort — JavaScript cannot interrupt it, and a handler that
// honours its `signal` stops on its own. What this guarantees is the contract the caller was given:
// the method never resolves after the budget is gone. The losing outcome stays handled so a late
// rejection cannot surface as an unhandled one.
function abortableAbilityCall(call: unknown, signal: AbortSignal | undefined, methodName: string): Promise<unknown> {
  const settled = Promise.resolve(call);
  if (!signal) return settled;
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () =>
      reject(new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its caller's deadline: ${methodName}`));
    signal.addEventListener('abort', onAbort, { once: true });
    settled.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}

// Standard Schema reports failures as issues rather than by throwing, so the boundary that owns
// the caller/handler distinction turns them into an error: a bad input is the caller's fault
// (422), a bad output means the handler broke its own contract (500). Schemas come from a
// library this package never sees, so every deviation from the contract must fail closed here:
// an unrecognized result would otherwise hand the handler unvalidated data.
async function validateAbilityValue(schema: AbilitySchema, value: unknown, source: string, status: number): Promise<unknown> {
  let result: StandardSchemaV1.Result<unknown>;
  try {
    result = await schema['~standard'].validate(value);
  } catch (error) {
    // A validator that throws instead of returning issues still means "this value is invalid";
    // reporting it as an unclassified error would hide whose fault the call was.
    throw new AbilityValidationError(`Service-Plane ability ${source}: ${errorMessage(error)}`, status);
  }
  if (result?.issues) {
    throw new AbilityValidationError(
      `Service-Plane ability ${source}: ${formatSchemaIssues(result.issues)}`,
      status,
      normalizeSchemaIssues(result.issues),
    );
  }
  if (!result || !('value' in result)) {
    throw new AbilityValidationError(`Service-Plane ability ${source}: schema returned no validated value`, status);
  }
  return result.value;
}

// Flattens the vendor's issues into the package's own shape so consumers can read them without
// depending on the spec package, and so a malformed issue cannot escape into a caught error.
function normalizeSchemaIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): AbilityValidationIssue[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    const segments = issue?.path;
    const path = Array.isArray(segments) ? segments.map(schemaIssuePathKey) : undefined;
    return { message: issue?.message ?? 'invalid value', ...(path ? { path } : {}) };
  });
}

function schemaIssuePathKey(segment: unknown): PropertyKey {
  const key = segment && typeof segment === 'object' ? (segment as { key?: unknown }).key : segment;
  return typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol' ? key : String(key);
}

function formatSchemaIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  if (!Array.isArray(issues) || issues.length === 0) return 'schema reported no issue detail';
  return issues.map(formatSchemaIssue).join('; ');
}

function formatSchemaIssue(issue: StandardSchemaV1.Issue | undefined): string {
  const message = issue?.message ?? 'invalid value';
  const segments = issue?.path;
  if (!Array.isArray(segments) || segments.length === 0) return message;
  const path = segments.map(formatSchemaIssuePathSegment).join('.');
  return path ? `${path}: ${message}` : message;
}

function formatSchemaIssuePathSegment(segment: unknown): string {
  return String(schemaIssuePathKey(segment));
}

function activeValidatingAbilityHandlerState(target: RpcTarget): ValidatingAbilityHandlerState {
  const state = validatingHandlerStateByTarget.get(target);
  if (!state) throw new AbilityValidationError('Service-Plane ability handler is not initialized', 500);
  if (state.disposed) {
    throw new AbilityValidationError(`Service-Plane ability handler has been disposed: ${state.abilityId}`, 410);
  }
  return state;
}

function disposeValidatingAbilityHandler(target: RpcTarget): void {
  const state = validatingHandlerStateByTarget.get(target);
  if (!state || state.disposed) return;
  state.disposed = true;
  const dispose = (state.handler as RpcTarget & Partial<Disposable>)[Symbol.dispose];
  dispose?.call(state.handler);
}

// Wraps a handler's stream source into a ReadableStream that validates each item lazily, so
// backpressure from the consumer reaches the handler's generator untouched.
function validatedAbilityItemStream(
  method: NormalizedAbilityMethodDefinition,
  methodName: string,
  source: unknown,
): ReadableStream<unknown> {
  const puller = abilityStreamPuller(source, methodName);
  // Constant for the whole stream; building it per item would allocate once per pull for a
  // message that is only read when an item fails validation.
  const itemSource = `stream item for ${methodName}`;
  return new ReadableStream<unknown>({
    cancel(reason) {
      // Cancel the underlying source directly and without awaiting: an async generator's
      // return() queues behind an in-flight next(), and a disconnected consumer must not
      // keep the handler pinned while it waits for the next chunk that may never come.
      puller.cancel(reason);
    },
    async pull(controller) {
      try {
        const next = await puller.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(await validateAbilityValue(method.output, next.value, itemSource, 500));
      } catch (error) {
        // A failed pull or invalid item errors the stream, which can no longer be cancelled by
        // the consumer. Release the handler's source here so iterator return/finally cleanup and
        // reader locks are not stranded. Cancel with the original — the source's own cleanup is
        // in-process — but surface the same replacement a unary failure would get.
        puller.cancel(error);
        throw abilityHandlerFailure(error, methodName);
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
  serviceId: string,
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

    const methods = normalizeMethods(serviceId, id, ability.methods, scopes, knownScopes, capabilities, requireAbilityScopes);
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

const CAPNWEB_RPC_PROMISE_PROTOTYPE = (RpcPromise as unknown as { prototype: object }).prototype;

// Cap'n Web treats its promise/stub prototype members as local control operations rather than
// remote method names. Reject them when defining the ability instead of publishing an API that a
// caller cannot invoke. `invoke` is retained for compatibility with the former wrapper dispatcher.
function isReservedMethodName(methodName: string): boolean {
  return methodName === 'invoke' || methodName in CAPNWEB_RPC_PROMISE_PROTOTYPE;
}

function normalizeMethods(
  serviceId: string,
  abilityId: string,
  methods: AbilityMethodDefinitions,
  abilityScopes: string[],
  knownScopes: Set<string>,
  capabilities: CapabilityCatalog | undefined,
  requireAbilityScopes: boolean,
): Record<string, NormalizedAbilityMethodDefinition> {
  const names = Object.keys(methods);
  if (names.length === 0) throw new CapabilityAuthError(`Service-Plane ability must define at least one method: ${abilityId}`, 500);

  // Names are trimmed below, so two distinct keys can collapse into one. Without this guard the
  // later definition silently wins and the earlier method's scopes stop being enforced.
  const seenNames = new Set<string>();

  return Object.fromEntries(
    names.map((methodName) => {
      const name = normalizeValue(methodName, `method name for ${abilityId}`);
      if (isReservedMethodName(name)) {
        throw new CapabilityAuthError(`Service-Plane ability method name is reserved: ${abilityId}/${name}`, 500);
      }
      if (seenNames.has(name)) {
        throw new CapabilityAuthError(`Service-Plane ability method name is duplicated: ${abilityId}/${name}`, 500);
      }
      seenNames.add(name);
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
          inputSchema: abilityJsonSchema(
            method.input,
            'input',
            `${abilityId}/${name}`,
            schemaResourceId(serviceId, abilityId, name, 'input'),
          ),
          ...(mcp ? { mcp } : {}),
          ...(mcpPrompt ? { mcpPrompt } : {}),
          ...(mcpResource ? { mcpResource } : {}),
          outputSchema: abilityJsonSchema(
            method.output,
            'output',
            `${abilityId}/${name}`,
            schemaResourceId(serviceId, abilityId, name, 'output'),
          ),
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
          ...(method.idempotent ? { idempotent: true as const } : {}),
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
