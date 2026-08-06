import { type RpcStub, RpcTarget } from 'capnweb';
import { abilitySession, cloudflareNativeRpc, cloudflareServiceBindingRpc, websocketRpc } from '../service/capabilities.js';
import { normalizeCapabilitySubject } from '../shared/capability-tokens.js';
import type { ConnInfo } from '../shared/conn-info.js';
import { CapabilityAuthError } from '../shared/errors.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import { isOriginRelativePath } from '../shared/paths.js';
import type {
  AbilityAccess,
  CapabilitySubject,
  DiscoveredServiceAbility,
  IssueCapabilityTokenInput,
  IssuedCapabilityToken,
  ServiceEndpoint,
  ServiceRegistry,
} from '../shared/types.js';
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
 * The access class the plane vouches for when it mints a token. Only a caller it authenticated as
 * another service counts as `service`; a user, an API key, an anonymous request, and a broker used
 * with no caller at all are all `plane`. Services enforce this against their ability's own `access`,
 * so the mapping here is the same decision `authorizeAbility` makes, carried into the token.
 */
export function brokerCallerAccess(caller: BrokerCaller | undefined): AbilityAccess {
  return caller?.kind === 'service' ? 'service' : 'plane';
}

/**
 * One token requester for broker and MCP so the brokered-vs-plain fork and the caller-class stamp
 * cannot drift between the two mounts — the same anti-drift contract as `transportForAbility` and
 * `brokerCallerLogFields`. Minting brokered tokens for ingress-required targets and stamping the
 * resolver's caller class are both security-relevant, so they live in exactly one place.
 */
export function brokerRequestToken(options: {
  ability: DiscoveredServiceAbility;
  brokerServiceId: string;
  caller: BrokerCaller | undefined;
  issuer: CapabilityIssuer;
}): (input: IssueCapabilityTokenInput) => Promise<IssuedCapabilityToken> {
  const callerAccess = brokerCallerAccess(options.caller);
  return (input) => {
    const request = { ...input, callerAccess };
    return options.ability.serviceIngress?.required
      ? options.issuer.issueBrokeredCapabilityToken({ ...request, brokerServiceId: options.brokerServiceId })
      : options.issuer.issueCapabilityToken(request);
  };
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
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  registry?: ServiceRegistry;
  requestId?: string;
  services?: ServiceEndpoint[];
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
  return {
    rootCapability(caller, rootOptions) {
      return new BrokerRoot(
        {
          allowStreaming: rootOptions?.allowStreaming ?? false,
          ...(options.connInfo ? { connInfo: options.connInfo } : {}),
          controlPlaneServiceId: options.controlPlaneServiceId,
          issuer: options.issuer,
          ...(options.log ? { log: options.log } : {}),
          registry,
          ...(options.requestId ? { requestId: options.requestId } : {}),
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
      issuer: CapabilityIssuer;
      log?: (event: ServicePlaneBrokerLogEvent) => void;
      registry: ServiceRegistry;
      requestId?: string;
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
        issuer: this.options.issuer,
        ability,
        ...(this.options.log ? { log: this.options.log } : {}),
        ...(this.options.requestId ? { requestId: this.options.requestId } : {}),
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
      issuer: CapabilityIssuer;
      log?: (event: ServicePlaneBrokerLogEvent) => void;
      requestId?: string;
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
        ...(subject ? { subject } : {}),
        ...(rejectStreamMethods && rejectStreamMethods.length > 0 ? { rejectStreamMethods } : {}),
        ...(this.input.requestId ? { requestId: this.input.requestId } : {}),
        requestToken: brokerRequestToken({
          ability: this.input.ability,
          brokerServiceId: this.input.brokerServiceId,
          caller: this.input.caller,
          issuer: this.input.issuer,
        }),
        scopes: requested,
        targetServiceId: this.input.ability.serviceId,
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

// Decided from the discovered catalog, which the plane caches, so this is the earlier and more
// legible of two checks rather than the only one: the same decision rides into the token as `spa`
// and the service re-checks it against its own definition. A catalog that has not caught up with a
// tightened `access` therefore refuses the call at the service instead of letting it through.
function authorizeAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && brokerCallerAccess(caller) === 'service') return;
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
