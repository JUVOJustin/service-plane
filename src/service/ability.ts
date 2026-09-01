import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { Context, Env } from 'hono';
import type { ConnInfo } from '../shared/conn-info.js';
import type {
  CapabilityIdentity,
  ServiceAbilityMcpProjection,
  ServiceAbilityMcpPromptProjection,
  ServiceAbilityMcpResourceProjection,
  ServiceAbilityRestProjection,
} from '../shared/types.js';

/** A validation schema that can also be projected into discovery, OpenAPI, and MCP. */
export type AbilitySchema = StandardSchemaV1 & StandardJSONSchemaV1;

/** WebSocket capabilities exposed to a method without coupling its contract to an RPC engine. */
export type ServiceAbilityWebSocket = {
  /** Reads a Durable Object Hibernation attachment when the runtime supports it. */
  deserializeAttachment?: () => unknown;
  /** Writes an application frame to the authorized socket; the transport owns framing and delivery. */
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): unknown;
  /** Stores a Durable Object Hibernation attachment when the runtime supports it. */
  serializeAttachment?: (attachment: unknown) => void;
};

/** Runtime context injected only after Service Plane has authenticated and authorized the call. */
export type AbilityMethodContext<TEnv extends Env = Env> = {
  /** The ability owning the running method. */
  abilityId: string;
  /** Public method currently executing, useful for correctly scoped deduplication and metrics. */
  methodName: string;
  /** Advisory connection information forwarded by an authenticated control plane. */
  connInfo?: ConnInfo;
  /** Runtime bindings without requiring method code to depend on Hono. */
  env: TEnv['Bindings'];
  /** Raw transport request for headers and other request-local data. */
  request: Request;
  /** Advanced escape hatch for Hono-specific context features and middleware variables. */
  context: Context<TEnv>;
  /** The verified capability identity. */
  identity: CapabilityIdentity;
  /** Caller-provided key identifying this logical attempt. */
  idempotencyKey?: string;
  /** Reads the caller deadline budget remaining on this machine. */
  remainingTimeoutMs?: () => number;
  /** Aborts when the caller disconnects or its forwarded deadline elapses. */
  signal?: AbortSignal;
  /** Current socket for WebSocket methods, including Durable Object attachment APIs. */
  webSocket?: ServiceAbilityWebSocket;
};

/** Metadata Service Plane attaches to one method for policy and projections. */
export type AbilityMethodMetadata = {
  /** Marks a method safe to retry after an ambiguous transport failure. */
  readonly idempotent?: true;
  /** Publishes the method as an MCP tool. */
  readonly mcp?: ServiceAbilityMcpProjection;
  /** Publishes the method as an MCP prompt. */
  readonly mcpPrompt?: ServiceAbilityMcpPromptProjection;
  /** Publishes the method as an MCP resource. */
  readonly mcpResource?: ServiceAbilityMcpResourceProjection;
  /** Publishes the method as a REST operation. */
  readonly rest?: ServiceAbilityRestProjection;
  /** Minimum capability scopes required before input validation or handler execution. */
  readonly scopes?: ReadonlyArray<string>;
  /** Overrides the service-wide unary execution ceiling; zero disables the ceiling. */
  readonly timeoutMs?: number;
};

/** Execution shape of a method independent of its wire protocol. */
export type AbilityMethodKind = 'hibernation' | 'stream' | 'unary';

declare const ABILITY_METHOD_DEFINITION_BRAND: unique symbol;

/**
 * Portable method contract. Its phantom type field drives clients and handlers without exposing
 * the RPC engine used to execute it.
 */
export type AbilityMethodDefinition<
  in TEnv extends Env = Env,
  TInput extends AbilitySchema = AbilitySchema,
  TOutput extends AbilitySchema = AbilitySchema,
  TKind extends AbilityMethodKind = AbilityMethodKind,
> = {
  /** Nominal marker: method definitions are created by {@link createAbilityBuilder}. */
  readonly [ABILITY_METHOD_DEFINITION_BRAND]: true;
  /** Validates caller data before handler execution and drives client input inference and projections. */
  readonly input: TInput;
  /** Whether the method returns one value, a stream, or a hibernating subscription. */
  readonly kind: TKind;
  /** Service Plane policy and projection metadata. */
  readonly metadata: AbilityMethodMetadata;
  /** Validates each boundary result and drives client output inference and projections. */
  readonly output: TOutput;
  /** Compile-time method information; absent at runtime. */
  readonly '~types'?: {
    /** Environment accepted by the method context; the function shape preserves safe contravariance. */
    readonly env: (value: TEnv) => void;
    /** Value delivered to the handler after input validation. */
    readonly input: StandardSchemaV1.InferOutput<TInput>;
    /** Value exposed to the client after output validation. */
    readonly output: StandardSchemaV1.InferOutput<TOutput>;
  };
};

/** Any portable method contract accepted by an ability. */
export type AnyAbilityMethodDefinition<TEnv extends Env = never> = AbilityMethodDefinition<
  TEnv,
  AbilitySchema,
  AbilitySchema,
  AbilityMethodKind
>;

/** Extracts the Hono environment required by one method without depending on its phantom type shape. */
export type AbilityMethodEnvironment<TMethod extends AnyAbilityMethodDefinition<never>> =
  TMethod extends AbilityMethodDefinition<infer TEnv, infer _TInput, infer _TOutput, infer _TKind> ? TEnv : never;

type Promisable<T> = T | Promise<T>;

/** Async iterator returned by streaming ability clients. */
export type AbilityStream<T> = AsyncIterable<T> & AsyncIterator<T, unknown, void>;

/** Runtime-neutral source accepted from an ordinary streaming ability handler. */
export type AbilityStreamSource<T> = AsyncIterable<T> | (Iterable<T> & object) | ReadableStream<T>;

type UnaryHandler<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = (options: {
  context: AbilityMethodContext<TEnv>;
  input: StandardSchemaV1.InferOutput<TInput>;
}) => Promisable<StandardSchemaV1.InferInput<TOutput>>;

type StreamHandler<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = (options: {
  context: AbilityMethodContext<TEnv>;
  input: StandardSchemaV1.InferOutput<TInput>;
}) => Promisable<AbilityStreamSource<StandardSchemaV1.InferInput<TOutput>>>;

type HibernationHandler<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = (options: {
  context: AbilityMethodContext<TEnv>;
  input: StandardSchemaV1.InferOutput<TInput>;
}) => Promisable<AbilityHibernationStream<StandardSchemaV1.InferInput<TOutput>>>;

type AbilityMethodHandler = (options: { context: AbilityMethodContext; input: unknown }) => Promisable<unknown>;

const methodHandlers = new WeakMap<object, AbilityMethodHandler>();
const methodDefinitions = new WeakSet<object>();
const hibernationCallbacks = new WeakMap<object, (id: string) => Promisable<void>>();

/**
 * Describes a hibernating subscription without exposing the wire engine's iterator class.
 */
export class AbilityHibernationStream<T> {
  // The generic is deliberately carried only in the class type; values arrive after the original
  // handler returned and are validated by encodeAbilityHibernationEvent.
  private declare readonly output: T;

  constructor(onSubscribe: (id: string) => Promisable<void>) {
    hibernationCallbacks.set(this, onSubscribe);
  }
}

/** Converts a readable, iterable, or async iterable source to the iterator used on the wire. */
export function toAbilityStream<T>(source: AbilityStreamSource<T>): AbilityStream<T> {
  if (isAbilityStream(source)) return source;
  if (isReadableStream(source)) return readableAbilityStream(source);
  if (!source || typeof source !== 'object') {
    throw new TypeError('Service-Plane stream handler must return a ReadableStream, iterable, or async iterable object');
  }
  if (Symbol.asyncIterator in source) return iteratorAbilityStream(source[Symbol.asyncIterator]());
  if (Symbol.iterator in source) return iteratorAbilityStream(source[Symbol.iterator]());
  throw new TypeError('Service-Plane stream handler must return a ReadableStream, iterable, or async iterable object');
}

/** Reads the handler kept outside the serializable method contract. */
export function abilityMethodHandler(method: AnyAbilityMethodDefinition<never>): AbilityMethodHandler {
  const handler = methodHandlers.get(method);
  if (!handler) throw new TypeError('Service-Plane method has no handler');
  return handler;
}

/** Returns whether a portable method contract already has a service-side implementation. */
export function isImplementedAbilityMethod(method: AnyAbilityMethodDefinition<never>): boolean {
  return methodHandlers.has(method);
}

/** Reads the subscription callback used by the internal hibernation runtime. */
export function abilityHibernationCallback(stream: AbilityHibernationStream<unknown>): (id: string) => Promisable<void> {
  const callback = hibernationCallbacks.get(stream);
  if (!callback) throw new TypeError('Invalid Service-Plane hibernation stream');
  return callback;
}

/** Returns true only for a method produced by createAbilityBuilder. */
export function isAbilityMethodDefinition(value: unknown): value is AnyAbilityMethodDefinition<never> {
  return Boolean(value && typeof value === 'object' && methodDefinitions.has(value as object));
}

/** Concise unary method declaration, optionally carrying an inline implementation. */
export type AbilityUnaryMethodOptions<
  TEnv extends Env,
  TInput extends AbilitySchema,
  TOutput extends AbilitySchema,
> = AbilityMethodMetadata & {
  /** Validates caller data before handler execution and drives client input inference. */
  readonly input: TInput;
  /** Validates the returned value before transport and drives client output inference. */
  readonly output: TOutput;
  /** Optional inline implementation; omit it in a shared client/server contract. */
  readonly handler?: UnaryHandler<TEnv, TInput, TOutput>;
};

/** Concise stream declaration, optionally carrying an inline implementation. */
export type AbilityStreamMethodOptions<
  TEnv extends Env,
  TInput extends AbilitySchema,
  TOutput extends AbilitySchema,
  TKind extends 'hibernation' | 'stream',
> = AbilityMethodMetadata & {
  /** Validates subscription arguments before the handler runs and drives client input inference. */
  readonly input: TInput;
  /** Validates every yielded item before transport and drives client item inference. */
  readonly output: TOutput;
  /** Optional inline implementation; omit it in a shared client/server contract. */
  readonly handler?: TKind extends 'hibernation' ? HibernationHandler<TEnv, TInput, TOutput> : StreamHandler<TEnv, TInput, TOutput>;
};

/** Correct handler signature inferred from one portable method contract. */
export type AbilityMethodHandlerFor<TMethod extends AnyAbilityMethodDefinition<never>> =
  TMethod extends AbilityMethodDefinition<infer TEnv, infer TInput, infer TOutput, infer TKind>
    ? TKind extends 'unary'
      ? UnaryHandler<TEnv, TInput, TOutput>
      : TKind extends 'hibernation'
        ? HibernationHandler<TEnv, TInput, TOutput>
        : StreamHandler<TEnv, TInput, TOutput>
    : never;

/** Transport-neutral method factory for portable contracts and optional inline implementations. */
export type AbilityBuilder<TEnv extends Env> = {
  /** Declares a hibernating stream, optionally with an inline implementation. */
  hibernationStream<TInput extends AbilitySchema, TOutput extends AbilitySchema>(
    options: AbilityStreamMethodOptions<TEnv, TInput, TOutput, 'hibernation'>,
  ): AbilityMethodDefinition<TEnv, TInput, TOutput, 'hibernation'>;
  /** Declares a unary method, optionally with an inline implementation. */
  method<TInput extends AbilitySchema, TOutput extends AbilitySchema>(
    options: AbilityUnaryMethodOptions<TEnv, TInput, TOutput>,
  ): AbilityMethodDefinition<TEnv, TInput, TOutput, 'unary'>;
  /** Declares an ordinary stream, optionally with an inline implementation. */
  stream<TInput extends AbilitySchema, TOutput extends AbilitySchema>(
    options: AbilityStreamMethodOptions<TEnv, TInput, TOutput, 'stream'>,
  ): AbilityMethodDefinition<TEnv, TInput, TOutput, 'stream'>;
};

/** Creates transport-neutral method definitions from one explicit options object per method. */
export function createAbilityBuilder<TEnv extends Env = Env>(): AbilityBuilder<TEnv> {
  return {
    hibernationStream<TInput extends AbilitySchema, TOutput extends AbilitySchema>(
      options: AbilityStreamMethodOptions<TEnv, TInput, TOutput, 'hibernation'>,
    ) {
      const { handler, input, output, ...metadata } = options;
      return defineMethod('hibernation', metadata, input, output, handler as AbilityMethodHandler | undefined);
    },
    method<TInput extends AbilitySchema, TOutput extends AbilitySchema>(options: AbilityUnaryMethodOptions<TEnv, TInput, TOutput>) {
      const { handler, input, output, ...metadata } = options;
      return defineMethod('unary', metadata, input, output, handler as AbilityMethodHandler | undefined);
    },
    stream<TInput extends AbilitySchema, TOutput extends AbilitySchema>(
      options: AbilityStreamMethodOptions<TEnv, TInput, TOutput, 'stream'>,
    ) {
      const { handler, input, output, ...metadata } = options;
      return defineMethod('stream', metadata, input, output, handler as AbilityMethodHandler | undefined);
    },
  };
}

/** Binds one contract method to a service-side handler without mutating the shared contract. */
export function implementAbilityMethod<TMethod extends AnyAbilityMethodDefinition<never>>(
  method: TMethod,
  handler: AbilityMethodHandlerFor<TMethod>,
): TMethod {
  if (!isAbilityMethodDefinition(method)) throw new TypeError('Service-Plane method must be created with createAbilityBuilder');
  if (typeof handler !== 'function') throw new TypeError('Service-Plane method implementation must be a function');
  const implemented = Object.freeze({ ...method, metadata: immutableAbilityMethodMetadata(method.metadata) }) as TMethod;
  methodDefinitions.add(implemented);
  methodHandlers.set(implemented, handler as unknown as AbilityMethodHandler);
  return implemented;
}

function defineMethod<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema, TKind extends AbilityMethodKind>(
  kind: TKind,
  metadata: AbilityMethodMetadata,
  input: TInput,
  output: TOutput,
  handler?: AbilityMethodHandler,
): AbilityMethodDefinition<TEnv, TInput, TOutput, TKind> {
  const definition = Object.freeze({
    input,
    kind,
    metadata: immutableAbilityMethodMetadata(metadata),
    output,
  }) as AbilityMethodDefinition<TEnv, TInput, TOutput, TKind>;
  methodDefinitions.add(definition);
  if (handler) methodHandlers.set(definition, handler);
  return definition;
}

function immutableAbilityMethodMetadata(metadata: AbilityMethodMetadata): AbilityMethodMetadata {
  return Object.freeze({
    ...metadata,
    ...(metadata.mcp ? { mcp: Object.freeze({ ...metadata.mcp }) } : {}),
    ...(metadata.mcpPrompt
      ? {
          mcpPrompt: Object.freeze({
            ...metadata.mcpPrompt,
            ...(metadata.mcpPrompt.arguments
              ? { arguments: Object.freeze(metadata.mcpPrompt.arguments.map((argument) => Object.freeze({ ...argument }))) }
              : {}),
          }),
        }
      : {}),
    ...(metadata.mcpResource ? { mcpResource: Object.freeze({ ...metadata.mcpResource }) } : {}),
    ...(metadata.rest
      ? {
          rest: Object.freeze({
            ...metadata.rest,
            ...(metadata.rest.tags ? { tags: Object.freeze([...metadata.rest.tags]) } : {}),
          }),
        }
      : {}),
    ...(metadata.scopes ? { scopes: Object.freeze([...metadata.scopes]) } : {}),
  });
}

function isReadableStream<T>(value: AbilityStreamSource<T>): value is ReadableStream<T> {
  return Boolean(value && typeof value === 'object' && typeof (value as ReadableStream<T>).getReader === 'function');
}

function isAbilityStream<T>(value: AbilityStreamSource<T>): value is AbilityStream<T> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as unknown as AsyncIterator<T>).next === 'function' &&
      typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === 'function',
  );
}

function iteratorAbilityStream<T>(iterator: AsyncIterator<T, unknown, void> | Iterator<T, unknown, void>): AbilityStream<T> {
  let closed = false;
  const stream: AbilityStream<T> = {
    [Symbol.asyncIterator]: () => stream,
    async next(value) {
      if (closed) return { done: true, value: undefined };
      try {
        const item = await iterator.next(value);
        if (item.done) closed = true;
        return item;
      } catch (error) {
        closed = true;
        throw error;
      }
    },
    async return(value) {
      if (closed) return { done: true, value };
      closed = true;
      return iterator.return ? iterator.return(value) : { done: true, value };
    },
    async throw(error) {
      if (closed) throw error;
      closed = true;
      if (iterator.throw) return iterator.throw(error);
      if (iterator.return) await iterator.return();
      throw error;
    },
  };
  return stream;
}

function readableAbilityStream<T>(source: ReadableStream<T>): AbilityStream<T> {
  const reader = source.getReader();
  let closed = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancel = async (reason?: unknown) => {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const stream: AbilityStream<T> = {
    [Symbol.asyncIterator]: () => stream,
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        const item = await reader.read();
        if (item.done) {
          closed = true;
          release();
        }
        return item;
      } catch (error) {
        closed = true;
        release();
        throw error;
      }
    },
    async return(value) {
      await cancel(value);
      return { done: true, value };
    },
    async throw(error) {
      await cancel(error);
      throw error;
    },
  };
  return stream;
}
