import { RPCLink } from '@orpc/client/fetch';
import { asyncIteratorObject, ORPCError, os, type as typeSchema } from '@orpc/server';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { orpcErrorFromServicePlane } from '../service/orpc.js';
import { createRpcClientPlugins } from '../service/orpc-features.js';
import { applyForwardedCallHeaders, type ForwardedCallValues } from '../shared/call-headers.js';
import type { ConnInfo } from '../shared/conn-info.js';
import { discardDisposableValue, normalizeTimeoutMs, raceDeadline, remainingTimeoutMs } from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneTimeoutError, servicePlaneErrorInfo } from '../shared/errors.js';
import { isAsyncIterable } from '../shared/guards.js';
import { normalizeIdempotencyKey } from '../shared/idempotency.js';
import { emitBestEffortServicePlaneLog, logErrorFields, type ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import { assertServicePlaneRpcProtocol, SERVICE_PLANE_RPC_PROTOCOL } from '../shared/rpc-protocol.js';
import type { DiscoveredServiceAbility, IssuedCapabilityToken, ServiceEndpoint, ServiceRegistry } from '../shared/types.js';
import {
  type BrokerCaller,
  brokerCallerAccess,
  brokerCallerLogFields,
  brokerCallerSubject,
  type ControlPlaneAuthorizationInvocation,
  type ControlPlaneInvocationAuthorizer,
} from './caller.js';
import type { CapabilityIssuer } from './capabilities.js';
import { createServiceRegistry } from './registry.js';

export type CreateControlPlaneRpcBrokerOptions = {
  /** Product permission check run for each logical call before capability issuance; grants still apply. */
  authorizeInvocation?: ControlPlaneInvocationAuthorizer;
  /**
   * Advisory connection info about the original client, forwarded to the target service. Services
   * surface it to handlers only for brokered calls with ingress enabled.
   */
  connInfo?: ConnInfo;
  /** Service id stamped as the broker on ingress-protected tokens. */
  controlPlaneServiceId: string;
  /**
   * The caller's key for this attempt, forwarded to the target service so a retry through the plane
   * is recognizable as one. The plane never generates it and never deduplicates on it.
   */
  idempotencyKey?: string;
  /** Capability issuer used after catalog authorization succeeds. */
  issuer: CapabilityIssuer;
  /** Receives structured broker call events. */
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  /**
   * Reads the current time for deadline accounting. Both readings happen on this machine, so the
   * elapsed value never depends on the plane and the service agreeing about the clock. Injectable
   * for tests.
   */
  now?: () => number;
  /**
   * When this request reached the plane. A shell that authenticates the caller or resolves its
   * catalog first should pass its own entry timestamp so that work is charged to the caller budget.
   */
  receivedAt?: number;
  /** Prebuilt registry; preferred when the shell already resolved a request-scoped catalog. */
  registry?: ServiceRegistry;
  /** Correlation id forwarded to the target service. */
  requestId?: string;
  /** Endpoints used to build a registry when `registry` is omitted. */
  services?: ServiceEndpoint[];
  /**
   * The caller's remaining budget in milliseconds when this request reached the plane. What is left
   * after the plane's own work — resolving the catalog, minting a token — is forwarded to the
   * service, so a slow plane spends the caller's budget rather than extending it.
   */
  timeoutMs?: number;
};

/** One procedure call through the control plane's authorization and routing boundary. */
export type ControlPlaneRpcBrokerCallInput = {
  /** Ability id from the target service discovery document. */
  abilityId: string;
  /** Authenticated caller, or no caller for a plane-owned call. */
  caller?: BrokerCaller;
  /** Method input carried by the broker. */
  input: unknown;
  /** Method from the discovered ability catalog. */
  method: string;
  /** Scopes authorized for this call. */
  scopes: ReadonlyArray<string>;
  /** Service that owns the ability. */
  targetServiceId: string;
};

export type ControlPlaneRpcBroker = {
  /** Calls one ability method through discovery, authorization, token minting, and routing. */
  callAbility(input: ControlPlaneRpcBrokerCallInput, expectedKind?: 'call' | 'stream'): Promise<unknown>;
};

/** Private wire envelope for the control plane's generic broker methods. */
export type ControlPlaneBrokerProcedureInput = {
  /** Ability selected inside the target service. */
  abilityId: string;
  /** Opaque method input validated authoritatively by the target service. */
  input: unknown;
  /** Method name from the discovered catalog. */
  method: string;
  /** Scopes requested from the broker. */
  scopes: ReadonlyArray<string>;
  /** Service that owns the ability. */
  targetServiceId: string;
};

/** Request-owned context injected after the control plane authenticates the external caller. */
export type ControlPlaneBrokerProcedureContext = {
  /** Resolves authorization only after the private wire request has passed decoding and limits. */
  resolveBroker: (headers?: Headers) => Promise<{ broker: ControlPlaneRpcBroker; caller?: BrokerCaller }>;
  /** Logical-call headers injected by the private RPC engine. */
  reqHeaders?: Headers;
};

const controlPlaneBrokerProcedureInputSchema = {
  '~standard': {
    validate(value: unknown) {
      return isControlPlaneBrokerProcedureInput(value)
        ? { value }
        : { issues: [{ message: 'Invalid Service Plane broker call envelope' }] };
    },
    vendor: 'service-plane',
    version: 1,
  },
} satisfies StandardSchemaV1<ControlPlaneBrokerProcedureInput>;

/**
 * Generic public broker router. Typed ability clients adapt their method calls to `call` or
 * `stream`, while the control plane keeps service discovery and token minting server-side.
 */
export const controlPlaneBrokerRouter = {
  call: os
    .$context<ControlPlaneBrokerProcedureContext>()
    .input(controlPlaneBrokerProcedureInputSchema)
    .output(typeSchema<unknown>())
    .handler(async ({ context, input }) => {
      const output = await callBrokerProcedure(context, input, 'call');
      if (isAsyncIterable(output)) {
        // A stale catalog or divergent backend must not leave an unconsumed stream alive.
        try {
          void Promise.resolve(output[Symbol.asyncIterator]().return?.()).catch(() => undefined);
        } catch {
          // Cleanup cannot replace the endpoint refusal.
        }
        throw new ORPCError('METHOD_NOT_SUPPORTED', {
          message: `Service-Plane streaming method must use the broker stream endpoint: ${input.method}`,
        });
      }
      return output;
    }),
  stream: os
    .$context<ControlPlaneBrokerProcedureContext>()
    .input(controlPlaneBrokerProcedureInputSchema)
    .output(asyncIteratorObject(typeSchema<unknown>()))
    .handler(async ({ context, input }) => {
      const output = await callBrokerProcedure(context, input, 'stream');
      if (!isAsyncIterable(output)) {
        throw new ORPCError('METHOD_NOT_SUPPORTED', {
          message: `Service-Plane unary method must use the broker call endpoint: ${input.method}`,
        });
      }
      return output as never;
    }),
};

async function callBrokerProcedure(
  context: ControlPlaneBrokerProcedureContext,
  input: ControlPlaneBrokerProcedureInput,
  expectedKind: 'call' | 'stream',
): Promise<unknown> {
  try {
    const { broker, caller } = await context.resolveBroker(context.reqHeaders);
    return await broker.callAbility({ ...input, ...(caller ? { caller } : {}) }, expectedKind);
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    throw orpcErrorFromServicePlane(error) ?? new ORPCError('INTERNAL_SERVER_ERROR', { data: undefined });
  }
}

function isControlPlaneBrokerProcedureInput(value: unknown): value is ControlPlaneBrokerProcedureInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.abilityId === 'string' &&
    input.abilityId.trim().length > 0 &&
    Object.hasOwn(input, 'input') &&
    typeof input.method === 'string' &&
    input.method.trim().length > 0 &&
    Array.isArray(input.scopes) &&
    input.scopes.every((scope) => typeof scope === 'string') &&
    typeof input.targetServiceId === 'string' &&
    input.targetServiceId.trim().length > 0
  );
}

export function createControlPlaneRpcBroker(options: CreateControlPlaneRpcBrokerOptions): ControlPlaneRpcBroker {
  const registry = options.registry ?? createServiceRegistry({ services: options.services ?? [] });
  const now = options.now ?? (() => Date.now());
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
  return {
    async callAbility(input, expectedKind) {
      const callReceivedAt = options.receivedAt ?? now();
      try {
        const initialRemaining = remainingTimeoutMs(timeoutMs, now() - callReceivedAt);
        if (initialRemaining === 0) {
          throw new ServicePlaneTimeoutError(
            `Service-Plane broker received an exhausted caller deadline: ${input.targetServiceId}/${input.abilityId}`,
          );
        }
        const deadlineAt = initialRemaining === undefined ? undefined : Date.now() + initialRemaining;
        const timeoutController = deadlineAt === undefined ? undefined : new AbortController();
        const remainingBudget = (stage: string): number | undefined => {
          if (timeoutController?.signal.aborted) throw timeoutController.signal.reason;
          const remaining = remainingTimeoutMs(timeoutMs, now() - callReceivedAt);
          if (remaining === 0) {
            throw new ServicePlaneTimeoutError(
              `Service-Plane broker exhausted the caller's deadline ${stage}: ${input.targetServiceId}/${input.abilityId}`,
            );
          }
          return remaining;
        };
        const operation = (async () => {
          const ability = await registry.ability(input.targetServiceId, input.abilityId);
          if (!ability) {
            throw new CapabilityAuthError(`Service-Plane broker has no ability: ${input.targetServiceId}/${input.abilityId}`, 404);
          }
          remainingBudget('during discovery');
          assertServicePlaneRpcProtocol(ability.rpc.protocol);
          authorizeAbility(ability, input.caller);
          const method = Object.hasOwn(ability.methods, input.method) ? ability.methods[input.method] : undefined;
          if (!method) {
            throw new CapabilityAuthError(
              `Service-Plane broker has no ability method: ${input.targetServiceId}/${input.abilityId}/${input.method}`,
              404,
            );
          }
          // Endpoint intent is server-owned, never taken from the untrusted wire envelope.
          const methodKind = method.stream === true ? 'stream' : 'call';
          if (expectedKind !== undefined && expectedKind !== methodKind) {
            throw new ORPCError('METHOD_NOT_SUPPORTED', {
              message: `Service-Plane ${method.stream === true ? 'streaming' : 'unary'} method must use the broker ${methodKind} endpoint: ${input.method}`,
            });
          }
          const scopes = validateBrokerScopes(ability, input.method, input.scopes);
          if (options.authorizeInvocation) {
            await authorizeInvocation(options.authorizeInvocation, {
              abilityId: ability.id,
              ...(input.caller ? { caller: input.caller } : {}),
              method: input.method,
              scopes,
              serviceId: ability.serviceId,
            });
            remainingBudget('during invocation authorization');
          }
          const issued = await issueBrokerToken(ability, input.caller, options, scopes);
          const remaining = remainingBudget('during capability issuance');
          const output = await callDiscoveredAbility(
            ability,
            input.method,
            input.input,
            issued.token,
            {
              ...(options.connInfo ? { connInfo: options.connInfo } : {}),
              ...(idempotencyKey ? { idempotencyKey } : {}),
              ...(options.requestId ? { requestId: options.requestId } : {}),
              ...(remaining === undefined ? {} : { timeoutMs: remaining }),
            },
            timeoutController?.signal,
          );
          return { ability, output, scopes };
        })();
        const result =
          deadlineAt === undefined
            ? await operation
            : await raceDeadline(operation, {
                deadlineAt,
                deadlineError: () =>
                  new ServicePlaneTimeoutError(
                    `Service-Plane broker exceeded the caller's deadline: ${input.targetServiceId}/${input.abilityId}/${input.method}`,
                  ),
                discardLateValue(value) {
                  discardDisposableValue((value as { output?: unknown }).output);
                },
                onTimeout: (error) => timeoutController?.abort(error),
              });
        emitBestEffortServicePlaneLog(options.log, {
          abilityId: result.ability.id,
          brokered: Boolean(result.ability.serviceIngress?.required),
          ...brokerCallerLogFields(input.caller),
          durationMs: now() - callReceivedAt,
          event: 'service_plane.broker.call.completed',
          level: 'info',
          method: input.method,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          scopes: result.scopes,
          serviceId: result.ability.serviceId,
        });
        return result.output;
      } catch (error) {
        const info = servicePlaneErrorInfo(error);
        emitBestEffortServicePlaneLog(options.log, {
          abilityId: input.abilityId,
          ...brokerCallerLogFields(input.caller),
          durationMs: now() - callReceivedAt,
          error: logErrorFields(error),
          event: 'service_plane.broker.call.failed',
          level: 'warn',
          method: input.method,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          scopes: input.scopes,
          serviceId: input.targetServiceId,
          ...(info ? { status: info.status } : {}),
        });
        throw error;
      }
    },
  };
}

// Minting brokered tokens for ingress-required targets and stamping the caller's access class are
// both security-relevant, so every brokered surface mints here and nowhere else.
function issueBrokerToken(
  ability: DiscoveredServiceAbility,
  caller: BrokerCaller | undefined,
  options: Pick<CreateControlPlaneRpcBrokerOptions, 'controlPlaneServiceId' | 'issuer'>,
  scopes: ReadonlyArray<string>,
): Promise<IssuedCapabilityToken> {
  const subject = brokerCallerSubject(caller);
  const request = {
    callerAccess: brokerCallerAccess(caller),
    callerServiceId: caller?.kind === 'service' ? caller.id : options.controlPlaneServiceId,
    scopes,
    ...(subject ? { subject } : {}),
    targetServiceId: ability.serviceId,
  };
  return ability.serviceIngress?.required
    ? options.issuer.issueBrokeredCapabilityToken({ ...request, brokerServiceId: options.controlPlaneServiceId })
    : options.issuer.issueCapabilityToken(request);
}

// App policy receives a frozen copy so auditing or policy evaluation cannot rewrite dispatch authority.
async function authorizeInvocation(
  authorizer: ControlPlaneInvocationAuthorizer,
  invocation: ControlPlaneAuthorizationInvocation,
): Promise<void> {
  const snapshot = Object.freeze({
    ...invocation,
    ...(invocation.caller ? { caller: Object.freeze({ ...invocation.caller }) } : {}),
    scopes: Object.freeze([...invocation.scopes]),
  });
  let allowed = false;
  try {
    allowed = (await authorizer(snapshot)) === true;
  } catch {
    // Application exceptions can contain provider credentials or policy internals.
  }
  if (!allowed) throw new CapabilityAuthError('Service-Plane invocation is not permitted', 403);
}

function validateBrokerScopes(ability: DiscoveredServiceAbility, methodName: string, scopes: ReadonlyArray<string>): string[] {
  const requested = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (requested.length === 0) throw new CapabilityAuthError('Service-Plane broker call requires at least one scope', 400);
  for (const scope of requested) {
    if (!ability.scopes.includes(scope)) {
      throw new CapabilityAuthError(`Service-Plane broker ability does not declare scope: ${scope}`, 403);
    }
  }
  const method = Object.hasOwn(ability.methods, methodName) ? ability.methods[methodName] : undefined;
  for (const required of method?.scopes ?? []) {
    if (!requested.includes(required)) {
      throw new CapabilityAuthError(`Service-Plane broker call is missing method scope: ${required}`, 403);
    }
  }
  return requested;
}

async function callDiscoveredAbility(
  ability: DiscoveredServiceAbility,
  method: string,
  input: unknown,
  token: string,
  forwarded: Pick<ForwardedCallValues, 'connInfo' | 'idempotencyKey' | 'requestId' | 'timeoutMs'>,
  signal?: AbortSignal,
): Promise<unknown> {
  const nativeBinding = ability.service.abilityRpc;
  const definition = Object.hasOwn(ability.methods, method) ? ability.methods[method] : undefined;
  const streams = definition?.stream === true;
  if (nativeBinding?.invokeAbility && !streams && ability.rpc.transports.includes('service-binding')) {
    return nativeBinding.invokeAbility({
      protocol: SERVICE_PLANE_RPC_PROTOCOL,
      abilityId: ability.id,
      ...(forwarded.connInfo ? { connInfo: forwarded.connInfo } : {}),
      ...(forwarded.idempotencyKey ? { idempotencyKey: forwarded.idempotencyKey } : {}),
      input,
      method,
      ...(forwarded.requestId ? { requestId: forwarded.requestId } : {}),
      ...(forwarded.timeoutMs === undefined ? {} : { timeoutMs: forwarded.timeoutMs }),
      token,
    });
  }

  if (!ability.rpc.transports.includes('fetch') && !ability.rpc.transports.includes('service-binding')) {
    throw new CapabilityAuthError(`Service-Plane ability has no Fetch transport: ${ability.serviceId}/${ability.id}`, 500);
  }
  const headers = applyForwardedCallHeaders(new Headers(), { ...forwarded, token });
  const link = new RPCLink({
    plugins: createRpcClientPlugins({}),
    fetch: async (url, init) => ability.service.fetch(new Request(url, init)),
    headers,
    origin: ability.service.origin,
    url: ability.rpc.path as `/${string}`,
  });
  return link.call([method], input, { context: {}, ...(signal ? { signal } : {}) });
}

// Decided from the discovered catalog, which the plane caches, so this is the earlier and more
// legible of two checks rather than the only one: the same decision rides into the token as `spa`
// and the service re-checks it against its own definition. A catalog that has not caught up with a
// tightened `access` therefore refuses the call at the service instead of letting it through.
function authorizeAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && brokerCallerAccess(caller) === 'service') return;
  throw new CapabilityAuthError('Service-Plane broker ability requires service access', 403);
}
