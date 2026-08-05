import { newRpcResponse } from '@hono/capnweb';
import { Context, type Env, Hono } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import { type ConnInfo, normalizeConnInfo } from '../shared/conn-info.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import { defaultServicePlaneLogSink, type ServicePlaneControlPlaneLogEvent, type ServicePlaneLogSink } from '../shared/logging.js';
import {
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  type RegistryCache,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_OPENAPI_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceEndpoint,
  type ServiceGrant,
  type ServiceRegistry,
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
import { createServiceRegistry, memoryRegistryCache, serviceRegistryCacheKey } from './registry.js';
import { type IssueCapabilityTokenForCallerInput, issueCapabilityTokenForCaller, type RpcIssuedCapabilityToken } from './rpc.js';
import {
  type CapabilitySigningKey,
  sameCapabilitySigningKeys,
  snapshotSigningKeys,
  validatedPrivateJwksFromSigningKeys,
} from './signing-keys.js';

type ServicePlaneControlPlaneEnv<TEnv extends Env> = TEnv & {
  Variables: RequestIdVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;

// Resolves the authenticated broker/MCP caller from a request. A resolver-owned Response lets the
// application preserve its authentication scheme's exact challenge and body. Returning undefined
// refuses the request with 403; omitting the resolver entirely fails closed with 500.
export type BrokerCallerResolver<TEnv extends Env = Env> = (
  context: Context<TEnv>,
) => BrokerCaller | Promise<BrokerCaller | Response | undefined> | Response | undefined;

// Supplies the original client's connection info for forwarding to services. `getConnInfo` is
// runtime-specific in Hono (`hono/cloudflare-workers`, `@hono/node-server/conninfo`, ...), so the
// application picks the right one: `connInfo: (c) => getConnInfo(c)`.
export type ConnInfoResolver<TEnv extends Env = Env> = (context: Context<TEnv>) => ConnInfo | undefined;

type BrokeredRequest = {
  caller: BrokerCaller;
  connInfo: ConnInfo | undefined;
  issuer: CapabilityIssuer;
  registry: ServiceRegistry;
  requestId: string | undefined;
};

// The two ways the catalog gets used, which is the only split worth configuring. `token` covers the
// whole call path — issuing a token, brokering, MCP — because a brokered call *is* an issuance plus
// a registry lookup and both must come from one snapshot. `openapi` is the projection path: cold,
// infrequent, and happy on a store whose reads are slow.
const DISCOVERY_CACHE_ROUTES = ['openapi', 'token'] as const;

export type DiscoveryCacheRoute = (typeof DISCOVERY_CACHE_ROUTES)[number];

// `default` covers every route not named. A route set to `false` resolves the catalog fresh.
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
  broker?:
    | false
    | {
        caller?: BrokerCallerResolver<TEnv>;
        connInfo?: ConnInfoResolver<TEnv>;
        path?: string;
        upgradeWebSocket?: UpgradeWebSocket;
      };
  controlPlaneServiceId?: string;
  // Caches the discovered service catalog. Resolving it is a fan-out — one request per configured
  // service — and every route that needs the catalog pays that fan-out without a cache: token
  // issuance on every request, the broker and MCP on every call, OpenAPI on every document build.
  //
  // One cache backs all of them. Pass an object instead to split the call path (`token`, which also
  // covers brokering and MCP) from the projection path (`openapi`) — the one split that reflects a
  // real difference: issuance is hot and latency-sensitive, OpenAPI is cold and tolerates a slow
  // read. Note that separate stores warm separately: the same catalog is then fetched and held once
  // per store, so splitting trades fan-out for control.
  //
  // Staleness is a convergence question, not a correctness one: a token minted from a stale catalog
  // is still checked by the service against its current definition, so the failure mode is a newly
  // published ability taking up to the TTL to become grantable, never a stale one staying usable.
  // That is why this defaults to a process-local `memoryRegistryCache()` rather than to nothing —
  // the fan-out is real on every request and the risk it trades against is bounded. Pass `false`,
  // here or per route, to resolve the catalog every time instead.
  discoveryCache?: false | RegistryCache | ServicePlaneDiscoveryCaches;
  // Discriminates cache entries when one plane resolves different catalogs under the same service
  // ids. `serviceRegistryCacheKey` covers ids and origins only, and `cloudflareServiceBinding`
  // defaults the origin to `https://<id>.service-plane.internal`, so a plane handing each tenant its
  // own binding under the id `asana` produces one key for all of them — and the first tenant's
  // catalog is then served to the rest for the TTL. Return something that identifies the catalog
  // (a tenant id) and it is folded into the key. Only needed for that shape; a plane whose service
  // set is the same for every caller needs nothing here.
  discoveryCacheKey?: (context: Context<TEnv>) => string | undefined;
  httpCache?: ServicePlaneHttpCacheOption;
  issuer?: string;
  log?: false | ServicePlaneLogSink;
  mcp?:
    | false
    | {
        allowedOrigins?: string[];
        caller?: BrokerCallerResolver<TEnv>;
        connInfo?: ConnInfoResolver<TEnv>;
        path?: string;
        serverInfo?: Partial<ControlPlaneMcpServerInfo>;
        streamLimits?: { maxBytes?: number; maxItems?: number };
      };
  openapi?: false | ControlPlaneOpenApiOptions;
  requestId?: ServicePlaneRequestIdOptions;
  services: (context: Context<TEnv>) => ServiceEndpoint[] | Promise<ServiceEndpoint[]>;
  // `keys[0]` signs every new token; the rest are published in JWKS for verification only. Rotating
  // is two deploys, not one: append the new key so every verifier can see it, wait the overlap
  // window in `docs/auth.md`, and only then move it to the front. Prepending a key straight away
  // signs with a `kid` services holding an older JWKS cannot resolve. The old key stays listed for
  // one more window before it is dropped. Resolved per request so a replica picks up a rotation
  // without a redeploy, and so replicas mid-rollout can disagree about the active key without
  // downtime.
  signingKeys: (bindings: TEnv['Bindings'], context: Context<TEnv>) => CapabilitySigningKey[] | Promise<CapabilitySigningKey[]>;
  ttlSeconds?: number;
};

// ServicePlaneControlPlane is now only STS/JWKS plus an optional Cap'n Web broker.
export class ServicePlaneControlPlane<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneControlPlaneEnv<TEnv>>;
  // Resolved once so the default instance is per plane — which is per isolate on Cloudflare and per
  // process on Node, the granularity a process-local cache can actually have.
  private readonly discoveryCaches: Record<DiscoveryCacheRoute, RegistryCache | undefined>;
  private readonly log: ServicePlaneLogSink | undefined;
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
    this.discoveryCaches = discoveryCachesFor(options.discoveryCache);

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

    if (options.broker) {
      this.mountBroker(options.broker);
    }

    if (options.mcp !== false) {
      this.mountMcp(options.mcp ?? {});
    }
  }

  fetch: Hono<ServicePlaneControlPlaneEnv<TEnv>>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);

  async issueCapabilityTokenForCaller(
    callerServiceId: string,
    input: IssueCapabilityTokenForCallerInput,
    bindings: TEnv['Bindings'],
  ): Promise<RpcIssuedCapabilityToken> {
    const context = nativeControlPlaneContext<TEnv>(bindings);
    return issueCapabilityTokenForCaller(await this.issuerFor(context), callerServiceId, input);
  }

  private mountBroker(brokerOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['broker'], false | undefined>): void {
    const path = brokerOptions.path ?? '/rpc/broker';
    this.app.all(path, async (context) => {
      const resolved = await this.resolveBrokeredRequest(context as Context<TEnv>, brokerOptions);
      if (resolved instanceof Response) return resolved;
      const log = this.log;
      const broker = createControlPlaneRpcBroker({
        ...(resolved.connInfo ? { connInfo: resolved.connInfo } : {}),
        controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
        issuer: resolved.issuer,
        ...(log ? { log: (event) => log(event, context) } : {}),
        registry: resolved.registry,
        ...(resolved.requestId ? { requestId: resolved.requestId } : {}),
      });
      // Only a WebSocket-upgraded caller leg can carry a returned stream back; over HTTP-batch
      // the broker rejects streaming methods with a clear 405 instead of a dangling stub.
      const allowStreaming = context.req.header('upgrade')?.toLowerCase() === 'websocket';
      return newRpcResponse(
        context,
        broker.rootCapability(resolved.caller, { allowStreaming }),
        brokerOptions.upgradeWebSocket ? { upgradeWebSocket: brokerOptions.upgradeWebSocket } : undefined,
      );
    });
  }

  private mountMcp(mcpOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['mcp'], false | undefined>): void {
    const path = mcpOptions.path ?? DEFAULT_MCP_PATH;
    this.app.all(path, async (context) => {
      const transportError = validateControlPlaneMcpTransportRequest(context.req.raw, mcpOptions.allowedOrigins);
      if (transportError) return transportError;
      // This implementation is stateless POST-only. Reject unsupported transport methods before
      // caller resolution or service discovery so a documented 405 cannot turn into an auth or
      // configuration error (and does not allocate an issuer for a request we will not handle).
      if (context.req.method !== 'POST') {
        return new Response('Method Not Allowed', { headers: { allow: 'POST' }, status: 405 });
      }
      const resolved = await this.resolveBrokeredRequest(context as Context<TEnv>, mcpOptions);
      if (resolved instanceof Response) return resolved;
      const log = this.log;
      return handleControlPlaneMcpRequest(context.req.raw, {
        ...(mcpOptions.allowedOrigins ? { allowedOrigins: mcpOptions.allowedOrigins } : {}),
        caller: resolved.caller,
        ...(resolved.connInfo ? { connInfo: resolved.connInfo } : {}),
        controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
        issuer: resolved.issuer,
        ...(log ? { log: (event) => log(event, context) } : {}),
        registry: resolved.registry,
        ...(resolved.requestId ? { requestId: resolved.requestId } : {}),
        ...(mcpOptions.serverInfo ? { serverInfo: mcpOptions.serverInfo } : {}),
        ...(mcpOptions.streamLimits ? { streamLimits: mcpOptions.streamLimits } : {}),
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
      // The generated document inherits the same tenant discriminator as the catalog behind it: a
      // per-tenant plane that caches documents would otherwise serve tenant A's published REST
      // surface to tenant B until the document TTL expires — the registry key was scoped, the
      // document key not. An explicit `openapi.cacheKey` keeps full responsibility instead.
      const discriminator = this.options.discoveryCacheKey?.(context as Context<TEnv>);
      const cacheKey =
        openApiOptions.cacheKey ?? `${controlPlaneOpenApiCacheKey(services, openApiOptions)}${discriminator ? `|${discriminator}` : ''}`;
      const cached = await openApiOptions.cache?.get(cacheKey);
      if (cached) return context.json(cached);

      const openApiCache = this.discoveryCaches.openapi;
      const snapshot = await createServiceRegistry({
        ...(openApiCache ? { cache: openApiCache } : {}),
        ...this.discoveryCacheKeyFor(context as Context<TEnv>, services),
        services,
      }).discover();
      const document = generateControlPlaneOpenApi({
        ...(openApiOptions.description ? { description: openApiOptions.description } : {}),
        ...(openApiOptions.servers ? { servers: openApiOptions.servers } : {}),
        snapshot,
        ...(openApiOptions.title ? { title: openApiOptions.title } : {}),
        ...(openApiOptions.version ? { version: openApiOptions.version } : {}),
      });
      await openApiOptions.cache?.set(cacheKey, document, openApiOptions.cacheTtlSeconds ?? DEFAULT_OPENAPI_CACHE_TTL_SECONDS);
      return context.json(document);
    });
  }

  // Broker and MCP need the same request-scoped bundle: an authenticated caller, the request's
  // endpoint set, an issuer over it, and a registry over it. This stays a plain method rather than
  // middleware so each mount keeps deciding what it validates *before* caller resolution — MCP
  // rejects non-POST first, which middleware ordering would invert.
  private async resolveBrokeredRequest(
    context: Context<TEnv>,
    mountOptions: { caller?: BrokerCallerResolver<TEnv>; connInfo?: ConnInfoResolver<TEnv> },
  ): Promise<Response | BrokeredRequest> {
    const caller = await resolveBrokerCaller(context, mountOptions.caller);
    if (caller instanceof Response) return caller;
    const services = await this.options.services(context);
    // Both halves from one store: a brokered call needs an issuer and a registry, and reading them
    // from two caches would mean one request warming both and combining snapshots that need not
    // agree. Brokering is the call path, so it shares `token`.
    const cache = this.discoveryCaches.token;
    return {
      caller,
      // Normalized at the boundary so the plane never forwards a value the service would reject.
      connInfo: normalizeConnInfo(mountOptions.connInfo?.(context)),
      issuer: await this.issuerFor(context, services),
      registry: createServiceRegistry({
        ...(cache ? { cache } : {}),
        ...this.discoveryCacheKeyFor(context, services),
        services,
      }),
      requestId: brokerRequestId(context),
    };
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

  // Folds the caller-supplied discriminator into the derived key, or leaves the derived one alone
  // when there is none. Returned as a spreadable so every call site stays exact-optional-safe.
  private discoveryCacheKeyFor(context: Context<TEnv>, services: ServiceEndpoint[]): { cacheKey?: string } {
    const discriminator = this.options.discoveryCacheKey?.(context);
    if (!discriminator) return {};
    return { cacheKey: `${serviceRegistryCacheKey(services)}|${discriminator}` };
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
  private async issuerFor(context: Context<TEnv>, services?: ServiceEndpoint[]): Promise<CapabilityIssuer> {
    const keys = await this.options.signingKeys(context.env, context);
    // Resolved before the memo lookup so a miss only has to assemble the catalog, which is
    // microseconds — the key work is already done and shared across every configuration.
    const privateJwks = await this.signingMaterialFor(keys);
    const resolvedServices = services ?? (await this.options.services(context));
    const capabilities = await discoverServiceCapabilities(
      resolvedServices,
      this.discoveryCaches.token,
      this.discoveryCacheKeyFor(context, resolvedServices).cacheKey,
    );
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

// Fails closed: a broker/MCP request with no configured resolver is a 500 (misconfiguration). A
// resolver-owned response is preserved; undefined is a generic refusal, not a made-up auth scheme.
async function resolveBrokerCaller<TEnv extends Env>(
  context: Context<TEnv>,
  resolver: BrokerCallerResolver<TEnv> | undefined,
): Promise<BrokerCaller | Response> {
  if (!resolver) return brokerCallerNotConfigured(context);
  const resolved = await resolver(context);
  if (resolved instanceof Response) return resolved;
  if (!resolved) return context.json({ error: 'Forbidden' }, 403);
  return resolved;
}

function brokerCallerNotConfigured(context: Context): Response {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  console.error(
    JSON.stringify({
      event: 'service_plane.broker.caller_auth.not_configured',
      level: 'error',
      message: 'Service-Plane broker caller authentication is not configured',
      path: new URL(context.req.url).pathname,
      ...(requestId ? { requestId } : {}),
    }),
  );
  return context.json({ error: 'Service-Plane broker caller authentication is not configured' }, 500);
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

async function discoverServiceCapabilities(services: ServiceEndpoint[], cache?: RegistryCache, cacheKey?: string) {
  const registry = createServiceRegistry({ ...(cache ? { cache } : {}), ...(cacheKey ? { cacheKey } : {}), services });
  const snapshot = await registry.discover();
  return snapshot.services.flatMap((service) => (service.capabilities ? [service.capabilities] : []));
}

function serviceGrantsFromEndpoints(services: ServiceEndpoint[]): ServiceGrant[] {
  return services.flatMap((service) =>
    (service.grants ?? []).map((grant) => ({
      ...grant,
      target: grant.target ?? service.id,
    })),
  );
}
