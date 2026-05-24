import { RpcTarget } from 'capnweb';
import { abilitySession, cloudflareServiceBindingRpc, websocketRpc } from '../service/index.js';
import { CapabilityAuthError } from '../shared/errors.js';
import {
  type DiscoveredServiceAbility,
  type McpDiscoveryDocument,
  SERVICE_PLANE_MCP_PATH,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import type { BrokerCaller } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';

export type ControlPlaneMcpBrokerOptions = {
  caller?: BrokerCaller;
  controlPlaneServiceId: string;
  issuer: CapabilityIssuer;
  registry: ServiceRegistry;
};

export type ControlPlaneMcpBroker = {
  rootCapability(): RpcTarget;
};

export type ControlPlaneMcpOptions = {
  path?: string;
};

export const DEFAULT_MCP_PATH = SERVICE_PLANE_MCP_PATH;

export function generateMcpDiscovery(snapshot: ServiceRegistrySnapshot): McpDiscoveryDocument {
  const tools = snapshot.abilities.flatMap((ability) => {
    if (ability.exposure !== 'published') return [];
    return Object.entries(ability.methods).flatMap(([methodName, method]) => {
      if (!method.mcp) return [];
      return [
        {
          ...(method.mcp.description ? { description: method.mcp.description } : {}),
          inputSchema: method.inputSchema,
          name: method.mcp.name,
          outputSchema: method.outputSchema,
          scopes: method.scopes,
          servicePlane: {
            abilityId: ability.id,
            method: methodName,
            serviceId: ability.serviceId,
          },
        },
      ];
    });
  });
  return { tools };
}

export function createControlPlaneMcpBroker(options: ControlPlaneMcpBrokerOptions): ControlPlaneMcpBroker {
  return {
    rootCapability() {
      return new McpRoot(options);
    },
  };
}

class McpRoot extends RpcTarget {
  constructor(private readonly options: ControlPlaneMcpBrokerOptions) {
    super();
  }

  async tools(): Promise<McpDiscoveryDocument> {
    return generateMcpDiscovery(await this.options.registry.discover());
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    const snapshot = await this.options.registry.discover();
    const match = findTool(snapshot, name);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP tool not found: ${name}`, 404);
    authorizePublishedAbility(match.ability, this.options.caller);

    const api = await abilitySession<Record<string, (methodInput: unknown) => Promise<unknown>>>({
      abilityId: match.ability.id,
      callerServiceId: this.options.caller?.kind === 'service' ? this.options.caller.id : this.options.controlPlaneServiceId,
      requestToken: (tokenInput) => this.options.issuer.issueCapabilityToken(tokenInput),
      scopes: match.scopes,
      targetServiceId: match.ability.serviceId,
      transport: transportForAbility(match.ability),
    });
    const method = api[match.method];
    if (!method) throw new CapabilityAuthError(`Service-Plane MCP tool method not found: ${match.method}`, 500);
    return method(input);
  }
}

function findTool(snapshot: ServiceRegistrySnapshot, name: string) {
  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [method, definition] of Object.entries(ability.methods)) {
      if (definition.mcp?.name === name) return { ability, method, scopes: definition.scopes };
    }
  }
  return undefined;
}

function authorizePublishedAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.auth === 'anonymous') return;
  if (ability.auth === 'user' && caller?.kind === 'user') return;
  if (ability.auth === 'service' && caller?.kind === 'service') return;
  throw new CapabilityAuthError(`Service-Plane MCP tool requires ${ability.auth} authentication`, ability.auth === 'service' ? 403 : 401);
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
