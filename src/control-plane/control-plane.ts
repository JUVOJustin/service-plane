import { wrapAsyncIteratorPreservingEventMeta } from '@orpc/client';
import type { StandardLazyRequest } from '@orpc/server';
import { RPCHandler as FetchRpcHandler } from '@orpc/server/fetch';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import { Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import { matchedRoutes } from 'hono/route';
import type { UpgradeWebSocket } from 'hono/ws';
import {
  type AbilityCallOptions,
  type AbilityClient,
  type AnyServiceAbilityDefinition,
  abilityClientScopesByMethod,
  abilityClientScopesForMethod,
} from '../service/discovery.js';
import { orpcErrorFromServicePlane } from '../service/orpc.js';
import { createRpcHandlerPlugins } from '../service/orpc-features.js';
import { DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES, type ServicePlaneServerWireOptions } from '../service/wire-options.js';
import { resolveOptionalBodyByteLimit, type ServicePlaneBodyTooLargeError, validateBodyByteLimit } from '../shared/body-limit.js';
import { type ConnInfo, normalizeConnInfo } from '../shared/conn-info.js';
import {
  createDeadlineSignal,
  discardDisposableValue,
  normalizeTimeoutMs,
  parseTimeoutMs,
  raceDeadline,
  resolveTimeoutMs,
  SERVICE_PLANE_TIMEOUT_GRACE_MS,
  SERVICE_PLANE_TIMEOUT_HEADER,
  type ServicePlaneTimeoutPolicy,
  signalBoundAsyncIterator,
  timeoutMsFromRequest,
  validateTimeoutPolicy,
} from '../shared/deadline.js';
import {
  CapabilityAuthError,
  requireNonEmpty,
  ServicePlaneTimeoutError,
  servicePlaneClientError,
  servicePlaneErrorResponse,
} from '../shared/errors.js';
import { createFlatAbilityClient } from '../shared/flat-ability-client.js';
import { isAsyncIterator } from '../shared/guards.js';
import { deriveRequestContext, mergedRequestHeaders, requestIdFromContext } from '../shared/hono-context.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import {
  idempotencyKeyFromRequest,
  normalizeForwardedToken,
  normalizeIdempotencyKey,
  SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER,
} from '../shared/idempotency.js';
import {
  defaultServicePlaneLogSink,
  emitBestEffortServicePlaneLog,
  type ServicePlaneBrokerLogEvent,
  type ServicePlaneControlPlaneLogEvent,
  type ServicePlaneLogSink,
} from '../shared/logging.js';
import { normalizeOriginRelativePath } from '../shared/paths.js';
import {
  cancelUnusedRequestBody,
  createFetchRequestPreparation,
  preparationDeadlineAt,
  requestWithBoundedBody,
} from '../shared/request-preparation.js';
import { rpcProtocolExposedHeaders, rpcProtocolPreflight, SERVICE_PLANE_BROKER_RPC_PATH } from '../shared/rpc-protocol.js';
import {
  type ControlPlaneRpcTokenBinding,
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  type DiscoveredServiceAbility,
  type RegistryCache,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_OPENAPI_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceEndpoint,
  type ServiceGrant,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import { OrderedWebSocketTasks } from '../shared/web-socket-tasks.js';
import { runBestEffortCacheOperation } from './best-effort-cache.js';
import {
  type ControlPlaneBrokerProcedureContext,
  type ControlPlaneRpcBroker,
  controlPlaneBrokerRouter,
  createControlPlaneRpcBroker,
} from './broker.js';
import type { BrokerCaller, ControlPlaneAuthorizationInvocation } from './caller.js';
import {
  type CapabilityIssuer,
  type CapabilitySigningAuthority,
  type CapabilitySigningJwk,
  createCapabilityIssuerFromPrivateJwk,
  createCapabilitySigningAuthority,
  type MountCapabilityEndpointsOptions,
  mountCapabilityEndpoints,
} from './capabilities.js';
import {
  assertControlPlaneOperationCanStart,
  type ControlPlaneInvocationOptions,
  type ControlPlaneOperationDeadline,
  raceControlPlaneOperation,
} from './invocation.js';
import {
  type ControlPlaneMcpServerInfo,
  controlPlaneMcpErrorResponse,
  DEFAULT_MCP_PATH,
  handlePreparedControlPlaneMcpRequest,
  type PreparedControlPlaneMcpRequest,
  preflightControlPlaneMcpRequest,
  prepareControlPlaneMcpRequest,
  validateControlPlaneMcpMaxBodyBytes,
  validateControlPlaneMcpStreamLimits,
} from './mcp.js';
import {
  type ControlPlaneOpenApiOptions,
  controlPlaneOpenApiCacheKey,
  DEFAULT_OPENAPI_CACHE_TTL_SECONDS,
  generateControlPlaneOpenApi,
} from './openapi.js';
import {
  createRequestServiceRegistry,
  createServiceRegistry,
  DEFAULT_SERVICE_DISCOVERY_RESPONSE_MAX_BYTES,
  memoryRegistryCache,
} from './registry.js';
import { type ControlPlaneRestInvocation, handleControlPlaneRestRequest } from './rest.js';
import { issueCapabilityTokenForCaller } from './rpc.js';
import {
  type CapabilitySigningKey,
  sameCapabilitySigningKeys,
  snapshotSigningKeys,
  validatedPrivateJwksFromSigningKeys,
} from './signing-keys.js';

/** Resolved operation metadata exposed to control-plane invocation middleware for auditing. */
export type ServicePlaneControlPlaneInvocation =
  | ControlPlaneRestInvocation
  | {
      /** Resolved catalog ability for one MCP operation; absent for a broker session that can multiplex calls. */
      abilityId?: string;
      /** Resolved method within an MCP ability; absent for a broker session that can multiplex calls. */
      method?: string;
      /** Method scopes used when minting the downstream capability. */
      scopes?: ReadonlyArray<string>;
      /** Catalog owner selected for the projected operation. */
      serviceId?: string;
      /** Originating protocol; broker sessions intentionally omit per-call target metadata. */
      surface: 'broker' | 'mcp';
    };

/** Request facts shared by ordinary Hono middleware and every control-plane invocation surface. */
export type ServicePlaneControlPlaneVariables = {
  /** Authenticated invocation caller supplied by Hono middleware. */
  servicePlaneCaller?: BrokerCaller;
  /** Original-client connection information supplied by Hono middleware. */
  servicePlaneConnInfo?: ConnInfo;
  /**
   * Resolved invocation metadata. Middleware can inspect it after `await next()` for auditing. RPC
   * broker sessions can invoke many abilities, so that surface exposes only `surface: 'broker'`.
   */
  servicePlaneInvocation?: ServicePlaneControlPlaneInvocation;
};

/** Hono environment augmented with Service Plane request and invocation variables. */
export type ServicePlaneControlPlaneEnv<TEnv extends Env = Env> = TEnv & {
  /** Variables populated by request-id, authentication, and invocation middleware. */
  Variables: RequestIdVariables & ServicePlaneControlPlaneVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;

/** Options for the automatically mounted REST projection facade. */
export type ControlPlaneRestOptions = {
  /** Maximum accepted JSON request-body size. Defaults to one MiB. */
  maxBodyBytes?: number;
};

/** Per-call metadata supported by a trusted in-process ability client. */
export type ControlPlaneAbilityClientCallOptions = Pick<AbilityCallOptions, 'idempotencyKey' | 'requestId' | 'timeoutMs'>;

/** Describes one trusted in-process ability client created by the control plane. */
export type ControlPlaneAbilityClientOptions<TAbility extends AnyServiceAbilityDefinition = AnyServiceAbilityDefinition> = {
  /** Portable ability contract used to infer methods, schemas, and required scopes. */
  ability: TAbility;
  /** Authenticated caller delegated by trusted control-plane code. */
  caller?: BrokerCaller;
  /** Advisory original-client connection information. */
  connInfo?: ConnInfo;
  /** Caller-owned key identifying one logical attempt across retries. */
  idempotencyKey?: string;
  /** Correlation id forwarded to the target service. */
  requestId?: string;
  /** Additional ability-level scopes requested by every method; required method scopes are automatic. */
  scopes?: ReadonlyArray<string>;
  /** Service that owns the ability. */
  targetServiceId: string;
  /** End-to-end budget in milliseconds, including discovery and token issuance. */
  timeoutMs?: number;
};

/** In-process typed ability surface; returned streams own their own cleanup. */
export type ControlPlaneAbilityClient<TAbility extends AnyServiceAbilityDefinition> = AbilityClient<
  TAbility,
  ControlPlaneAbilityClientCallOptions
>;

/** What the plane forwards for one request and the caller it authenticated, fixed when the scope opens. */
type ControlPlaneRequestFacts = {
  caller: BrokerCaller | undefined;
  connInfo: ConnInfo | undefined;
  idempotencyKey: string | undefined;
  receivedAt: number;
  requestId: string | undefined;
  timeoutMs: number | undefined;
};

/** One request's lazily resolved dependencies; see `requestScope`. */
type ControlPlaneRequestScope = {
  /** Calls abilities through this request's authorization and catalog; per-call headers may narrow the budget. */
  broker(headers?: Headers): Promise<ControlPlaneRpcBroker>;
  /** The facts a projected REST or MCP method dispatches with; the issuer inside resolves lazily. */
  invocation(): ControlPlaneInvocationOptions;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  /** Discovery bound to this request's single snapshot. */
  registry: Pick<ServiceRegistry, 'discover'>;
};

const BROKER_WEB_SOCKET_TOO_LARGE_MESSAGE = 'Service-Plane broker WebSocket message exceeds broker.maxRequestBodyBytes';

/**
 * The two ways the catalog gets used, which is the only split worth configuring. `token` covers the
 * whole call path — issuing a token, brokering, MCP — because a brokered call *is* an issuance plus
 * a registry lookup and both must come from one snapshot. `openapi` is the projection path: cold,
 * infrequent, and happy on a store whose reads are slow.
 */
export type DiscoveryCacheRoute = 'openapi' | 'token';

/**
 * `default` covers every route not named. A route set to `false` resolves the catalog fresh.
 */
export type ServicePlaneDiscoveryCaches = Partial<Record<DiscoveryCacheRoute | 'default', false | RegistryCache>>;

function isRegistryCache(value: RegistryCache | ServicePlaneDiscoveryCaches): value is RegistryCache {
  return typeof (value as RegistryCache).get === 'function';
}

function discoveryCachesFor(
  option: false | RegistryCache | ServicePlaneDiscoveryCaches | undefined,
): Record<DiscoveryCacheRoute, RegistryCache | undefined> {
  // One instance for every route, so routes left on the default share a single warm snapshot
  // instead of each fetching the catalog into its own copy.
  if (option === undefined) return sharedByAllRoutes(memoryRegistryCache());
  if (option === false) return sharedByAllRoutes(undefined);
  if (isRegistryCache(option)) return sharedByAllRoutes(option);

  // Per-route object: `default` covers the routes not named, and a route set to `false` opts out
  // on its own.
  const fallback = option.default ?? memoryRegistryCache();
  const routeCache = (route: DiscoveryCacheRoute) => {
    const configured = option[route] ?? fallback;
    return configured === false ? undefined : configured;
  };
  return { openapi: routeCache('openapi'), token: routeCache('token') };
}

function sharedByAllRoutes(cache: RegistryCache | undefined): Record<DiscoveryCacheRoute, RegistryCache | undefined> {
  return { openapi: cache, token: cache };
}

export type ServicePlaneControlPlaneOptions<TEnv extends Env = Env> = {
  app?: Hono<TEnv>;
  /** Product permission check for each resolved RPC, REST, MCP, or in-process method. Only `true` permits; service grants still apply. */
  authorizeInvocation?: (invocation: ControlPlaneAuthorizationInvocation, context: Context<TEnv>) => boolean | Promise<boolean>;
  authenticateCaller?: MountCapabilityEndpointsOptions<TEnv>['authenticateCaller'];
  /** Mounts the public RPC broker. Omit it or pass `false` to leave the broker route absent. */
  broker?:
    | false
    | (ServicePlaneServerWireOptions & {
        /** Public RPC route. Defaults to `/rpc/v1/broker`. */
        path?: string;
        /** Runtime-specific Hono WebSocket upgrader for session and streaming calls. */
        upgradeWebSocket?: UpgradeWebSocket;
      });
  controlPlaneServiceId?: string;
  /**
   * Caches the discovered service catalog. Resolving it is a fan-out — one request per configured
   * service — and every route that needs the catalog pays that fan-out without a cache: token
   * issuance on every request, the broker and MCP on every call, OpenAPI on every document build.
   *
   * One cache backs all of them. Pass an object instead to split the call path (`token`, which also
   * covers brokering and MCP) from the projection path (`openapi`) — the one split that reflects a
   * real difference: issuance is hot and latency-sensitive, OpenAPI is cold and tolerates a slow
   * read. Note that separate stores warm separately: the same catalog is then fetched and held once
   * per store, so splitting trades fan-out for control.
   *
   * Staleness is a convergence question, not a correctness one: a token minted from a stale catalog
   * is still checked by the service against its current definition, so the failure mode is a newly
   * published ability taking up to the TTL to become grantable, never a stale one staying usable.
   * That is why this defaults to a process-local `memoryRegistryCache()` rather than to nothing —
   * the fan-out is real on every request and the risk it trades against is bounded. Pass `false`,
   * here or per route, to resolve the catalog every time instead.
   */
  discoveryCache?: false | RegistryCache | ServicePlaneDiscoveryCaches;
  /** Maximum accepted response size for each remote discovery document. Defaults to 1 MiB. */
  discoveryMaxResponseBytes?: number;
  httpCache?: ServicePlaneHttpCacheOption;
  /**
   * Hono middleware run before REST catch-all discovery, and for valid-boundary MCP and enabled RPC
   * requests. It must set `servicePlaneCaller` or return before `next()`. A REST miss has no
   * `servicePlaneInvocation`; later application routes bypass the catch-all. MCP method, protocol,
   * origin, and declared body-size failures are rejected first. Mounted decoders read their own
   * Request branch, so this middleware may consume the original body for signature verification;
   * body-reading authentication should still enforce its own byte limit. Use middleware on `app`
   * when every request must be seen.
   */
  invocationMiddleware?: MiddlewareHandler<ServicePlaneControlPlaneEnv<TEnv>>;
  issuer?: string;
  log?: false | ServicePlaneLogSink;
  mcp?:
    | false
    | {
        allowedOrigins?: string[];
        /** Maximum accepted JSON-RPC request-body size. Defaults to one MiB. */
        maxBodyBytes?: number;
        path?: string;
        serverInfo?: Partial<ControlPlaneMcpServerInfo>;
        streamLimits?: { maxBytes?: number; maxItems?: number };
      };
  openapi?: false | ControlPlaneOpenApiOptions;
  /** Tunes the REST projection facade; `false` leaves the catch-all route unmounted. */
  rest?: false | ControlPlaneRestOptions;
  requestId?: ServicePlaneRequestIdOptions;
  /**
   * Resolves the plane's service endpoints from the runtime context. The logical endpoint set and
   * discovery catalog must be the same for every caller and organization; use the context to read
   * bindings or deployment configuration, not to select a tenant-specific service catalog.
   * Organization-specific data access belongs in each service behind its stable abilities.
   */
  services: (context: Context<TEnv>) => ServiceEndpoint[] | Promise<ServiceEndpoint[]>;
  /**
   * `keys[0]` signs every new token; the rest are published in JWKS for verification only. Rotating
   * is two deploys, not one: append the new key so every verifier can see it, wait the overlap
   * window in `docs/auth.md`, and only then move it to the front. Prepending a key straight away
   * signs with a `kid` services holding an older JWKS cannot resolve. The old key stays listed for
   * one more window before it is dropped. Resolved per request so a replica picks up a rotation
   * without a redeploy, and so replicas mid-rollout can disagree about the active key without
   * downtime.
   */
  signingKeys: (bindings: TEnv['Bindings'], context: Context<TEnv>) => CapabilitySigningKey[] | Promise<CapabilitySigningKey[]>;
  /**
   * Policy for the deadline the plane forwards. `defaultMs` bounds callers that send none of their
   * own; `maxMs` clamps one that asks for more than this plane is willing to hold a connection for.
   *
   * There is no built-in default here on purpose. The plane forwards a budget rather than doing the
   * work, so the bound that must always exist belongs at the service, where
   * `DEFAULT_ABILITY_TIMEOUT_MS` already applies it per method. Set `defaultMs` when the plane
   * itself should be the policy point — the role Envoy's route timeout plays.
   */
  timeout?: ServicePlaneTimeoutPolicy;
  /** Maximum accepted STS capability-token request-body size. Defaults to one MiB. */
  tokenMaxBodyBytes?: number;
  ttlSeconds?: number;
};

/**
 * ServicePlaneControlPlane serves STS/JWKS, ability brokering, MCP, and API projections.
 */
export class ServicePlaneControlPlane<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneControlPlaneEnv<TEnv>>;
  // Resolved once so the default instance is per plane — which is per isolate on Cloudflare and per
  // process on Node, the granularity a process-local cache can actually have.
  private readonly discoveryCaches: Record<DiscoveryCacheRoute, RegistryCache | undefined>;
  private readonly discoveryMaxResponseBytes: number;
  private readonly issuerName: string;
  private readonly log: ServicePlaneLogSink | undefined;
  private readonly reservedRestPaths: string[];
  private readonly serviceId: string;
  // Single slot rather than a map: JWKS is a hot route, and the only reason the derived key set
  // changes is a rotation, which should replace the memo instead of growing it. The resolved key
  // set is kept alongside so a hit is a synchronous compare rather than an awaited digest; it holds
  // no secret the memoized authority is not already holding as a derived private JWK.
  private signingAuthority: { authority: CapabilitySigningAuthority; issuer: string; keys: CapabilitySigningKey[] } | undefined;
  // The expensive half of building an issuer — the P-256 derivation and the key-pair round-trip —
  // depends only on the key set, never on the catalog or grants. Memoized on its own so a plane that
  // resolves many configurations pays it once per rotation instead of once per configuration. It is
  // also what makes rebuilding the issuer per request affordable. One slot: a plane signs with one
  // key set at a time.
  private signingMaterial: { keys: CapabilitySigningKey[]; privateJwks: Promise<CapabilitySigningJwk[]> } | undefined;

  constructor(private readonly options: ServicePlaneControlPlaneOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneControlPlaneEnv<TEnv>>()) as Hono<ServicePlaneControlPlaneEnv<TEnv>>;
    this.log = options.log === false ? undefined : (options.log ?? defaultServicePlaneLogSink);
    this.issuerName = options.issuer ?? 'control-plane';
    this.serviceId = options.controlPlaneServiceId ?? 'control-plane';
    validateTimeoutPolicy(options.timeout);
    this.discoveryMaxResponseBytes = validateBodyByteLimit(
      options.discoveryMaxResponseBytes ?? DEFAULT_SERVICE_DISCOVERY_RESPONSE_MAX_BYTES,
      'Service-Plane discoveryMaxResponseBytes must be a positive safe integer',
    );
    if (options.mcp) {
      validateControlPlaneMcpMaxBodyBytes(options.mcp.maxBodyBytes);
      validateControlPlaneMcpStreamLimits(options.mcp.streamLimits);
    }
    if (options.rest && options.rest.maxBodyBytes !== undefined) {
      validateBodyByteLimit(options.rest.maxBodyBytes, 'Service-Plane REST maxBodyBytes must be a positive safe integer');
    }
    this.discoveryCaches = discoveryCachesFor(options.discoveryCache);
    this.reservedRestPaths = controlPlaneReservedRestPaths(options);

    this.app.use(
      '*',
      requestId({
        headerName: SERVICE_PLANE_REQUEST_ID_HEADER,
        ...options.requestId,
      }),
    );

    mountCapabilityEndpoints(this.app, (context) => this.issuerFor(context as Context<TEnv>), {
      authenticateCaller:
        options.authenticateCaller ?? ((context) => callerNotConfigured(context, this.log, AUTHENTICATE_CALLER_MISSING_MESSAGE)),

      ...(options.httpCache === undefined ? {} : { httpCache: options.httpCache }),
      // JWKS answers from the signing authority only. Verifiers must be able to refresh keys while
      // target services are unreachable, and the public key does not depend on the catalog.
      jwks: (context) => this.signingAuthorityFor(context as Context<TEnv>),
      ...(options.tokenMaxBodyBytes === undefined ? {} : { tokenMaxBodyBytes: options.tokenMaxBodyBytes }),
    });

    if (options.openapi !== false) {
      this.mountOpenApi(options.openapi ?? {});
    }

    if (options.broker) {
      this.mountBroker(options.broker);
    }

    if (options.mcp) {
      this.mountMcp(options.mcp);
    }

    if (options.rest !== false) {
      this.mountRest(options.rest ?? {});
    }
  }

  fetch: Hono<ServicePlaneControlPlaneEnv<TEnv>>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);

  /**
   * Creates a trusted in-process client through the same authorization and ingress path as public
   * broker calls, without serializing the caller-to-plane hop.
   */
  abilityClient<TAbility extends AnyServiceAbilityDefinition = AnyServiceAbilityDefinition>(
    input: ControlPlaneAbilityClientOptions<TAbility>,
    bindings: TEnv['Bindings'],
  ): ControlPlaneAbilityClient<TAbility> {
    const scopesByMethod = abilityClientScopesByMethod(input.ability, input.scopes);
    const connInfo = normalizeConnInfo(input.connInfo);
    const defaultRequestId = normalizeForwardedToken(input.requestId);
    validateAbilityClientTimeoutMs(input.timeoutMs, 'default');
    // Authorization stays per call so a grant revocation or endpoint change cannot hide behind a
    // cached client: every call opens its own request scope over a fresh native context.
    const broker = (callOptions: ControlPlaneAbilityClientCallOptions, receivedAt: number, timeoutMs: number | undefined) => {
      const context = nativeControlPlaneContext<TEnv>(bindings);
      return this.requestScope(context, 'in-process', {
        caller: input.caller,
        connInfo,
        idempotencyKey: callOptions.idempotencyKey ?? input.idempotencyKey,
        receivedAt,
        requestId: normalizeForwardedToken(callOptions.requestId) ?? defaultRequestId ?? brokerRequestId(context),
        timeoutMs,
      }).broker();
    };
    return controlPlaneAbilityClient(broker, input, scopesByMethod, this.options.timeout);
  }

  /** Creates the native STS surface for one deployment-pinned service identity. */
  capabilityTokenBinding(callerServiceId: string, bindings: TEnv['Bindings']): ControlPlaneRpcTokenBinding {
    const pinnedCallerServiceId = requireNonEmpty(callerServiceId, 'caller service id');
    return {
      issueCapabilityToken: async (input) => {
        const context = nativeControlPlaneContext<TEnv>(bindings);
        return issueCapabilityTokenForCaller(await this.issuerFor(context), pinnedCallerServiceId, input);
      },
    };
  }

  private mountBroker(brokerOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['broker'], false | undefined>): void {
    const path = controlPlaneRoutePath(brokerOptions.path ?? SERVICE_PLANE_BROKER_RPC_PATH, 'broker');
    this.app.use(`${path}/*`, async (context, next) => {
      await next();
      const exposed = rpcProtocolExposedHeaders(context.res.headers);
      if (exposed) context.header('access-control-expose-headers', exposed);
    });
    const maxRequestBodyBytes = resolveOptionalBodyByteLimit(
      brokerOptions.maxRequestBodyBytes,
      DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES,
      'Service-Plane maxRequestBodyBytes must be a positive integer or false',
    );
    const handlerOptions = { plugins: createRpcHandlerPlugins(brokerOptions, false) };
    const orpcHandler = new FetchRpcHandler(controlPlaneBrokerRouter, handlerOptions);
    const upgradeWebSocket = brokerOptions.upgradeWebSocket;
    if (upgradeWebSocket) {
      const websocketHandler = new WebSocketRpcHandler(controlPlaneBrokerRouter, handlerOptions);
      const webSocketTasks = new OrderedWebSocketTasks();
      this.app.all(`${path}/ws`, async (context) => {
        if (context.req.header('upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Service-Plane broker WebSocket upgrade required', { status: 426 });
        }
        const deadline = operationDeadline(Date.now(), resolveTimeoutMs(timeoutMsFromRequest(context.req), this.options.timeout));
        setControlPlaneInvocation(context, { surface: 'broker' });
        try {
          return await raceControlPlaneOperation(
            this.runInvocationMiddleware(
              context,
              async () => {
                if (!controlPlaneCaller(context)) return callerNotConfigured(context, this.log, INVOCATION_CALLER_MISSING_MESSAGE);
                return upgradeWebSocket(context, {
                  onClose: (_event, socket) => {
                    void webSocketTasks.run(socket, () => websocketHandler.close(socket));
                  },
                  onMessage: (event, socket) => {
                    const receivedAt = Date.now();
                    return webSocketTasks.deliver(socket, event.data, {
                      closeOnOversized: true,
                      maxBytes: maxRequestBodyBytes,
                      send: (data) =>
                        websocketHandler.message(socket, data, {
                          // Each frame is its own logical request: it resolves the catalog once and
                          // answers every call in its batch from that snapshot.
                          context: async (request: StandardLazyRequest) => {
                            const callContext = controlPlaneRpcMessageContext(context as unknown as Context<TEnv>, request);
                            const timeoutMs = resolveTimeoutMs(timeoutMsFromRequest(callContext.req), this.options.timeout);
                            return { resolveBroker: this.brokerResolver(callContext, receivedAt, timeoutMs) };
                          },
                          prefix: path as `/${string}`,
                        }),
                      tooLargeMessage: BROKER_WEB_SOCKET_TOO_LARGE_MESSAGE,
                    });
                  },
                });
              },
              deadline,
              'broker WebSocket upgrade',
            ),
            deadline,
            'broker WebSocket invocation middleware',
          );
        } catch (error) {
          return servicePlaneErrorResponse(error, CONTROL_PLANE_REQUEST_FAILED_MESSAGE);
        }
      });
    }
    this.app.all(`${path}/*`, async (context) => {
      const protocolError = rpcProtocolPreflight(context.req.raw);
      if (protocolError) return protocolError;
      setControlPlaneInvocation(context, { surface: 'broker' });
      // Before caller resolution and catalog resolution, not after: resolving the catalog is a
      // fan-out across every service, and on a cold cache it is the most expensive thing the plane
      // does. Stamping later would hand the service a budget the caller has already partly spent.
      const receivedAt = Date.now();
      const requestTimeoutMs = resolveTimeoutMs(timeoutMsFromRequest(context.req), this.options.timeout);
      const deadline = operationDeadline(receivedAt, requestTimeoutMs);
      let rawRequest: Request;
      let physicalBodyError: ServicePlaneBodyTooLargeError | undefined;
      try {
        rawRequest = requestWithBoundedBody(
          context.req.raw,
          maxRequestBodyBytes,
          'Service-Plane broker request body is too large',
          (error) => {
            physicalBodyError = error;
          },
        );
      } catch (error) {
        return servicePlaneErrorResponse(error, CONTROL_PLANE_REQUEST_FAILED_MESSAGE);
      }
      // Product authentication may bind a signature to the body. Give the private decoder its own
      // branch so middleware can consume the original without making the RPC request unusable.
      const decodingSource = this.options.invocationMiddleware ? rawRequest.clone() : rawRequest;
      const preparation = createFetchRequestPreparation(decodingSource, {
        deadlineAt: preparationDeadlineAt(receivedAt, requestTimeoutMs),
        deadlineError: () => new ServicePlaneTimeoutError('Service-Plane broker request decoding exceeded its deadline'),
        ...(this.options.invocationMiddleware ? { linkedRequests: [rawRequest] } : {}),
      });
      const decodingRequest = preparation.request;
      const middlewareRequest = preparation.linkedRequests[0];
      if (middlewareRequest) context.req.raw = middlewareRequest;
      try {
        return await preparation.run(
          () =>
            raceControlPlaneOperation(
              this.runInvocationMiddleware(
                context,
                async () => {
                  if (!controlPlaneCaller(context)) return callerNotConfigured(context, this.log, INVOCATION_CALLER_MISSING_MESSAGE);
                  const resolveBroker = this.brokerResolver(
                    context as unknown as Context<TEnv>,
                    receivedAt,
                    requestTimeoutMs,
                    preparation.complete,
                  );
                  const handled = await orpcHandler.handle(decodingRequest, { context: { resolveBroker }, prefix: path as `/${string}` });
                  if (physicalBodyError) throw physicalBodyError;
                  return handled.matched ? handled.response : new Response('Service-Plane broker method not found', { status: 404 });
                },
                deadline,
                'broker request dispatch',
              ),
              deadline,
              'broker invocation middleware',
            ),
          discardDisposableValue,
        );
      } catch (error) {
        return servicePlaneErrorResponse(error, CONTROL_PLANE_REQUEST_FAILED_MESSAGE);
      } finally {
        cancelUnusedRequestBody(decodingRequest);
        if (middlewareRequest) cancelUnusedRequestBody(middlewareRequest);
      }
    });
  }

  // Both broker transports resolve the caller's catalog once per physical request or frame and
  // answer every logical call in it from that snapshot; per-call headers may only narrow the budget
  // and relabel the attempt. The caller was checked before the private decoder ran, and is checked
  // again here so a decoded call can never dispatch as plane-owned.
  private brokerResolver(
    context: Context<TEnv>,
    receivedAt: number,
    fallbackTimeoutMs: number | undefined,
    onResolve?: () => void,
  ): ControlPlaneBrokerProcedureContext['resolveBroker'] {
    let scope: ControlPlaneRequestScope | undefined;
    return async (headers) => {
      onResolve?.();
      const caller = controlPlaneCaller(context);
      if (!caller) throw brokerCallerResolutionError(callerNotConfigured(context, this.log, INVOCATION_CALLER_MISSING_MESSAGE));
      scope ??= this.requestScope(context, 'broker', {
        ...forwardedRequestFacts(context),
        caller,
        receivedAt,
        timeoutMs: fallbackTimeoutMs,
      });
      return { broker: await scope.broker(headers), caller };
    };
  }

  private mountMcp(mcpOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['mcp'], false | undefined>): void {
    const path = controlPlaneRoutePath(mcpOptions.path ?? DEFAULT_MCP_PATH, 'MCP');
    const preflightOptions = {
      ...(mcpOptions.allowedOrigins ? { allowedOrigins: mcpOptions.allowedOrigins } : {}),
      ...(mcpOptions.maxBodyBytes === undefined ? {} : { maxBodyBytes: mcpOptions.maxBodyBytes }),
    };
    this.app.all(path, async (context) => {
      const receivedAt = Date.now();
      const timeoutMs = resolveTimeoutMs(timeoutMsFromRequest(context.req), this.options.timeout);
      const boundaryError = preflightControlPlaneMcpRequest(context.req.raw, preflightOptions);
      if (boundaryError) return boundaryError;
      try {
        context.req.raw = requestWithBoundedBody(
          context.req.raw,
          validateControlPlaneMcpMaxBodyBytes(mcpOptions.maxBodyBytes),
          'Service-Plane MCP request body is too large',
        );
      } catch (error) {
        return controlPlaneMcpErrorResponse(error);
      }
      // Authentication may bind a signature to the body. Parse a clone only after middleware has
      // inspected the untouched original request.
      const preparation = createFetchRequestPreparation(context.req.raw.clone(), {
        deadlineAt: preparationDeadlineAt(receivedAt, timeoutMs),
        deadlineError: () => new ServicePlaneTimeoutError('Service-Plane MCP request decoding exceeded its deadline'),
        linkedRequests: [context.req.raw],
      });
      const parsingRequest = preparation.request;
      context.req.raw = preparation.linkedRequests[0] as Request;

      setControlPlaneInvocation(context, { surface: 'mcp' });
      const deadline = operationDeadline(receivedAt, timeoutMs);
      let parsedRequestId: string | number | null = null;
      try {
        return await preparation.run(async () => {
          const invocation = this.runInvocationMiddleware(
            context,
            async () => {
              const caller = controlPlaneCaller(context);
              if (!caller) return callerNotConfigured(context, this.log, INVOCATION_CALLER_MISSING_MESSAGE);
              let prepared: PreparedControlPlaneMcpRequest | Response;
              try {
                prepared = await raceControlPlaneOperation(
                  prepareControlPlaneMcpRequest(parsingRequest, preflightOptions),
                  deadline,
                  'MCP request parsing',
                );
              } catch (error) {
                return controlPlaneMcpErrorResponse(error);
              }
              if (prepared instanceof Response) return prepared;
              parsedRequestId = prepared.id;
              preparation.complete();

              const scope = this.requestScope(context as Context<TEnv>, 'MCP', {
                ...forwardedRequestFacts(context),
                caller,
                receivedAt,
                timeoutMs,
              });
              return handlePreparedControlPlaneMcpRequest(prepared, {
                ...scope.invocation(),
                ...(scope.log ? { log: scope.log } : {}),
                onInvocation: (target) => setControlPlaneInvocation(context, { ...target, surface: 'mcp' }),
                registry: scope.registry,
                ...(mcpOptions.serverInfo ? { serverInfo: mcpOptions.serverInfo } : {}),
                ...(mcpOptions.streamLimits ? { streamLimits: mcpOptions.streamLimits } : {}),
              });
            },
            deadline,
            'MCP request dispatch',
          );
          try {
            return await raceControlPlaneOperation(invocation, deadline, 'MCP invocation middleware');
          } catch (error) {
            return controlPlaneMcpErrorResponse(error, parsedRequestId);
          }
        }, discardDisposableValue);
      } catch (error) {
        return controlPlaneMcpErrorResponse(error, parsedRequestId);
      } finally {
        cancelUnusedRequestBody(parsingRequest);
        cancelUnusedRequestBody(context.req.raw);
      }
    });
  }

  private mountRest(restOptions: ControlPlaneRestOptions): void {
    this.app.all('*', async (context, next) => {
      if (hasLaterApplicationRoute(context)) {
        await next();
        return context.res;
      }
      const receivedAt = Date.now();
      const timeoutMs = resolveTimeoutMs(timeoutMsFromRequest(context.req), this.options.timeout);
      const deadline = operationDeadline(receivedAt, timeoutMs);
      // The caller is only known once invocation middleware has run, which the REST dispatcher
      // drives itself; the scope therefore opens on first use inside dispatch.
      let scope: ControlPlaneRequestScope | undefined;
      const scopeForCaller = () =>
        (scope ??= this.requestScope(context as Context<TEnv>, 'REST', {
          ...forwardedRequestFacts(context),
          caller: controlPlaneCaller(context),
          receivedAt,
          timeoutMs,
        }));
      return handleControlPlaneRestRequest(context.req.raw, {
        ...(this.log ? { log: (event) => this.log?.(event, context) } : {}),
        ...(restOptions.maxBodyBytes === undefined ? {} : { maxBodyBytes: restOptions.maxBodyBytes }),
        onInvocation: (invocation) => setControlPlaneInvocation(context, invocation),
        onNotFound: async () => {
          await next();
          return context.res;
        },
        runInvocationMiddleware: (dispatch, request) => {
          context.req.raw = request;
          return this.runInvocationMiddleware(
            context,
            async () => {
              if (!controlPlaneCaller(context)) return callerNotConfigured(context, this.log, INVOCATION_CALLER_MISSING_MESSAGE);
              return dispatch();
            },
            deadline,
            'REST request dispatch',
          );
        },
        receivedAt,
        registry: { discover: () => scopeForCaller().registry.discover() },
        resolveInvocation: async () => scopeForCaller().invocation(),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    });
  }

  private mountOpenApi(openApiOptions: ControlPlaneOpenApiOptions): void {
    const path = controlPlaneRoutePath(openApiOptions.path ?? SERVICE_PLANE_OPENAPI_PATH, 'OpenAPI');
    const cacheHeaders = servicePlaneHttpCacheHeaders(this.options.httpCache, ['service-plane', 'service-plane:openapi']);
    const documentCache = openApiOptions.cache;
    this.app.use(path, etag());
    this.app.get(path, async (context) => {
      applyHttpCacheHeaders(cacheHeaders, (name, value) => context.header(name, value));
      const explicitCacheKey = openApiOptions.cacheKey;
      if (explicitCacheKey !== undefined) {
        const cached = await runBestEffortCacheOperation(documentCache ? () => documentCache.get(explicitCacheKey) : undefined);
        if (cached) return context.json(cached);
      }
      const services = await this.options.services(context as Context<TEnv>);
      const cacheKey = explicitCacheKey ?? controlPlaneOpenApiCacheKey(services, openApiOptions, this.reservedRestPaths);
      if (explicitCacheKey === undefined) {
        const cached = await runBestEffortCacheOperation(documentCache ? () => documentCache.get(cacheKey) : undefined);
        if (cached) return context.json(cached);
      }

      const openApiCache = this.discoveryCaches.openapi;
      const snapshot = await createServiceRegistry({
        ...(openApiCache ? { cache: openApiCache } : {}),
        maxResponseBytes: this.discoveryMaxResponseBytes,
        reservedRestPaths: this.reservedRestPaths,
        services,
      }).discover();
      const document = generateControlPlaneOpenApi({
        ...(openApiOptions.description ? { description: openApiOptions.description } : {}),
        ...(openApiOptions.security === undefined ? {} : { security: openApiOptions.security }),
        ...(openApiOptions.securitySchemes ? { securitySchemes: openApiOptions.securitySchemes } : {}),
        ...(openApiOptions.servers ? { servers: openApiOptions.servers } : {}),
        snapshot,
        ...(openApiOptions.title ? { title: openApiOptions.title } : {}),
        ...(openApiOptions.version ? { version: openApiOptions.version } : {}),
      });
      await runBestEffortCacheOperation(
        documentCache
          ? () => documentCache.set(cacheKey, document, openApiOptions.cacheTtlSeconds ?? DEFAULT_OPENAPI_CACHE_TTL_SECONDS)
          : undefined,
      );
      return context.json(document);
    });
  }

  /**
   * The plane's view of one inbound request: its deadline, the facts it forwards, and the catalog,
   * registry, and issuer it resolves lazily and at most once. Broker, MCP, REST, and the in-process
   * client all authorize and route against this one snapshot, and a cheap refusal never pays for it.
   * Both halves of a brokered call, issuer and registry, read the `token` cache so one request never
   * combines snapshots from two stores.
   */
  private requestScope(context: Context<TEnv>, surface: string, facts: ControlPlaneRequestFacts): ControlPlaneRequestScope {
    const deadline = operationDeadline(facts.receivedAt, facts.timeoutMs);
    const log = this.log;
    const authorize = this.options.authorizeInvocation;
    let services: Promise<ServiceEndpoint[]> | undefined;
    let registry: Promise<ServiceRegistry> | undefined;
    let issuer: Promise<CapabilityIssuer> | undefined;
    const resolveServices = () =>
      (services ??= raceControlPlaneOperation(
        Promise.resolve().then(() => this.options.services(context)),
        deadline,
        `${surface} service resolution`,
      ));
    const resolveRegistry = () =>
      (registry ??= resolveServices().then((resolved) => requestScopedRegistry(this.registryFor(resolved, deadline))));
    const resolveIssuer = () =>
      (issuer ??= raceControlPlaneOperation(
        Promise.all([resolveServices(), resolveRegistry()]).then(([resolved, scoped]) => this.issuerFor(context, resolved, scoped)),
        deadline,
        `${surface} issuer resolution`,
      ));
    // Route and scope checks need no signing material; the issuer resolves only once a call has
    // passed those cheaper guards.
    const lazyIssuer = lazyCapabilityIssuer(resolveIssuer);
    const base = () => ({
      ...(authorize ? { authorizeInvocation: (target: ControlPlaneAuthorizationInvocation) => authorize(target, context) } : {}),
      ...(facts.connInfo ? { connInfo: facts.connInfo } : {}),
      controlPlaneServiceId: this.serviceId,
      issuer: lazyIssuer,
      receivedAt: facts.receivedAt,
    });
    return {
      ...(log ? { log: (event: ServicePlaneBrokerLogEvent) => log(event, context) } : {}),

      registry: { discover: async () => (await resolveRegistry()).discover() },
      invocation: () => ({
        ...base(),
        ...(facts.caller ? { caller: facts.caller } : {}),
        ...(facts.idempotencyKey ? { idempotencyKey: facts.idempotencyKey } : {}),
        ...(facts.requestId ? { requestId: facts.requestId } : {}),
        ...(facts.timeoutMs === undefined ? {} : { timeoutMs: facts.timeoutMs }),
      }),
      broker: async (headers) => {
        const timeoutMs = headers?.has(SERVICE_PLANE_TIMEOUT_HEADER)
          ? resolveTimeoutMs(parseTimeoutMs(headers.get(SERVICE_PLANE_TIMEOUT_HEADER)), this.options.timeout)
          : facts.timeoutMs;
        const requestId = normalizeForwardedToken(headers?.get(SERVICE_PLANE_REQUEST_ID_HEADER)) ?? facts.requestId;
        const idempotencyKey = normalizeIdempotencyKey(headers?.get(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER)) ?? facts.idempotencyKey;
        const scoped = await raceControlPlaneOperation(
          resolveRegistry(),
          operationDeadline(facts.receivedAt, timeoutMs),
          `${surface} service resolution`,
        );
        return createControlPlaneRpcBroker({
          ...base(),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(log ? { log: (event) => log(event, context) } : {}),
          registry: scoped,
          ...(requestId ? { requestId } : {}),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      },
    };
  }

  private registryFor(services: ServiceEndpoint[], deadline: ControlPlaneOperationDeadline): ServiceRegistry {
    const cache = this.discoveryCaches.token;
    return createRequestServiceRegistry(
      {
        ...(cache ? { cache } : {}),
        maxResponseBytes: this.discoveryMaxResponseBytes,
        reservedRestPaths: this.reservedRestPaths,
        services,
      },
      requestDeadlineAt(deadline.receivedAt, deadline.timeoutMs),
    );
  }

  private async runInvocationMiddleware(
    context: Context<ServicePlaneControlPlaneEnv<TEnv>>,
    next: () => Promise<Response>,
    deadline?: ControlPlaneOperationDeadline,
    stage = 'control-plane request dispatch',
  ): Promise<Response> {
    const middleware = this.options.invocationMiddleware;
    let nextCalled = false;
    const invokeNext = async () => {
      if (nextCalled) throw new Error('next() called multiple times');
      nextCalled = true;
      if (deadline) assertControlPlaneOperationCanStart(deadline, stage);
      context.res = await next();
    };
    if (!middleware) {
      await invokeNext();
      return context.res;
    }
    const response = await middleware(context, invokeNext);
    if (response) context.res = response;
    return context.res;
  }

  // Signing authority: key material only. Deliberately does not resolve `services`.
  private async signingAuthorityFor(context: Context<TEnv>): Promise<CapabilitySigningAuthority> {
    const keys = await this.options.signingKeys(context.env, context);
    // The whole ordered key set is the identity: rotating the active key, retiring an old one, and
    // reordering after a rollback must each invalidate the memo. Compared directly rather than
    // through a digest, because this is the JWKS hit path and a compare keeps it synchronous.
    // Snapshotted before anything is awaited, and the same snapshot feeds the derivation and the
    // memo. Copying after the await would record whatever the resolver's array holds by then: a
    // rotation landing inside that window would leave the memo describing the new key set while the
    // authority still holds the old material, so JWKS would publish the retired key indefinitely
    // while issuance had already moved on — and every token minted after the move would fail
    // verification against the published set.
    const resolved = snapshotSigningKeys(keys);
    const memo = this.signingAuthority;
    if (memo && memo.issuer === this.issuerName && sameCapabilitySigningKeys(memo.keys, resolved)) return memo.authority;

    const authority = createCapabilitySigningAuthority({ issuer: this.issuerName, privateJwks: await this.signingMaterialFor(resolved) });
    this.signingAuthority = { authority, issuer: this.issuerName, keys: resolved };
    return authority;
  }

  // Memoized by direct key comparison rather than a digest: the caller already holds the key set, so
  // a hit costs a few string compares and stays synchronous up to the await on the shared promise.
  private signingMaterialFor(keys: CapabilitySigningKey[]): Promise<CapabilitySigningJwk[]> {
    const memo = this.signingMaterial;
    if (memo && sameCapabilitySigningKeys(memo.keys, keys)) return memo.privateJwks;

    const privateJwks = validatedPrivateJwksFromSigningKeys(keys);
    // Copied, not referenced: a resolver that hands back the same array — or the same key objects —
    // and rotates by mutating them in place would otherwise be comparing the new values against
    // themselves. That reads as a hit, and the plane would keep signing with the retired material
    // for the life of the process, which is exactly the case rotation exists to avoid.
    this.signingMaterial = { keys: snapshotSigningKeys(keys), privateJwks };
    // Invalid key material must not memoize as permanent: the next request retries and fails again
    // on its own merits rather than being refused by a cached rejection.
    privateJwks.catch(() => {
      if (this.signingMaterial?.privateJwks === privateJwks) this.signingMaterial = undefined;
    });
    return privateJwks;
  }

  // Authorization catalog plus signing authority: needs discovered capabilities and grants, so it
  // can fail while a target service is down. Only token issuance and brokering depend on it.
  private async issuerFor(context: Context<TEnv>, services?: ServiceEndpoint[], registry?: ServiceRegistry): Promise<CapabilityIssuer> {
    // Key-material derivation and catalog resolution are independent, and each is the slow half on
    // its own cold path — the P-256 derivation plus proof round-trip (~9.5ms) on one side, the
    // discovery fan-out on the other. Started together, a cold request pays the slower of the two
    // instead of their sum. Deliberately inside issuerFor, after caller authentication: refused
    // callers must keep costing nothing (the contract control-plane.test.ts pins), so the overlap
    // never widens what an unauthenticated request can trigger. Joined with first-rejection
    // semantics: a key failure must not wait behind a slow — or hung — catalog fetch, and vice
    // versa, so whichever half fails first answers the request. The pre-attached catches only keep
    // the surviving half's later rejection from surfacing as an unhandled one.
    const resolvingMaterial = (async () => this.signingMaterialFor(await this.options.signingKeys(context.env, context)))();
    resolvingMaterial.catch(() => undefined);
    const resolvingCatalog = (async () => {
      const resolvedServices = services ?? (await this.options.services(context));
      const snapshot = await (registry ?? this.registryFor(resolvedServices, {})).discover();
      const capabilities = snapshot.services.flatMap((service) => (service.capabilities ? [service.capabilities] : []));
      return { capabilities, resolvedServices };
    })();
    resolvingCatalog.catch(() => undefined);
    const [privateJwks, { capabilities, resolvedServices }] = await Promise.all([resolvingMaterial, resolvingCatalog]);
    // The issuer itself is deliberately NOT cached. Everything expensive about building one lives in
    // the signing material memoized above; what is left here is assembling a catalog and a grant
    // map, measured at +0.5% per request at one service and +5.7% at 200 (`npm run bench`). A cache
    // for that would need a bound, an eviction policy, an expiry and a key that must not leak the
    // signing secret — four things to get right for single-digit microseconds.
    return createCapabilityIssuerFromPrivateJwk({
      capabilities,
      grants: { grants: serviceGrantsFromEndpoints(resolvedServices) },
      privateJwks,
      issuer: this.issuerName,
      ttlSeconds: this.options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
      // Already proven when this key set's material was derived, and that memo is keyed on the exact
      // key set, so re-checking the same pair here would repeat work that cannot have changed.
      validateKeyPair: false,
    });
  }
}

const AUTHENTICATE_CALLER_MISSING_MESSAGE = 'Service-Plane caller authentication is not configured';
const INVOCATION_CALLER_MISSING_MESSAGE = 'Service-Plane Hono invocation context is missing servicePlaneCaller';
const CONTROL_PLANE_REQUEST_FAILED_MESSAGE = 'Service-Plane request failed';

function nativeControlPlaneContext<TEnv extends Env>(bindings: TEnv['Bindings']): Context<TEnv> {
  const requestId = crypto.randomUUID();
  const path = SERVICE_PLANE_CAPABILITY_TOKEN_PATH;
  const request = new Request(new URL(path, 'https://service-plane-control-plane-native.internal'), {
    headers: { [SERVICE_PLANE_REQUEST_ID_HEADER]: requestId },
    method: 'POST',
  });
  const context = new Context<ServicePlaneControlPlaneEnv<TEnv>>(request, { env: bindings, path });
  context.set('requestId', requestId);
  return context as unknown as Context<TEnv>;
}

// One frame of a broker socket becomes its own logical request, keeping the authenticated caller,
// connection info, and invocation variables the upgrade request established.
function controlPlaneRpcMessageContext<TEnv extends Env>(base: Context<TEnv>, message: StandardLazyRequest): Context<TEnv> {
  const headers = mergedRequestHeaders(base.req.raw.headers, message.headers);
  const requestId = normalizeForwardedToken(headers.get(SERVICE_PLANE_REQUEST_ID_HEADER)) ?? brokerRequestId(base);
  if (requestId) headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, requestId);
  return deriveRequestContext(base, { headers, method: message.method, signal: message.signal }, requestId);
}

// What an HTTP surface forwards downstream, read once from the authenticated request.
function forwardedRequestFacts(context: Context): Pick<ControlPlaneRequestFacts, 'connInfo' | 'idempotencyKey' | 'requestId'> {
  return {
    // Normalized at the boundary so the plane never forwards a value the service would reject.
    connInfo: normalizeConnInfo(controlPlaneConnInfo(context)),
    idempotencyKey: idempotencyKeyFromRequest(context.req),
    requestId: brokerRequestId(context),
  };
}

function operationDeadline(receivedAt: number, timeoutMs: number | undefined): ControlPlaneOperationDeadline {
  return { receivedAt, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function callerNotConfigured(context: Context, log: ServicePlaneLogSink | undefined, message: string): Response {
  const requestId = brokerRequestId(context);
  const event: ServicePlaneControlPlaneLogEvent = {
    event: 'service_plane.caller_auth.not_configured',
    level: 'error',
    message,
    path: new URL(context.req.url).pathname,
    ...(requestId ? { requestId } : {}),
  };
  emitBestEffortServicePlaneLog(log, event, context);
  return context.json({ error: message }, 500);
}

function brokerRequestId(context: Context): string | undefined {
  return requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER)?.trim();
}

function controlPlaneCaller(context: Context): BrokerCaller | undefined {
  return context.get('servicePlaneCaller' as never) as BrokerCaller | undefined;
}

function controlPlaneConnInfo(context: Context): ConnInfo | undefined {
  return context.get('servicePlaneConnInfo' as never) as ConnInfo | undefined;
}

function setControlPlaneInvocation(context: Context, invocation: ServicePlaneControlPlaneInvocation): void {
  context.set('servicePlaneInvocation' as never, invocation as never);
}

function registryFromSnapshot(registry: ServiceRegistry, snapshot: ServiceRegistrySnapshot): ServiceRegistry {
  const abilitiesByService = new Map<string, Map<string, DiscoveredServiceAbility>>();
  for (const ability of snapshot.abilities) {
    let byId = abilitiesByService.get(ability.serviceId);
    if (!byId) {
      byId = new Map();
      abilitiesByService.set(ability.serviceId, byId);
    }
    byId.set(ability.id, ability);
  }
  return {
    abilities: async () => snapshot.abilities,
    ability: async (serviceId, abilityId) => abilitiesByService.get(serviceId)?.get(abilityId),
    discover: async () => snapshot,
    endpoint: (id) => registry.endpoint(id),
  };
}

function lazyCapabilityIssuer(resolve: () => Promise<CapabilityIssuer>): CapabilityIssuer {
  return {
    issueBrokeredCapabilityToken: async (input) => (await resolve()).issueBrokeredCapabilityToken(input),
    issueCapabilityToken: async (input) => (await resolve()).issueCapabilityToken(input),
    jwks: async () => (await resolve()).jwks(),
  };
}

function requestDeadlineAt(receivedAt: number | undefined, timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : (receivedAt ?? Date.now()) + timeoutMs;
}

// One outer broker/REST/MCP request must authorize and route against one catalog snapshot. Besides
// making that invariant explicit, this avoids rebuilding and linearly scanning the full ability
// list once per logical call inside an oRPC batch.
function requestScopedRegistry(registry: ServiceRegistry): ServiceRegistry {
  let resolved: Promise<ServiceRegistry> | undefined;
  const resolve = () => (resolved ??= registry.discover().then((snapshot) => registryFromSnapshot(registry, snapshot)));
  return {
    abilities: async () => (await resolve()).abilities(),
    ability: async (serviceId, abilityId) => (await resolve()).ability(serviceId, abilityId),
    discover: async () => (await resolve()).discover(),
    endpoint: (id) => registry.endpoint(id),
  };
}

function hasLaterApplicationRoute(context: Context): boolean {
  return matchedRoutes(context)
    .slice(context.req.routeIndex + 1)
    .some((route) => (route.path !== '*' && route.path !== '/*') || route.handler.length < 2);
}

function controlPlaneReservedRestPaths<TEnv extends Env>(options: ServicePlaneControlPlaneOptions<TEnv>): string[] {
  const brokerPath = options.broker ? controlPlaneRoutePath(options.broker.path ?? SERVICE_PLANE_BROKER_RPC_PATH, 'broker') : undefined;
  return [
    SERVICE_PLANE_CAPABILITY_JWKS_PATH,
    SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
    ...(options.openapi === false ? [] : [controlPlaneRoutePath(options.openapi?.path ?? SERVICE_PLANE_OPENAPI_PATH, 'OpenAPI')]),
    ...(options.mcp ? [controlPlaneRoutePath(options.mcp.path ?? DEFAULT_MCP_PATH, 'MCP')] : []),
    ...(brokerPath ? [brokerPath, `${brokerPath === '/' ? '' : brokerPath}/*`] : []),
  ];
}

function controlPlaneRoutePath(path: string, surface: string): string {
  const normalized = normalizeOriginRelativePath(path);
  if (!normalized) throw new CapabilityAuthError(`Service-Plane ${surface} path must be origin-relative`, 500);
  return normalized;
}

function serviceGrantsFromEndpoints(services: ServiceEndpoint[]): ServiceGrant[] {
  return services.flatMap((service) =>
    (service.grants ?? []).map((grant) => ({
      ...grant,
      target: grant.target ?? service.id,
    })),
  );
}

function controlPlaneAbilityClient<TAbility extends AnyServiceAbilityDefinition>(
  resolveBroker: (
    options: ControlPlaneAbilityClientCallOptions,
    receivedAt: number,
    timeoutMs: number | undefined,
  ) => Promise<ControlPlaneRpcBroker>,
  input: ControlPlaneAbilityClientOptions<TAbility>,
  scopesByMethod: ReadonlyMap<string, string[]>,
  timeoutPolicy: ServicePlaneTimeoutPolicy | undefined,
): ControlPlaneAbilityClient<TAbility> {
  return createFlatAbilityClient<ControlPlaneAbilityClient<TAbility>, ControlPlaneAbilityClientCallOptions>(
    Object.keys(input.ability.methods),
    {
      async call([methodName], methodInput, callOptions = {}) {
        const definition = input.ability.methods[methodName];
        try {
          if (!definition) {
            throw new CapabilityAuthError(`Service-Plane ability method not found: ${input.ability.id}/${methodName}`, 404);
          }
          if (definition.kind === 'hibernation') {
            throw new CapabilityAuthError(
              `Service-Plane hibernation method requires a direct service WebSocket transport: ${input.ability.id}/${methodName}`,
              405,
            );
          }
          const requestedTimeoutMs = callOptions.timeoutMs ?? input.timeoutMs;
          validateAbilityClientTimeoutMs(requestedTimeoutMs, 'call');
          if (requestedTimeoutMs === 0) {
            throw new ServicePlaneTimeoutError(`Service-Plane caller deadline is already exhausted: ${input.ability.id}/${methodName}`);
          }
          const timeoutMs = resolveTimeoutMs(requestedTimeoutMs, timeoutPolicy);
          const receivedAt = Date.now();
          const deadlineAt = timeoutMs === undefined ? undefined : receivedAt + timeoutMs + SERVICE_PLANE_TIMEOUT_GRACE_MS;
          const deadlineError = () =>
            new ServicePlaneTimeoutError(`Service-Plane caller deadline exceeded: ${input.ability.id}/${methodName}`);
          const call = (async () => {
            const broker = await resolveBroker(callOptions, receivedAt, timeoutMs);
            return broker.callAbility({
              abilityId: input.ability.id,
              ...(input.caller ? { caller: input.caller } : {}),
              input: methodInput,
              method: methodName,
              scopes: abilityClientScopesForMethod(scopesByMethod, input.ability.id, methodName),
              targetServiceId: input.targetServiceId,
            });
          })();
          const output = await (deadlineAt === undefined
            ? call
            : raceDeadline(call, {
                deadlineAt,
                deadlineError,
                discardLateValue: discardDisposableValue,
              }));
          if (!isAsyncIterator(output)) return output;
          const deadline = deadlineAt === undefined ? undefined : createDeadlineSignal(undefined, deadlineAt - Date.now(), deadlineError());
          const iterator = deadline ? signalBoundAsyncIterator(output, deadline.signal, deadline.dispose) : output;
          return wrapAsyncIteratorPreservingEventMeta(iterator, {
            mapError: servicePlaneClientError,
            mapResult: (value) => value,
          });
        } catch (error) {
          throw servicePlaneClientError(error);
        }
      },
    },
  );
}

function brokerCallerResolutionError(response: Response): Error {
  return orpcErrorFromServicePlane(new CapabilityAuthError('Service-Plane broker caller authentication failed', response.status)) as Error;
}

function validateAbilityClientTimeoutMs(value: number | undefined, source: 'call' | 'default'): void {
  if (value === undefined || value === 0 || normalizeTimeoutMs(value) !== undefined) return;
  throw new CapabilityAuthError(`Service-Plane ${source} timeoutMs must be 0 or a positive integer`, source === 'call' ? 400 : 500);
}
