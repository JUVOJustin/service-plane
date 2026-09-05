import { normalizeCapabilitySubject } from '../shared/capability-tokens.js';
import type { AbilityAccess, CapabilitySubject } from '../shared/types.js';

/** Authenticated product or service identity carried through the control-plane boundary. */
export type BrokerCaller = {
  /** Stable authenticated caller identifier. */
  id: string;
  /** Security-sensitive caller access classification. */
  kind: 'service' | 'user';
  /** Optional organization attached to a delegated plane-class subject. */
  orgId?: string;
  /**
   * Application-owned category for a plane-class principal, signed into delegated tokens without
   * changing the caller's `plane` access classification.
   */
  principalKind?: string;
};

/** Immutable authenticated target evaluated before a logical invocation may mint a capability. */
export type ControlPlaneAuthorizationInvocation = {
  /** Service-owned ability selected from the current catalog. */
  readonly abilityId: string;
  /** Authenticated caller; absent for a trusted plane-owned invocation. */
  readonly caller?: Readonly<BrokerCaller>;
  /** Resolved method name, without unvalidated input. */
  readonly method: string;
  /** Exact scopes requested for this invocation, including required method scopes. */
  readonly scopes: ReadonlyArray<string>;
  /** Service selected from the current catalog. */
  readonly serviceId: string;
};

/** Optional application policy; when configured, only literal `true` permits dispatch. */
export type ControlPlaneInvocationAuthorizer = (invocation: ControlPlaneAuthorizationInvocation) => boolean | Promise<boolean>;

/** Maps a product caller to the delegated subject signed into downstream capability tokens. */
export function brokerCallerSubject(caller: BrokerCaller | undefined): CapabilitySubject | undefined {
  if (caller?.kind !== 'user') return undefined;
  const orgId = caller.orgId?.trim();
  return normalizeCapabilitySubject({
    id: caller.id,
    ...(orgId ? { orgId } : {}),
    ...(caller.principalKind === undefined ? {} : { kind: caller.principalKind }),
  });
}

/** Maps an authenticated caller to the access class stamped into downstream tokens. */
export function brokerCallerAccess(caller: BrokerCaller | undefined): AbilityAccess {
  return caller?.kind === 'service' ? 'service' : 'plane';
}

/** Projects one authenticated caller into stable structured audit fields. */
export function brokerCallerLogFields(caller: BrokerCaller | undefined): {
  /** Authenticated caller identifier. */
  callerId?: string;
  /** Authenticated caller access category. */
  callerKind?: BrokerCaller['kind'];
  /** Delegated caller organization. */
  callerOrgId?: string;
  /** Application-owned delegated principal category. */
  callerPrincipalKind?: string;
} {
  if (!caller) return {};
  const principalKind = caller.kind === 'user' ? caller.principalKind?.trim() : undefined;
  return {
    callerId: caller.id,
    callerKind: caller.kind,
    ...(caller.orgId ? { callerOrgId: caller.orgId } : {}),
    ...(principalKind ? { callerPrincipalKind: principalKind } : {}),
  };
}
