import { type AnyNestedClient, type ClientLink, createORPCClient, DynamicLink, wrapAsyncIteratorPreservingEventMeta } from '@orpc/client';
import { RPCLink as FetchRpcLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { decodeCapabilityTokenPayload, servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { normalizeConnInfo, SERVICE_PLANE_CONN_INFO_HEADER, serializeConnInfo } from '../shared/conn-info.js';
import {
  normalizeTimeoutMs,
  raceDeadline,
  SERVICE_PLANE_TIMEOUT_GRACE_MS,
  SERVICE_PLANE_TIMEOUT_HEADER,
  serializeTimeoutMs,
} from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneTimeoutError, servicePlaneClientError } from '../shared/errors.js';
import { normalizeIdempotencyKey, SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER } from '../shared/idempotency.js';
import type {
  CapabilitySubject,
  CapabilityTokenCache,
  CapabilityTokenProvider,
  FetchLike,
  ServiceAbilityNativeCall,
} from '../shared/types.js';
import { SERVICE_PLANE_PROOF_HEADER, SERVICE_PLANE_REQUEST_ID_HEADER } from '../shared/types.js';
import { type CapabilityProofSigner, type CapabilityTokenRequester, createCapabilityTokenProvider } from './capabilities.js';
import type { AbilityClient, AbilityMethodDefinitions, ServiceAbilityDefinition } from './discovery.js';
import { createRpcClientPlugins } from './orpc-features.js';
import type { ServicePlaneClientWireOptions } from './wire-options.js';

/** Service binding entrypoint used for zero-serialization unary ability calls. */
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
  /** Delay before a connection attempt. */
  delay?: (info: {
    /** Consecutive attempt count for the current outage. */
    attempt: number;
    /** Total connection attempts made by this client. */
    totalAttempt: number;
  }) => number;
  /** Enables reconnection. */
  enabled: boolean;
  /** Maximum consecutive attempts before the call fails. */
  maxAttempt?: number;
  /** Proactively reconnects after a socket closes. */
  onClose?: {
    /** Delay before reconnecting after a close event. */
    delay?: number;
    /** Whether a close event starts reconnection. */
    enabled: boolean;
  };
};

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
  | (ServicePlaneClientWireOptions & {
      /** Cloudflare native RPC for unary calls, with binding Fetch for streams. */
      binding: AbilityNativeBinding;
      /** Synthetic origin used by the binding's Fetch streaming fallback. */
      origin?: string;
      /** Selects Cloudflare native unary RPC with binding Fetch streams. */
      type: 'service-binding';
    })
  | {
      /** Long-lived WebSocket with optional reconnect behavior. */
      createWebSocket?: (url: string) => WebSocket;
      /** Reconnect policy owned by the caller. */
      reconnect?: ServicePlaneWebSocketReconnectOptions;
      /** Selects Service Plane WebSocket. */
      type: 'websocket';
      /** Physical WebSocket endpoint. */
      url: string;
    };

type AbilityClientTokenOptions =
  | {
      /** Existing provider, useful when several clients intentionally share one token cache. */
      tokenProvider: CapabilityTokenProvider;
    }
  | {
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
  /** Service identity requesting the target capability. */
  callerServiceId: string;
  /** Advisory connection information forwarded to an ingress-protected target. */
  connInfo?: import('../shared/conn-info.js').ConnInfo;
  /** Caller-owned key identifying this logical attempt. */
  idempotencyKey?: string;
  /** Creates proof for sender-constrained tokens. */
  proveTokenPossession?: CapabilityProofSigner;
  /** Correlation id forwarded across the call. */
  requestId?: string;
  /** Capability scopes requested for the ability. */
  scopes: string[];
  /** Service that owns the ability. */
  targetServiceId: string;
  /** Per-call local and forwarded deadline. */
  timeoutMs?: number;
  /** Wire transport used to reach the service. */
  transport: AbilityClientTransport;
};

type BrokeredAbilityTransportCommon = {
  /** Fetch implementation, including an in-process control-plane adapter. */
  fetch?: FetchLike | typeof fetch;
  /** Caller authentication headers understood by the control plane. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Logical broker prefix, normally `/rpc/broker`. */
  path?: string;
};

/** Transport from a public caller or headless front to the central control plane. */
export type BrokeredAbilityTransport = BrokeredAbilityTransportCommon &
  (
    | (ServicePlaneClientWireOptions & {
        /** Public control-plane origin. */
        origin?: string;
        /** Selects ordinary Fetch when omitted or set to `fetch`. */
        type?: 'fetch';
      })
    | {
        /** Creates the physical socket when no global WebSocket constructor is available. */
        createWebSocket?: (url: string) => WebSocket;
        /** Reconnect policy owned by the public caller. */
        reconnect?: ServicePlaneWebSocketReconnectOptions;
        /** Selects the WebSocket broker endpoint. */
        type: 'websocket';
        /** Public WebSocket endpoint, normally `wss://host/rpc/broker/ws`. */
        url: string;
      }
  );

/** Options for a typed ability client whose calls all pass through the control plane. */
export type CreateBrokeredAbilityClientOptions<TAbility extends ServiceAbilityDefinition> = {
  /** Portable ability definition; its methods drive the returned client type. */
  ability: TAbility;
  /** Advisory connection information forwarded by a trusted caller. */
  connInfo?: import('../shared/conn-info.js').ConnInfo;
  /** Caller-owned key identifying this logical attempt. */
  idempotencyKey?: string;
  /** Correlation id forwarded across both hops. */
  requestId?: string;
  /** Capability scopes the broker should authorize and mint. */
  scopes: string[];
  /** Service that owns the ability. */
  targetServiceId: string;
  /** End-to-end caller budget in milliseconds. */
  timeoutMs?: number;
  /** Public transport to the central control plane. */
  transport: BrokeredAbilityTransport;
};

/**
 * Creates a synchronous, fully typed ability client. Tokens and sockets are resolved lazily on the
 * first call, so constructing a client has no network side effects.
 */
export function createAbilityClient<TAbility extends ServiceAbilityDefinition<import('hono').Env, AbilityMethodDefinitions>>(
  options: CreateAbilityClientOptions<TAbility>,
): AbilityClient<TAbility> {
  const tokenProvider =
    options.tokenProvider ??
    createCapabilityTokenProvider({
      abilityId: options.ability.id,
      ...(options.cache ? { cache: options.cache } : {}),
      callerServiceId: options.callerServiceId,
      ...(options.refreshSkewSeconds === undefined ? {} : { refreshSkewSeconds: options.refreshSkewSeconds }),
      requestToken: options.requestToken,
      scopes: options.scopes,
      ...(options.subject ? { subject: options.subject } : {}),
      targetServiceId: options.targetServiceId,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    });
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const headers = async (): Promise<Headers> => {
    const token = await tokenProvider.token();
    const proof = await capabilityProof(options, token);
    const result = new Headers({ authorization: servicePlaneAuthorization(token) });
    const connInfo = serializeConnInfo(options.connInfo);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const timeout = serializeTimeoutMs(timeoutMs);
    if (connInfo) result.set(SERVICE_PLANE_CONN_INFO_HEADER, connInfo);
    if (idempotencyKey) result.set(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    if (proof) result.set(SERVICE_PLANE_PROOF_HEADER, proof);
    if (options.requestId) result.set(SERVICE_PLANE_REQUEST_ID_HEADER, options.requestId);
    if (timeout) result.set(SERVICE_PLANE_TIMEOUT_HEADER, timeout);
    return result;
  };
  const baseLink = abilityClientLink(options, headers);
  const deadlineLink: ClientLink<object> = {
    async call(path, input, callOptions) {
      if (options.timeoutMs === 0) {
        throw new ServicePlaneTimeoutError(`Service-Plane caller deadline is already exhausted: ${path.join('.')}`);
      }
      const call = Promise.resolve(baseLink.call(path, input, callOptions));
      if (timeoutMs === undefined) return call;
      return raceDeadline(call, {
        deadlineAt: Date.now() + timeoutMs + SERVICE_PLANE_TIMEOUT_GRACE_MS,
        deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane caller deadline exceeded: ${path.join('.')}`),
      });
    },
  };
  return createTypedAbilityClient<TAbility>(deadlineLink);
}

/**
 * Creates the same typed ability client through the public control-plane broker. This is the
 * browser/headless-front path: callers know the ability contract but never see a service token or
 * a private service address.
 */
export function createBrokeredAbilityClient<TAbility extends ServiceAbilityDefinition<import('hono').Env, AbilityMethodDefinitions>>(
  options: CreateBrokeredAbilityClientOptions<TAbility>,
): AbilityClient<TAbility> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const brokerHeaders = async () => {
    const configured = typeof options.transport.headers === 'function' ? await options.transport.headers() : options.transport.headers;
    const headers = new Headers(configured);
    const connInfo = serializeConnInfo(options.connInfo);
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const timeout = serializeTimeoutMs(timeoutMs);
    if (connInfo) headers.set(SERVICE_PLANE_CONN_INFO_HEADER, connInfo);
    if (idempotencyKey) headers.set(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    if (options.requestId) headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, options.requestId);
    if (timeout) headers.set(SERVICE_PLANE_TIMEOUT_HEADER, timeout);
    return headers;
  };
  const transport = options.transport;
  const brokerPath = (transport.path ?? '/rpc/broker') as `/${string}`;
  const brokerLink =
    transport.type === 'websocket'
      ? new WebSocketRpcLink({
          connect: () => (transport.createWebSocket ?? ((url: string) => new WebSocket(url)))(transport.url),
          headers: brokerHeaders,
          ...(transport.reconnect ? { reconnect: transport.reconnect } : {}),
          url: brokerPath,
        })
      : new FetchRpcLink({
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
          plugins: createRpcClientPlugins(transport),
          url: brokerPath,
        });
  const abilityLink: ClientLink<object> = {
    call(path, input, callOptions) {
      const method = path.at(-1) ?? '';
      const definition = options.ability.methods[method];
      if (!definition) {
        throw new CapabilityAuthError(`Service-Plane ability method not found: ${options.ability.id}/${method}`, 404);
      }
      return brokerLink.call(
        [definition.kind === 'unary' ? 'call' : 'stream'],
        {
          abilityId: options.ability.id,
          input,
          method,
          scopes: options.scopes,
          targetServiceId: options.targetServiceId,
        },
        callOptions,
      );
    },
  };
  const deadlineLink: ClientLink<object> = {
    async call(path, input, callOptions) {
      if (options.timeoutMs === 0) {
        throw new ServicePlaneTimeoutError(`Service-Plane caller deadline is already exhausted: ${path.join('.')}`);
      }
      const call = Promise.resolve(abilityLink.call(path, input, callOptions));
      if (timeoutMs === undefined) return call;
      return raceDeadline(call, {
        deadlineAt: Date.now() + timeoutMs + SERVICE_PLANE_TIMEOUT_GRACE_MS,
        deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane caller deadline exceeded: ${path.join('.')}`),
      });
    },
  };
  return createTypedAbilityClient<TAbility>(deadlineLink);
}

function createTypedAbilityClient<TAbility extends ServiceAbilityDefinition>(link: ClientLink<object>): AbilityClient<TAbility> {
  const client = createORPCClient<AnyNestedClient>(link) as unknown as AbilityClient<TAbility>;
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver) as unknown;
      if (typeof member !== 'function') return member;
      const cached = methods.get(property);
      if (cached) return cached;
      const wrapped = async (...args: unknown[]) => {
        try {
          const result = await (member as (...input: unknown[]) => Promise<unknown>)(...args);
          return isAsyncIterator(result)
            ? wrapAsyncIteratorPreservingEventMeta(result, {
                mapError: servicePlaneClientError,
                mapResult: (value) => value,
              })
            : result;
        } catch (error) {
          throw servicePlaneClientError(error);
        }
      };
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}

function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return Boolean(value && typeof value === 'object' && typeof (value as { next?: unknown }).next === 'function');
}

function abilityClientLink<TAbility extends ServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  headers: () => Promise<Headers>,
): ClientLink<object> {
  const path = options.ability.rpc?.path ?? `/rpc/${options.ability.id}`;
  switch (options.transport.type) {
    case 'fetch':
      return fetchAbilityLink(path, options.transport.fetch, options.transport.origin, headers, options.transport);
    case 'websocket': {
      const transport = options.transport;
      const createWebSocket = transport.createWebSocket ?? ((url: string) => new WebSocket(url));
      return new WebSocketRpcLink({
        connect: () => createWebSocket(transport.url),
        headers,
        ...(transport.reconnect ? { reconnect: transport.reconnect } : {}),
        url: path as `/${string}`,
      });
    }
    case 'service-binding': {
      const transport = options.transport;
      const native = nativeAbilityLink(options, headers);
      const fetchFallback = transport.binding.fetch
        ? fetchAbilityLink(
            path,
            { fetch: (request) => (transport.binding.fetch as NonNullable<AbilityNativeBinding['fetch']>)(request) },
            transport.origin,
            headers,
            transport,
          )
        : undefined;
      return new DynamicLink((_callOptions, methodPath) => {
        const method = options.ability.methods[methodPath.at(-1) ?? ''];
        if (method && method.kind !== 'unary') {
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

function fetchAbilityLink(
  path: string,
  fetcher: FetchLike | typeof fetch | undefined,
  origin = 'https://service-plane-service.internal',
  headers: () => Promise<Headers>,
  wire: ServicePlaneClientWireOptions = {},
): ClientLink<object> {
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
  headers: () => Promise<Headers>,
): ClientLink<object> {
  return {
    async call(path, input) {
      const callHeaders = await headers();
      const token = callHeaders.get('authorization')?.replace(/^ServicePlane\s+/iu, '');
      if (!token) throw new CapabilityAuthError('Service-Plane capability token is required', 401);
      if (options.transport.type === 'service-binding') {
        const connInfo = normalizeConnInfo(options.connInfo);
        const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
        const proof = callHeaders.get(SERVICE_PLANE_PROOF_HEADER) ?? undefined;
        return options.transport.binding.invokeAbility({
          abilityId: options.ability.id,
          ...(connInfo ? { connInfo } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          input,
          method: path.at(-1) ?? '',
          ...(proof ? { proof } : {}),
          ...(options.requestId ? { requestId: options.requestId } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
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
