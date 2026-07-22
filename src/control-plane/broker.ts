import { type RpcStub, RpcTarget } from 'capnweb';
import { abilitySession, cloudflareServiceBindingRpc, websocketRpc } from '../service/capabilities.js';
import { normalizeCapabilitySubject, servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import { SERVICE_PLANE_STREAM_CONTENT_TYPE } from '../shared/stream.js';
import {
  type CapabilitySubject,
  type DiscoveredServiceAbility,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceEndpoint,
  type ServiceRegistry,
} from '../shared/types.js';
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

export type OpenBrokeredAbilityStreamInput = {
  ability: DiscoveredServiceAbility;
  brokerServiceId: string;
  caller: BrokerCaller | undefined;
  callerServiceId: string;
  input?: unknown;
  issuer: CapabilityIssuer;
  method: string;
  requestId?: string;
  scopes: string[];
};

// Shared brokered path to a service's ability stream endpoint: authorize the requested scopes,
// mint the (brokered) capability token, and open the upstream NDJSON response without buffering.
// The caller is expected to be authorized for the ability already (access + caller resolution).
export async function openBrokeredAbilityStream(
  options: OpenBrokeredAbilityStreamInput,
): Promise<{ brokered: boolean; response: Response }> {
  const { ability } = options;
  const method = ability.methods[options.method];
  const streamPath = ability.rpc.streamPath;
  if (!method?.stream || !streamPath) {
    throw new CapabilityAuthError(
      `Service-Plane ability method does not stream: ${ability.serviceId}/${ability.id}/${options.method}`,
      405,
    );
  }

  const requested = [...new Set(options.scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (requested.length === 0) throw new CapabilityAuthError('Service-Plane broker stream requires at least one scope', 400);
  for (const scope of requested) {
    if (!ability.scopes.includes(scope)) {
      throw new CapabilityAuthError(`Service-Plane broker ability does not declare scope: ${scope}`, 403);
    }
  }

  const brokered = Boolean(ability.serviceIngress?.required);
  const subject = brokerCallerSubject(options.caller);
  const tokenInput = {
    callerServiceId: options.callerServiceId,
    scopes: requested,
    ...(subject ? { subject } : {}),
    targetServiceId: ability.serviceId,
  };
  const issued = brokered
    ? await options.issuer.issueBrokeredCapabilityToken({ ...tokenInput, brokerServiceId: options.brokerServiceId })
    : await options.issuer.issueCapabilityToken(tokenInput);

  const headers = new Headers({
    authorization: servicePlaneAuthorization(issued.token),
    'content-type': 'application/json',
  });
  if (options.requestId) headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, options.requestId);
  const response = await ability.service.fetch(
    new Request(new URL(streamPath, ability.service.origin), {
      body: JSON.stringify({ ...(options.input === undefined ? {} : { input: options.input }), method: options.method }),
      headers,
      method: 'POST',
    }),
  );
  return { brokered, response };
}

export type BrokerStreamHandlerOptions = {
  caller?: BrokerCaller;
  controlPlaneServiceId: string;
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  registry: ServiceRegistry;
  requestId?: string;
};

// HTTP stream lane of the broker: Cap'n Web sessions cannot carry incremental results, so
// brokered streaming calls POST here and the service's NDJSON response is piped through the
// control plane — services still only ever see plane-minted tokens.
export async function handleBrokerStreamRequest(request: Request, options: BrokerStreamHandlerOptions): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { headers: { allow: 'POST' }, status: 405 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON in Service-Plane broker stream request' }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { abilityId?: unknown }).abilityId !== 'string' ||
    typeof (body as { method?: unknown }).method !== 'string' ||
    typeof (body as { serviceId?: unknown }).serviceId !== 'string' ||
    !Array.isArray((body as { scopes?: unknown }).scopes) ||
    !((body as { scopes: unknown[] }).scopes as unknown[]).every((scope) => typeof scope === 'string')
  ) {
    return Response.json(
      { error: 'Service-Plane broker stream request requires serviceId, abilityId, method, and scopes' },
      { status: 400 },
    );
  }
  const streamRequest = body as { abilityId: string; input?: unknown; method: string; scopes: string[]; serviceId: string };

  const context = {
    abilityId: streamRequest.abilityId,
    caller: options.caller,
    requestId: options.requestId,
    serviceId: streamRequest.serviceId,
  };
  try {
    const ability = await options.registry.ability(streamRequest.serviceId, streamRequest.abilityId);
    if (!ability) {
      throw new CapabilityAuthError(`Service-Plane broker has no ability: ${streamRequest.serviceId}/${streamRequest.abilityId}`, 404);
    }
    authorizeAbility(ability, options.caller);
    const { brokered, response } = await openBrokeredAbilityStream({
      ability,
      brokerServiceId: options.controlPlaneServiceId,
      caller: options.caller,
      callerServiceId: options.caller?.kind === 'service' ? options.caller.id : options.controlPlaneServiceId,
      ...('input' in streamRequest ? { input: streamRequest.input } : {}),
      issuer: options.issuer,
      method: streamRequest.method,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      scopes: streamRequest.scopes,
    });
    options.log?.({
      abilityId: streamRequest.abilityId,
      brokered,
      ...brokerCallerLogFields(options.caller),
      event: response.ok ? 'service_plane.broker.stream.completed' : 'service_plane.broker.stream.failed',
      level: response.ok ? 'info' : 'warn',
      method: streamRequest.method,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      scopes: streamRequest.scopes,
      serviceId: streamRequest.serviceId,
      ...(response.ok ? {} : { status: response.status }),
    });
    // Pass the upstream response through untouched: item frames stream without buffering and
    // pre-stream service errors keep their status codes.
    return new Response(response.body, {
      headers: { 'content-type': response.headers.get('content-type') ?? SERVICE_PLANE_STREAM_CONTENT_TYPE },
      status: response.status,
    });
  } catch (error) {
    options.log?.(brokerStreamFailedEvent(error, context));
    const status = error instanceof CapabilityAuthError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}

function brokerStreamFailedEvent(
  error: unknown,
  context: { abilityId: string; caller: BrokerCaller | undefined; requestId?: string | undefined; serviceId: string },
): ServicePlaneBrokerLogEvent {
  return {
    abilityId: context.abilityId,
    ...brokerCallerLogFields(context.caller),
    error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error), name: 'Error' },
    event: 'service_plane.broker.stream.failed',
    level: 'warn',
    ...(context.requestId ? { requestId: context.requestId } : {}),
    serviceId: context.serviceId,
    ...(error instanceof CapabilityAuthError ? { status: error.status } : {}),
  };
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
  if (ability.rpc.transports.includes('http-batch')) {
    return cloudflareServiceBindingRpc(ability.service, ability.rpc.path, ability.service.origin);
  }
  if (ability.rpc.transports.includes('websocket')) {
    return websocketRpc(new URL(ability.rpc.path, ability.service.origin.replace(/^http/u, 'ws')).toString());
  }
  throw new CapabilityAuthError(`Service-Plane ability has no supported RPC transport: ${ability.serviceId}/${ability.id}`, 500);
}
