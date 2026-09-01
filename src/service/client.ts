import { type ClientLink, type ClientOptions, DynamicLink, wrapAsyncIteratorPreservingEventMeta } from '@orpc/client';
import { RPCLink as FetchRpcLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { decodeCapabilityTokenPayload, servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { type ConnInfo, normalizeConnInfo, SERVICE_PLANE_CONN_INFO_HEADER, serializeConnInfo } from '../shared/conn-info.js';
import {
  createDeadlineSignal,
  discardDisposableValue,
  normalizeTimeoutMs,
  parseTimeoutMs,
  raceAbortSignal,
  remainingTimeoutMs,
  SERVICE_PLANE_TIMEOUT_GRACE_MS,
  SERVICE_PLANE_TIMEOUT_HEADER,
  serializeTimeoutMs,
  signalBoundAsyncIterator,
} from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneClientError, ServicePlaneTimeoutError, servicePlaneClientError } from '../shared/errors.js';
import { createFlatAbilityClient } from '../shared/flat-ability-client.js';
import { normalizeIdempotencyKey, SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER } from '../shared/idempotency.js';
import { normalizeOriginRelativePath } from '../shared/paths.js';
import type {
  CapabilitySubject,
  CapabilityTokenCache,
  CapabilityTokenProvider,
  FetchLike,
  ServiceAbilityNativeCall,
} from '../shared/types.js';
import { SERVICE_PLANE_PROOF_HEADER, SERVICE_PLANE_REQUEST_ID_HEADER } from '../shared/types.js';
import { type CapabilityProofSigner, type CapabilityTokenRequester, createCapabilityTokenProvider } from './capabilities.js';
import {
  type AbilityCallOptions,
  type AbilityClient,
  type AbilityMethodDefinitions,
  abilityClientScopesByMethod,
  abilityClientScopesForMethod,
  type ServiceAbilityDefinition,
} from './discovery.js';
import { createRpcClientPlugins } from './orpc-features.js';
import type { ServicePlaneClientWireOptions } from './wire-options.js';

/** Service binding entrypoint used for unary ability calls without the HTTP/JSON codec. */
export type AbilityNativeBinding = {
  /** Calls one authorized ability method inside the target Worker. */
  invokeAbility(input: NativeAbilityCall): Promise<unknown> | unknown;
  /** Fetch fallback used for streaming methods, which need the package's streaming codec. */
  fetch?(request: Request): Promise<Response>;
};

/** Serialized call envelope accepted by a Cloudflare native service binding. */
export type NativeAbilityCall = ServiceAbilityNativeCall;

/** Reconnect policy for a Service Plane WebSocket client. */
export type ServicePlaneWebSocketReconnectOptions = {
  /** Returns the wait in milliseconds before each connection retry. */
  delay?: (info: {
    /** Consecutive attempt count for the current outage. */
    attempt: number;
    /** Total connection attempts made by this client. */
    totalAttempt: number;
  }) => number;
  /** Allows the client to retry a failed WebSocket connection. */
  enabled: boolean;
  /** Maximum consecutive attempts before the call fails. */
  maxAttempt?: number;
  /** Proactively reconnects after a socket closes. */
  onClose?: {
    /** Fixed wait in milliseconds before reconnecting after a close event. */
    delay?: number;
    /** When true, a close event starts a proactive reconnect attempt. */
    enabled: boolean;
  };
};

/** Structural WebSocket surface accepted by Service Plane clients and test doubles. */
export type AbilityClientWebSocket = Pick<WebSocket, 'addEventListener' | 'close' | 'readyState' | 'removeEventListener' | 'send'>;

/** Runtime transport choices for a typed ability client. */
export type AbilityClientTransport =
  | (ServicePlaneClientWireOptions & {
      /** Ordinary Fetch, including `env.SERVICE.fetch` on Cloudflare service bindings. */
      fetch?: FetchLike | typeof fetch;
      /** Origin used to resolve the ability's RPC path. */
      origin?: string;
      /** Selects ordinary Service Plane Fetch. */
      type: 'fetch';
    })
  | (Omit<ServicePlaneClientWireOptions, 'batch'> & {
      /** Cloudflare native RPC for unary calls, with binding Fetch for streams. */
      binding: AbilityNativeBinding;
      /** Synthetic origin used by the binding's Fetch streaming fallback. */
      origin?: string;
      /** Selects Cloudflare native unary RPC with binding Fetch streams. */
      type: 'service-binding';
    })
  | {
      /** Long-lived WebSocket with optional reconnect behavior. */
      createWebSocket?: (url: string) => AbilityClientWebSocket;
      /** Reconnect policy owned by the caller. */
      reconnect?: ServicePlaneWebSocketReconnectOptions;
      /** Selects Service Plane WebSocket. */
      type: 'websocket';
      /** Physical WebSocket endpoint. */
      url: string;
    };

type AbilityClientTokenOptions =
  | {
      /** Existing provider; method-derived scopes are passed when the provider chooses to use them. */
      tokenProvider: CapabilityTokenProvider;
    }
  | {
      /** Service identity requesting the target capability. */
      callerServiceId: string;
      /** Optional cache shared across capability-token requests. */
      cache?: CapabilityTokenCache;
      /** Refreshes a cached token this many seconds before expiry. */
      refreshSkewSeconds?: number;
      /** Requests a capability token from the control plane; the client caches it until refresh. */
      requestToken: (
        input: import('../shared/types.js').IssueCapabilityTokenInput,
      ) => Promise<import('../shared/types.js').IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
      /** Delegated subject for trusted direct callers. */
      subject?: CapabilitySubject;
      /** Discriminates this requester-owned branch from an existing provider. */
      tokenProvider?: undefined;
      /** Requested token lifetime in seconds. */
      ttlSeconds?: number;
    };

/** Options for creating a typed client from an ability definition. */
export type CreateAbilityClientOptions<TAbility extends ServiceAbilityDefinition> = AbilityClientTokenOptions & {
  /** Portable ability definition; its id and method contracts drive the client. */
  ability: TAbility;
  /** Default advisory connection information; individual calls may override it. */
  connInfo?: ConnInfo;
  /** Default caller-owned attempt key; individual calls may override it. */
  idempotencyKey?: string;
  /** Creates proof for sender-constrained tokens. */
  proveTokenPossession?: CapabilityProofSigner;
  /** Default correlation id; individual calls may override it. */
  requestId?: string;
  /** Additional ability-level scopes requested by every method; required method scopes are automatic. */
  scopes?: string[];
  /** Service that owns the ability. */
  targetServiceId: string;
  /** Default local and forwarded deadline; individual calls may override it. */
  timeoutMs?: number;
  /** Wire transport used to reach the service. */
  transport: AbilityClientTransport;
};

/** Transport from a public caller or headless front to the central control plane. */
export type BrokeredAbilityTransport =
  | (ServicePlaneClientWireOptions & {
      /** Fetch implementation, including an in-process control-plane adapter. */
      fetch?: FetchLike | typeof fetch;
      /** Caller authentication headers understood by the control plane. */
      headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
      /** Public control-plane origin. */
      origin?: string;
      /** Logical broker prefix, normally `/rpc/broker`. */
      path?: string;
      /** Selects ordinary Fetch when omitted or set to `fetch`. */
      type?: 'fetch';
    })
  | {
      /** Creates the physical socket and owns any WebSocket handshake authentication. */
      createWebSocket?: (url: string) => AbilityClientWebSocket;
      /** Logical broker prefix, normally `/rpc/broker`. */
      path?: string;
      /** Reconnect policy owned by the public caller. */
      reconnect?: ServicePlaneWebSocketReconnectOptions;
      /** Selects the WebSocket broker endpoint. */
      type: 'websocket';
      /** Public WebSocket endpoint, including any URL-based handshake authentication. */
      url: string;
    };

/** Options for a typed ability client whose calls all pass through the control plane. */
export type BrokeredAbilityCallOptions = Omit<AbilityCallOptions, 'connInfo'>;

/** Options for a typed ability client whose calls all pass through the control plane. */
export type CreateBrokeredAbilityClientOptions<TAbility extends ServiceAbilityDefinition> = {
  /** Portable ability definition; its methods drive the returned client type. */
  ability: TAbility;
  /** Default caller-owned attempt key; individual calls may override it. */
  idempotencyKey?: string;
  /** Default correlation id; individual calls may override it. */
  requestId?: string;
  /** Additional ability-level scopes requested by every method; required method scopes are automatic. */
  scopes?: string[];
  /** Service that owns the ability. */
  targetServiceId: string;
  /** Default end-to-end caller budget; individual calls may override it. */
  timeoutMs?: number;
  /** Public transport to the central control plane. */
  transport: BrokeredAbilityTransport;
};

const ABILITY_CALL_RECEIVED_AT = Symbol('service-plane.ability-call-received-at');

type AbilityClientContext = Omit<AbilityCallOptions, 'signal'> & {
  [ABILITY_CALL_RECEIVED_AT]?: number;
};
type AbilityORPCCallOptions = ClientOptions<AbilityClientContext>;
type AbilityClientLink = ClientLink<AbilityClientContext>;
type AbilityHeadersResolver = (options: AbilityORPCCallOptions, path: string[]) => Promise<Headers>;
type ClientMetadataDefaults = {
  connInfo?: ConnInfo;
  idempotencyKey?: string;
  requestId?: string;
  timeoutMs?: number;
};

type ResolvedCallMetadata = Omit<ClientMetadataDefaults, 'timeoutMs'> & {
  requestedTimeoutMs?: number;
  timeoutMs?: number;
};

const abilityClientLifecycles = new WeakMap<object, WebSocketAbilityClientLifecycle>();
// oRPC treats a failed reconnect factory as a reason to retry. Returning an inert OPEN peer after
// disposal lets its pending connect loop settle without another timer or physical socket; the
// lifecycle link has already rejected every logical call and blocks all later ones.
const DISPOSED_ABILITY_CLIENT_WEB_SOCKET = {
  addEventListener: () => undefined,
  close: () => undefined,
  readyState: 1,
  removeEventListener: () => undefined,
  send: () => undefined,
} as AbilityClientWebSocket;

class WebSocketAbilityClientLifecycle {
  readonly #controller = new AbortController();
  readonly #disposedError = new ServicePlaneClientError({
    code: 'cancelled',
    message: 'Service-Plane ability client is disposed',
    retryable: false,
    status: 499,
  });
  readonly #iterators = new Set<AsyncIterator<unknown>>();
  readonly #sockets = new Set<AbilityClientWebSocket>();
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Tracks sockets created through the public factory without depending on link internals. */
  connect(create: () => AbilityClientWebSocket): AbilityClientWebSocket {
    if (this.#disposed) return DISPOSED_ABILITY_CLIENT_WEB_SOCKET;
    const socket = create();
    this.#sockets.add(socket);
    socket.addEventListener('close', () => this.#sockets.delete(socket), { once: true });
    return managedAbilityClientWebSocket(socket, this);
  }

  /** Keeps active stream cancellation under the same client-owned lifetime. */
  trackIterator(iterator: AsyncIterator<unknown>): void {
    if (this.#disposed) {
      discardDisposableValue(iterator);
      return;
    }
    this.#iterators.add(iterator);
  }

  /** Drops completed streams so a long-lived client does not retain them. */
  untrackIterator(iterator: AsyncIterator<unknown>): void {
    this.#iterators.delete(iterator);
  }

  /** Stops active calls before closing every physical socket exactly once. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#controller.abort(this.#disposedError);
    const iterators = [...this.#iterators];
    this.#iterators.clear();
    for (const iterator of iterators) discardDisposableValue(iterator);
    const sockets = [...this.#sockets];
    this.#sockets.clear();
    for (const socket of sockets) {
      try {
        if (socket.readyState < 2) socket.close(1000, 'Service Plane client disposed');
      } catch {
        // Cleanup is best-effort after the client has already become unusable.
      }
    }
  }
}

function managedAbilityClientWebSocket(socket: AbilityClientWebSocket, lifecycle: WebSocketAbilityClientLifecycle): AbilityClientWebSocket {
  return {
    addEventListener: socket.addEventListener.bind(socket),
    close: socket.close.bind(socket),
    removeEventListener: socket.removeEventListener.bind(socket),
    // The private link interprets a closed socket as a reconnect request. Once disposed, keep its
    // already-closed peer selected so proactive reconnect cannot create another physical socket.
    get readyState() {
      return lifecycle.disposed ? 1 : socket.readyState;
    },
    send: socket.send.bind(socket),
  } as AbilityClientWebSocket;
}

/**
 * Creates a synchronous, fully typed ability client. Tokens and sockets are resolved lazily on the
 * first call, so constructing a client has no network side effects.
 */
export function createAbilityClient<TAbility extends ServiceAbilityDefinition<import('hono').Env, AbilityMethodDefinitions>>(
  options: CreateAbilityClientOptions<TAbility>,
): AbilityClient<TAbility> {
  const scopesByMethod = abilityClientScopesByMethod(options.ability, options.scopes);
  const tokenProvider = abilityTokenProvider(options, scopesByMethod);
  const defaults = clientMetadataDefaults(options);
  const headers: AbilityHeadersResolver = async (callOptions, path): Promise<Headers> => {
    const token = await callWithSignal(tokenProvider(methodNameFromPath(options.ability, path)), callOptions.signal);
    const proof = await callWithSignal(capabilityProof(options, token), callOptions.signal);
    const result = new Headers({ authorization: servicePlaneAuthorization(token) });
    const metadata = resolveForwardedCallMetadata(defaults, callOptions, path.join('.'));
    const connInfo = serializeConnInfo(metadata.connInfo);
    const idempotencyKey = normalizeIdempotencyKey(metadata.idempotencyKey);
    const timeout = serializeTimeoutMs(metadata.timeoutMs);
    if (connInfo) result.set(SERVICE_PLANE_CONN_INFO_HEADER, connInfo);
    if (idempotencyKey) result.set(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    if (proof) result.set(SERVICE_PLANE_PROOF_HEADER, proof);
    if (metadata.requestId) result.set(SERVICE_PLANE_REQUEST_ID_HEADER, metadata.requestId);
    if (timeout) result.set(SERVICE_PLANE_TIMEOUT_HEADER, timeout);
    return result;
  };
  const lifecycle = options.transport.type === 'websocket' ? new WebSocketAbilityClientLifecycle() : undefined;
  const baseLink = abilityClientLink(options, headers, defaults, lifecycle);
  return createTypedAbilityClient(options.ability, deadlineClientLink(baseLink, defaults, lifecycle), lifecycle);
}

/**
 * Creates the same typed ability client through the public control-plane broker. This is the
 * browser/headless-front path: callers know the ability contract but never see a service token or
 * a private service address.
 */
export function createBrokeredAbilityClient<TAbility extends ServiceAbilityDefinition<import('hono').Env, AbilityMethodDefinitions>>(
  options: CreateBrokeredAbilityClientOptions<TAbility>,
): AbilityClient<TAbility, BrokeredAbilityCallOptions> {
  const scopesByMethod = abilityClientScopesByMethod(options.ability, options.scopes);
  const defaults = clientMetadataDefaults(options);
  const transport = options.transport;
  const brokerHeaders = async (callOptions: AbilityORPCCallOptions) => {
    const configured = await callWithSignal(
      Promise.resolve(
        transport.type === 'websocket' ? undefined : typeof transport.headers === 'function' ? transport.headers() : transport.headers,
      ),
      callOptions.signal,
    );
    const headers = new Headers(configured);
    const metadata = resolveForwardedCallMetadata(defaults, callOptions, 'control-plane broker');
    const idempotencyKey = normalizeIdempotencyKey(metadata.idempotencyKey);
    const timeout = serializeTimeoutMs(metadata.timeoutMs);
    if (idempotencyKey) headers.set(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    if (metadata.requestId) headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, metadata.requestId);
    if (timeout) headers.set(SERVICE_PLANE_TIMEOUT_HEADER, timeout);
    return headers;
  };
  const brokerPath = normalizeClientRpcPath(transport.path ?? '/rpc/broker', 'control-plane broker');
  let brokerLink: AbilityClientLink;
  let brokerStreamLink: AbilityClientLink;
  const lifecycle = transport.type === 'websocket' ? new WebSocketAbilityClientLifecycle() : undefined;
  if (transport.type === 'websocket') {
    if (!lifecycle) throw new CapabilityAuthError('Service-Plane WebSocket client lifecycle is required', 500);
    brokerLink = new WebSocketRpcLink({
      connect: () => lifecycle.connect(() => (transport.createWebSocket ?? ((url: string) => new WebSocket(url)))(transport.url)),
      headers: brokerHeaders,
      ...(transport.reconnect ? { reconnect: transport.reconnect } : {}),
      url: brokerPath,
    });
    brokerStreamLink = brokerLink;
  } else {
    const fetchLink = (wire: ServicePlaneClientWireOptions): AbilityClientLink =>
      new FetchRpcLink({
        ...(transport.fetch
          ? {
              fetch: async (url, init) =>
                typeof transport.fetch === 'function'
                  ? transport.fetch(url, init)
                  : (transport.fetch as FetchLike).fetch(new Request(url, init)),
            }
          : {}),
        headers: brokerHeaders,
        origin: transport.origin ?? 'https://service-plane-control-plane.internal',
        plugins: createRpcClientPlugins(wire),
        url: brokerPath,
      });
    brokerLink = fetchLink(transport);
    brokerStreamLink = transport.batch ? fetchLink({ ...transport, batch: false }) : brokerLink;
  }
  const abilityLink: AbilityClientLink = {
    call(path, input, callOptions) {
      const { definition, methodName } = abilityMethodFromPath(options.ability, path);
      if (definition.kind === 'hibernation') {
        throw brokeredHibernationTransportError(options.ability.id, methodName);
      }
      const link = definition.kind === 'unary' ? brokerLink : brokerStreamLink;
      return link.call(
        [definition.kind === 'unary' ? 'call' : 'stream'],
        {
          abilityId: options.ability.id,
          input,
          method: methodName,
          scopes: abilityClientScopesForMethod(scopesByMethod, options.ability.id, methodName),
          targetServiceId: options.targetServiceId,
        },
        callOptions,
      );
    },
  };
  return createTypedAbilityClient(options.ability, deadlineClientLink(abilityLink, defaults, lifecycle), lifecycle) as AbilityClient<
    TAbility,
    BrokeredAbilityCallOptions
  >;
}

/**
 * Releases transport resources owned by a typed ability client. WebSocket disposal cancels active
 * streams, closes physical sockets, prevents reconnect, and rejects later calls. Fetch and native
 * clients have no persistent transport resource, so disposing them is an idempotent no-op.
 */
export function disposeAbilityClient<
  TAbility extends ServiceAbilityDefinition,
  TCallOptions extends AbilityCallOptions = AbilityCallOptions,
>(client: AbilityClient<TAbility, TCallOptions>): void {
  abilityClientLifecycles.get(client)?.dispose();
}

function createTypedAbilityClient<TAbility extends ServiceAbilityDefinition>(
  ability: TAbility,
  link: AbilityClientLink,
  lifecycle?: WebSocketAbilityClientLifecycle,
): AbilityClient<TAbility> {
  const client = createFlatAbilityClient<AbilityClient<TAbility>, AbilityCallOptions>(Object.keys(ability.methods), {
    async call(path, input, options = {}) {
      const { signal, ...context } = options ?? {};
      try {
        const result = await link.call(path, input, {
          context,
          ...(signal ? { signal } : {}),
        });
        if (!isAsyncIterator(result)) return result;
        return wrapAsyncIteratorPreservingEventMeta(result, {
          mapError: (error) => abilityClientCallError(error, signal, lifecycle),
          mapResult: (value) => value,
        });
      } catch (error) {
        throw abilityClientCallError(error, signal, lifecycle);
      }
    },
  });
  if (lifecycle) abilityClientLifecycles.set(client, lifecycle);
  return client;
}

function abilityClientCallError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  lifecycle: WebSocketAbilityClientLifecycle | undefined,
): ServicePlaneClientError {
  const abortedSignal = callerSignal?.aborted ? callerSignal : lifecycle?.signal.aborted ? lifecycle.signal : callerSignal;
  return servicePlaneClientError(error, abortedSignal);
}

function abilityTokenProvider<TAbility extends ServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  scopesByMethod: ReadonlyMap<string, string[]>,
): (methodName: string) => Promise<string> {
  const configuredProvider = options.tokenProvider;
  if (configuredProvider) {
    return (methodName) => configuredProvider.token(abilityClientScopesForMethod(scopesByMethod, options.ability.id, methodName));
  }

  const providersByScopeSet = new Map<string, CapabilityTokenProvider>();
  const providersByMethod = new Map<string, CapabilityTokenProvider>();
  for (const [methodName, scopes] of scopesByMethod) {
    const key = JSON.stringify([...scopes].sort());
    let provider = providersByScopeSet.get(key);
    if (!provider) {
      provider = createCapabilityTokenProvider({
        abilityId: options.ability.id,
        ...(options.cache ? { cache: options.cache } : {}),
        callerServiceId: options.callerServiceId,
        ...(options.refreshSkewSeconds === undefined ? {} : { refreshSkewSeconds: options.refreshSkewSeconds }),
        requestToken: options.requestToken,
        scopes,
        ...(options.subject ? { subject: options.subject } : {}),
        targetServiceId: options.targetServiceId,
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      });
      providersByScopeSet.set(key, provider);
    }
    providersByMethod.set(methodName, provider);
  }

  return (methodName) => {
    const provider = providersByMethod.get(methodName);
    if (!provider) throw new CapabilityAuthError(`Service-Plane ability method not found: ${options.ability.id}/${methodName}`, 404);
    return provider.token();
  };
}

function clientMetadataDefaults(options: ClientMetadataDefaults): ClientMetadataDefaults {
  return {
    ...(options.connInfo === undefined ? {} : { connInfo: options.connInfo }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: validateClientTimeoutMs(options.timeoutMs, 'default') }),
  };
}

function resolveCallMetadata(defaults: ClientMetadataDefaults, callOptions: AbilityORPCCallOptions): ResolvedCallMetadata {
  const connInfo = callOptions.context.connInfo ?? defaults.connInfo;
  const idempotencyKey = callOptions.context.idempotencyKey ?? defaults.idempotencyKey;
  const requestId = callOptions.context.requestId ?? defaults.requestId;
  const requestedTimeoutMs =
    callOptions.context.timeoutMs === undefined ? defaults.timeoutMs : validateClientTimeoutMs(callOptions.context.timeoutMs, 'per-call');
  const timeoutMs = requestedTimeoutMs === 0 ? undefined : requestedTimeoutMs;
  return {
    ...(connInfo === undefined ? {} : { connInfo }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(requestedTimeoutMs === undefined ? {} : { requestedTimeoutMs }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function resolveForwardedCallMetadata(
  defaults: ClientMetadataDefaults,
  callOptions: AbilityORPCCallOptions,
  target: string,
): ResolvedCallMetadata {
  const metadata = resolveCallMetadata(defaults, callOptions);
  if (metadata.timeoutMs === undefined) return metadata;
  const receivedAt = callOptions.context[ABILITY_CALL_RECEIVED_AT] ?? Date.now();
  const timeoutMs = remainingTimeoutMs(metadata.timeoutMs, Date.now() - receivedAt) as number;
  if (timeoutMs === 0) throw new ServicePlaneTimeoutError(`Service-Plane caller deadline exhausted before dispatch: ${target}`);
  return { ...metadata, timeoutMs };
}

function validateClientTimeoutMs(value: unknown, source: 'default' | 'per-call'): number {
  if (value === 0) return value;
  const normalized = normalizeTimeoutMs(value);
  if (normalized === undefined) {
    throw new CapabilityAuthError(`Service-Plane client ${source} timeoutMs must be 0 or a positive safe integer`, 500);
  }
  return normalized;
}

function linkedAbilityClientSignal(first: AbortSignal, second: AbortSignal) {
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => controller.abort(signal.reason);
  const abortFromFirst = () => abortFrom(first);
  const abortFromSecond = () => abortFrom(second);
  if (first.aborted) abortFrom(first);
  else if (second.aborted) abortFrom(second);
  if (!controller.signal.aborted) {
    first.addEventListener('abort', abortFromFirst, { once: true });
    second.addEventListener('abort', abortFromSecond, { once: true });
  }
  return {
    dispose() {
      first.removeEventListener('abort', abortFromFirst);
      second.removeEventListener('abort', abortFromSecond);
    },
    signal: controller.signal,
  };
}

function deadlineClientLink(
  link: AbilityClientLink,
  defaults: ClientMetadataDefaults,
  lifecycle?: WebSocketAbilityClientLifecycle,
): AbilityClientLink {
  return {
    async call(path, input, callOptions) {
      const receivedAt = Date.now();
      const { requestedTimeoutMs, timeoutMs } = resolveCallMetadata(defaults, callOptions);
      if (requestedTimeoutMs === 0) {
        throw new ServicePlaneTimeoutError(`Service-Plane caller deadline is already exhausted: ${path.join('.')}`);
      }
      const callerSignal = callOptions.signal;
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (lifecycle?.disposed) throw lifecycle.signal.reason;
      const linked = lifecycle && callerSignal ? linkedAbilityClientSignal(callerSignal, lifecycle.signal) : undefined;
      const lifetimeSignal = linked?.signal ?? lifecycle?.signal ?? callerSignal;
      const deadline =
        timeoutMs === undefined
          ? undefined
          : createDeadlineSignal(
              lifetimeSignal,
              timeoutMs + SERVICE_PLANE_TIMEOUT_GRACE_MS,
              new ServicePlaneTimeoutError(`Service-Plane caller deadline exceeded: ${path.join('.')}`),
            );
      const signal = deadline?.signal ?? lifetimeSignal;
      const disposeSignals = () => {
        deadline?.dispose();
        linked?.dispose();
      };
      try {
        const forwardedOptions = {
          ...callOptions,
          context: { ...callOptions.context, [ABILITY_CALL_RECEIVED_AT]: receivedAt },
          ...(signal ? { signal } : {}),
        };
        const call = Promise.resolve(link.call(path, input, forwardedOptions));
        const result = signal ? await raceAbortSignal(call, signal) : await call;
        if (isAsyncIterator(result) && signal) {
          let wrapped: AsyncIterableIterator<unknown> | undefined;
          let finishedBeforeTracking = false;
          wrapped = signalBoundAsyncIterator(result, signal, () => {
            disposeSignals();
            if (wrapped) lifecycle?.untrackIterator(wrapped);
            else finishedBeforeTracking = true;
          });
          if (!finishedBeforeTracking) lifecycle?.trackIterator(wrapped);
          return wrapped;
        }
        disposeSignals();
        return result;
      } catch (error) {
        disposeSignals();
        throw error;
      }
    },
  };
}

function callWithSignal<T>(call: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return signal ? raceAbortSignal(call, signal) : call;
}

function methodNameFromPath(ability: ServiceAbilityDefinition, path: string[]): string {
  return abilityMethodFromPath(ability, path).methodName;
}

function abilityMethodFromPath(ability: ServiceAbilityDefinition, path: string[]) {
  const methodName = path.at(-1) ?? '';
  const definition = Object.hasOwn(ability.methods, methodName) ? ability.methods[methodName] : undefined;
  if (!definition) {
    throw new CapabilityAuthError(`Service-Plane ability method not found: ${ability.id}/${methodName}`, 404);
  }
  return { definition, methodName };
}

function hibernationTransportError(abilityId: string, methodName: string): CapabilityAuthError {
  return new CapabilityAuthError(`Service-Plane hibernation method requires a WebSocket transport: ${abilityId}/${methodName}`, 405);
}

function brokeredHibernationTransportError(abilityId: string, methodName: string): CapabilityAuthError {
  return new CapabilityAuthError(
    `Service-Plane hibernation method cannot run through the control-plane broker; connect to the service WebSocket: ${abilityId}/${methodName}`,
    405,
  );
}

function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return Boolean(value && typeof value === 'object' && typeof (value as { next?: unknown }).next === 'function');
}

function abilityClientLink<TAbility extends ServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  headers: AbilityHeadersResolver,
  defaults: ClientMetadataDefaults,
  lifecycle?: WebSocketAbilityClientLifecycle,
): AbilityClientLink {
  const path = normalizeClientRpcPath(options.ability.rpc?.path ?? `/rpc/${options.ability.id}`, options.ability.id);
  switch (options.transport.type) {
    case 'fetch': {
      const unaryLink = fetchAbilityLink(path, options.transport.fetch, options.transport.origin, headers, options.transport);
      const streamLink = options.transport.batch
        ? fetchAbilityLink(path, options.transport.fetch, options.transport.origin, headers, {
            ...options.transport,
            batch: false,
          })
        : unaryLink;
      return new DynamicLink((_callOptions, methodPath) => {
        const { definition, methodName } = abilityMethodFromPath(options.ability, methodPath);
        if (definition.kind === 'hibernation') {
          throw hibernationTransportError(options.ability.id, methodName);
        }
        return definition.kind === 'unary' ? unaryLink : streamLink;
      });
    }
    case 'websocket': {
      const transport = options.transport;
      const createWebSocket = transport.createWebSocket ?? ((url: string) => new WebSocket(url));
      if (!lifecycle) throw new CapabilityAuthError('Service-Plane WebSocket client lifecycle is required', 500);
      return new WebSocketRpcLink({
        connect: () => lifecycle.connect(() => createWebSocket(transport.url)),
        headers,
        ...(transport.reconnect ? { reconnect: transport.reconnect } : {}),
        url: path as `/${string}`,
      });
    }
    case 'service-binding': {
      const transport = options.transport;
      const native = nativeAbilityLink(options, headers, defaults);
      const fetchFallback = transport.binding.fetch
        ? fetchAbilityLink(
            path,
            { fetch: (request) => (transport.binding.fetch as NonNullable<AbilityNativeBinding['fetch']>)(request) },
            transport.origin,
            headers,
            { ...transport, batch: false },
          )
        : undefined;
      return new DynamicLink((_callOptions, methodPath) => {
        const { definition, methodName } = abilityMethodFromPath(options.ability, methodPath);
        if (definition.kind === 'hibernation') {
          throw hibernationTransportError(options.ability.id, methodName);
        }
        if (definition.kind === 'stream') {
          if (!fetchFallback) {
            throw new CapabilityAuthError('Service-Plane streaming over a service binding requires binding.fetch', 500);
          }
          return fetchFallback;
        }
        return native;
      });
    }
  }
}

function normalizeClientRpcPath(path: string, source: string): `/${string}` {
  const normalized = normalizeOriginRelativePath(path);
  if (!normalized) {
    throw new CapabilityAuthError(`Service-Plane RPC path must be origin-relative: ${source}`, 500);
  }
  return normalized as `/${string}`;
}

function fetchAbilityLink(
  path: string,
  fetcher: FetchLike | typeof fetch | undefined,
  origin = 'https://service-plane-service.internal',
  headers: AbilityHeadersResolver,
  wire: ServicePlaneClientWireOptions = {},
): AbilityClientLink {
  return new FetchRpcLink({
    ...(fetcher
      ? {
          fetch: async (url, init) => (typeof fetcher === 'function' ? fetcher(url, init) : fetcher.fetch(new Request(url, init))),
        }
      : {}),
    headers,
    origin,
    plugins: createRpcClientPlugins(wire),
    url: path as `/${string}`,
  });
}

function nativeAbilityLink<TAbility extends ServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  headers: AbilityHeadersResolver,
  defaults: ClientMetadataDefaults,
): AbilityClientLink {
  return {
    async call(path, input, callOptions) {
      const callHeaders = await headers(callOptions, path);
      const token = callHeaders.get('authorization')?.replace(/^ServicePlane\s+/iu, '');
      if (!token) throw new CapabilityAuthError('Service-Plane capability token is required', 401);
      if (options.transport.type === 'service-binding') {
        const metadata = resolveCallMetadata(defaults, callOptions);
        const connInfo = normalizeConnInfo(metadata.connInfo);
        const idempotencyKey = normalizeIdempotencyKey(metadata.idempotencyKey);
        const proof = callHeaders.get(SERVICE_PLANE_PROOF_HEADER) ?? undefined;
        const timeoutMs = parseTimeoutMs(callHeaders.get(SERVICE_PLANE_TIMEOUT_HEADER));
        return options.transport.binding.invokeAbility({
          abilityId: options.ability.id,
          ...(connInfo ? { connInfo } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          input,
          method: path.at(-1) ?? '',
          ...(proof ? { proof } : {}),
          ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          token,
        });
      }
      throw new CapabilityAuthError('Service-Plane native binding transport is required', 500);
    },
  };
}

async function capabilityProof<TAbility extends ServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  token: string,
): Promise<string | undefined> {
  const prove =
    options.proveTokenPossession ??
    ('requestToken' in options ? (options.requestToken as CapabilityTokenRequester).proveTokenPossession : undefined);
  if (!prove || !decodeCapabilityTokenPayload(token).cnf) return undefined;
  return prove({ abilityId: options.ability.id, targetServiceId: options.targetServiceId, token });
}
