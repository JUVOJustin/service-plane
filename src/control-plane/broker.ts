import { type RpcStub, RpcTarget } from 'capnweb';
import { abilitySession, cloudflareNativeRpc, cloudflareServiceBindingRpc, websocketRpc } from '../service/capabilities.js';
import { normalizeCapabilitySubject } from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import type { CapabilitySubject, DiscoveredServiceAbility, ServiceEndpoint, ServiceRegistry } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';
import { createServiceRegistry } from './registry.js';

export type BrokerCaller = {
  id: string;
  kind: 'service' | 'user';
  orgId?: string;
};

// User callers become the RFC 8693 delegated subject (`sub` = user, `act` = brokering service) so
// target services see verified end-user attribution; service callers already ride in `sub` alone.
// A blank orgId from the resolver is dropped rather than failing the call; a blank id still fails
// closed, but here at the boundary with a clear error instead of deep inside token minting.
export function brokerCallerSubject(caller: BrokerCaller | undefined): CapabilitySubject | undefined {
  if (caller?.kind !== 'user') return undefined;
  const orgId = caller.orgId?.trim();
  return normalizeCapabilitySubject({ id: caller.id, ...(orgId ? { orgId } : {}) });
}

// One projection for caller audit fields so broker and MCP log events cannot drift.
export function brokerCallerLogFields(caller: BrokerCaller | undefined): {
  callerId?: string;
  callerKind?: BrokerCaller['kind'];
  callerOrgId?: string;
} {
  if (!caller) return {};
  return { callerId: caller.id, callerKind: caller.kind, ...(caller.orgId ? { callerOrgId: caller.orgId } : {}) };
}

export type CreateControlPlaneRpcBrokerOptions = {
  controlPlaneServiceId: string;
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  registry?: ServiceRegistry;
  requestId?: string;
  services?: ServiceEndpoint[];
};

export type ControlPlaneRpcBroker = {
  rootCapability(caller?: BrokerCaller): RpcTarget;
};

export function createControlPlaneRpcBroker(options: CreateControlPlaneRpcBrokerOptions): ControlPlaneRpcBroker {
  const registry = options.registry ?? createServiceRegistry({ services: options.services ?? [] });
  return {
    rootCapability(caller) {
      return new BrokerRoot(
        {
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
        brokerServiceId: this.options.controlPlaneServiceId,
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
      brokerServiceId: string;
      caller: BrokerCaller | undefined;
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
      const session = (await abilitySession<unknown>({
        abilityId: this.input.ability.id,
        callerServiceId: this.input.callerServiceId,
        ...(subject ? { subject } : {}),
        ...(this.input.requestId ? { requestId: this.input.requestId } : {}),
        requestToken: (input) =>
          brokered
            ? this.input.issuer.issueBrokeredCapabilityToken({ ...input, brokerServiceId: this.input.brokerServiceId })
            : this.input.issuer.issueCapabilityToken(input),
        scopes: requested,
        targetServiceId: this.input.ability.serviceId,
        transport: transportForAbility(this.input.ability),
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

function authorizeAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && caller?.kind === 'service') return;
  throw new CapabilityAuthError('Service-Plane broker ability requires service access', 403);
}

function transportForAbility(ability: DiscoveredServiceAbility) {
  // Streaming methods need a session transport: prefer the endpoint's native ability RPC
  // binding, then WebSocket. Falling through to HTTP-batch keeps unary methods working; the
  // service rejects streaming calls there with a clear 405.
  if (Object.values(ability.methods).some((method) => method.stream)) {
    if (ability.service.abilityRpc && ability.rpc.transports.includes('cloudflare-binding-rpc')) {
      return cloudflareNativeRpc(ability.service.abilityRpc);
    }
    if (ability.rpc.transports.includes('websocket')) {
      return websocketRpc(new URL(ability.rpc.path, ability.service.origin.replace(/^http/u, 'ws')).toString());
    }
  }
  if (ability.rpc.transports.includes('http-batch')) {
    return cloudflareServiceBindingRpc(ability.service, ability.rpc.path, ability.service.origin);
  }
  if (ability.rpc.transports.includes('websocket')) {
    return websocketRpc(new URL(ability.rpc.path, ability.service.origin.replace(/^http/u, 'ws')).toString());
  }
  throw new CapabilityAuthError(`Service-Plane ability has no supported RPC transport: ${ability.serviceId}/${ability.id}`, 500);
}
