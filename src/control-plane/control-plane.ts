import { newRpcResponse } from '@hono/capnweb';
import { Context, type Env, Hono } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import { type ConnInfo, normalizeConnInfo } from '../shared/conn-info.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import { defaultServicePlaneLogSink, type ServicePlaneControlPlaneLogEvent, type ServicePlaneLogSink } from '../shared/logging.js';
import {
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
import { createServiceRegistry } from './registry.js';
import { type IssueCapabilityTokenForCallerInput, issueCapabilityTokenForCaller, type RpcIssuedCapabilityToken } from './rpc.js';
import {
  type CapabilitySigningKey,
  createCapabilityIssuerFromSigningKeys,
  createCapabilitySigningAuthorityFromSigningKeys,
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

export type ServicePlaneControlPlaneOptions<TEnv extends Env = Env> = {
  app?: Hono<TEnv>;
  authenticateCaller?: MountCapabilityEndpointsOptions['authenticateCaller'];
  broker?:
    | false
    | {
        cache?: RegistryCache;
        caller?: BrokerCallerResolver<TEnv>;
        connInfo?: ConnInfoResolver<TEnv>;
        path?: string;
        upgradeWebSocket?: UpgradeWebSocket;
      };
  controlPlaneServiceId?: string;
  httpCache?: ServicePlaneHttpCacheOption;
  issuer?: string;
  log?: false | ServicePlaneLogSink;
  mcp?:
    | false
    | {
        allowedOrigins?: string[];
        cache?: RegistryCache;
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
  private readonly issuers = new Map<string, Promise<CapabilityIssuer>>();
  private readonly log: ServicePlaneLogSink | undefined;
  // Single slot rather than a map: JWKS is a hot route, and the only reason the derived key set
  // changes is a rotation, which should replace the memo instead of growing it.
  private signingAuthority: { authority: CapabilitySigningAuthority; cacheKey: string } | undefined;

  constructor(private readonly options: ServicePlaneControlPlaneOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneControlPlaneEnv<TEnv>>()) as Hono<ServicePlaneControlPlaneEnv<TEnv>>;
    this.log = options.log === false ? undefined : (options.log ?? defaultServicePlaneLogSink);

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
      const cacheKey = openApiOptions.cacheKey ?? controlPlaneOpenApiCacheKey(services, openApiOptions);
      const cached = await openApiOptions.cache?.get(cacheKey);
      if (cached) return context.json(cached);

      const snapshot = await createServiceRegistry({ services }).discover();
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
    mountOptions: { cache?: RegistryCache; caller?: BrokerCallerResolver<TEnv>; connInfo?: ConnInfoResolver<TEnv> },
  ): Promise<Response | BrokeredRequest> {
    const caller = await resolveBrokerCaller(context, mountOptions.caller);
    if (caller instanceof Response) return caller;
    const services = await this.options.services(context);
    return {
      caller,
      // Normalized at the boundary so the plane never forwards a value the service would reject.
      connInfo: normalizeConnInfo(mountOptions.connInfo?.(context)),
      issuer: await this.issuerFor(context, services),
      registry: createServiceRegistry({ ...(mountOptions.cache ? { cache: mountOptions.cache } : {}), services }),
      requestId: brokerRequestId(context),
    };
  }

  // Signing authority: key material only. Deliberately does not resolve `services`.
  private async signingAuthorityFor(context: Context<TEnv>): Promise<CapabilitySigningAuthority> {
    const keys = await this.options.signingKeys(context.env, context);
    const issuer = this.options.issuer ?? 'control-plane';
    // The whole ordered key set is the identity: rotating the active key, retiring an old one, and
    // reordering after a rollback must each invalidate the memo.
    const cacheKey = JSON.stringify({ issuer, keys });
    if (this.signingAuthority?.cacheKey === cacheKey) return this.signingAuthority.authority;

    const authority = createCapabilitySigningAuthorityFromSigningKeys({ issuer, keys });
    this.signingAuthority = { authority, cacheKey };
    return authority;
  }

  // Authorization catalog plus signing authority: needs discovered capabilities and grants, so it
  // can fail while a target service is down. Only token issuance and brokering depend on it.
  private async issuerFor(context: Context<TEnv>, services?: ServiceEndpoint[]): Promise<CapabilityIssuer> {
    const keys = await this.options.signingKeys(context.env, context);
    const resolvedServices = services ?? (await this.options.services(context));
    const capabilities = await discoverServiceCapabilities(resolvedServices);
    const grantDefinition = {
      grants: serviceGrantsFromEndpoints(resolvedServices),
    };
    const cacheKey = JSON.stringify({
      capabilities,
      grants: grantDefinition.grants,
      issuer: this.options.issuer ?? 'control-plane',
      keys,
      ttlSeconds: this.options.ttlSeconds ?? null,
    });
    const existing = this.issuers.get(cacheKey);
    if (existing) return existing;

    const issuer = createCapabilityIssuerFromSigningKeys({
      capabilities,
      grants: grantDefinition,
      keys,
      ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
      ...(this.options.ttlSeconds ? { ttlSeconds: this.options.ttlSeconds } : {}),
    });
    this.issuers.set(cacheKey, issuer);
    // Construction failures — bad key material, a duplicate service id in the discovered catalog —
    // must not be memoized as permanent; the next request rebuilds. Catalog drift no longer lands
    // here: an unknown grant target or scope resolves and refuses that target at issuance instead,
    // so the cache key (which embeds the discovered capabilities) is what expires it on recovery.
    issuer.catch(() => {
      if (this.issuers.get(cacheKey) === issuer) this.issuers.delete(cacheKey);
    });
    return issuer;
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

async function discoverServiceCapabilities(services: ServiceEndpoint[]) {
  const registry = createServiceRegistry({ services });
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
