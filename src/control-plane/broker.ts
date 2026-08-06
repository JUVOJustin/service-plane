import { type RpcStub, RpcTarget } from 'capnweb';
import { abilitySession, cloudflareNativeRpc, cloudflareServiceBindingRpc, websocketRpc } from '../service/capabilities.js';
import { normalizeCapabilitySubject } from '../shared/capability-tokens.js';
import type { ConnInfo } from '../shared/conn-info.js';
import { normalizeTimeoutMs, remainingTimeoutMs } from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneTimeoutError } from '../shared/errors.js';
import { normalizeIdempotencyKey } from '../shared/idempotency.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import { isOriginRelativePath } from '../shared/paths.js';
import type { CapabilitySubject, DiscoveredServiceAbility, ServiceEndpoint, ServiceRegistry } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';
import { createServiceRegistry } from './registry.js';

export type BrokerCaller = {
  id: string;
  kind: 'service' | 'user';
  orgId?: string;
};

/**
 * User callers become the RFC 8693 delegated subject (`sub` = user, `act` = brokering service) so
 * target services see verified end-user attribution; service callers already ride in `sub` alone.
 * A blank orgId from the resolver is dropped rather than failing the call; a blank id still fails
 * closed, but here at the boundary with a clear error instead of deep inside token minting.
 */
export function brokerCallerSubject(caller: BrokerCaller | undefined): CapabilitySubject | undefined {
  if (caller?.kind !== 'user') return undefined;
  const orgId = caller.orgId?.trim();
  return normalizeCapabilitySubject({ id: caller.id, ...(orgId ? { orgId } : {}) });
}

/**
 * One projection for caller audit fields so broker and MCP log events cannot drift.
 */
export function brokerCallerLogFields(caller: BrokerCaller | undefined): {
  callerId?: string;
  callerKind?: BrokerCaller['kind'];
  callerOrgId?: string;
} {
  if (!caller) return {};
  return { callerId: caller.id, callerKind: caller.kind, ...(caller.orgId ? { callerOrgId: caller.orgId } : {}) };
}

export type CreateControlPlaneRpcBrokerOptions = {
  /**
   * Advisory connection info about the original client, forwarded to the target service. Services
   * surface it to handlers only for brokered calls with ingress enabled.
   */
  connInfo?: ConnInfo;
  controlPlaneServiceId: string;
  /**
   * The caller's key for this attempt, forwarded to the target service so a retry through the plane
   * is recognizable as one. The plane never generates it and never deduplicates on it.
   */
  idempotencyKey?: string;
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  /**
   * Reads the current time for deadline accounting. Both readings happen on this machine, so the
   * elapsed value never depends on the plane and the service agreeing about the clock. Injectable
   * for tests.
   */
  now?: () => number;
  /**
   * When this request reached the plane. Defaults to construction time, which is only the same
   * thing when the broker is built first — a shell that authenticates the caller or resolves its
   * catalog before constructing the broker must pass its own entry timestamp, or that work is not
   * charged to the caller's budget.
   */
  receivedAt?: number;
  registry?: ServiceRegistry;
  requestId?: string;
  services?: ServiceEndpoint[];
  /**
   * The caller's remaining budget in milliseconds when this request reached the plane. What is left
   * after the plane's own work — resolving the catalog, minting a token — is forwarded to the
   * service, so a slow plane spends the caller's budget rather than extending it.
   */
  timeoutMs?: number;
};

export type RootCapabilityOptions = {
  /**
   * Enable only when the caller's own leg to the broker is a session transport that can carry a
   * returned stream. The default is false so custom shells cannot accidentally return dangling
   * stream stubs over HTTP-batch.
   */
  allowStreaming?: boolean;
};

export type ControlPlaneRpcBroker = {
  rootCapability(caller?: BrokerCaller, options?: RootCapabilityOptions): RpcTarget;
};

export function createControlPlaneRpcBroker(options: CreateControlPlaneRpcBrokerOptions): ControlPlaneRpcBroker {
  const registry = options.registry ?? createServiceRegistry({ services: options.services ?? [] });
  const now = options.now ?? (() => Date.now());
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
  // Everything the plane does from this point on is time the caller is already waiting, so it comes
  // out of the budget forwarded downstream.
  const receivedAt = options.receivedAt ?? now();
  return {
    rootCapability(caller, rootOptions) {
      return new BrokerRoot(
        {
          allowStreaming: rootOptions?.allowStreaming ?? false,
          ...(options.connInfo ? { connInfo: options.connInfo } : {}),
          controlPlaneServiceId: options.controlPlaneServiceId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          issuer: options.issuer,
          ...(options.log ? { log: options.log } : {}),
          now,
          receivedAt,
          registry,
          ...(options.requestId ? { requestId: options.requestId } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        caller,
      );
    },
  };
}

class BrokerRoot extends RpcTarget {
  constructor(
    private readonly options: {
      allowStreaming: boolean;
      connInfo?: ConnInfo;
      controlPlaneServiceId: string;
      idempotencyKey?: string;
      issuer: CapabilityIssuer;
      log?: (event: ServicePlaneBrokerLogEvent) => void;
      now: () => number;
      receivedAt: number;
      registry: ServiceRegistry;
      requestId?: string;
      timeoutMs?: number;
    },
    private readonly caller: BrokerCaller | undefined,
  ) {
    super();
  }

  async ability(serviceId: string, abilityId: string): Promise<BrokeredAbility> {
    try {
      const ability = await this.options.registry.ability(serviceId, abilityId);
      if (!ability) {
        throw new CapabilityAuthError(`Service-Plane broker has no ability: ${serviceId}/${abilityId}`, 404);
      }
      authorizeAbility(ability, this.caller);
      return new BrokeredAbility({
        allowStreaming: this.options.allowStreaming,
        brokerServiceId: this.options.controlPlaneServiceId,
        ...(this.options.connInfo ? { connInfo: this.options.connInfo } : {}),
        caller: this.caller,
        callerServiceId: this.caller?.kind === 'service' ? this.caller.id : this.options.controlPlaneServiceId,
        ...(this.options.idempotencyKey ? { idempotencyKey: this.options.idempotencyKey } : {}),
        issuer: this.options.issuer,
        ability,
        ...(this.options.log ? { log: this.options.log } : {}),
        now: this.options.now,
        receivedAt: this.options.receivedAt,
        ...(this.options.requestId ? { requestId: this.options.requestId } : {}),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      });
    } catch (error) {
      this.options.log?.(brokerConnectFailedEvent(error, { abilityId, caller: this.caller, requestId: this.options.requestId, serviceId }));
      throw error;
    }
  }
}

class BrokeredAbility extends RpcTarget {
  constructor(
    private readonly input: {
      ability: DiscoveredServiceAbility;
      allowStreaming: boolean;
      brokerServiceId: string;
      caller: BrokerCaller | undefined;
      connInfo?: ConnInfo;
      callerServiceId: string;
      idempotencyKey?: string;
      issuer: CapabilityIssuer;
      log?: (event: ServicePlaneBrokerLogEvent) => void;
      now: () => number;
      receivedAt: number;
      requestId?: string;
      timeoutMs?: number;
    },
  ) {
    super();
  }

  async connect(scopes: string[]): Promise<RpcStub<unknown>> {
    const context = {
      abilityId: this.input.ability.id,
      caller: this.input.caller,
      requestId: this.input.requestId,
      serviceId: this.input.ability.serviceId,
    };
    try {
      const requested = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
      if (requested.length === 0) throw new CapabilityAuthError('Service-Plane broker connect requires at least one scope', 400);
      for (const scope of requested) {
        if (!this.input.ability.scopes.includes(scope)) {
          throw new CapabilityAuthError(`Service-Plane broker ability does not declare scope: ${scope}`, 403);
        }
      }

      const brokered = Boolean(this.input.ability.serviceIngress?.required);
      const subject = brokerCallerSubject(this.input.caller);
      // What the caller has left after the plane's own work. Measured against the plane's own clock
      // on both ends, so no clock agreement with the service is assumed. A budget already spent here
      // fails now rather than opening a session the caller has stopped waiting for.
      const timeoutMs = remainingTimeoutMs(this.input.timeoutMs, this.input.now() - this.input.receivedAt);
      if (timeoutMs === 0) {
        throw new ServicePlaneTimeoutError(
          `Service-Plane broker exhausted the caller's deadline before reaching the service: ${this.input.ability.serviceId}/${this.input.ability.id}`,
        );
      }
      // If the caller's own leg to the broker cannot carry a stream (HTTP-batch), reject the
      // ability's streaming methods with a clear 405 rather than returning a stream that fails
      // to serialize back to the caller and leaks the plane→service session.
      const rejectStreamMethods = this.input.allowStreaming
        ? undefined
        : Object.entries(this.input.ability.methods)
            .filter(([, method]) => method.stream)
            .map(([name]) => name);
      const session = (await abilitySession<unknown>({
        abilityId: this.input.ability.id,
        callerServiceId: this.input.callerServiceId,
        ...(this.input.connInfo ? { connInfo: this.input.connInfo } : {}),
        ...(this.input.idempotencyKey ? { idempotencyKey: this.input.idempotencyKey } : {}),
        ...(subject ? { subject } : {}),
        ...(rejectStreamMethods && rejectStreamMethods.length > 0 ? { rejectStreamMethods } : {}),
        ...(this.input.requestId ? { requestId: this.input.requestId } : {}),
        requestToken: (input) =>
          brokered
            ? this.input.issuer.issueBrokeredCapabilityToken({ ...input, brokerServiceId: this.input.brokerServiceId })
            : this.input.issuer.issueCapabilityToken(input),
        scopes: requested,
        targetServiceId: this.input.ability.serviceId,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        // Streaming methods are rejected outright when the caller's leg cannot carry a stream, so
        // the plane→service leg must not escalate to a persistent WebSocket it would never use.
        transport: transportForAbility(this.input.ability, this.input.allowStreaming ? {} : { requiresStreaming: false }),
      })) as RpcStub<unknown>;
      this.input.log?.({
        abilityId: this.input.ability.id,
        brokered,
        ...brokerCallerLogFields(this.input.caller),
        event: 'service_plane.broker.connect.completed',
        level: 'info',
        ...(this.input.requestId ? { requestId: this.input.requestId } : {}),
        scopes: requested,
        serviceId: this.input.ability.serviceId,
      });
      return session;
    } catch (error) {
      this.input.log?.(brokerConnectFailedEvent(error, context));
      throw error;
    }
  }
}

function brokerConnectFailedEvent(
  error: unknown,
  context: { abilityId: string; caller: BrokerCaller | undefined; requestId?: string | undefined; serviceId: string },
): ServicePlaneBrokerLogEvent {
  return {
    abilityId: context.abilityId,
    ...brokerCallerLogFields(context.caller),
    error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error), name: 'Error' },
    event: 'service_plane.broker.connect.failed',
    level: 'warn',
    ...(context.requestId ? { requestId: context.requestId } : {}),
    serviceId: context.serviceId,
    ...(error instanceof CapabilityAuthError ? { status: error.status } : {}),
  };
}

// Decided from the discovered catalog, which the plane caches. That makes `access` the one catalog
// field whose staleness *loosens* enforcement rather than delaying availability: the service checks
// scopes and ingress but never re-checks `access`, so tightening an ability from 'plane' to
// 'service' only takes effect once the plane's discovery cache refreshes. Until then a non-service
// caller that already holds a grant for the scope still gets through. Revoking the grant is the
// immediate lever; closing it properly needs the caller kind inside the token so the service can
// enforce this itself. Tracked in #32.
function authorizeAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && caller?.kind === 'service') return;
  throw new CapabilityAuthError('Service-Plane broker ability requires service access', 403);
}

/**
 * Shared transport selection for broker and MCP so the two cannot drift. The broker opens the
 * whole ability and uses its default all-methods view; single-method projections such as MCP can
 * request a session transport only for the method that needs one.
 */
export function transportForAbility(ability: DiscoveredServiceAbility, options: { requiresStreaming?: boolean } = {}) {
  const requiresStreaming = options.requiresStreaming ?? Object.values(ability.methods).some((method) => method.stream);
  // Native Workers RPC is session-shaped without holding a WebSocket and is the cheapest
  // same-account path for both unary and streaming methods.
  if (ability.service.abilityRpc && ability.rpc.transports.includes('cloudflare-binding-rpc')) {
    return cloudflareNativeRpc(ability.service.abilityRpc);
  }
  if (requiresStreaming) {
    if (ability.rpc.transports.includes('websocket')) {
      return abilityWebSocketTransport(ability);
    }
  }
  if (ability.rpc.transports.includes('http-batch')) {
    return cloudflareServiceBindingRpc(ability.service, ability.rpc.path, ability.service.origin);
  }
  if (ability.rpc.transports.includes('websocket')) {
    return abilityWebSocketTransport(ability);
  }
  throw new CapabilityAuthError(`Service-Plane ability has no supported RPC transport: ${ability.serviceId}/${ability.id}`, 500);
}

function abilityWebSocketTransport(ability: DiscoveredServiceAbility) {
  const url = abilityWebSocketUrl(ability);
  return websocketRpc(url, ability.service.createWebSocket ? { createWebSocket: ability.service.createWebSocket } : {});
}

function abilityWebSocketUrl(ability: DiscoveredServiceAbility): string {
  // Registry discovery applies the same check, but custom ServiceRegistry implementations can
  // supply abilities directly. Keep transport construction on the configured service origin.
  if (!isOriginRelativePath(ability.rpc.path)) {
    throw new CapabilityAuthError(`Service-Plane ability RPC path must be origin-relative: ${ability.serviceId}/${ability.id}`, 500);
  }
  return new URL(ability.rpc.path, ability.service.origin.replace(/^http/u, 'ws')).toString();
}
