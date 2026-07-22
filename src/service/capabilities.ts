import {
  newWebSocketRpcSession,
  type RpcCompatible,
  RpcSession,
  type RpcSessionOptions,
  type RpcStub,
  RpcTarget,
  type RpcTransport,
} from 'capnweb';
import { decodeCapabilityTokenPayload, normalizeCapabilitySubject, verifyCapabilityToken } from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { SERVICE_PLANE_HMAC_CLIENT_HEADER, SERVICE_PLANE_HMAC_TIMESTAMP_HEADER, signServicePlaneHmacRequest } from '../shared/hmac-auth.js';
import {
  SERVICE_PLANE_JWK_ASSERTION_AUDIENCE,
  SERVICE_PLANE_JWK_CLIENT_HEADER,
  SERVICE_PLANE_JWK_KEY_ID_HEADER,
  signServicePlaneJwkRequest,
} from '../shared/jwk-auth.js';
import {
  type CapabilityCatalog,
  type CapabilityIdentity,
  type CapabilityJwks,
  type CapabilityJwksCache,
  type CapabilityJwksResolver,
  type CapabilityScopeDefinition,
  type CapabilitySubject,
  type CapabilityTokenCache,
  type CapabilityTokenProvider,
  type CapabilityVerifierOptions,
  DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
  type FetchLike,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
  MAX_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  SERVICE_PLANE_REQUEST_ID_QUERY_PARAM,
} from '../shared/types.js';

const identityByTarget = new WeakMap<object, CapabilityIdentity>();
const serviceBindingJwksResolvers = new WeakMap<object, Map<string, CapabilityJwksResolver>>();
const urlJwksResolvers = new Map<string, CapabilityJwksResolver>();

export type RemoteJwksFetch = typeof fetch | FetchLike;

export type JwksFromUrlOptions = {
  cache?: CapabilityJwksCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  fetch?: RemoteJwksFetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  now?: () => Date;
};

export type JwksFromServiceBindingOptions = Omit<JwksFromUrlOptions, 'fetch'> & {
  origin?: string;
  path?: string;
};

export type CreateCapabilityTokenProviderOptions = {
  abilityId?: string;
  cache?: CapabilityTokenCache;
  cacheKey?: string;
  callerServiceId: string;
  now?: () => Date;
  refreshSkewSeconds?: number;
  requestToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
  scopes: string[];
  subject?: CapabilitySubject;
  targetServiceId: string;
  ttlSeconds?: number;
};

type ControlPlaneTokenRequestOptions = {
  controlPlaneUrl: string | URL;
  fetch?: typeof fetch | FetchLike;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  requestId?: string | (() => string | Promise<string | undefined> | undefined);
  requestIdHeaderName?: string;
  tokenPath?: string;
};

export type ControlPlaneHmacTokenRequesterOptions = ControlPlaneTokenRequestOptions & {
  clientId: string;
  clientIdHeaderName?: string;
  clientSecret: string | (() => Promise<string> | string);
  now?: () => Date;
  timestampHeaderName?: string;
};

export type ControlPlaneJwkTokenRequesterOptions = ControlPlaneTokenRequestOptions & {
  assertionAudience?: string;
  assertionTtlSeconds?: number;
  clientId: string;
  clientIdHeaderName?: string;
  keyId: string;
  keyIdHeaderName?: string;
  maxBodyBytes?: number;
  now?: () => Date;
  privateJwk: JsonWebKey | (() => Promise<JsonWebKey> | JsonWebKey);
};

export type ControlPlaneRpcTokenBinding = {
  issueCapabilityToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
};

export type ControlPlaneRpcCallerTokenBinding = {
  issueCapabilityTokenForCaller(
    callerServiceId: string,
    input: Omit<IssueCapabilityTokenInput, 'callerServiceId'> & { callerServiceId?: string },
  ): Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
};

export type ControlPlaneRpcTokenRequesterOptions = {
  binding: ControlPlaneRpcCallerTokenBinding | ControlPlaneRpcTokenBinding;
  callerServiceId?: string;
};

export type CloudflareAbilityRpcBinding = {
  connectAbility(input: { abilityId: string; requestId?: string; token: string }): Promise<object> | object;
};

export interface AuthenticatedRoot<Scoped> {
  authenticate(token: string): Scoped;
}

export type CapabilityRpcTransport =
  | { binding: CloudflareAbilityRpcBinding; kind: 'cloudflare-binding-rpc' }
  | { kind: 'custom'; transport: RpcTransport }
  | { kind: 'fetch'; fetcher: FetchLike; origin: string; path?: string }
  | { kind: 'http-batch'; path?: string; url: Request | string | URL }
  | { kind: 'websocket'; url: string };

export type CapabilityRpcSessionOptions<Scoped> = (
  | (CreateCapabilityTokenProviderOptions & { tokenProvider?: undefined })
  | ({ tokenProvider: CapabilityTokenProvider } & Pick<
      CreateCapabilityTokenProviderOptions,
      'callerServiceId' | 'scopes' | 'targetServiceId'
    >)
) & {
  abilityId?: string;
  authenticate?: (root: AuthenticatedRoot<Scoped>, token: string) => Scoped;
  requestId?: string;
  requestIdHeaderName?: string;
  rpcSessionOptions?: RpcSessionOptions;
  transport: CapabilityRpcTransport;
};

export type AbilitySessionOptions<Scoped> = CapabilityRpcSessionOptions<Scoped> & {
  abilityId: string;
};

export function defineCapabilities(catalog: CapabilityCatalog): CapabilityCatalog {
  const scopes = catalog.scopes.map(normalizeScopeDefinition);
  const duplicate = firstDuplicate(scopes.map((scope) => scope.id));
  if (duplicate) throw new CapabilityAuthError(`Duplicate Service-Plane capability scope: ${duplicate}`, 500);
  return {
    scopes,
    serviceId: normalizeValue(catalog.serviceId, 'service id'),
  };
}

export function bindCapabilityIdentity<T extends object>(target: T, identity: CapabilityIdentity): T {
  identityByTarget.set(target, identity);
  return target;
}

export function capabilityIdentity(target: object): CapabilityIdentity | undefined {
  return identityByTarget.get(target);
}

export function requireScopes(target: object, ...scopes: string[]): CapabilityIdentity {
  const identity = identityByTarget.get(target);
  if (!identity) {
    throw new CapabilityAuthError('Service-Plane capability identity is not bound to this RPC target', 401);
  }
  const required = normalizeScopes(scopes);
  for (const scope of required) {
    if (!identity.scopes.includes(scope)) {
      throw new CapabilityAuthError(`Missing Service-Plane capability scope: ${scope}`, 403);
    }
  }
  return identity;
}

export async function verifyAuthenticationToken(token: string, verifier: CapabilityVerifierOptions): Promise<CapabilityIdentity> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new CapabilityAuthError('Service-Plane capability token is required', 401);
  }
  return verifyCapabilityToken(token, verifier);
}

export function jwksFromUrl(url: string | URL, options: JwksFromUrlOptions = {}): CapabilityJwksResolver {
  requireExplicitJwksCacheKeyForVariantSources(options, 'headers');
  const key = JSON.stringify({
    cacheTtlSeconds: options.cacheTtlSeconds ?? DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
    url: String(url),
  });
  if (!options.cache && !options.cacheKey && !options.fetch && !options.headers && !options.now) {
    const existing = urlJwksResolvers.get(key);
    if (existing) return existing;
  }

  const resolver = createRemoteJwksResolver({ ...options, url });
  if (!options.cache && !options.cacheKey && !options.fetch && !options.headers && !options.now) urlJwksResolvers.set(key, resolver);
  return resolver;
}

export function jwksFromServiceBinding(binding: FetchLike, options: JwksFromServiceBindingOptions = {}): CapabilityJwksResolver {
  requireExplicitJwksCacheKeyForVariantSources(options, 'binding');
  const origin = options.origin ?? 'https://service-plane-control-plane.internal';
  const path = options.path ?? SERVICE_PLANE_CAPABILITY_JWKS_PATH;
  const url = new URL(path, origin);
  if (options.cache || options.cacheKey || options.headers || options.now) {
    return createRemoteJwksResolver({ ...options, fetch: binding, url });
  }

  const key = JSON.stringify({
    cacheTtlSeconds: options.cacheTtlSeconds ?? DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
    url: String(url),
  });
  let resolvers = serviceBindingJwksResolvers.get(binding);
  if (!resolvers) {
    resolvers = new Map();
    serviceBindingJwksResolvers.set(binding, resolvers);
  }
  const existing = resolvers.get(key);
  if (existing) return existing;
  const resolver = createRemoteJwksResolver({ ...options, fetch: binding, url });
  resolvers.set(key, resolver);
  return resolver;
}

export function createCapabilityTokenProvider(options: CreateCapabilityTokenProviderOptions): CapabilityTokenProvider {
  let cached: { expiresAt: Date; token: string } | undefined;
  const refreshSkewSeconds = options.refreshSkewSeconds ?? 10;
  const callerServiceId = normalizeValue(options.callerServiceId, 'caller service id');
  const targetServiceId = normalizeValue(options.targetServiceId, 'target service id');
  const scopes = normalizeScopes(options.scopes);
  const ttlSeconds = options.ttlSeconds === undefined ? undefined : normalizeTtlSeconds(options.ttlSeconds);
  const subject = options.subject === undefined ? undefined : normalizeCapabilitySubject(options.subject);
  // A caller-supplied cacheKey is still partitioned by the delegated subject: services authorize
  // per user from identity.subject, so one user's cached token must never serve another.
  const cacheKey = options.cacheKey
    ? subject
      ? `${options.cacheKey}:subject:${encodeURIComponent(JSON.stringify({ id: subject.id, orgId: subject.orgId ?? null }))}`
      : options.cacheKey
    : capabilityTokenCacheKey({
        ...(options.abilityId ? { abilityId: normalizeValue(options.abilityId, 'ability id') } : {}),
        callerServiceId,
        scopes,
        ...(subject ? { subject } : {}),
        targetServiceId,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });

  return {
    async token() {
      const now = options.now?.() ?? new Date();
      if (cached && cached.expiresAt.getTime() - refreshSkewSeconds * 1000 > now.getTime()) return cached.token;

      const shared = await readCapabilityTokenCache(options.cache, cacheKey, now, refreshSkewSeconds);
      if (shared) {
        cached = shared;
        return shared.token;
      }

      const issued = await options.requestToken({
        callerServiceId,
        scopes,
        ...(subject ? { subject } : {}),
        targetServiceId,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      cached = {
        expiresAt: issued.expiresAt instanceof Date ? issued.expiresAt : new Date(issued.expiresAt),
        token: issued.token,
      };
      await writeCapabilityTokenCache(options.cache, cacheKey, cached, now);
      return cached.token;
    },
  };
}

export function capabilityTokenCacheKey(input: {
  abilityId?: string;
  callerServiceId: string;
  scopes: string[];
  subject?: CapabilitySubject;
  targetServiceId: string;
  ttlSeconds?: number;
}): string {
  const parts = {
    abilityId: input.abilityId ?? null,
    callerServiceId: input.callerServiceId,
    scopes: [...input.scopes].sort(),
    // Included conditionally so subject-less keys stay byte-identical with earlier releases; tokens
    // delegated to a subject must never be shared across subjects through the token cache.
    ...(input.subject ? { subject: { id: input.subject.id, orgId: input.subject.orgId ?? null } } : {}),
    targetServiceId: input.targetServiceId,
    ttlSeconds: input.ttlSeconds ?? null,
  };
  return `service-plane:capability-token:${encodeURIComponent(JSON.stringify(parts))}`;
}

// The session proxy is deliberately NOT typed as a capnweb RpcStub: it is our own
// promise-returning proxy at runtime, and capnweb's RpcCompatible machinery cannot represent
// typed item streams (its types only bless ReadableStream<Uint8Array>), which would send the
// compiler into unbounded recursion for abilities with streaming methods.
export async function capabilityRpcSession<Scoped>(options: CapabilityRpcSessionOptions<Scoped>): Promise<Scoped> {
  const tokenProvider = options.tokenProvider ?? createCapabilityTokenProvider(options as CreateCapabilityTokenProviderOptions);
  const authenticate = options.authenticate ?? defaultAuthenticate<Scoped>;
  let persistent: Scoped | undefined;
  let nativeBinding: Promise<object> | object | undefined;
  // The proxy target is RpcTarget-branded so the session object survives being returned over
  // another Cap'n Web session by reference (e.g. the broker handing a connected ability to a
  // remote caller) instead of being serialized into an empty plain object.
  return new Proxy(new SessionProxyTarget(), {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (typeof property !== 'string') return undefined;
      return async (...args: unknown[]) => {
        if (options.transport.kind === 'cloudflare-binding-rpc') {
          nativeBinding ??= options.transport.binding.connectAbility({
            abilityId: options.abilityId ?? missingAbilityId(),
            ...(options.requestId ? { requestId: options.requestId } : {}),
            token: await tokenProvider.token(),
          });
          const target = (await nativeBinding) as Record<string, unknown>;
          const method = target[property];
          if (typeof method !== 'function')
            throw new CapabilityAuthError(`Service-Plane ability method is not available: ${property}`, 500);
          return method.apply(target, args);
        }

        let scoped: Scoped;
        if (options.transport.kind === 'http-batch' || options.transport.kind === 'fetch') {
          const token = await tokenProvider.token();
          scoped = authenticate(openSession<Scoped>(options), token);
        } else {
          if (!persistent) {
            const token = await tokenProvider.token();
            persistent = authenticate(openSession<Scoped>(options), token);
          }
          scoped = persistent;
        }
        return (scoped as Record<string, (...methodArgs: unknown[]) => unknown>)[property]?.(...args);
      };
    },
  }) as Scoped;
}

export function abilitySession<Scoped>(options: AbilitySessionOptions<Scoped>): Promise<Scoped> {
  return capabilityRpcSession(options);
}

export function httpBatchRpc(url: Request | string | URL, path?: string): CapabilityRpcTransport {
  return { kind: 'http-batch', ...(path ? { path } : {}), url };
}

export function websocketRpc(url: string): CapabilityRpcTransport {
  return { kind: 'websocket', url };
}

export function cloudflareServiceBindingRpc(
  binding: FetchLike,
  path?: string,
  origin = 'https://service-plane-service.internal',
): CapabilityRpcTransport {
  return { fetcher: binding, kind: 'fetch', origin, ...(path ? { path } : {}) };
}

export function cloudflareNativeRpc(binding: CloudflareAbilityRpcBinding): CapabilityRpcTransport {
  return { binding, kind: 'cloudflare-binding-rpc' };
}

export function customRpcTransport(transport: RpcTransport): CapabilityRpcTransport {
  return { kind: 'custom', transport };
}

export function controlPlaneHmacTokenRequester(
  options: ControlPlaneHmacTokenRequesterOptions,
): CreateCapabilityTokenProviderOptions['requestToken'] {
  const fetcher = options.fetch ?? fetch;
  const tokenUrl = new URL(options.tokenPath ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH, options.controlPlaneUrl);
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const clientIdHeaderName = options.clientIdHeaderName ?? SERVICE_PLANE_HMAC_CLIENT_HEADER;
  const timestampHeaderName = options.timestampHeaderName ?? SERVICE_PLANE_HMAC_TIMESTAMP_HEADER;

  return async (input) => {
    rejectRequesterSubject(input);
    const headers = new Headers(typeof options.headers === 'function' ? await options.headers() : options.headers);
    headers.set('content-type', 'application/json');
    const requestId = await resolveRequestId(options.requestId);
    if (requestId) headers.set(requestIdHeaderName, requestId);

    const request = await signServicePlaneHmacRequest(
      new Request(tokenUrl, {
        body: JSON.stringify(input),
        headers,
        method: 'POST',
      }),
      {
        clientId: options.clientId,
        clientIdHeaderName,
        requestIdHeaderName,
        secret: await resolveClientSecret(options.clientSecret),
        timestampHeaderName,
        ...(options.now ? { now: options.now() } : {}),
      },
    );

    const response = await fetchToken(fetcher, request);
    if (!response.ok) throw new CapabilityAuthError(`Unable to fetch Service-Plane capability token: ${response.status}`, response.status);
    return parseIssuedCapabilityToken(await readJson(response, 'Invalid Service-Plane capability token response'));
  };
}

export function controlPlaneJwkTokenRequester(
  options: ControlPlaneJwkTokenRequesterOptions,
): CreateCapabilityTokenProviderOptions['requestToken'] {
  const fetcher = options.fetch ?? fetch;
  const tokenUrl = new URL(options.tokenPath ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH, options.controlPlaneUrl);
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const clientIdHeaderName = options.clientIdHeaderName ?? SERVICE_PLANE_JWK_CLIENT_HEADER;
  const keyIdHeaderName = options.keyIdHeaderName ?? SERVICE_PLANE_JWK_KEY_ID_HEADER;

  return async (input) => {
    rejectRequesterSubject(input);
    const headers = new Headers(typeof options.headers === 'function' ? await options.headers() : options.headers);
    headers.set('content-type', 'application/json');
    const requestId = await resolveRequestId(options.requestId);
    if (requestId) headers.set(requestIdHeaderName, requestId);

    const request = await signServicePlaneJwkRequest(
      new Request(tokenUrl, {
        body: JSON.stringify(input),
        headers,
        method: 'POST',
      }),
      {
        audience: options.assertionAudience ?? SERVICE_PLANE_JWK_ASSERTION_AUDIENCE,
        clientId: options.clientId,
        clientIdHeaderName,
        keyId: options.keyId,
        keyIdHeaderName,
        ...(options.assertionTtlSeconds === undefined ? {} : { assertionTtlSeconds: options.assertionTtlSeconds }),
        ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
        ...(options.now ? { now: options.now() } : {}),
        privateJwk: await resolvePrivateJwk(options.privateJwk),
        requestIdHeaderName,
      },
    );

    const response = await fetchToken(fetcher, request);
    if (!response.ok) throw new CapabilityAuthError(`Unable to fetch Service-Plane capability token: ${response.status}`, response.status);
    return parseIssuedCapabilityToken(await readJson(response, 'Invalid Service-Plane capability token response'));
  };
}

export function controlPlaneRpcTokenRequester(
  options: ControlPlaneRpcTokenRequesterOptions,
): CreateCapabilityTokenProviderOptions['requestToken'] {
  return async (input) => {
    rejectRequesterSubject(input);
    if ('issueCapabilityTokenForCaller' in options.binding) {
      if (!options.callerServiceId) throw new CapabilityAuthError('Service-Plane RPC token requester requires callerServiceId', 500);
      return parseIssuedCapabilityToken(
        await options.binding.issueCapabilityTokenForCaller(options.callerServiceId, {
          scopes: input.scopes,
          targetServiceId: input.targetServiceId,
          ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
        }),
      );
    }
    return parseIssuedCapabilityToken(await options.binding.issueCapabilityToken(input));
  };
}

// Shipped requesters are service-side callers, and callers cannot assert subject delegation.
// Fail fast here with a clear error instead of transmitting the subject and surfacing a remote
// 403 — this also keeps subjects away from raw issuer bindings that would honor them.
function rejectRequesterSubject(input: IssueCapabilityTokenInput): void {
  if (input.subject === undefined) return;
  throw new CapabilityAuthError(
    'Service-Plane token requesters cannot assert a delegated subject; only control-plane code may mint one',
    403,
  );
}

export function tokenExpiresAt(token: string): Date {
  return new Date(decodeCapabilityTokenPayload(token).exp * 1000);
}

export type { RpcCompatible, RpcSessionOptions, RpcStub, RpcTransport };
export { RpcTarget };

class SessionProxyTarget extends RpcTarget {}

function defaultAuthenticate<Scoped>(root: AuthenticatedRoot<Scoped>, token: string): Scoped {
  return root.authenticate(token);
}

// capnweb's generics are instantiated with an untyped root so RpcCompatible never sees the
// caller's Scoped shape; the runtime stub is identical either way.
type UntypedAuthenticatedRoot = AuthenticatedRoot<Record<string, unknown>>;

function openSession<Scoped>(options: {
  abilityId?: string;
  requestId?: string;
  requestIdHeaderName?: string;
  rpcSessionOptions?: RpcSessionOptions;
  transport: CapabilityRpcTransport;
}): AuthenticatedRoot<Scoped> {
  const { abilityId, requestId, rpcSessionOptions, transport } = options;
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  if (transport.kind === 'http-batch') {
    // Same wire protocol as capnweb's newHttpBatchRpcSession, but flushed without Node's
    // setTimeout clamp (see nextMacrotask) and with Request-template headers preserved.
    const batchTransport = createFetchBatchTransport(
      { fetch: (request) => fetch(request) },
      withRequestIdHeader(httpBatchUrl(transport, abilityId), requestId, requestIdHeaderName),
    );
    const session = new RpcSession<UntypedAuthenticatedRoot>(batchTransport, undefined, rpcSessionOptions);
    return session.getRemoteMain() as unknown as AuthenticatedRoot<Scoped>;
  }
  if (transport.kind === 'websocket') {
    return newWebSocketRpcSession<UntypedAuthenticatedRoot>(
      withRequestIdQueryParam(transport.url, requestId),
      undefined,
      rpcSessionOptions,
    ) as unknown as AuthenticatedRoot<Scoped>;
  }
  if (transport.kind === 'cloudflare-binding-rpc') {
    throw new CapabilityAuthError('Cloudflare native RPC transport does not open a Cap’n Web session', 500);
  }
  const rpcTransport =
    transport.kind === 'fetch'
      ? createFetchBatchTransport(
          transport.fetcher,
          fetchTransportUrl(transport, abilityId),
          requestId ? { [requestIdHeaderName]: requestId } : undefined,
        )
      : transport.transport;
  const session = new RpcSession<UntypedAuthenticatedRoot>(rpcTransport, undefined, rpcSessionOptions);
  return session.getRemoteMain() as unknown as AuthenticatedRoot<Scoped>;
}

// Cap'n Web sends the batch as `fetch(urlOrRequest, { method, body })`, so a bodyless template
// Request keeps its headers across batches and carries the correlation id to the service.
function withRequestIdHeader(url: Request | string, requestId: string | undefined, headerName: string): Request | string {
  if (!requestId) return url;
  const request = url instanceof Request ? new Request(url) : new Request(url, { method: 'POST' });
  request.headers.set(headerName, requestId);
  return request;
}

function withRequestIdQueryParam(url: string, requestId: string | undefined): string {
  if (!requestId) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(SERVICE_PLANE_REQUEST_ID_QUERY_PARAM, requestId);
  return parsed.toString();
}

function httpBatchUrl(transport: Extract<CapabilityRpcTransport, { kind: 'http-batch' }>, abilityId?: string): Request | string {
  if (transport.url instanceof Request) return transport.url;
  if (!transport.path && !abilityId) return transport.url instanceof URL ? transport.url.toString() : transport.url;
  const url = new URL(transport.url instanceof URL ? transport.url.toString() : String(transport.url));
  url.pathname = transport.path ?? defaultAbilityPath(abilityId);
  return url.toString();
}

function fetchTransportUrl(transport: Extract<CapabilityRpcTransport, { kind: 'fetch' }>, abilityId?: string): string {
  return new URL(transport.path ?? defaultAbilityPath(abilityId), transport.origin).toString();
}

function defaultAbilityPath(abilityId?: string): string {
  if (!abilityId) throw new CapabilityAuthError('Service-Plane abilityId is required when transport path is omitted', 500);
  return `/rpc/${abilityId}`;
}

function missingAbilityId(): never {
  throw new CapabilityAuthError('Service-Plane abilityId is required for Cloudflare native RPC transport', 500);
}

// Deviation from capnweb's stock newHttpBatchRpcSession client, on purpose: batches must
// flush on the next macrotask so same-tick pipelined calls share one request, and the stock
// client schedules that flush with setTimeout(0) — which Node clamps to ~1ms, costing more per
// call than the ES256 token verification itself (measured 1,185us vs 100us). This helper
// prefers setImmediate where it exists and is feature-detected via globalThis so no runtime
// types are required:
//   - Node, Bun: setImmediate exists — flush in ~1us.
//   - workerd, Deno: no setImmediate — setTimeout(0) fallback, which neither runtime clamps
//     the way Node does.
// A microtask flush would be wrong here: pull messages can be registered a microtask after the
// call messages, and flushing between them would truncate the batch.
function nextMacrotask(): Promise<void> {
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => void }).setImmediate;
  return new Promise((resolve) => {
    if (immediate) immediate(resolve);
    else setTimeout(resolve, 0);
  });
}

// Speaks the exact newline-delimited wire protocol of capnweb's HTTP-batch client, built on
// web-standard Request/fetch only (portable to Node 20+, Bun, workerd, Deno). It exists instead
// of the stock client for two reasons: the unclamped flush above, and Request-template support —
// a template Request's headers (gateway auth, tenant routing) survive into every batch.
function createFetchBatchTransport(fetcher: FetchLike, url: Request | string, headers?: Record<string, string>): RpcTransport {
  let batchToSend: string[] | null = [];
  let batchToReceive: string[] | undefined;
  let aborted: unknown;
  const scheduled = (async () => {
    await nextMacrotask();
    if (aborted !== undefined) throw aborted;
    const batch = batchToSend ?? [];
    batchToSend = null;
    const response = await fetcher.fetch(new Request(url, { body: batch.join('\n'), ...(headers ? { headers } : {}), method: 'POST' }));
    if (!response.ok) {
      response.body?.cancel();
      throw new CapabilityAuthError(`Cap'n Web HTTP-batch transport failed: ${response.status}`, response.status);
    }
    const body = await response.text();
    batchToReceive = body === '' ? [] : body.split('\n');
  })();

  return {
    async send(message) {
      batchToSend?.push(message);
    },
    async receive() {
      if (!batchToReceive) await scheduled;
      const message = batchToReceive?.shift();
      if (message !== undefined) return message;
      throw new Error('Batch RPC request ended.');
    },
    abort(reason) {
      aborted = reason;
    },
  };
}

function requireExplicitJwksCacheKeyForVariantSources(options: JwksFromUrlOptions, source: 'binding' | 'headers'): void {
  if (!options.cache || options.cacheKey) return;
  if (source === 'binding') {
    throw new CapabilityAuthError('Service-Plane JWKS cacheKey is required when using a shared cache with service bindings', 500);
  }
  if (options.headers) {
    throw new CapabilityAuthError('Service-Plane JWKS cacheKey is required when using a shared cache with JWKS request headers', 500);
  }
}

function normalizeScopeDefinition(scope: CapabilityScopeDefinition): CapabilityScopeDefinition {
  return {
    ...scope,
    id: normalizeScope(scope.id),
  };
}

function normalizeScopes(scopes: string[]): string[] {
  if (scopes.length === 0) throw new CapabilityAuthError('Service-Plane capability requires at least one scope', 500);
  return [...new Set(scopes.map(normalizeScope))];
}

function normalizeScope(scope: string): string {
  const normalized = normalizeValue(scope, 'scope');
  if (normalized.includes('*')) throw new CapabilityAuthError('Service-Plane capability wildcards are not supported', 500);
  return normalized;
}

function normalizeValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane capability ${field} cannot be empty`, 500);
  return normalized;
}

function normalizeTtlSeconds(ttlSeconds: number): number {
  if (
    !Number.isFinite(ttlSeconds) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_CAPABILITY_TOKEN_TTL_SECONDS
  ) {
    throw new CapabilityAuthError(
      `Service-Plane capability token TTL must be a positive integer no greater than ${MAX_CAPABILITY_TOKEN_TTL_SECONDS} seconds`,
      500,
    );
  }
  return ttlSeconds;
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function createRemoteJwksResolver(options: JwksFromUrlOptions & { url: string | URL }): CapabilityJwksResolver {
  const cacheTtlSeconds = normalizeCacheTtlSeconds(options.cacheTtlSeconds ?? DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS);
  const cacheKey = options.cacheKey ?? capabilityJwksCacheKey(options.url);
  const fetcher = options.fetch ?? fetch;
  let cached: { expiresAt: number; jwks: CapabilityJwks } | undefined;
  let inFlight: Promise<CapabilityJwks> | undefined;

  return async () => {
    const now = (options.now?.() ?? new Date()).getTime();
    if (cached && cached.expiresAt > now) return cached.jwks;
    const shared = await readCapabilityJwksCache(options.cache, cacheKey, new Date(now));
    if (shared) {
      cached = {
        expiresAt: shared.expiresAt,
        jwks: shared.jwks,
      };
      return shared.jwks;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const headers = typeof options.headers === 'function' ? await options.headers() : options.headers;
      const request = headers === undefined ? new Request(String(options.url)) : new Request(String(options.url), { headers });
      const response = await fetchJwks(fetcher, request);
      if (!response.ok) {
        throw new CapabilityAuthError(`Unable to fetch Service-Plane JWKS: ${response.status}`, 500);
      }
      const jwks = parseRemoteJwks(await readJson(response, 'Invalid Service-Plane JWKS response'));
      cached = {
        expiresAt: now + cacheTtlSeconds * 1000,
        jwks,
      };
      await writeCapabilityJwksCache(options.cache, cacheKey, jwks, new Date(now), cacheTtlSeconds);
      return jwks;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

function capabilityJwksCacheKey(url: string | URL): string {
  return `service-plane:jwks:${encodeURIComponent(String(url))}`;
}

function fetchJwks(fetcher: RemoteJwksFetch, request: Request): Promise<Response> {
  return typeof fetcher === 'function' ? fetcher(request) : fetcher.fetch(request);
}

function fetchToken(fetcher: typeof fetch | FetchLike, request: Request): Promise<Response> {
  return typeof fetcher === 'function' ? fetcher(request) : fetcher.fetch(request);
}

async function readJson(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CapabilityAuthError(message, 500);
  }
}

async function resolveClientSecret(secret: ControlPlaneHmacTokenRequesterOptions['clientSecret']): Promise<string> {
  const resolved = typeof secret === 'function' ? await secret() : secret;
  const normalized = resolved.trim();
  if (!normalized) throw new CapabilityAuthError('Service-Plane HMAC client secret cannot be empty', 500);
  return normalized;
}

async function resolvePrivateJwk(privateJwk: ControlPlaneJwkTokenRequesterOptions['privateJwk']): Promise<JsonWebKey> {
  const resolved = typeof privateJwk === 'function' ? await privateJwk() : privateJwk;
  if (typeof resolved !== 'object' || resolved === null) throw new CapabilityAuthError('Service-Plane JWK private key is invalid', 500);
  return resolved;
}

async function resolveRequestId(requestId: ControlPlaneTokenRequestOptions['requestId']): Promise<string | undefined> {
  const resolved = typeof requestId === 'function' ? await requestId() : requestId;
  const normalized = resolved?.trim();
  return normalized || undefined;
}

function parseIssuedCapabilityToken(value: unknown): IssuedCapabilityToken {
  if (!value || typeof value !== 'object') throw new CapabilityAuthError('Invalid Service-Plane capability token response', 500);
  const issued = value as { expiresAt?: unknown; token?: unknown };
  if (!(typeof issued.expiresAt === 'string' || issued.expiresAt instanceof Date) || typeof issued.token !== 'string') {
    throw new CapabilityAuthError('Invalid Service-Plane capability token response', 500);
  }
  return {
    expiresAt: issued.expiresAt instanceof Date ? issued.expiresAt : new Date(issued.expiresAt),
    token: issued.token,
  };
}

function parseRemoteJwks(value: unknown): CapabilityJwks {
  if (!value || typeof value !== 'object') throw new CapabilityAuthError('Invalid Service-Plane JWKS response', 500);
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new CapabilityAuthError('Invalid Service-Plane JWKS response', 500);
  if (!keys.every((key) => key && typeof key === 'object')) throw new CapabilityAuthError('Invalid Service-Plane JWKS response', 500);
  return { keys: keys as CapabilityJwks['keys'] };
}

function normalizeCacheTtlSeconds(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CapabilityAuthError('Service-Plane JWKS cache TTL must be a positive integer', 500);
  }
  return ttlSeconds;
}

async function readCapabilityTokenCache(
  cache: CapabilityTokenCache | undefined,
  key: string,
  now: Date,
  refreshSkewSeconds: number,
): Promise<{ expiresAt: Date; token: string } | undefined> {
  if (!cache) return undefined;
  try {
    const value = await cache.get(key);
    if (!value) return undefined;
    const expiresAt = value.expiresAt instanceof Date ? value.expiresAt : new Date(value.expiresAt);
    if (expiresAt.getTime() - refreshSkewSeconds * 1000 <= now.getTime()) return undefined;
    return { expiresAt, token: value.token };
  } catch {
    return undefined;
  }
}

async function writeCapabilityTokenCache(
  cache: CapabilityTokenCache | undefined,
  key: string,
  value: { expiresAt: Date; token: string },
  now: Date,
): Promise<void> {
  if (!cache) return;
  const ttlSeconds = Math.floor((value.expiresAt.getTime() - now.getTime()) / 1000);
  if (ttlSeconds <= 0) return;
  try {
    await cache.set(key, value, ttlSeconds);
  } catch {
    return;
  }
}

async function readCapabilityJwksCache(
  cache: CapabilityJwksCache | undefined,
  key: string,
  now: Date,
): Promise<{ expiresAt: number; jwks: CapabilityJwks } | undefined> {
  if (!cache) return undefined;
  try {
    const value = await cache.get(key);
    if (!value) return undefined;
    const expiresAt = value.expiresAt instanceof Date ? value.expiresAt : new Date(value.expiresAt);
    if (expiresAt.getTime() <= now.getTime()) return undefined;
    return { expiresAt: expiresAt.getTime(), jwks: parseRemoteJwks(value.jwks) };
  } catch {
    return undefined;
  }
}

async function writeCapabilityJwksCache(
  cache: CapabilityJwksCache | undefined,
  key: string,
  jwks: CapabilityJwks,
  now: Date,
  ttlSeconds: number,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.set(
      key,
      {
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        jwks,
      },
      ttlSeconds,
    );
  } catch {
    return;
  }
}
