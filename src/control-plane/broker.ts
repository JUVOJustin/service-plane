import {
  RpcTarget,
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  RpcSession,
  type RpcCompatible,
  type RpcSessionOptions,
  type RpcStub,
  type RpcTransport,
} from 'capnweb';
import { CapabilityAuthError } from '../shared/errors.js';
import type { ServiceCapabilityVisibility, ServiceRpcEndpoint } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';
import type { AuthenticatedRoot } from '../service/client.js';

// ---------------------------------------------------------------------------
// Control-plane RPC broker.
//
// In the Hono-RPC era the control plane proxied HTTP requests and stamped a
// short-lived STS token on the Authorization header. Cap'n Web has no notion
// of a route to forward, so the broker exposes an `RpcTarget` whose methods
// return *brokered* sub-capabilities. Each brokered capability handles its
// own session against the target service, attaches the freshly-minted token
// via `authenticate(token)`, and forwards method calls along.
//
// Visibility maps directly: callers ask the broker for `public('example')`,
// `auth('example')`, or — for service-to-service callers identified by the
// `caller` configuration — `internal('example')`. The broker rejects any
// shape that the caller is not entitled to.
// ---------------------------------------------------------------------------

export type BrokeredCapabilityVisibility = ServiceCapabilityVisibility;

export type BrokeredServiceConfig = {
  /** Endpoint for the service. The broker uses `endpoint.fetch` for
   * HTTP-batch RPC and `endpoint.origin` to build the URL. */
  endpoint: ServiceRpcEndpoint;
  /** Capability id (matches `ServiceCapabilityDefinition.id` on the service)
   * exposed for each visibility. Defaults to the visibility name itself
   * (i.e. `'public'`, `'auth'`, `'internal'`). */
  capabilityIds?: Partial<Record<BrokeredCapabilityVisibility, string>>;
  /** Service id used by the issuer to mint capability tokens. Defaults to
   * `endpoint.id`. */
  serviceId?: string;
  /** Override the RPC transport used to talk to this service. Defaults to
   * HTTP-batch using the endpoint's `fetch`. */
  transport?: BrokeredServiceTransport;
};

export type BrokeredServiceTransport =
  | { kind: 'http-batch' }
  | { kind: 'websocket'; url: string }
  | { kind: 'custom'; openTransport: () => RpcTransport | Promise<RpcTransport> };

export type CreateControlPlaneRpcBrokerOptions = {
  /**
   * Service id of the control-plane. Used as `callerServiceId` when the
   * broker mints tokens for the public/auth surfaces it brokers on behalf
   * of unauthenticated or end-user-authenticated callers.
   */
  controlPlaneServiceId: string;
  /** Issuer used to mint capability tokens. */
  issuer: CapabilityIssuer;
  /** Cap'n Web session options forwarded to all opened sessions. */
  rpcSessionOptions?: RpcSessionOptions;
  /** Services brokered by this control-plane. */
  services: BrokeredServiceConfig[];
};

export type ControlPlaneRpcBroker = {
  /** Build the root `RpcTarget` to expose at the control-plane RPC endpoint.
   * `caller` may be `undefined` for unauthenticated public traffic, or set
   * to the verified end-user / service id for `auth` / `internal` traffic
   * (the broker uses it to gate which visibility levels can be requested). */
  rootCapability(caller?: BrokerCaller): RpcTarget;
};

export type BrokerCaller = {
  /** Stable identifier of the caller (service id or user id). Used as
   * `callerServiceId` when minting tokens. Required for `internal` traffic. */
  id: string;
  /** Whether the caller is a registered service (eligible for `internal`
   * visibility) or an end-user / public principal. */
  kind: 'service' | 'user';
};

export function createControlPlaneRpcBroker(options: CreateControlPlaneRpcBrokerOptions): ControlPlaneRpcBroker {
  const services = new Map(options.services.map((service) => [service.endpoint.id, service] as const));
  return {
    rootCapability(caller) {
      return new BrokerRoot({ ...options, services }, caller);
    },
  };
}

type Resolved = Omit<CreateControlPlaneRpcBrokerOptions, 'services'> & {
  services: Map<string, BrokeredServiceConfig>;
};

class BrokerRoot extends RpcTarget {
  readonly #options: Resolved;
  readonly #caller: BrokerCaller | undefined;

  constructor(options: Resolved, caller: BrokerCaller | undefined) {
    super();
    this.#options = options;
    this.#caller = caller;
  }

  /** Get a brokered stub for a service's `public` capability. The control
   * plane mints the token using its own service id as caller. */
  public(serviceId: string): RpcStub<unknown> {
    return this.#open(serviceId, 'public', this.#options.controlPlaneServiceId);
  }

  /** Get a brokered stub for a service's `auth` capability. The caller
   * identity supplied at construction time is forwarded as token subject so
   * the target service can attribute the call. */
  auth(serviceId: string): RpcStub<unknown> {
    if (!this.#caller) {
      throw new CapabilityAuthError('Service-Plane control-plane broker requires an authenticated caller for `auth` capabilities', 401);
    }
    return this.#open(serviceId, 'auth', this.#caller.id);
  }

  /** Get a brokered stub for a service's `internal` capability. Only callers
   * registered as `kind: 'service'` may request internal capabilities. */
  internal(serviceId: string): RpcStub<unknown> {
    if (!this.#caller || this.#caller.kind !== 'service') {
      throw new CapabilityAuthError('Service-Plane control-plane broker only exposes `internal` capabilities to service callers', 403);
    }
    return this.#open(serviceId, 'internal', this.#caller.id);
  }

  #open(serviceId: string, visibility: BrokeredCapabilityVisibility, callerServiceId: string): RpcStub<unknown> {
    const service = this.#options.services.get(serviceId);
    if (!service) {
      throw new CapabilityAuthError(`Service-Plane broker has no service registered as: ${serviceId}`, 404);
    }
    const capabilityId = service.capabilityIds?.[visibility] ?? visibility;
    const targetServiceId = service.serviceId ?? service.endpoint.id;
    return openBrokeredCapability({
      callerServiceId,
      capabilityId,
      endpoint: service.endpoint,
      issuer: this.#options.issuer,
      ...(this.#options.rpcSessionOptions ? { rpcSessionOptions: this.#options.rpcSessionOptions } : {}),
      targetServiceId,
      transport: service.transport ?? { kind: 'http-batch' },
    });
  }
}

type OpenInput = {
  callerServiceId: string;
  capabilityId: string;
  endpoint: ServiceRpcEndpoint;
  issuer: CapabilityIssuer;
  rpcSessionOptions?: RpcSessionOptions;
  targetServiceId: string;
  transport: BrokeredServiceTransport;
};

function openBrokeredCapability(input: OpenInput): RpcStub<unknown> {
  // Sessions are opened lazily on the first `connect()` call so that we
  // never establish an outbound connection unless a caller actually uses it.
  const wrapper = new BrokeredCapability(input);
  return wrapper as unknown as RpcStub<unknown>;
}

class BrokeredCapability extends RpcTarget {
  readonly #input: OpenInput;
  #rootPromise: Promise<RpcStub<AuthenticatedRoot<unknown>>> | undefined;

  constructor(input: OpenInput) {
    super();
    this.#input = input;
  }

  /** Open the brokered capability with the given scopes. Returns a pipelined
   * stub authenticated with a freshly-minted capability token; subsequent
   * method calls on the returned stub are sent in the same RPC batch. */
  async connect(scopes: string[]): Promise<RpcStub<unknown>> {
    const issued = await this.#input.issuer.issueCapabilityToken({
      callerServiceId: this.#input.callerServiceId,
      scopes,
      targetServiceId: this.#input.targetServiceId,
    });
    if (!this.#rootPromise) {
      this.#rootPromise = Promise.resolve(openServiceSession(this.#input));
    }
    const root = await this.#rootPromise;
    return root.authenticate(issued.token) as unknown as RpcStub<unknown>;
  }
}

function openServiceSession(input: OpenInput): RpcStub<AuthenticatedRoot<unknown>> | Promise<RpcStub<AuthenticatedRoot<unknown>>> {
  const transport = input.transport;
  if (transport.kind === 'http-batch') {
    if (input.endpoint.fetch) {
      return openHttpBatchOverBinding(input);
    }
    const url = capabilityUrl(input);
    return newHttpBatchRpcSession<AuthenticatedRoot<unknown>>(url, input.rpcSessionOptions);
  }
  if (transport.kind === 'websocket') {
    return newWebSocketRpcSession<AuthenticatedRoot<unknown>>(transport.url, undefined, input.rpcSessionOptions);
  }
  // Custom transport: opened lazily via the supplied factory.
  return Promise.resolve(transport.openTransport()).then((rpcTransport) => {
    const session = new RpcSession<AuthenticatedRoot<unknown>>(rpcTransport, undefined, input.rpcSessionOptions);
    return session.getRemoteMain();
  });
}

function openHttpBatchOverBinding(input: OpenInput): RpcStub<AuthenticatedRoot<unknown>> {
  // When the service is reachable via a Cloudflare Service Binding, the
  // broker dispatches HTTP-batch RPC through the binding's fetch hook. Cap'n
  // Web doesn't expose a custom-fetch hook for `newHttpBatchRpcSession`, so
  // we wire up a thin fetch-backed RpcTransport that POSTs the batch in one
  // shot.
  const fetcher = input.endpoint.fetch!;
  const url = capabilityUrl(input);
  const transport = createFetchBatchTransport(fetcher, url);
  const session = new RpcSession<AuthenticatedRoot<unknown>>(transport, undefined, input.rpcSessionOptions);
  return session.getRemoteMain();
}

function capabilityUrl(input: OpenInput): string {
  const origin = input.endpoint.origin ?? `https://${input.endpoint.id}.service-plane.internal`;
  const rpcPath = input.endpoint.rpcPath ?? `/rpc/${input.capabilityId}`;
  return new URL(rpcPath, origin).toString();
}

function createFetchBatchTransport(fetcher: (request: Request) => Promise<Response>, url: string): RpcTransport {
  // Cap'n Web's HTTP-batch protocol is a single POST whose body is the
  // serialized outbound batch and whose response body is the serialized
  // inbound batch. The runtime drives `send` for each outgoing message and
  // calls `receive` for each incoming one. We accumulate sends until the
  // first receive and ship them as a single request.
  let outbox: string[] = [];
  let inboxQueue: string[] = [];
  let pending: Promise<void> | undefined;

  return {
    async send(message) {
      outbox.push(message);
    },
    async receive() {
      if (inboxQueue.length > 0) return inboxQueue.shift()!;
      if (!pending) {
        pending = (async () => {
          const body = outbox.join('\n');
          outbox = [];
          const response = await fetcher(new Request(url, { body, method: 'POST' }));
          if (!response.ok) {
            throw new CapabilityAuthError(`Cap'n Web HTTP-batch transport failed: ${response.status}`, response.status);
          }
          const text = await response.text();
          inboxQueue = text.length > 0 ? text.split('\n').filter((line) => line.length > 0) : [];
        })();
      }
      await pending;
      pending = undefined;
      if (inboxQueue.length === 0) {
        // No more messages — the batch is complete. Block forever; Cap'n Web
        // treats this as a clean shutdown.
        return new Promise<string>(() => {});
      }
      return inboxQueue.shift()!;
    },
    abort() {
      outbox = [];
      inboxQueue = [];
    },
  };
}

// Re-exported for callers that want to attach a custom RPC root capability
// type at the call site.
export type { RpcStub, RpcCompatible };
