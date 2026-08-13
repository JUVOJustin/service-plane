import { newRpcResponse } from '@hono/capnweb';
import { Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import { matchedRoutes } from 'hono/route';
import type { UpgradeWebSocket } from 'hono/ws';
import type { AbilitySession } from '../service/capabilities.js';
import { type ConnInfo, normalizeConnInfo } from '../shared/conn-info.js';
import { resolveTimeoutMs, type ServicePlaneTimeoutPolicy, timeoutMsFromRequest, validateTimeoutPolicy } from '../shared/deadline.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import { idempotencyKeyFromRequest } from '../shared/idempotency.js';
import { defaultServicePlaneLogSink, type ServicePlaneControlPlaneLogEvent, type ServicePlaneLogSink } from '../shared/logging.js';
import {
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
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
import { type BrokerCaller, createControlPlaneRpcBroker } from './broker.js';
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
  type ControlPlaneMcpServerInfo,
  DEFAULT_MCP_PATH,
  handleControlPlaneMcpRequest,
  validateControlPlaneMcpTransportRequest,
} from './mcp.js';
import {
  type ControlPlaneOpenApiOptions,
  controlPlaneOpenApiCacheKey,
  DEFAULT_OPENAPI_CACHE_TTL_SECONDS,
  generateControlPlaneOpenApi,
} from './openapi.js';
import { createServiceRegistry, memoryRegistryCache } from './registry.js';
import { type ControlPlaneRestInvocation, handleControlPlaneRestRequest } from './rest.js';
import { type IssueCapabilityTokenForCallerInput, issueCapabilityTokenForCaller, type RpcIssuedCapabilityToken } from './rpc.js';
import {
  type CapabilitySigningKey,
  sameCapabilitySigningKeys,
  snapshotSigningKeys,
  validatedPrivateJwksFromSigningKeys,
} from './signing-keys.js';

export type ServicePlaneControlPlaneInvocation =
  | ControlPlaneRestInvocation
  | {
      /** Discovered ability id when one invocation can be identified. */
      abilityId?: string;
      /** Discovered ability method when one invocation can be identified. */
      method?: string;
      /** Scopes requested for the invocation. */
      scopes?: string[];
      /** Service that owns the invoked ability. */
      serviceId?: string;
      /** Protocol surface that handled the request. */
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

export type ServicePlaneControlPlaneEnv<TEnv extends Env = Env> = TEnv & {
  Variables: RequestIdVariables & ServicePlaneControlPlaneVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;

/** Options for the automatically mounted REST projection facade. */
export type ControlPlaneRestOptions = {
  /** Maximum accepted JSON request-body size. Defaults to one MiB. */
  maxBodyBytes?: number;
};

/**
 * Describes one trusted in-process ability session opened by the control plane.
 */
export type ControlPlaneAbilitySessionOptions = {
  /** Ability id from the target service discovery document. */
  abilityId: string;
  /**
   * Identity the plane has already authenticated. A user becomes the delegated subject; a service
   * remains a service-class caller. Omit for a plane-owned call with no delegated subject.
   */
  caller?: BrokerCaller;
  /** Advisory original-client connection info, surfaced only by ingress-protected services. */
  connInfo?: ConnInfo;
  /** Caller-owned key identifying one logical attempt across retries. */
  idempotencyKey?: string;
  /** Correlation id forwarded to the target service; a generated id is used when omitted. */
  requestId?: string;
  /** Scopes the returned session may exercise. */
  scopes: string[];
  /** Service that owns the ability. */
  targetServiceId: string;
  /** End-to-end budget in milliseconds, including discovery and token issuance. */
  timeoutMs?: number;
};

type BrokeredRequest = {
  caller: BrokerCaller;
  connInfo: ConnInfo | undefined;
  idempotencyKey: string | undefined;
  issuer: CapabilityIssuer;
  registry: ServiceRegistry;
  requestId: string | undefined;
  timeoutMs: number | undefined;
};

// The two ways the catalog gets used, which is the only split worth configuring. `token` covers the
// whole call path — issuing a token, brokering, MCP — because a brokered call *is* an issuance plus
// a registry lookup and both must come from one snapshot. `openapi` is the projection path: cold,
// infrequent, and happy on a store whose reads are slow.
const DISCOVERY_CACHE_ROUTES = ['openapi', 'token'] as const;

export type DiscoveryCacheRoute = (typeof DISCOVERY_CACHE_ROUTES)[number];

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
  const sharedByAllRoutes = (cache: RegistryCache | undefined) =>
    Object.fromEntries(DISCOVERY_CACHE_ROUTES.map((route) => [route, cache])) as Record<DiscoveryCacheRoute, RegistryCache | undefined>;

  if (option === undefined) return sharedByAllRoutes(memoryRegistryCache());
  if (option === false) return sharedByAllRoutes(undefined);
  if (isRegistryCache(option)) return sharedByAllRoutes(option);

  // Per-route object: `default` covers the routes not named, and a route set to `false` opts out
  // on its own.
  const fallback = option.default ?? memoryRegistryCache();
  return Object.fromEntries(
    DISCOVERY_CACHE_ROUTES.map((route) => {
      const configured = option[route] ?? fallback;
      return [route, configured === false ? undefined : configured];
    }),
  ) as Record<DiscoveryCacheRoute, RegistryCache | undefined>;
}

export type ServicePlaneControlPlaneOptions<TEnv extends Env = Env> = {
  app?: Hono<TEnv>;
  authenticateCaller?: MountCapabilityEndpointsOptions['authenticateCaller'];
  /** Mounts the public Cap'n Web RPC broker. Omit it or pass `false` to leave `/rpc` absent. */
  rpc?:
    | false
    | {
        /** Public RPC route. Defaults to `/rpc`. */
        path?: string;
        /** Runtime-specific Hono WebSocket upgrader for session and streaming calls. */
        upgradeWebSocket?: UpgradeWebSocket;
      };
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
  httpCache?: ServicePlaneHttpCacheOption;
  /**
   * Hono middleware run only for matched REST, exposed MCP, and enabled RPC requests. It must set
   * `servicePlaneCaller` on the context or return its own response before calling `next()`.
   */
  invocationMiddleware?: MiddlewareHandler<ServicePlaneControlPlaneEnv<TEnv>>;
  issuer?: string;
  log?: false | ServicePlaneLogSink;
  mcp?:
    | false
    | {
        allowedOrigins?: string[];
        path?: string;
        serverInfo?: Partial<ControlPlaneMcpServerInfo>;
        streamLimits?: { maxBytes?: number; maxItems?: number };
      };
  openapi?: false | ControlPlaneOpenApiOptions;
  /** Tunes the REST projection facade, which is always mounted from published ability metadata. */
  rest?: ControlPlaneRestOptions;
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
  ttlSeconds?: number;
};

/** Hosts capability issuance, public projections, and the optional Cap'n Web RPC broker. */
export class ServicePlaneControlPlane<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneControlPlaneEnv<TEnv>>;
  // Resolved once so the default instance is per plane — which is per isolate on Cloudflare and per
  // process on Node, the granularity a process-local cache can actually have.
  private readonly discoveryCaches: Record<DiscoveryCacheRoute, RegistryCache | undefined>;
  private readonly log: ServicePlaneLogSink | undefined;
  private readonly reservedRestPaths: string[];
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
    validateTimeoutPolicy(options.timeout);
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
      authenticateCaller: options.authenticateCaller ?? ((context) => missingAuthenticateCaller(context, this.log)),
      ...(options.httpCache === undefined ? {} : { httpCache: options.httpCache }),
      // JWKS answers from the signing authority only. Verifiers must be able to refresh keys while
      // target services are unreachable, and the public key does not depend on the catalog.
      jwks: (context) => this.signingAuthorityFor(context as Context<TEnv>),
    });

    if (options.openapi !== false) {
      this.mountOpenApi(options.openapi ?? {});
    }

    if (options.rpc) {
      this.mountRpcBroker(options.rpc);
    }

    if (options.mcp !== false) {
      this.mountMcp(options.mcp ?? {});
    }

    this.mountRest(options.rest ?? {});
  }

  fetch: Hono<ServicePlaneControlPlaneEnv<TEnv>>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);

  /**
   * Opens a trusted in-process ability session through the plane-owned broker path. The caller must
   * already be authenticated by application code: passing a user here asserts subject delegation.
   * External token surfaces remain unable to assert subjects.
   */
  async abilitySession<Scoped>(input: ControlPlaneAbilitySessionOptions, bindings: TEnv['Bindings']): Promise<AbilitySession<Scoped>> {
    const receivedAt = Date.now();
    const context = nativeControlPlaneContext<TEnv>(bindings);
    const services = await this.options.services(context);
    const cache = this.discoveryCaches.token;
    const connInfo = normalizeConnInfo(input.connInfo);
    const requestId = input.requestId?.trim() || brokerRequestId(context);
    const log = this.log;
    const broker = createControlPlaneRpcBroker({
      ...(connInfo ? { connInfo } : {}),
      controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      issuer: await this.issuerFor(context, services),
      ...(log ? { log: (event) => log(event, context) } : {}),
      receivedAt,
      registry: createServiceRegistry({
        ...(cache ? { cache } : {}),
        services,
      }),
      ...(requestId ? { requestId } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    return broker.abilitySession<Scoped>({
      abilityId: input.abilityId,
      ...(input.caller ? { caller: input.caller } : {}),
      scopes: input.scopes,
      targetServiceId: input.targetServiceId,
    });
  }

  async issueCapabilityTokenForCaller(
    callerServiceId: string,
    input: IssueCapabilityTokenForCallerInput,
    bindings: TEnv['Bindings'],
  ): Promise<RpcIssuedCapabilityToken> {
    const context = nativeControlPlaneContext<TEnv>(bindings);
    return issueCapabilityTokenForCaller(await this.issuerFor(context), callerServiceId, input);
  }

  private mountRpcBroker(rpcOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['rpc'], false | undefined>): void {
    const path = rpcOptions.path ?? '/rpc';
    this.app.all(path, async (context) => {
      setControlPlaneInvocation(context, { surface: 'broker' });
      // Before caller resolution and catalog resolution, not after: resolving the catalog is a
      // fan-out across every service, and on a cold cache it is the most expensive thing the plane
      // does. Stamping later would hand the service a budget the caller has already partly spent.
      const receivedAt = Date.now();
      return this.runInvocationMiddleware(context, async () => {
        const resolved = await this.resolveBrokeredRequest(context as Context<TEnv>);
        if (resolved instanceof Response) return resolved;
        const log = this.log;
        const broker = createControlPlaneRpcBroker({
          ...(resolved.connInfo ? { connInfo: resolved.connInfo } : {}),
          controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
          ...(resolved.idempotencyKey ? { idempotencyKey: resolved.idempotencyKey } : {}),
          issuer: resolved.issuer,
          ...(log ? { log: (event) => log(event, context) } : {}),
          receivedAt,
          registry: resolved.registry,
          ...(resolved.requestId ? { requestId: resolved.requestId } : {}),
          ...(resolved.timeoutMs === undefined ? {} : { timeoutMs: resolved.timeoutMs }),
        });
        // Only a WebSocket-upgraded caller leg can carry a returned stream back; over HTTP-batch
        // the broker rejects streaming methods with a clear 405 instead of a dangling stub.
        const allowStreaming = context.req.header('upgrade')?.toLowerCase() === 'websocket';
        return newRpcResponse(
          context,
          broker.rootCapability(resolved.caller, { allowStreaming }),
          rpcOptions.upgradeWebSocket ? { upgradeWebSocket: rpcOptions.upgradeWebSocket } : undefined,
        );
      });
    });
  }

  private mountMcp(mcpOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['mcp'], false | undefined>): void {
    const path = mcpOptions.path ?? DEFAULT_MCP_PATH;
    this.app.all(path, async (context) => {
      const receivedAt = Date.now();
      const transportError = validateControlPlaneMcpTransportRequest(context.req.raw, mcpOptions.allowedOrigins);
      if (transportError) return transportError;
      // This implementation is stateless POST-only. Reject unsupported transport methods before
      // caller resolution or service discovery so a documented 405 cannot turn into an auth or
      // configuration error (and does not allocate an issuer for a request we will not handle).
      if (context.req.method !== 'POST') {
        return new Response('Method Not Allowed', { headers: { allow: 'POST' }, status: 405 });
      }
      const typedContext = context as Context<TEnv>;
      const services = await this.options.services(typedContext);
      const cache = this.discoveryCaches.token;
      const registry = createServiceRegistry({
        ...(cache ? { cache } : {}),
        reservedRestPaths: this.reservedRestPaths,
        services,
      });
      const snapshot = await registry.discover();
      if (!hasPublishedMcpProjection(snapshot)) return context.notFound();

      setControlPlaneInvocation(context, { surface: 'mcp' });
      const snapshotRegistry = registryFromSnapshot(registry, snapshot);
      return this.runInvocationMiddleware(context, async () => {
        const resolved = await this.resolveBrokeredRequest(typedContext, services, snapshotRegistry);
        if (resolved instanceof Response) return resolved;
        const log = this.log;
        return handleControlPlaneMcpRequest(context.req.raw, {
          ...(mcpOptions.allowedOrigins ? { allowedOrigins: mcpOptions.allowedOrigins } : {}),
          caller: resolved.caller,
          ...(resolved.connInfo ? { connInfo: resolved.connInfo } : {}),
          controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
          ...(resolved.idempotencyKey ? { idempotencyKey: resolved.idempotencyKey } : {}),
          issuer: resolved.issuer,
          ...(log ? { log: (event) => log(event, context) } : {}),
          onInvocation: (invocation) => setControlPlaneInvocation(context, { ...invocation, surface: 'mcp' }),
          registry: resolved.registry,
          ...(resolved.requestId ? { requestId: resolved.requestId } : {}),
          ...(mcpOptions.serverInfo ? { serverInfo: mcpOptions.serverInfo } : {}),
          receivedAt,
          ...(mcpOptions.streamLimits ? { streamLimits: mcpOptions.streamLimits } : {}),
          ...(resolved.timeoutMs === undefined ? {} : { timeoutMs: resolved.timeoutMs }),
        });
      });
    });
  }

  private mountRest(restOptions: ControlPlaneRestOptions): void {
    this.app.all('*', async (context, next) => {
      if (hasLaterApplicationRoute(context)) {
        await next();
        return context.res;
      }
      const receivedAt = Date.now();
      const typedContext = context as Context<TEnv>;
      const services = await this.options.services(typedContext);
      const cache = this.discoveryCaches.token;
      const registry = createServiceRegistry({
        ...(cache ? { cache } : {}),
        reservedRestPaths: this.reservedRestPaths,
        services,
      });
      return handleControlPlaneRestRequest(context.req.raw, {
        ...(this.log ? { log: (event) => this.log?.(event, context) } : {}),
        ...(restOptions.maxBodyBytes === undefined ? {} : { maxBodyBytes: restOptions.maxBodyBytes }),
        onInvocation: (invocation) => setControlPlaneInvocation(context, invocation),
        onNotFound: async () => {
          await next();
          return context.res;
        },
        runInvocationMiddleware: (next) => this.runInvocationMiddleware(context, next),
        receivedAt,
        registry,
        resolveInvocation: async (snapshot) => {
          const resolved = await this.resolveBrokeredRequest(typedContext, services, registryFromSnapshot(registry, snapshot));
          if (resolved instanceof Response) return resolved;
          return {
            caller: resolved.caller,
            ...(resolved.connInfo ? { connInfo: resolved.connInfo } : {}),
            controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
            ...(resolved.idempotencyKey ? { idempotencyKey: resolved.idempotencyKey } : {}),
            issuer: resolved.issuer,
            receivedAt,
            ...(resolved.requestId ? { requestId: resolved.requestId } : {}),
            ...(resolved.timeoutMs === undefined ? {} : { timeoutMs: resolved.timeoutMs }),
          };
        },
      });
    });
  }

  private mountOpenApi(openApiOptions: ControlPlaneOpenApiOptions): void {
    const path = openApiOptions.path ?? SERVICE_PLANE_OPENAPI_PATH;
    const cacheHeaders = servicePlaneHttpCacheHeaders(this.options.httpCache, ['service-plane', 'service-plane:openapi']);
    this.app.use(path, etag());
    this.app.get(path, async (context) => {
      applyHttpCacheHeaders(cacheHeaders, (name, value) => context.header(name, value));
      const services = await this.options.services(context as Context<TEnv>);
      const cacheKey = openApiOptions.cacheKey ?? controlPlaneOpenApiCacheKey(services, openApiOptions, this.reservedRestPaths);
      const cached = await openApiOptions.cache?.get(cacheKey);
      if (cached) return context.json(cached);

      const openApiCache = this.discoveryCaches.openapi;
      const snapshot = await createServiceRegistry({
        ...(openApiCache ? { cache: openApiCache } : {}),
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
      await openApiOptions.cache?.set(cacheKey, document, openApiOptions.cacheTtlSeconds ?? DEFAULT_OPENAPI_CACHE_TTL_SECONDS);
      return context.json(document);
    });
  }

  // REST, broker, and MCP need the same request-scoped bundle: an authenticated caller, the request's
  // endpoint set, an issuer over it, and a registry over it. This stays a plain method rather than
  // middleware so each mount keeps deciding what it validates *before* caller resolution — MCP
  // rejects non-POST first, which middleware ordering would invert.
  private async resolveBrokeredRequest(
    context: Context<TEnv>,
    knownServices?: ServiceEndpoint[],
    knownRegistry?: ServiceRegistry,
  ): Promise<Response | BrokeredRequest> {
    const caller = controlPlaneCaller(context);
    if (!caller) return invocationCallerNotConfigured(context, this.log);
    const services = knownServices ?? (await this.options.services(context));
    // Both halves from one store: a brokered call needs an issuer and a registry, and reading them
    // from two caches would mean one request warming both and combining snapshots that need not
    // agree. Brokering is the call path, so it shares `token`.
    const cache = this.discoveryCaches.token;
    return {
      caller,
      // Normalized at the boundary so the plane never forwards a value the service would reject.
      connInfo: normalizeConnInfo(controlPlaneConnInfo(context)),
      issuer: await this.issuerFor(context, services, knownRegistry),
      registry:
        knownRegistry ??
        createServiceRegistry({
          ...(cache ? { cache } : {}),
          reservedRestPaths: this.reservedRestPaths,
          services,
        }),
      idempotencyKey: idempotencyKeyFromRequest(context.req),
      requestId: brokerRequestId(context),
      // The caller states its own budget; the plane spends from it rather than granting one unless
      // a defaultMs policy says otherwise.
      timeoutMs: resolveTimeoutMs(timeoutMsFromRequest(context.req), this.options.timeout),
    };
  }

  private async runInvocationMiddleware(
    context: Context<ServicePlaneControlPlaneEnv<TEnv>>,
    next: () => Promise<Response>,
  ): Promise<Response> {
    const middleware = this.options.invocationMiddleware;
    if (!middleware) return next();
    let nextCalled = false;
    const response = await middleware(context, async () => {
      if (nextCalled) throw new Error('next() called multiple times');
      nextCalled = true;
      context.res = await next();
    });
    if (response) context.res = response;
    return context.res;
  }

  // Signing authority: key material only. Deliberately does not resolve `services`.
  private async signingAuthorityFor(context: Context<TEnv>): Promise<CapabilitySigningAuthority> {
    const keys = await this.options.signingKeys(context.env, context);
    const issuer = this.options.issuer ?? 'control-plane';
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
    if (memo && memo.issuer === issuer && sameCapabilitySigningKeys(memo.keys, resolved)) return memo.authority;

    const authority = createCapabilitySigningAuthority({ issuer, privateJwks: await this.signingMaterialFor(resolved) });
    this.signingAuthority = { authority, issuer, keys: resolved };
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
      const capabilities = registry
        ? (await registry.discover()).services.flatMap((service) => (service.capabilities ? [service.capabilities] : []))
        : await discoverServiceCapabilities(resolvedServices, this.discoveryCaches.token, undefined, this.reservedRestPaths);
      return { capabilities, resolvedServices };
    })();
    resolvingCatalog.catch(() => undefined);
    const [privateJwks, { capabilities, resolvedServices }] = await Promise.all([resolvingMaterial, resolvingCatalog]);
    const grantDefinition = {
      grants: serviceGrantsFromEndpoints(resolvedServices),
    };
    // The issuer itself is deliberately NOT cached. Everything expensive about building one lives in
    // the signing material memoized above — deriving each private JWK is a P-256 scalar
    // multiplication and proving the pair is a sign/verify round-trip, ~9.5ms together — while what
    // is left here is assembling a catalog and a grant map. Measured end to end against a variant
    // that did cache the issuer, rebuilding per request costs +0.5% at one service, +1.5% at 20,
    // +2.4% at 50 and +5.7% at 200 (`npm run bench`, and the component benchmarks that pin the
    // ratio). A cache for that would need a bound, an eviction policy, an expiry and a key that must
    // not leak the signing secret — four things to get right for single-digit microseconds.
    //
    // Revisit if a plane carries a catalog large enough to move that number: the assembly cost is
    // what scales with the number of services, and it is benchmarked so the tradeoff stays visible.
    return createCapabilityIssuerFromPrivateJwk({
      capabilities,
      grants: grantDefinition,
      privateJwks,
      // Defaults were previously filled by the from-signing-keys wrapper; applied here so building
      // straight from derived material keeps the same issuer identity and token lifetime.
      issuer: this.options.issuer ?? 'control-plane',
      ttlSeconds: this.options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
      // Already proven when this key set's material was derived, and that memo is keyed on the exact
      // key set, so re-checking the same pair here would repeat work that cannot have changed.
      validateKeyPair: false,
    });
  }
}

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

function missingAuthenticateCaller(context: Context, log: ServicePlaneLogSink | undefined): Response {
  const requestId = brokerRequestId(context);
  const event: ServicePlaneControlPlaneLogEvent = {
    event: 'service_plane.caller_auth.not_configured',
    level: 'error',
    message: 'Service-Plane caller authentication is not configured',
    path: new URL(context.req.url).pathname,
    ...(requestId ? { requestId } : {}),
  };
  log?.(event, context);
  return context.json({ error: 'Service-Plane caller authentication is not configured' }, 500);
}

function brokerRequestId(context: Context): string | undefined {
  return requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER)?.trim() ?? undefined;
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

function invocationCallerNotConfigured(context: Context, log: ServicePlaneLogSink | undefined): Response {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  const event: ServicePlaneControlPlaneLogEvent = {
    event: 'service_plane.caller_auth.not_configured',
    level: 'error',
    message: 'Service-Plane Hono invocation context is missing servicePlaneCaller',
    path: new URL(context.req.url).pathname,
    ...(requestId ? { requestId } : {}),
  };
  log?.(event, context);
  return context.json({ error: event.message }, 500);
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

function hasPublishedMcpProjection(snapshot: ServiceRegistrySnapshot): boolean {
  return snapshot.abilities.some(
    (ability) =>
      ability.exposure === 'published' &&
      Object.values(ability.methods).some((method) => Boolean(method.mcp || method.mcpPrompt || method.mcpResource)),
  );
}

function registryFromSnapshot(registry: ServiceRegistry, snapshot: ServiceRegistrySnapshot): ServiceRegistry {
  return {
    abilities: async () => snapshot.abilities,
    ability: async (serviceId, abilityId) =>
      snapshot.abilities.find((ability) => ability.serviceId === serviceId && ability.id === abilityId),
    discover: async () => snapshot,
    endpoint: (id) => registry.endpoint(id),
  };
}

function hasLaterApplicationRoute(context: Context): boolean {
  return matchedRoutes(context)
    .slice(context.req.routeIndex + 1)
    .some((route) => (route.path !== '*' && route.path !== '/*') || route.handler.length < 2);
}

async function discoverServiceCapabilities(
  services: ServiceEndpoint[],
  cache?: RegistryCache,
  cacheKey?: string,
  reservedRestPaths?: string[],
) {
  const registry = createServiceRegistry({
    ...(cache ? { cache } : {}),
    ...(cacheKey ? { cacheKey } : {}),
    ...(reservedRestPaths ? { reservedRestPaths } : {}),
    services,
  });
  const snapshot = await registry.discover();
  return snapshot.services.flatMap((service) => (service.capabilities ? [service.capabilities] : []));
}

function controlPlaneReservedRestPaths<TEnv extends Env>(options: ServicePlaneControlPlaneOptions<TEnv>): string[] {
  return [
    SERVICE_PLANE_CAPABILITY_JWKS_PATH,
    SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
    ...(options.openapi === false ? [] : [options.openapi?.path ?? SERVICE_PLANE_OPENAPI_PATH]),
    ...(options.mcp === false ? [] : [options.mcp?.path ?? DEFAULT_MCP_PATH]),
    ...(options.rpc ? [options.rpc.path ?? '/rpc'] : []),
  ];
}

function serviceGrantsFromEndpoints(services: ServiceEndpoint[]): ServiceGrant[] {
  return services.flatMap((service) =>
    (service.grants ?? []).map((grant) => ({
      ...grant,
      target: grant.target ?? service.id,
    })),
  );
}
