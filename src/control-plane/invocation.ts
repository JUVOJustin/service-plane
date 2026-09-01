import type { ConnInfo } from '../shared/conn-info.js';
import { discardDisposableValue, normalizeTimeoutMs, raceDeadline, remainingTimeoutMs } from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneTimeoutError } from '../shared/errors.js';
import type { DiscoveredServiceAbility, ServiceRegistry } from '../shared/types.js';
import { createControlPlaneRpcBroker } from './broker.js';
import { type BrokerCaller, brokerCallerAccess } from './caller.js';
import type { CapabilityIssuer } from './capabilities.js';

/** One already-matched catalog method passed to the shared control-plane dispatcher. */
export type ControlPlaneMethodInvocation = {
  /** Catalog entry whose endpoint and access metadata authorize the call. */
  ability: DiscoveredServiceAbility;
  /** Method key already resolved within the discovered ability. */
  method: string;
  /** Method scopes to mint into the downstream capability token. */
  scopes: ReadonlyArray<string>;
};

/** Authenticated request facts needed to authorize and dispatch one projected method. */
export type ControlPlaneInvocationOptions = {
  /** Authenticated product or service caller. */
  caller?: BrokerCaller;
  /** Original-client connection information forwarded to the service. */
  connInfo?: ConnInfo;
  /** Service id used as the broker actor for non-service callers. */
  controlPlaneServiceId: string;
  /** Idempotency key forwarded to the service. */
  idempotencyKey?: string;
  /** Capability issuer for the current discovery snapshot. */
  issuer: CapabilityIssuer;
  /** Time the outer protocol request reached the plane. */
  receivedAt?: number;
  /** Correlation id forwarded to the target service. */
  requestId?: string;
  /** Caller deadline available when the request reached the plane. */
  timeoutMs?: number;
};

/** Request-entry timestamp and caller budget shared by control-plane operation stages. */
export type ControlPlaneOperationDeadline = Pick<ControlPlaneInvocationOptions, 'receivedAt' | 'timeoutMs'>;

/** Refuses to start a new control-plane stage after the request-entry budget has expired. */
export function assertControlPlaneOperationCanStart(deadline: ControlPlaneOperationDeadline, stage: string): void {
  const timeoutMs = normalizeTimeoutMs(deadline.timeoutMs);
  if (timeoutMs === undefined) return;
  const receivedAt = deadline.receivedAt ?? Date.now();
  if (remainingTimeoutMs(timeoutMs, Date.now() - receivedAt) === 0) {
    throw new ServicePlaneTimeoutError(`Service-Plane control-plane deadline exceeded before ${stage}`);
  }
}

/** Applies one request-entry budget to discovery, dependency resolution, and final dispatch. */
export function raceControlPlaneOperation<T>(operation: Promise<T>, deadline: ControlPlaneOperationDeadline, stage: string): Promise<T> {
  const timeoutMs = normalizeTimeoutMs(deadline.timeoutMs);
  if (timeoutMs === undefined) return operation;
  const receivedAt = deadline.receivedAt ?? Date.now();
  const remaining = remainingTimeoutMs(timeoutMs, Date.now() - receivedAt) as number;
  return raceDeadline(operation, {
    deadlineAt: Date.now() + remaining,
    deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane control-plane deadline exceeded during ${stage}`),
    discardLateValue: discardDisposableValue,
  });
}

/** Invokes one discovered method through the shared authorization and transport path. */
export async function invokeControlPlaneMethod(
  invocation: ControlPlaneMethodInvocation,
  input: unknown,
  options: ControlPlaneInvocationOptions,
): Promise<unknown> {
  authorizePublishedAbility(invocation.ability, options.caller);
  const broker = createControlPlaneRpcBroker({
    ...(options.connInfo ? { connInfo: options.connInfo } : {}),
    controlPlaneServiceId: options.controlPlaneServiceId,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    issuer: options.issuer,
    ...(options.receivedAt === undefined ? {} : { receivedAt: options.receivedAt }),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    registry: singleAbilityRegistry(invocation.ability),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return raceControlPlaneOperation(
    broker.callAbility({
      abilityId: invocation.ability.id,
      ...(options.caller ? { caller: options.caller } : {}),
      input,
      method: invocation.method,
      scopes: [...invocation.scopes],
      targetServiceId: invocation.ability.serviceId,
    }),
    options,
    `${invocation.ability.serviceId}/${invocation.ability.id}/${invocation.method}`,
  );
}

function singleAbilityRegistry(ability: DiscoveredServiceAbility): ServiceRegistry {
  return {
    abilities: async () => [ability],
    ability: async (serviceId, abilityId) => (serviceId === ability.serviceId && abilityId === ability.id ? ability : undefined),
    discover: async () => ({ abilities: [ability], discoveredAt: new Date().toISOString(), services: [] }),
    endpoint: (serviceId) => (serviceId === ability.serviceId ? ability.service : undefined),
  };
}

// Catalog authorization is an early, readable refusal. The signed caller-access claim makes the
// service's own current ability definition the final authority even when discovery is stale.
function authorizePublishedAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.exposure !== 'published') throw new CapabilityAuthError('Service-Plane projected ability is not published', 404);
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && brokerCallerAccess(caller) === 'service') return;
  throw new CapabilityAuthError('Service-Plane projected call requires service access', 403);
}
