import { wrapAsyncIteratorPreservingEventMeta } from '@orpc/client';
import { type AnySchema, asyncIteratorObject, defineMeta, getAsyncIteratorObjectSchemaDetails } from '@orpc/contract';
import { type EncodeHibernationRPCEventOptions, encodeHibernationRPCEvent, HibernationAsyncIteratorClass } from '@orpc/hibernation';
import { type AnyProcedure, ORPCError, os, Procedure, ValidationError } from '@orpc/server';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Context, Env } from 'hono';
import type { ConnInfo } from '../shared/conn-info.js';
import { discardDisposableValue, raceDeadline } from '../shared/deadline.js';
import {
  AbilityValidationError,
  type AbilityValidationIssue,
  rememberHandlerFailureCause,
  ServicePlaneError,
  type ServicePlaneErrorInfo,
  ServicePlaneTimeoutError,
  servicePlaneErrorInfo,
} from '../shared/errors.js';
import type {
  CapabilityIdentity,
  ServiceAbilityMcpProjection,
  ServiceAbilityMcpPromptProjection,
  ServiceAbilityMcpResourceProjection,
  ServiceAbilityRestProjection,
} from '../shared/types.js';
import type { AbilitySchema, ServiceAbilityWebSocket } from './discovery.js';

/** Metadata Service Plane adds to an oRPC procedure for authorization and projections. */
export type AbilityProcedureMetadata = {
  /** Marks a method safe to retry after an ambiguous transport failure. */
  idempotent?: true;
  /** Publishes the procedure as an MCP tool. */
  mcp?: ServiceAbilityMcpProjection;
  /** Publishes the procedure as an MCP prompt. */
  mcpPrompt?: ServiceAbilityMcpPromptProjection;
  /** Publishes the procedure as an MCP resource. */
  mcpResource?: ServiceAbilityMcpResourceProjection;
  /** Publishes the procedure as a REST operation. */
  rest?: ServiceAbilityRestProjection;
  /** Minimum capability scopes required before input validation or handler execution. */
  scopes?: string[];
  /** Overrides the service-wide unary execution ceiling; zero disables the ceiling. */
  timeoutMs?: number;
};

type StoredAbilityProcedureMetadata = AbilityProcedureMetadata & {
  stream?: true;
};

const [abilityProcedureMetadata, getAbilityProcedureMetadata] = defineMeta<'service-plane:ability-method', StoredAbilityProcedureMetadata>(
  'service-plane:ability-method',
  (incoming, current) => ({ ...current, ...incoming }),
);

const [hibernationOutputMetadata, getHibernationOutputMetadata] = defineMeta<'service-plane:hibernation-output', AbilitySchema>(
  'service-plane:hibernation-output',
  (incoming) => incoming,
);

/** Async stream shape exposed to clients of a hibernating procedure. */
export type AbilityHibernationStream<T> = AsyncIterable<T> & AsyncIterator<T, unknown, void>;

/** Context injected only after Service Plane has authenticated and authorized the call. */
export type AbilityProcedureContext<TEnv extends Env = Env> = {
  /** The ability owning the running procedure. */
  abilityId: string;
  /** Advisory connection information forwarded by an authenticated control plane. */
  connInfo?: ConnInfo;
  /** Runtime bindings without requiring procedure code to depend on Hono. */
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
  /** Current socket for WebSocket procedures, including Durable Object attachment APIs. */
  webSocket?: ServiceAbilityWebSocket;
};

/** Input supplied to the transport-owned authorization callback. */
export type AuthorizeAbilityProcedureInput = {
  /** Router path of the procedure being called. */
  path: string[];
  /** Procedure being called, including its Service Plane metadata. */
  procedure: AnyProcedure;
  /** Transport cancellation signal, when the adapter supplies one. */
  signal?: AbortSignal;
};

/** Runtime policy shared by Fetch, WebSocket, and native service-binding calls. */
export type AbilityProcedureRuntimeOptions<TEnv extends Env = Env> = {
  /** Authenticates and authorizes one procedure before oRPC validates its input. */
  authorize(input: AuthorizeAbilityProcedureInput): Promise<AbilityProcedureContext<TEnv>> | AbilityProcedureContext<TEnv>;
  /** Absolute caller deadline measured with the current process clock. */
  deadlineAt?: number;
  /** Default per-procedure ceiling; false removes the service-wide ceiling. */
  defaultMethodTimeoutMs?: false | number;
  /** Receives handler failures that are replaced by an opaque RPC error. */
  onHandlerFailure?: (cause: unknown, methodName: string) => void;
};

export type ServicePlaneRpcErrorData = {
  /** Transport-safe Service Plane error classification. */
  servicePlane: ServicePlaneErrorInfo;
};

type AbilityProcedureRuntimeContext<TEnv extends Env = Env> = {
  [ABILITY_RUNTIME]: AbilityProcedureRuntimeOptions<TEnv>;
};

const ABILITY_RUNTIME = Symbol('service-plane.ability-runtime');

const servicePlaneRpcErrorDataSchema = {
  '~standard': {
    validate(value: unknown) {
      return isServicePlaneRpcErrorData(value) ? { value } : { issues: [{ message: 'Invalid Service Plane RPC error data' }] };
    },
    vendor: 'service-plane',
    version: 1,
  },
} satisfies import('@standard-schema/spec').StandardSchemaV1<ServicePlaneRpcErrorData>;

const servicePlaneErrorMap = {
  BAD_REQUEST: { data: servicePlaneRpcErrorDataSchema },
  FORBIDDEN: { data: servicePlaneRpcErrorDataSchema },
  GATEWAY_TIMEOUT: { data: servicePlaneRpcErrorDataSchema },
  GONE: { data: servicePlaneRpcErrorDataSchema },
  INTERNAL_SERVER_ERROR: { data: servicePlaneRpcErrorDataSchema },
  METHOD_NOT_SUPPORTED: { data: servicePlaneRpcErrorDataSchema },
  NOT_FOUND: { data: servicePlaneRpcErrorDataSchema },
  SERVICE_UNAVAILABLE: { data: servicePlaneRpcErrorDataSchema },
  TOO_MANY_REQUESTS: { data: servicePlaneRpcErrorDataSchema },
  UNAUTHORIZED: { data: servicePlaneRpcErrorDataSchema },
  UNPROCESSABLE_CONTENT: { data: servicePlaneRpcErrorDataSchema },
} as const;

/**
 * Creates the procedure builders used by one service. Procedures and streams share the same
 * authenticated context while oRPC owns validation, serialization, typed errors, and middleware.
 */
export function createAbilityBuilder<TEnv extends Env = Env>() {
  // This middleware is attached before authors add `.input(...)`, so capability checks execute
  // before validation. It also wraps the whole procedure lifecycle for deadlines and opaque errors.
  const base = os
    .$context<AbilityProcedureRuntimeContext<TEnv>>()
    .errors(servicePlaneErrorMap)
    .use(async ({ context, next, path, procedure, signal }) => {
      const runtime = context[ABILITY_RUNTIME];
      const methodName = path.at(-1) ?? 'unknown';

      try {
        const authorized = await runtime.authorize({ path, procedure, ...(signal ? { signal } : {}) });
        const metadata = abilityProcedureDefinition(procedure);
        const ceilingMs = abilityProcedureStreams(procedure)
          ? undefined
          : resolveProcedureTimeoutMs(metadata.timeoutMs, runtime.defaultMethodTimeoutMs);
        const result = await raceDeadline<{ context: AbilityProcedureContext<TEnv>; output: unknown }>(
          Promise.resolve(next({ context: authorized })),
          {
            ...(ceilingMs === undefined ? {} : { ceilingMs }),
            ceilingError: (limit) =>
              new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its ${limit}ms limit: ${methodName}`),
            ...(runtime.deadlineAt === undefined ? {} : { deadlineAt: runtime.deadlineAt }),
            deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its caller's deadline: ${methodName}`),
            discardLateValue(value) {
              discardDisposableValue((value as { output?: unknown }).output);
            },
          },
        );

        if (
          abilityProcedureStreams(procedure) &&
          runtime.deadlineAt !== undefined &&
          !(result.output instanceof HibernationAsyncIteratorClass)
        ) {
          const iterator = result.output as AsyncIterator<unknown>;
          return {
            ...result,
            output: wrapAsyncIteratorPreservingEventMeta(iterator, {
              mapError: (error) => normalizeProcedureError(error, methodName, runtime.onHandlerFailure),
              mapResult: (item) => {
                if (Date.now() >= (runtime.deadlineAt as number)) {
                  throw normalizeProcedureError(
                    new ServicePlaneTimeoutError(`Service-Plane streaming method exceeded its caller's deadline: ${methodName}`),
                    methodName,
                    runtime.onHandlerFailure,
                  );
                }
                return item;
              },
            }),
          };
        }

        return result;
      } catch (error) {
        throw normalizeProcedureError(error, methodName, runtime.onHandlerFailure);
      }
    });

  return {
    /** Starts a unary procedure whose handler, schemas, scopes, and projections stay together. */
    procedure(metadata: AbilityProcedureMetadata = {}) {
      return base.meta(abilityProcedureMetadata(metadata));
    },
    /** Starts a streaming procedure and validates every yielded item with `output`. */
    stream<TOutput extends AbilitySchema>(output: TOutput, metadata: AbilityProcedureMetadata = {}) {
      return base.meta(abilityProcedureMetadata({ ...metadata, stream: true })).output(asyncIteratorObject(output));
    },
    /**
     * Starts a Durable Object hibernation stream. Later message events must be encoded with
     * {@link encodeAbilityHibernationEvent}, because they occur after this procedure has returned.
     */
    hibernationStream<TOutput extends AbilitySchema>(output: TOutput, metadata: AbilityProcedureMetadata = {}) {
      return base
        .meta(abilityProcedureMetadata({ ...metadata, stream: true }))
        .meta(hibernationOutputMetadata(output))
        .output(hibernationIteratorSchema<TOutput>());
    },
  };
}

/**
 * Validates and encodes one later yield for a hibernating procedure. Error and close events carry
 * protocol data rather than yielded items, so only message events are checked against `output`.
 */
export function encodeAbilityHibernationEvent<TOutput extends AbilitySchema>(
  output: TOutput,
  id: string,
  payload: StandardSchemaV1.InferInput<TOutput>,
  options?: Omit<EncodeHibernationRPCEventOptions, 'event'> & { event?: 'message' },
): Promise<string | Uint8Array<ArrayBuffer>>;
/** Encodes a protocol error or close event for an existing hibernating procedure. */
export function encodeAbilityHibernationEvent<TOutput extends AbilitySchema>(
  output: TOutput,
  id: string,
  payload: unknown,
  options: Omit<EncodeHibernationRPCEventOptions, 'event'> & { event: 'close' | 'error' },
): Promise<string | Uint8Array<ArrayBuffer>>;
export async function encodeAbilityHibernationEvent<TOutput extends AbilitySchema>(
  output: TOutput,
  id: string,
  payload: unknown,
  options: EncodeHibernationRPCEventOptions = {},
): Promise<string | Uint8Array<ArrayBuffer>> {
  let encodedPayload = payload;
  if (options.event === undefined || options.event === 'message') {
    let result: StandardSchemaV1.Result<StandardSchemaV1.InferOutput<TOutput>>;
    try {
      result = await output['~standard'].validate(payload);
    } catch {
      throw new AbilityValidationError('Service-Plane hibernation event output validation failed', 500);
    }
    if (result.issues) {
      throw new AbilityValidationError(
        `Service-Plane hibernation event output failed validation: ${formatValidationIssues(normalizeValidationIssues(result.issues))}`,
        500,
        normalizeValidationIssues(result.issues),
      );
    }
    encodedPayload = result.value;
  }
  return encodeHibernationRPCEvent(id, encodedPayload, options);
}

/** Creates the internal initial context accepted by every Service Plane procedure. */
export function createAbilityProcedureRuntimeContext<TEnv extends Env>(
  options: AbilityProcedureRuntimeOptions<TEnv>,
): AbilityProcedureRuntimeContext<TEnv> {
  return { [ABILITY_RUNTIME]: options };
}

/** Returns true only for an implemented oRPC procedure. */
export function isAbilityProcedure(value: unknown): value is AnyProcedure {
  return value instanceof Procedure;
}

/** Returns whether a procedure carries the runtime middleware installed by `createAbilityBuilder`. */
export function isServicePlaneAbilityProcedure(procedure: AnyProcedure): boolean {
  return getAbilityProcedureMetadata(procedure) !== undefined;
}

/** Reads Service Plane method metadata without exposing oRPC's internal metadata storage. */
export function abilityProcedureDefinition(procedure: AnyProcedure): StoredAbilityProcedureMetadata {
  return getAbilityProcedureMetadata(procedure) ?? {};
}

/** Extracts the single portable input schema declared by an ability procedure. */
export function abilityProcedureInputSchema(procedure: AnyProcedure): AnySchema | undefined {
  return onlySchema(procedure['~orpc'].inputSchemas);
}

/** Extracts the unary output schema or the yielded-item schema for a streaming procedure. */
export function abilityProcedureOutputSchema(procedure: AnyProcedure): AnySchema | undefined {
  const hibernationOutput = getHibernationOutputMetadata(procedure);
  if (hibernationOutput) return hibernationOutput;
  const output = onlySchema(procedure['~orpc'].outputSchemas);
  return output ? (getAsyncIteratorObjectSchemaDetails(output)?.yieldSchema ?? output) : undefined;
}

/** Returns whether the procedure's output uses oRPC's validated async-iterator schema. */
export function abilityProcedureStreams(procedure: AnyProcedure): boolean {
  if (getAbilityProcedureMetadata(procedure)?.stream === true) return true;
  const output = onlySchema(procedure['~orpc'].outputSchemas);
  return output !== undefined && getAsyncIteratorObjectSchemaDetails(output) !== undefined;
}

function hibernationIteratorSchema<TOutput extends AbilitySchema>(): StandardSchemaV1<
  AbilityHibernationStream<StandardSchemaV1.InferInput<TOutput>>,
  AbilityHibernationStream<StandardSchemaV1.InferOutput<TOutput>>
> {
  return {
    '~standard': {
      validate(value) {
        if (value instanceof HibernationAsyncIteratorClass) {
          // A hibernation iterator has no values yet. Those are validated when an awakened Durable
          // Object calls encodeAbilityHibernationEvent, so this validator must preserve its class.
          return { value: value as AbilityHibernationStream<StandardSchemaV1.InferOutput<TOutput>> };
        }
        return { issues: [{ message: 'Expected a HibernationAsyncIteratorClass' }] };
      },
      vendor: 'service-plane',
      version: 1,
    },
  };
}

/** Refuses stacked schemas because discovery must publish one transport-neutral JSON Schema. */
function onlySchema(schemas: AnySchema | AnySchema[] | undefined): AnySchema | undefined {
  if (!schemas) return undefined;
  if (!Array.isArray(schemas)) return schemas;
  return schemas.length === 1 ? schemas[0] : undefined;
}

function resolveProcedureTimeoutMs(declared: number | undefined, fallback: false | number | undefined): number | undefined {
  if (declared === 0) return undefined;
  return declared ?? (fallback === false ? undefined : fallback);
}

function normalizeProcedureError(
  error: unknown,
  methodName: string,
  onHandlerFailure: ((cause: unknown, methodName: string) => void) | undefined,
): ORPCError<string, unknown> {
  if (error instanceof ORPCError) {
    if (error.cause instanceof ValidationError) {
      const issues = normalizeValidationIssues(error.cause.issues);
      if (error.code === 'BAD_REQUEST') {
        return servicePlaneOrpcError({
          code: 'ability_validation',
          issues,
          message: `Service-Plane ability input for ${methodName}: ${formatValidationIssues(issues)}`,
          retryable: false,
          status: 422,
        });
      }
      return servicePlaneOrpcError({
        code: 'ability_validation',
        message: `Service-Plane ability output for ${methodName} failed validation`,
        retryable: false,
        status: 500,
      });
    }
    return error;
  }

  const classified = servicePlaneErrorInfo(error);
  if (classified) return servicePlaneOrpcError(classified);

  const opaque = new ServicePlaneError(`Service-Plane ability handler failed: ${methodName}`, 500);
  rememberHandlerFailureCause(opaque, error);
  try {
    onHandlerFailure?.(error, methodName);
  } catch {
    // A logging hook must never replace the failure it is reporting.
  }
  return servicePlaneOrpcError(servicePlaneErrorInfo(opaque) as ServicePlaneErrorInfo);
}

function servicePlaneOrpcError(info: ServicePlaneErrorInfo): ORPCError<string, ServicePlaneRpcErrorData> {
  return new ORPCError(orpcErrorCode(info.status), {
    data: { servicePlane: info },
    message: info.message,
  });
}

/** Converts a classified Service Plane failure into its transport-safe oRPC representation. */
export function orpcErrorFromServicePlane(error: unknown): ORPCError<string, ServicePlaneRpcErrorData> | undefined {
  const info = servicePlaneErrorInfo(error);
  return info ? servicePlaneOrpcError(info) : undefined;
}

function orpcErrorCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_SUPPORTED';
    case 410:
      return 'GONE';
    case 422:
      return 'UNPROCESSABLE_CONTENT';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    case 504:
      return 'GATEWAY_TIMEOUT';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

function normalizeValidationIssues(issues: readonly import('@standard-schema/spec').StandardSchemaV1.Issue[]): AbilityValidationIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    ...(issue.path ? { path: issue.path.map((segment) => (typeof segment === 'object' ? segment.key : segment)) } : {}),
  }));
}

function formatValidationIssues(issues: AbilityValidationIssue[]): string {
  return issues.length === 0
    ? 'schema reported no issue detail'
    : issues.map((issue) => `${issue.path?.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
}

function isServicePlaneRpcErrorData(value: unknown): value is ServicePlaneRpcErrorData {
  if (!value || typeof value !== 'object') return false;
  return servicePlaneErrorInfo((value as { servicePlane?: unknown }).servicePlane) !== undefined;
}
