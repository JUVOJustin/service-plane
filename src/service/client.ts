import { type ClientLink, createORPCClient, DynamicLink, ORPCError } from '@orpc/client';
import { RPCLink as FetchRpcLink } from '@orpc/client/fetch';
import type { StandardLinkPlugin } from '@orpc/client/standard';
import { type WebSocketLinkTransportReconnectOptions, RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import type { RouterClient } from '@orpc/server';
import { decodeCapabilityTokenPayload, servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { normalizeConnInfo, SERVICE_PLANE_CONN_INFO_HEADER, serializeConnInfo } from '../shared/conn-info.js';
import {
  normalizeTimeoutMs,
  raceDeadline,
  SERVICE_PLANE_TIMEOUT_GRACE_MS,
  SERVICE_PLANE_TIMEOUT_HEADER,
  serializeTimeoutMs,
} from '../shared/deadline.js';
import { CapabilityAuthError, ServicePlaneTimeoutError } from '../shared/errors.js';
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
import type { AbilityProcedureDefinitions, OrpcServiceAbilityDefinition } from './discovery.js';
import { abilityProcedureStreams } from './orpc.js';

/** Service binding entrypoint used for zero-serialization unary oRPC calls. */
export type AbilityNativeBinding = {
  /** Calls one authorized ability procedure inside the target Worker. */
  invokeAbility(input: NativeAbilityCall): Promise<unknown> | unknown;
  /** Fetch fallback used for streaming procedures, which need oRPC's streaming codec. */
  fetch?(request: Request): Promise<Response>;
};

/** Serialized call envelope accepted by a Cloudflare native service binding. */
export type NativeAbilityCall = ServiceAbilityNativeCall;

/** Runtime transport choices for a typed ability client. */
export type AbilityClientTransport =
  | {
      /** Ordinary Fetch, including `env.SERVICE.fetch` on Cloudflare service bindings. */
      fetch?: FetchLike | typeof fetch;
      /** Origin used to resolve the ability's RPC path. */
      origin?: string;
      /** oRPC link plugins such as batching, compression, dedupe, or retry. */
      plugins?: StandardLinkPlugin<object>[];
      /** Selects ordinary oRPC Fetch. */
      type: 'fetch';
    }
  | {
      /** Cloudflare native RPC for unary calls, with binding Fetch for streams. */
      binding: AbilityNativeBinding;
      /** Synthetic origin used by the binding's Fetch streaming fallback. */
      origin?: string;
      /** Plugins applied to the Fetch streaming fallback. */
      plugins?: StandardLinkPlugin<object>[];
      /** Selects Cloudflare native unary RPC with binding Fetch streams. */
      type: 'service-binding';
    }
  | {
      /** Custom oRPC link for runtimes with their own transport. */
      link: ClientLink<object>;
      /** Selects a caller-supplied link. */
      type: 'custom';
    }
  | {
      /** Long-lived oRPC WebSocket with optional reconnect behavior. */
      createWebSocket?: (url: string) => WebSocket;
      /** oRPC plugins applied to WebSocket calls. */
      plugins?: StandardLinkPlugin<object>[];
      /** Reconnect policy owned by the caller. */
      reconnect?: WebSocketLinkTransportReconnectOptions;
      /** Selects oRPC WebSocket. */
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

/** Options for creating a typed oRPC client from an ability definition. */
export type CreateAbilityClientOptions<TAbility extends OrpcServiceAbilityDefinition> = AbilityClientTokenOptions & {
  /** Procedure-first ability definition; its id and router type drive the client. */
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
  /** Logical oRPC prefix, normally `/rpc/broker`. */
  path?: string;
  /** oRPC link plugins such as batching, compression, dedupe, or retry. */
  plugins?: StandardLinkPlugin<object>[];
};

/** Transport from a public caller or headless front to the central control plane. */
export type BrokeredAbilityTransport = BrokeredAbilityTransportCommon &
  (
    | {
        /** Public control-plane origin. */
        origin?: string;
        /** Selects ordinary Fetch when omitted or set to `fetch`. */
        type?: 'fetch';
      }
    | {
        /** Creates the physical socket when no global WebSocket constructor is available. */
        createWebSocket?: (url: string) => WebSocket;
        /** Reconnect policy owned by the public caller. */
        reconnect?: WebSocketLinkTransportReconnectOptions;
        /** Selects the WebSocket broker endpoint. */
        type: 'websocket';
        /** Public WebSocket endpoint, normally `wss://host/rpc/broker/ws`. */
        url: string;
      }
  );

/** Options for a typed ability client whose calls all pass through the control plane. */
export type CreateBrokeredAbilityClientOptions<TAbility extends OrpcServiceAbilityDefinition> = {
  /** Procedure-first ability definition; its router drives the returned client type. */
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
 * Creates a synchronous, fully typed oRPC client. Tokens and sockets are resolved lazily on the
 * first call, so constructing a client has no network side effects.
 */
export function createAbilityClient<TAbility extends OrpcServiceAbilityDefinition<import('hono').Env, AbilityProcedureDefinitions>>(
  options: CreateAbilityClientOptions<TAbility>,
): RouterClient<TAbility['methods']> {
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
        throw new ORPCError('TIMEOUT', { message: `Service-Plane caller deadline is already exhausted: ${path.join('.')}` });
      }
      const call = Promise.resolve(baseLink.call(path, input, callOptions));
      if (timeoutMs === undefined) return call;
      return raceDeadline(call, {
        deadlineAt: Date.now() + timeoutMs + SERVICE_PLANE_TIMEOUT_GRACE_MS,
        deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane caller deadline exceeded: ${path.join('.')}`),
      });
    },
  };
  return createORPCClient<RouterClient<TAbility['methods']>>(deadlineLink);
}

/**
 * Creates the same typed ability client through the public control-plane broker. This is the
 * browser/headless-front path: callers know the ability contract but never see a service token or
 * a private service address.
 */
export function createBrokeredAbilityClient<TAbility extends OrpcServiceAbilityDefinition<import('hono').Env, AbilityProcedureDefinitions>>(
  options: CreateBrokeredAbilityClientOptions<TAbility>,
): RouterClient<TAbility['methods']> {
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
          ...(transport.plugins ? { plugins: transport.plugins } : {}),
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
          ...(transport.plugins ? { plugins: transport.plugins } : {}),
          url: brokerPath,
        });
  const abilityLink: ClientLink<object> = {
    call(path, input, callOptions) {
      const method = path.at(-1) ?? '';
      const procedure = options.ability.methods[method];
      if (!procedure) {
        throw new CapabilityAuthError(`Service-Plane ability method not found: ${options.ability.id}/${method}`, 404);
      }
      return brokerLink.call(
        [abilityProcedureStreams(procedure) ? 'stream' : 'call'],
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
        throw new ORPCError('TIMEOUT', { message: `Service-Plane caller deadline is already exhausted: ${path.join('.')}` });
      }
      const call = Promise.resolve(abilityLink.call(path, input, callOptions));
      if (timeoutMs === undefined) return call;
      return raceDeadline(call, {
        deadlineAt: Date.now() + timeoutMs + SERVICE_PLANE_TIMEOUT_GRACE_MS,
        deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane caller deadline exceeded: ${path.join('.')}`),
      });
    },
  };
  return createORPCClient<RouterClient<TAbility['methods']>>(deadlineLink);
}

function abilityClientLink<TAbility extends OrpcServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  headers: () => Promise<Headers>,
): ClientLink<object> {
  const path = options.ability.rpc?.path ?? `/rpc/${options.ability.id}`;
  switch (options.transport.type) {
    case 'custom':
      return options.transport.link;
    case 'fetch':
      return fetchAbilityLink(path, options.transport.fetch, options.transport.origin, headers, options.transport.plugins);
    case 'websocket': {
      const transport = options.transport;
      const createWebSocket = transport.createWebSocket ?? ((url: string) => new WebSocket(url));
      return new WebSocketRpcLink({
        connect: () => createWebSocket(transport.url),
        headers,
        ...(transport.reconnect ? { reconnect: transport.reconnect } : {}),
        ...(transport.plugins ? { plugins: transport.plugins } : {}),
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
            transport.plugins,
          )
        : undefined;
      return new DynamicLink((_callOptions, procedurePath) => {
        const procedure = options.ability.methods[procedurePath.at(-1) ?? ''];
        if (procedure && abilityProcedureStreams(procedure)) {
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
  plugins?: StandardLinkPlugin<object>[],
): ClientLink<object> {
  return new FetchRpcLink({
    ...(fetcher
      ? {
          fetch: async (url, init) => (typeof fetcher === 'function' ? fetcher(url, init) : fetcher.fetch(new Request(url, init))),
        }
      : {}),
    headers,
    origin,
    ...(plugins ? { plugins } : {}),
    url: path as `/${string}`,
  });
}

function nativeAbilityLink<TAbility extends OrpcServiceAbilityDefinition>(
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

async function capabilityProof<TAbility extends OrpcServiceAbilityDefinition>(
  options: CreateAbilityClientOptions<TAbility>,
  token: string,
): Promise<string | undefined> {
  const prove =
    options.proveTokenPossession ??
    ('requestToken' in options ? (options.requestToken as CapabilityTokenRequester).proveTokenPossession : undefined);
  if (!prove || !decodeCapabilityTokenPayload(token).cnf) return undefined;
  return prove({ abilityId: options.ability.id, targetServiceId: options.targetServiceId, token });
}
