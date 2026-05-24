import { type RpcStub, RpcTarget } from 'capnweb';
import { abilitySession, cloudflareServiceBindingRpc, websocketRpc } from '../service/capabilities.js';
import { CapabilityAuthError } from '../shared/errors.js';
import type { DiscoveredServiceAbility, ServiceEndpoint, ServiceRegistry } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';
import { createServiceRegistry } from './registry.js';

export type BrokerCaller = {
  id: string;
  kind: 'service' | 'user';
};

export type CreateControlPlaneRpcBrokerOptions = {
  controlPlaneServiceId: string;
  issuer: CapabilityIssuer;
  registry?: ServiceRegistry;
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
          registry,
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
      registry: ServiceRegistry;
    },
    private readonly caller: BrokerCaller | undefined,
  ) {
    super();
  }

  async ability(serviceId: string, abilityId: string): Promise<BrokeredAbility> {
    const ability = await this.options.registry.ability(serviceId, abilityId);
    if (!ability) {
      throw new CapabilityAuthError(`Service-Plane broker has no ability: ${serviceId}/${abilityId}`, 404);
    }
    authorizeAbility(ability, this.caller);
    return new BrokeredAbility({
      callerServiceId: this.caller?.kind === 'service' ? this.caller.id : this.options.controlPlaneServiceId,
      issuer: this.options.issuer,
      ability,
    });
  }
}

class BrokeredAbility extends RpcTarget {
  constructor(
    private readonly input: {
      ability: DiscoveredServiceAbility;
      callerServiceId: string;
      issuer: CapabilityIssuer;
    },
  ) {
    super();
  }

  async connect(scopes: string[]): Promise<RpcStub<unknown>> {
    const requested = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
    if (requested.length === 0) throw new CapabilityAuthError('Service-Plane broker connect requires at least one scope', 400);
    for (const scope of requested) {
      if (!this.input.ability.scopes.includes(scope)) {
        throw new CapabilityAuthError(`Service-Plane broker ability does not declare scope: ${scope}`, 403);
      }
    }

    return abilitySession<unknown>({
      abilityId: this.input.ability.id,
      callerServiceId: this.input.callerServiceId,
      requestToken: (input) => this.input.issuer.issueCapabilityToken(input),
      scopes: requested,
      targetServiceId: this.input.ability.serviceId,
      transport: transportForAbility(this.input.ability),
    }) as Promise<RpcStub<unknown>>;
  }
}

function authorizeAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.exposure === 'private') {
    if (caller?.kind !== 'service') {
      throw new CapabilityAuthError('Service-Plane broker only exposes private abilities to service callers', 403);
    }
    return;
  }
  if (ability.auth === 'anonymous') return;
  if (ability.auth === 'user' && caller?.kind === 'user') return;
  if (ability.auth === 'service' && caller?.kind === 'service') return;
  throw new CapabilityAuthError(
    `Service-Plane broker ability requires ${ability.auth} authentication`,
    ability.auth === 'service' ? 403 : 401,
  );
}

function transportForAbility(ability: DiscoveredServiceAbility) {
  if (ability.rpc.transports.includes('http-batch')) {
    return cloudflareServiceBindingRpc(ability.service, ability.rpc.path, ability.service.origin);
  }
  if (ability.rpc.transports.includes('websocket')) {
    return websocketRpc(new URL(ability.rpc.path, ability.service.origin.replace(/^http/u, 'ws')).toString());
  }
  throw new CapabilityAuthError(`Service-Plane ability has no supported RPC transport: ${ability.serviceId}/${ability.id}`, 500);
}
