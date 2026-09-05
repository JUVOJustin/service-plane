import { wrapAsyncIteratorPreservingEventMeta } from '@orpc/client';
import { HibernationAsyncIteratorClass } from '@orpc/hibernation';
import { type AnyProcedure, asyncIteratorObject, ORPCError, os, ValidationError } from '@orpc/server';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Env } from 'hono';
import { discardDisposableValue, raceDeadline } from '../shared/deadline.js';
import {
  AbilityHandlerError,
  AbilityValidationError,
  PRIVATE_TRANSPORT_ERROR_STATUSES,
  rememberHandlerFailureCause,
  ServicePlaneError,
  type ServicePlaneErrorInfo,
  ServicePlaneTimeoutError,
  servicePlaneErrorInfo,
} from '../shared/errors.js';
import {
  AbilityHibernationStream,
  type AbilityMethodContext,
  type AbilitySchema,
  type AbilityStream,
  type AbilityStreamSource,
  type AnyAbilityMethodDefinition,
  abilityHibernationCallback,
  abilityMethodHandler,
  toAbilityStream,
} from './ability.js';
import { failClosedValidationResult, formatValidationIssues, normalizeValidationIssues } from './schema-validation.js';

type ServicePlaneRpcErrorData = {
  servicePlane: ServicePlaneErrorInfo;
};

const servicePlaneRpcErrorDataSchema = {
  '~standard': {
    validate(value: unknown) {
      return isServicePlaneRpcErrorData(value) ? { value } : { issues: [{ message: 'Invalid Service Plane RPC error data' }] };
    },
    vendor: 'service-plane',
    version: 1,
  },
} satisfies StandardSchemaV1<ServicePlaneRpcErrorData>;

// Streaming items are validated and transformed by the middleware wrapper so failures can be
// normalized before the engine serializes them. The engine output schema must therefore only carry
// the already-validated value; validating here again would double the hottest streaming cost.
const validatedStreamItemSchema = {
  '~standard': {
    validate: (value: unknown) => ({ value }),
    vendor: 'service-plane',
    version: 1,
  },
} satisfies StandardSchemaV1<unknown>;

// Every private transport code carries the same typed Service Plane payload, and the status table
// is the one source for both directions of the code mapping.
const servicePlaneErrorMap = Object.fromEntries(
  Object.keys(PRIVATE_TRANSPORT_ERROR_STATUSES).map((code) => [code, { data: servicePlaneRpcErrorDataSchema }]),
) as Record<keyof typeof PRIVATE_TRANSPORT_ERROR_STATUSES, { data: typeof servicePlaneRpcErrorDataSchema }>;
const ORPC_ERROR_CODES_BY_STATUS = new Map<number, string>(
  Object.entries(PRIVATE_TRANSPORT_ERROR_STATUSES).map(([code, status]) => [status, code]),
);

const hibernationIteratorSchema: StandardSchemaV1<HibernationAsyncIteratorClass<unknown>> = {
  '~standard': {
    validate(value) {
      return value instanceof HibernationAsyncIteratorClass
        ? { value }
        : { issues: [{ message: 'Expected a Service-Plane hibernation iterator' }] };
    },
    vendor: 'service-plane',
    version: 1,
  },
};

type AuthorizeAbilityMethodInput = {
  headers?: Headers;
  path: string[];
  procedure: AnyProcedure;
  signal?: AbortSignal;
};

type AuthorizedAbilityMethodContext<TEnv extends Env> = Omit<AbilityMethodContext<TEnv>, 'methodName'> & {
  methodName?: string;
};

type AuthorizedAbilityMethod<TEnv extends Env> = {
  context: AuthorizedAbilityMethodContext<TEnv>;
  deadlineAt?: number;
};

type AbilityRpcRuntimeOptions<TEnv extends Env = Env> = {
  authorize(input: AuthorizeAbilityMethodInput): Promise<AuthorizedAbilityMethod<TEnv>> | AuthorizedAbilityMethod<TEnv>;
  defaultMethodTimeoutMs?: false | number;
  onHandlerFailure?: (cause: unknown, methodName: string, context?: AbilityMethodContext<TEnv>) => void;
  /** Time this logical call entered the service, so a unary method ceiling includes authorization. */
  receivedAt?: number;
  /** Resolves the caller deadline before authorization so a slow trust source cannot escape it. */
  resolveDeadlineAt?(input: AuthorizeAbilityMethodInput): number | undefined;
};

type AbilityRpcRuntimeContext<TEnv extends Env = Env> = {
  [ABILITY_RUNTIME]: AbilityRpcRuntimeOptions<TEnv>;
  reqHeaders?: Headers;
};

const ABILITY_RUNTIME = Symbol('service-plane.ability-runtime');

// Handler failures cross this private wrapper before oRPC can classify them. Its identity is what
// lets the outer boundary distinguish an application-created ORPCError from one created by Service
// Plane itself without trusting a forgeable message, code, or data shape. It never leaves the
// middleware, so the original failure can ride along as `cause`.
class AbilityHandlerFailure extends Error {
  constructor(failure: unknown) {
    super('Service-Plane ability handler failed', { cause: failure });
    this.name = 'AbilityHandlerFailure';
  }
}

const servicePlaneOrpcErrors = new WeakSet<object>();

/** Compiles one transport-neutral method into the package's private oRPC execution engine. */
export function compileAbilityMethod<TEnv extends Env>(method: AnyAbilityMethodDefinition<TEnv>): AnyProcedure {
  const base = os
    .$context<AbilityRpcRuntimeContext<TEnv>>()
    .errors(servicePlaneErrorMap)
    .use(async ({ context, next, path, procedure, signal }, input) => {
      const runtime = context[ABILITY_RUNTIME];
      const methodName = path.at(-1) ?? 'unknown';
      let methodContext: AbilityMethodContext<TEnv> | undefined;

      try {
        const authorizationInput: AuthorizeAbilityMethodInput = {
          ...(context.reqHeaders ? { headers: context.reqHeaders } : {}),
          path,
          procedure,
          ...(signal ? { signal } : {}),
        };
        const ceilingMs =
          method.kind === 'unary' ? resolveMethodTimeoutMs(method.metadata.timeoutMs, runtime.defaultMethodTimeoutMs) : undefined;
        const ceilingDeadlineAt = ceilingMs === undefined ? undefined : (runtime.receivedAt ?? Date.now()) + ceilingMs;
        const callerDeadlineAt = runtime.resolveDeadlineAt?.(authorizationInput);
        let effectiveDeadline = resolveProcedureDeadline(callerDeadlineAt, ceilingDeadlineAt, ceilingMs, methodName);
        if (effectiveDeadline && effectiveDeadline.at <= Date.now()) {
          throw effectiveDeadline.error();
        }
        let deadlineController = effectiveDeadline ? new AbortController() : undefined;
        const authorizationSignal = deadlineController
          ? signal
            ? AbortSignal.any([signal, deadlineController.signal])
            : deadlineController.signal
          : signal;
        const authorization = Promise.resolve(
          runtime.authorize({
            ...authorizationInput,
            ...(authorizationSignal ? { signal: authorizationSignal } : {}),
          }),
        );
        const authorized =
          effectiveDeadline === undefined
            ? await authorization
            : await raceDeadline(authorization, {
                deadlineAt: effectiveDeadline.at,
                deadlineError: effectiveDeadline.error,
                onTimeout: (error) => deadlineController?.abort(error),
              });
        rejectPrototypePollutingInput(input);
        methodContext = { ...authorized.context, methodName };
        effectiveDeadline = resolveProcedureDeadline(callerDeadlineAt ?? authorized.deadlineAt, ceilingDeadlineAt, ceilingMs, methodName);
        if (effectiveDeadline && effectiveDeadline.at <= Date.now()) throw effectiveDeadline.error();
        if (!deadlineController && effectiveDeadline) deadlineController = new AbortController();
        const result = await raceDeadline<{ context: AbilityMethodContext<TEnv>; output: unknown }>(
          Promise.resolve(next({ context: methodContext })),
          {
            ...(effectiveDeadline === undefined ? {} : { deadlineAt: effectiveDeadline.at }),
            deadlineError:
              effectiveDeadline?.error ??
              (() => new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its caller's deadline: ${methodName}`)),
            discardLateValue(value) {
              discardDisposableValue((value as { output?: unknown }).output);
            },
            onTimeout: (error) => deadlineController?.abort(error),
          },
        );

        if (method.kind === 'stream' && !(result.output instanceof HibernationAsyncIteratorClass)) {
          const iterator =
            authorized.deadlineAt === undefined
              ? (result.output as AsyncIterator<unknown>)
              : deadlineBoundIterator(
                  result.output as AsyncIterator<unknown>,
                  authorized.deadlineAt,
                  () => new ServicePlaneTimeoutError(`Service-Plane streaming method exceeded its caller's deadline: ${methodName}`),
                );
          return {
            ...result,
            output: wrapAsyncIteratorPreservingEventMeta(iterator, {
              mapError: (error) => normalizeMethodError(error, methodName, runtime.onHandlerFailure, methodContext),
              mapResult: (item) => validateStreamResult(item, method.output, methodName),
            }),
          };
        }

        return result;
      } catch (error) {
        throw normalizeMethodError(error, methodName, runtime.onHandlerFailure, methodContext);
      }
    });

  const input = failClosedSchema(method.input);
  const output = failClosedSchema(method.output);
  const handler = abilityMethodHandler(method);

  if (method.kind === 'stream') {
    return base
      .input(input)
      .output(asyncIteratorObject(validatedStreamItemSchema))
      .handler(async ({ context, input: value }) => {
        const stream = await invokeAbilityHandler(async () => {
          const source = await handler({ context: context as unknown as AbilityMethodContext, input: value });
          return toAbilityStream(source as AbilityStreamSource<unknown>) as AbilityStream<unknown>;
        });
        return wrapAsyncIteratorPreservingEventMeta(stream, {
          mapError: (error) => new AbilityHandlerFailure(error),
          mapResult: (result) => result,
        }) as never;
      }) as AnyProcedure;
  }

  if (method.kind === 'hibernation') {
    return base
      .input(input)
      .output(hibernationIteratorSchema)
      .handler(async ({ context, input: value }) => {
        const subscription = await invokeAbilityHandler(() =>
          handler({ context: context as unknown as AbilityMethodContext, input: value }),
        );
        if (!(subscription instanceof AbilityHibernationStream)) {
          throw new AbilityValidationError('Service-Plane hibernation handler must return AbilityHibernationStream', 500);
        }
        const callback = abilityHibernationCallback(subscription);
        return new HibernationAsyncIteratorClass(async (id) => callback(id));
      }) as AnyProcedure;
  }

  return base
    .input(input)
    .output(output)
    .handler(({ context, input: value }) =>
      invokeAbilityHandler(() => handler({ context: context as unknown as AbilityMethodContext, input: value })),
    ) as AnyProcedure;
}

async function invokeAbilityHandler<T>(invoke: () => Promise<T> | T): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    throw new AbilityHandlerFailure(error);
  }
}

function rejectPrototypePollutingInput(root: unknown): void {
  const visited = new WeakSet<object>();
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) stack.push(key, entry);
      continue;
    }
    if (value instanceof Set) {
      for (const entry of value) stack.push(entry);
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) continue;
    if (
      Object.hasOwn(value, '__proto__') ||
      (Object.hasOwn(value, 'constructor') &&
        typeof (value as { constructor?: unknown }).constructor === 'object' &&
        (value as { constructor?: unknown }).constructor !== null &&
        Object.hasOwn((value as { constructor: object }).constructor, 'prototype'))
    ) {
      throw new AbilityValidationError('Service-Plane ability input was blocked by prototype-pollution protection', 400);
    }
    for (const key of Object.keys(value)) stack.push((value as Record<string, unknown>)[key]);
  }
}

function deadlineBoundIterator(
  iterator: AsyncIterator<unknown>,
  deadlineAt: number,
  deadlineError: () => ServicePlaneTimeoutError,
): AsyncIterableIterator<unknown> {
  let terminalError: ServicePlaneTimeoutError | undefined;
  let returnRequested = false;

  const release = (value?: unknown): Promise<IteratorResult<unknown>> => {
    if (returnRequested) return Promise.resolve({ done: true, value });
    returnRequested = true;
    try {
      return iterator.return ? Promise.resolve(iterator.return(value)) : Promise.resolve({ done: true, value });
    } catch {
      return Promise.resolve({ done: true, value });
    }
  };

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(...args: [] | [undefined]) {
      if (terminalError) throw terminalError;
      if (returnRequested) return { done: true, value: undefined };
      try {
        const result = await raceDeadline(Promise.resolve(iterator.next(...args)), {
          deadlineAt,
          deadlineError,
        });
        if (result.done) returnRequested = true;
        return result;
      } catch (error) {
        if (error instanceof ServicePlaneTimeoutError) {
          terminalError = error;
          void release().catch(() => undefined);
        }
        throw error;
      }
    },
    return(value?: unknown) {
      return release(value);
    },
    throw(error?: unknown) {
      if (returnRequested) return Promise.reject(error);
      returnRequested = true;
      try {
        return iterator.throw ? Promise.resolve(iterator.throw(error)) : Promise.reject(error);
      } catch (cause) {
        return Promise.reject(cause);
      }
    },
  };
}

/** Creates the private runtime context accepted by compiled ability methods. */
export function createAbilityRpcRuntimeContext<TEnv extends Env>(options: AbilityRpcRuntimeOptions<TEnv>): AbilityRpcRuntimeContext<TEnv> {
  return { [ABILITY_RUNTIME]: options };
}

async function validateStreamResult(
  result: IteratorResult<unknown, unknown>,
  output: AbilitySchema,
  methodName: string,
): Promise<IteratorResult<unknown, unknown>> {
  if (result.done) return result;
  let validated: StandardSchemaV1.Result<unknown> | undefined;
  try {
    validated = failClosedValidationResult(await output['~standard'].validate(result.value));
  } catch {
    validated = undefined;
  }
  if (!validated || validated.issues) throw outputValidationError(methodName);
  return { done: false, value: validated.value };
}

// Output issues stay on the service: they describe the handler's data, not anything the caller sent.
function outputValidationError(methodName: string): ORPCError<string, ServicePlaneRpcErrorData> {
  return servicePlaneOrpcError({
    code: 'ability_validation',
    message: `Service-Plane ability output for ${methodName} failed validation`,
    retryable: false,
    status: 500,
  });
}

function failClosedSchema<TSchema extends AbilitySchema>(schema: TSchema): TSchema {
  const standard = schema['~standard'];
  const validate = async (value: unknown) => failClosedValidationResult(await standard.validate(value));
  const guardedStandard = new Proxy(standard, {
    get: (target, property) => (property === 'validate' ? validate : Reflect.get(target, property)),
  });
  return new Proxy(schema, {
    get: (target, property) => (property === '~standard' ? guardedStandard : Reflect.get(target, property)),
  });
}

function resolveProcedureDeadline(
  callerDeadlineAt: number | undefined,
  ceilingDeadlineAt: number | undefined,
  ceilingMs: number | undefined,
  methodName: string,
): { at: number; error: () => ServicePlaneTimeoutError } | undefined {
  if (callerDeadlineAt !== undefined && (ceilingDeadlineAt === undefined || callerDeadlineAt <= ceilingDeadlineAt)) {
    return {
      at: callerDeadlineAt,
      error: () => new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its caller's deadline: ${methodName}`),
    };
  }
  if (ceilingDeadlineAt === undefined || ceilingMs === undefined) return undefined;
  return {
    at: ceilingDeadlineAt,
    error: () => new ServicePlaneTimeoutError(`Service-Plane ability method exceeded its ${ceilingMs}ms limit: ${methodName}`),
  };
}

function resolveMethodTimeoutMs(declared: number | undefined, fallback: false | number | undefined): number | undefined {
  if (declared === 0) return undefined;
  return declared ?? (fallback === false ? undefined : fallback);
}

function normalizeMethodError<TEnv extends Env>(
  error: unknown,
  methodName: string,
  onHandlerFailure: ((cause: unknown, methodName: string, context?: AbilityMethodContext<TEnv>) => void) | undefined,
  context?: AbilityMethodContext<TEnv>,
): ORPCError<string, unknown> {
  if (error instanceof AbilityHandlerFailure) {
    const failure = error.cause;
    if (failure instanceof AbilityHandlerError) {
      return servicePlaneOrpcError(servicePlaneErrorInfo(failure) as ServicePlaneErrorInfo);
    }
    return opaqueHandlerError(failure, methodName, onHandlerFailure, context);
  }

  if (error instanceof ORPCError) {
    if (servicePlaneOrpcErrors.has(error)) return error;
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
      return outputValidationError(methodName);
    }
    return opaqueHandlerError(error, methodName, onHandlerFailure, context);
  }

  const classified = servicePlaneErrorInfo(error);
  if (classified) return servicePlaneOrpcError(classified);

  return opaqueHandlerError(error, methodName, onHandlerFailure, context);
}

function opaqueHandlerError<TEnv extends Env>(
  error: unknown,
  methodName: string,
  onHandlerFailure: ((cause: unknown, methodName: string, context?: AbilityMethodContext<TEnv>) => void) | undefined,
  context?: AbilityMethodContext<TEnv>,
): ORPCError<string, ServicePlaneRpcErrorData> {
  const opaque = new ServicePlaneError(`Service-Plane ability handler failed: ${methodName}`, 500);
  rememberHandlerFailureCause(opaque, error);
  try {
    void Promise.resolve(onHandlerFailure?.(error, methodName, context)).catch(() => undefined);
  } catch {
    // A logging hook must never replace the failure it is reporting.
  }
  return servicePlaneOrpcError(servicePlaneErrorInfo(opaque) as ServicePlaneErrorInfo);
}

function servicePlaneOrpcError(info: ServicePlaneErrorInfo): ORPCError<string, ServicePlaneRpcErrorData> {
  const error = new ORPCError(orpcErrorCode(info.status), {
    data: { servicePlane: info },
    message: info.message,
  });
  servicePlaneOrpcErrors.add(error);
  return error;
}

/** Converts a classified Service Plane failure into its private wire representation. */
export function orpcErrorFromServicePlane(error: unknown): ORPCError<string, ServicePlaneRpcErrorData> | undefined {
  const info = servicePlaneErrorInfo(error);
  return info ? servicePlaneOrpcError(info) : undefined;
}

function orpcErrorCode(status: number): string {
  return ORPC_ERROR_CODES_BY_STATUS.get(status) ?? 'INTERNAL_SERVER_ERROR';
}

function isServicePlaneRpcErrorData(value: unknown): value is ServicePlaneRpcErrorData {
  if (!value || typeof value !== 'object') return false;
  return servicePlaneErrorInfo((value as { servicePlane?: unknown }).servicePlane) !== undefined;
}
