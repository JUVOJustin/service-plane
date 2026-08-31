import { wrapAsyncIteratorPreservingEventMeta } from '@orpc/client';
import { asyncIteratorObject } from '@orpc/contract';
import { HibernationAsyncIteratorClass } from '@orpc/hibernation';
import { type AnyProcedure, ORPCError, os, ValidationError } from '@orpc/server';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Env } from 'hono';
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
import {
  AbilityHibernationStream,
  type AbilityMethodContext,
  type AbilitySchema,
  type AbilityStream,
  type AnyAbilityMethodDefinition,
  abilityHibernationCallback,
  abilityMethodHandler,
} from './ability.js';

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

type AuthorizeAbilityMethodInput = {
  path: string[];
  procedure: AnyProcedure;
  signal?: AbortSignal;
};

type AbilityRpcRuntimeOptions<TEnv extends Env = Env> = {
  authorize(input: AuthorizeAbilityMethodInput): Promise<AbilityMethodContext<TEnv>> | AbilityMethodContext<TEnv>;
  deadlineAt?: number;
  defaultMethodTimeoutMs?: false | number;
  onHandlerFailure?: (cause: unknown, methodName: string) => void;
};

type AbilityRpcRuntimeContext<TEnv extends Env = Env> = {
  [ABILITY_RUNTIME]: AbilityRpcRuntimeOptions<TEnv>;
};

const ABILITY_RUNTIME = Symbol('service-plane.ability-runtime');

/** Compiles one transport-neutral method into the package's private oRPC execution engine. */
export function compileAbilityMethod<TEnv extends Env>(method: AnyAbilityMethodDefinition<TEnv>): AnyProcedure {
  const base = os
    .$context<AbilityRpcRuntimeContext<TEnv>>()
    .errors(servicePlaneErrorMap)
    .use(async ({ context, next, path, procedure, signal }) => {
      const runtime = context[ABILITY_RUNTIME];
      const methodName = path.at(-1) ?? 'unknown';

      try {
        const authorized = await runtime.authorize({ path, procedure, ...(signal ? { signal } : {}) });
        const ceilingMs =
          method.kind === 'unary' ? resolveMethodTimeoutMs(method.metadata.timeoutMs, runtime.defaultMethodTimeoutMs) : undefined;
        const result = await raceDeadline<{ context: AbilityMethodContext<TEnv>; output: unknown }>(
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

        if (method.kind === 'stream' && !(result.output instanceof HibernationAsyncIteratorClass)) {
          const iterator = result.output as AsyncIterator<unknown>;
          return {
            ...result,
            output: wrapAsyncIteratorPreservingEventMeta(iterator, {
              mapError: (error) => normalizeMethodError(error, methodName, runtime.onHandlerFailure),
              mapResult: async (item) => {
                if (runtime.deadlineAt !== undefined && Date.now() >= runtime.deadlineAt) {
                  throw normalizeMethodError(
                    new ServicePlaneTimeoutError(`Service-Plane streaming method exceeded its caller's deadline: ${methodName}`),
                    methodName,
                    runtime.onHandlerFailure,
                  );
                }
                return validateStreamResult(item, method.output, methodName);
              },
            }),
          };
        }

        return result;
      } catch (error) {
        throw normalizeMethodError(error, methodName, runtime.onHandlerFailure);
      }
    });

  const input = failClosedSchema(method.input);
  const output = failClosedSchema(method.output);
  const handler = abilityMethodHandler(method);

  if (method.kind === 'stream') {
    return base
      .input(input)
      .output(asyncIteratorObject(validatedStreamItemSchema))
      .handler(
        async ({ context, input: value }) =>
          (await handler({ context: context as unknown as AbilityMethodContext, input: value })) as AbilityStream<unknown> as never,
      ) as AnyProcedure;
  }

  if (method.kind === 'hibernation') {
    return base
      .input(input)
      .output(hibernationIteratorSchema())
      .handler(async ({ context, input: value }) => {
        const subscription = await handler({ context: context as unknown as AbilityMethodContext, input: value });
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
    .handler(({ context, input: value }) => handler({ context: context as unknown as AbilityMethodContext, input: value })) as AnyProcedure;
}

/** Creates the private runtime context accepted by compiled ability methods. */
export function createAbilityRpcRuntimeContext<TEnv extends Env>(options: AbilityRpcRuntimeOptions<TEnv>): AbilityRpcRuntimeContext<TEnv> {
  return { [ABILITY_RUNTIME]: options };
}

function failClosedValidationResult(result: unknown): StandardSchemaV1.Result<unknown> {
  if (result && typeof result === 'object' && ('value' in result || (result as { issues?: unknown }).issues)) {
    return result as StandardSchemaV1.Result<unknown>;
  }
  return { issues: [{ message: 'Standard Schema validator returned neither a value nor issues' }] };
}

async function validateStreamResult(
  result: IteratorResult<unknown, unknown>,
  output: AbilitySchema,
  methodName: string,
): Promise<IteratorResult<unknown, unknown>> {
  if (result.done) return result;
  let validated: StandardSchemaV1.Result<unknown>;
  try {
    validated = failClosedValidationResult(await output['~standard'].validate(result.value));
  } catch {
    throw servicePlaneOrpcError({
      code: 'ability_validation',
      message: `Service-Plane ability output for ${methodName} failed validation`,
      retryable: false,
      status: 500,
    });
  }
  if (validated.issues) {
    throw servicePlaneOrpcError({
      code: 'ability_validation',
      message: `Service-Plane ability output for ${methodName} failed validation`,
      retryable: false,
      status: 500,
    });
  }
  return { done: false, value: validated.value };
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

function hibernationIteratorSchema(): StandardSchemaV1<HibernationAsyncIteratorClass<unknown>> {
  return {
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
}

function resolveMethodTimeoutMs(declared: number | undefined, fallback: false | number | undefined): number | undefined {
  if (declared === 0) return undefined;
  return declared ?? (fallback === false ? undefined : fallback);
}

function normalizeMethodError(
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

/** Converts a classified Service Plane failure into its private wire representation. */
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

function normalizeValidationIssues(issues: readonly StandardSchemaV1.Issue[]): AbilityValidationIssue[] {
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
