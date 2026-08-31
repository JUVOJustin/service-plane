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
  /** Sends a WebSocket frame. */
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): unknown;
  /** Stores a Durable Object Hibernation attachment when the runtime supports it. */
  serializeAttachment?: (attachment: unknown) => void;
};

/** Runtime context injected only after Service Plane has authenticated and authorized the call. */
export type AbilityMethodContext<TEnv extends Env = Env> = {
  /** The ability owning the running method. */
  abilityId: string;
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
  idempotent?: true;
  /** Publishes the method as an MCP tool. */
  mcp?: ServiceAbilityMcpProjection;
  /** Publishes the method as an MCP prompt. */
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  /** Publishes the method as an MCP resource. */
  mcpResource?: ServiceAbilityMcpResourceProjection;
  /** Publishes the method as a REST operation. */
  rest?: ServiceAbilityRestProjection;
  /** Minimum capability scopes required before input validation or handler execution. */
  scopes?: string[];
  /** Overrides the service-wide unary execution ceiling; zero disables the ceiling. */
  timeoutMs?: number;
};

/** Execution shape of a method independent of its wire protocol. */
export type AbilityMethodKind = 'hibernation' | 'stream' | 'unary';

/**
 * Portable method contract. Its phantom type field drives clients and handlers without exposing
 * the RPC engine used to execute it.
 */
export type AbilityMethodDefinition<
  TEnv extends Env = Env,
  TInput extends AbilitySchema = AbilitySchema,
  TOutput extends AbilitySchema = AbilitySchema,
  TKind extends AbilityMethodKind = AbilityMethodKind,
> = {
  /** Input schema shared by validation and projections. */
  input: TInput;
  /** Whether the method returns one value, a stream, or a hibernating subscription. */
  kind: TKind;
  /** Service Plane policy and projection metadata. */
  metadata: AbilityMethodMetadata;
  /** Output schema, or yielded-item schema for streams. */
  output: TOutput;
  /** Compile-time method information; absent at runtime. */
  readonly '~types'?: {
    /** Hono environment used by the method context. */
    env: TEnv;
    /** Value delivered to the handler after input validation. */
    input: StandardSchemaV1.InferOutput<TInput>;
    /** Value exposed to the client after output validation. */
    output: StandardSchemaV1.InferOutput<TOutput>;
  };
};

/** Any portable method contract accepted by an ability. */
export type AnyAbilityMethodDefinition<TEnv extends Env = Env> = AbilityMethodDefinition<
  TEnv,
  AbilitySchema,
  AbilitySchema,
  AbilityMethodKind
>;

type Promisable<T> = T | Promise<T>;

/** Async iterator returned by streaming ability clients. */
export type AbilityStream<T> = AsyncIterable<T> & AsyncIterator<T, unknown, void>;

type UnaryHandler<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = (options: {
  context: AbilityMethodContext<TEnv>;
  input: StandardSchemaV1.InferOutput<TInput>;
}) => Promisable<StandardSchemaV1.InferInput<TOutput>>;

type StreamHandler<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = (options: {
  context: AbilityMethodContext<TEnv>;
  input: StandardSchemaV1.InferOutput<TInput>;
}) => Promisable<AbilityStream<StandardSchemaV1.InferInput<TOutput>>>;

type HibernationHandler<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = (options: {
  context: AbilityMethodContext<TEnv>;
  input: StandardSchemaV1.InferOutput<TInput>;
}) => Promisable<AbilityHibernationStream<StandardSchemaV1.InferInput<TOutput>>>;

type AbilityMethodHandler = (options: { context: AbilityMethodContext; input: unknown }) => Promisable<unknown>;

const methodHandlers = new WeakMap<object, AbilityMethodHandler>();
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

/** Reads the handler kept outside the serializable method contract. */
export function abilityMethodHandler(method: AnyAbilityMethodDefinition): AbilityMethodHandler {
  const handler = methodHandlers.get(method);
  if (!handler) throw new TypeError('Service-Plane method has no handler');
  return handler;
}

/** Reads the subscription callback used by the internal hibernation runtime. */
export function abilityHibernationCallback(stream: AbilityHibernationStream<unknown>): (id: string) => Promisable<void> {
  const callback = hibernationCallbacks.get(stream);
  if (!callback) throw new TypeError('Invalid Service-Plane hibernation stream');
  return callback;
}

/** Returns true only for a method produced by createAbilityBuilder. */
export function isAbilityMethodDefinition(value: unknown): value is AnyAbilityMethodDefinition {
  return Boolean(value && typeof value === 'object' && methodHandlers.has(value as object));
}

type UnaryInputBuilder<TEnv extends Env> = {
  /** Declares the method input schema. */
  input<TInput extends AbilitySchema>(input: TInput): UnaryOutputBuilder<TEnv, TInput>;
};

type UnaryOutputBuilder<TEnv extends Env, TInput extends AbilitySchema> = {
  /** Declares the method output schema. */
  output<TOutput extends AbilitySchema>(output: TOutput): UnaryHandlerBuilder<TEnv, TInput, TOutput>;
};

type UnaryHandlerBuilder<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema> = {
  /** Implements the method after Service Plane authorization and input validation. */
  handler(handler: UnaryHandler<TEnv, TInput, TOutput>): AbilityMethodDefinition<TEnv, TInput, TOutput, 'unary'>;
};

type StreamInputBuilder<TEnv extends Env, TOutput extends AbilitySchema, TKind extends 'hibernation' | 'stream'> = {
  /** Declares the stream subscription input schema. */
  input<TInput extends AbilitySchema>(input: TInput): StreamHandlerBuilder<TEnv, TInput, TOutput, TKind>;
};

type StreamHandlerBuilder<
  TEnv extends Env,
  TInput extends AbilitySchema,
  TOutput extends AbilitySchema,
  TKind extends 'hibernation' | 'stream',
> = {
  /** Implements the stream after Service Plane authorization and input validation. */
  handler(
    handler: TKind extends 'hibernation' ? HibernationHandler<TEnv, TInput, TOutput> : StreamHandler<TEnv, TInput, TOutput>,
  ): AbilityMethodDefinition<TEnv, TInput, TOutput, TKind>;
};

/**
 * Creates transport-neutral method builders. The installed RPC engine compiles the resulting
 * contracts internally, so service definitions never expose engine procedures or plugin types.
 */
export function createAbilityBuilder<TEnv extends Env = Env>() {
  return {
    /** Starts a unary ability method. */
    method(metadata: AbilityMethodMetadata = {}): UnaryInputBuilder<TEnv> {
      return {
        input<TInput extends AbilitySchema>(input: TInput) {
          return {
            output<TOutput extends AbilitySchema>(output: TOutput) {
              return {
                handler(handler: UnaryHandler<TEnv, TInput, TOutput>) {
                  return defineMethod<TEnv, TInput, TOutput, 'unary'>(
                    'unary',
                    metadata,
                    input,
                    output,
                    handler as unknown as AbilityMethodHandler,
                  );
                },
              };
            },
          };
        },
      };
    },
    /** Starts a streaming method whose yielded items are validated with output. */
    stream<TOutput extends AbilitySchema>(
      output: TOutput,
      metadata: AbilityMethodMetadata = {},
    ): StreamInputBuilder<TEnv, TOutput, 'stream'> {
      return streamBuilder<TEnv, TOutput, 'stream'>('stream', metadata, output);
    },
    /** Starts a stream whose subscription can survive a Durable Object hibernation cycle. */
    hibernationStream<TOutput extends AbilitySchema>(
      output: TOutput,
      metadata: AbilityMethodMetadata = {},
    ): StreamInputBuilder<TEnv, TOutput, 'hibernation'> {
      return streamBuilder<TEnv, TOutput, 'hibernation'>('hibernation', metadata, output);
    },
  };
}

function streamBuilder<TEnv extends Env, TOutput extends AbilitySchema, TKind extends 'hibernation' | 'stream'>(
  kind: TKind,
  metadata: AbilityMethodMetadata,
  output: TOutput,
): StreamInputBuilder<TEnv, TOutput, TKind> {
  return {
    input<TInput extends AbilitySchema>(input: TInput) {
      return {
        handler(handler: TKind extends 'hibernation' ? HibernationHandler<TEnv, TInput, TOutput> : StreamHandler<TEnv, TInput, TOutput>) {
          return defineMethod<TEnv, TInput, TOutput, TKind>(kind, metadata, input, output, handler as unknown as AbilityMethodHandler);
        },
      };
    },
  };
}

function defineMethod<TEnv extends Env, TInput extends AbilitySchema, TOutput extends AbilitySchema, TKind extends AbilityMethodKind>(
  kind: TKind,
  metadata: AbilityMethodMetadata,
  input: TInput,
  output: TOutput,
  handler: AbilityMethodHandler,
): AbilityMethodDefinition<TEnv, TInput, TOutput, TKind> {
  const definition: AbilityMethodDefinition<TEnv, TInput, TOutput, TKind> = {
    input,
    kind,
    metadata: { ...metadata },
    output,
  };
  methodHandlers.set(definition, handler);
  return definition;
}
