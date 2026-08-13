import { abilitySession, disposeAbilitySession } from '../service/index.js';
import type { ConnInfo } from '../shared/conn-info.js';
import { remainingTimeoutMs } from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneTimeoutError } from '../shared/errors.js';
import type { DiscoveredServiceAbility } from '../shared/types.js';
import { type BrokerCaller, brokerCallerAccess, brokerCallerSubject, brokerRequestToken, transportForAbility } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';

export type ControlPlaneMethodInvocation = {
  /** Discovered ability being invoked. */
  ability: DiscoveredServiceAbility;
  /** Ability method name. */
  method: string;
  /** Scopes required by the method. */
  scopes: string[];
};

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

/**
 * Invokes one discovered unary method through the same authorization and transport path used by
 * projected protocol surfaces. The session is always disposed before this function returns.
 */
export async function invokeControlPlaneMethod(
  invocation: ControlPlaneMethodInvocation,
  input: unknown,
  options: ControlPlaneInvocationOptions,
): Promise<unknown> {
  const { api, dispose } = await openControlPlaneMethodSession(invocation, options);
  try {
    const method = api[invocation.method];
    if (!method) throw new CapabilityAuthError(`Service-Plane projected method not found: ${invocation.method}`, 500);
    return await method(input);
  } finally {
    await dispose();
  }
}

/** Opens one projected method session for protocol surfaces that own a streaming response. */
export async function openControlPlaneMethodSession(
  invocation: ControlPlaneMethodInvocation,
  options: ControlPlaneInvocationOptions,
): Promise<{ api: Record<string, (methodInput: unknown) => Promise<unknown>>; dispose: () => Promise<void> }> {
  authorizePublishedAbility(invocation.ability, options.caller);
  const subject = brokerCallerSubject(options.caller);
  const timeoutMs = remainingTimeoutMs(options.timeoutMs, Date.now() - (options.receivedAt ?? Date.now()));
  if (timeoutMs === 0) {
    throw new ServicePlaneTimeoutError(
      `Service-Plane exhausted the caller's deadline before reaching the service: ${invocation.ability.serviceId}/${invocation.ability.id}`,
    );
  }

  const api = await abilitySession<Record<string, (methodInput: unknown) => Promise<unknown>>>({
    abilityId: invocation.ability.id,
    callerServiceId: options.caller?.kind === 'service' ? options.caller.id : options.controlPlaneServiceId,
    ...(options.connInfo ? { connInfo: options.connInfo } : {}),
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(subject ? { subject } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    requestToken: brokerRequestToken({
      ability: invocation.ability,
      brokerServiceId: options.controlPlaneServiceId,
      caller: options.caller,
      issuer: options.issuer,
    }),
    scopes: invocation.scopes,
    targetServiceId: invocation.ability.serviceId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    transport: transportForAbility(invocation.ability, {
      requiresStreaming: invocation.ability.methods[invocation.method]?.stream === true,
    }),
  });
  return { api, dispose: () => disposeAbilitySession(api) };
}

// Catalog authorization is an early, readable refusal. The signed caller-access claim makes the
// service's own current ability definition the final authority even when discovery is stale.
function authorizePublishedAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.exposure !== 'published') throw new CapabilityAuthError('Service-Plane projected ability is not published', 404);
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && brokerCallerAccess(caller) === 'service') return;
  throw new CapabilityAuthError('Service-Plane projected call requires service access', 403);
}
