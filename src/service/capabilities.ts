import { createMiddleware } from 'hono/factory';
import {
  decodeCapabilityTokenPayload,
  extractServicePlaneToken,
  servicePlaneAuthorization,
  verifyCapabilityToken,
} from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { SERVICE_PLANE_HMAC_CLIENT_HEADER, SERVICE_PLANE_HMAC_TIMESTAMP_HEADER, signServicePlaneHmacRequest } from '../shared/hmac-auth.js';
import {
  type CapabilityAuthMiddleware,
  type CapabilityAuthVariables,
  type CapabilityCatalog,
  type CapabilityContextSource,
  type CapabilityIdentity,
  type CapabilityJwks,
  type CapabilityJwksResolver,
  type CapabilityScopeDefinition,
  type CapabilityTokenCache,
  type CapabilityTokenProvider,
  type CapabilityVerifierOptions,
  DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
  type FetchLike,
  type HonoAppLike,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
  SERVICE_PLANE_CAPABILITY_CONTEXT,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_CAPABILITY_VERIFIER,
  SERVICE_PLANE_REQUEST_ID_HEADER,
} from '../shared/types.js';

const routeCapabilities = new WeakMap<object, string[]>();
const serviceBindingJwksResolvers = new WeakMap<object, Map<string, CapabilityJwksResolver>>();
const urlJwksResolvers = new Map<string, CapabilityJwksResolver>();

export type RemoteJwksFetch = typeof fetch | FetchLike;

export type JwksFromUrlOptions = {
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
  cache?: CapabilityTokenCache;
  cacheKey?: string;
  callerServiceId: string;
  now?: () => Date;
  refreshSkewSeconds?: number;
  requestToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
  scopes: string[];
  targetServiceId: string;
  ttlSeconds?: number;
};

export type CapabilityFetchOptions = CreateCapabilityTokenProviderOptions & {
  fetch?: typeof fetch;
};

export type CapabilityFetchWithProviderOptions = {
  fetch?: typeof fetch;
  tokenProvider: CapabilityTokenProvider;
};

export type ControlPlaneTokenRequesterOptions = {
  controlPlaneUrl: string | URL;
  fetch?: typeof fetch | FetchLike;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  requestId?: string | (() => string | Promise<string | undefined> | undefined);
  requestIdHeaderName?: string;
  serviceClientSecret: string | (() => Promise<string> | string);
  tokenPath?: string;
};

export type ControlPlaneHmacTokenRequesterOptions = Omit<ControlPlaneTokenRequesterOptions, 'serviceClientSecret'> & {
  clientId: string;
  clientIdHeaderName?: string;
  clientSecret: string | (() => Promise<string> | string);
  now?: () => Date;
  timestampHeaderName?: string;
};

export type ControlPlaneRpcTokenBinding = {
  issueCapabilityToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
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

export function capability(...requiredScopes: string[]): CapabilityAuthMiddleware {
  const scopes = normalizeScopes(requiredScopes);
  const middleware = createMiddleware<CapabilityAuthVariables>(async (context, next) => {
    const verifier = context.get(SERVICE_PLANE_CAPABILITY_VERIFIER);
    if (!verifier) return context.json({ error: 'Service-Plane capability auth is not configured' }, 500);

    try {
      const identity = await verifyCapabilityToken(extractServicePlaneToken(context.req.raw), {
        ...verifier,
        requiredScopes: scopes,
      });
      context.set(SERVICE_PLANE_CAPABILITY_CONTEXT, identity);
      await next();
    } catch (error) {
      if (error instanceof CapabilityAuthError) return context.json({ error: error.message }, error.status as 400 | 401 | 403 | 500);
      throw error;
    }
  });
  routeCapabilities.set(middleware, scopes);
  return middleware;
}

export function capabilityAuth(options: CapabilityVerifierOptions): CapabilityAuthMiddleware {
  return createMiddleware<CapabilityAuthVariables>(async (context, next) => {
    context.set(SERVICE_PLANE_CAPABILITY_VERIFIER, options);
    await next();
  });
}

export function jwksFromUrl(url: string | URL, options: JwksFromUrlOptions = {}): CapabilityJwksResolver {
  const key = JSON.stringify({
    cacheTtlSeconds: options.cacheTtlSeconds ?? DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
    url: String(url),
  });
  if (!options.fetch && !options.headers && !options.now) {
    const existing = urlJwksResolvers.get(key);
    if (existing) return existing;
  }

  const resolver = createRemoteJwksResolver({
    ...options,
    url,
  });
  if (!options.fetch && !options.headers && !options.now) urlJwksResolvers.set(key, resolver);
  return resolver;
}

export function jwksFromServiceBinding(binding: FetchLike, options: JwksFromServiceBindingOptions = {}): CapabilityJwksResolver {
  const origin = options.origin ?? 'https://service-plane-control-plane.internal';
  const path = options.path ?? SERVICE_PLANE_CAPABILITY_JWKS_PATH;
  const url = new URL(path, origin);
  if (options.headers || options.now) {
    return createRemoteJwksResolver({
      ...options,
      fetch: binding,
      url,
    });
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

  const resolver = createRemoteJwksResolver({
    ...options,
    fetch: binding,
    url,
  });
  resolvers.set(key, resolver);
  return resolver;
}

export function capabilityIdentity(context: CapabilityContextSource): CapabilityIdentity | undefined {
  return context.get(SERVICE_PLANE_CAPABILITY_CONTEXT);
}

export { verifyCapabilityToken };

export function routeRequiredScopes(handler: unknown): string[] {
  return typeof handler === 'function' || (typeof handler === 'object' && handler !== null) ? (routeCapabilities.get(handler) ?? []) : [];
}

export function serviceCapabilities(
  app: HonoAppLike,
  catalog: CapabilityCatalog,
): CapabilityCatalog & { routes: Array<{ method: string; path: string; requiredScopes: string[] }> } {
  return {
    ...catalog,
    routes: app.routes.flatMap((route) => {
      const requiredScopes = routeRequiredScopes(route.handler);
      if (requiredScopes.length === 0) return [];
      return [{ method: route.method.toUpperCase(), path: route.path, requiredScopes }];
    }),
  };
}

export function createCapabilityTokenProvider(options: CreateCapabilityTokenProviderOptions): CapabilityTokenProvider {
  let cached: { expiresAt: Date; token: string } | undefined;
  const refreshSkewSeconds = options.refreshSkewSeconds ?? 10;
  const callerServiceId = normalizeValue(options.callerServiceId, 'caller service id');
  const targetServiceId = normalizeValue(options.targetServiceId, 'target service id');
  const scopes = normalizeScopes(options.scopes);
  const ttlSeconds = options.ttlSeconds === undefined ? undefined : normalizeTtlSeconds(options.ttlSeconds);
  const cacheKey =
    options.cacheKey ??
    capabilityTokenCacheKey({ callerServiceId, scopes, targetServiceId, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });

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
  callerServiceId: string;
  scopes: string[];
  targetServiceId: string;
  ttlSeconds?: number;
}): string {
  const parts = {
    callerServiceId: input.callerServiceId,
    scopes: [...input.scopes].sort(),
    targetServiceId: input.targetServiceId,
    ttlSeconds: input.ttlSeconds ?? null,
  };
  return `service-plane:capability-token:${encodeURIComponent(JSON.stringify(parts))}`;
}

export function controlPlaneTokenRequester(
  options: ControlPlaneTokenRequesterOptions,
): CreateCapabilityTokenProviderOptions['requestToken'] {
  const fetcher = options.fetch ?? fetch;
  const tokenUrl = new URL(options.tokenPath ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH, options.controlPlaneUrl);
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;

  return async (input) => {
    const headers = new Headers(typeof options.headers === 'function' ? await options.headers() : options.headers);
    headers.set('authorization', `Bearer ${await resolveServiceClientSecret(options.serviceClientSecret)}`);
    headers.set('content-type', 'application/json');
    const requestId = await resolveRequestId(options.requestId);
    if (requestId) headers.set(requestIdHeaderName, requestId);

    const response = await fetchToken(
      fetcher,
      new Request(tokenUrl, {
        body: JSON.stringify(input),
        headers,
        method: 'POST',
      }),
    );
    if (!response.ok) throw new CapabilityAuthError(`Unable to fetch Service-Plane capability token: ${response.status}`, response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CapabilityAuthError('Invalid Service-Plane capability token response', 500);
    }
    return parseIssuedCapabilityToken(body);
  };
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
        secret: await resolveServiceClientSecret(options.clientSecret),
        timestampHeaderName,
        ...(options.now ? { now: options.now() } : {}),
      },
    );

    const response = await fetchToken(fetcher, request);
    if (!response.ok) throw new CapabilityAuthError(`Unable to fetch Service-Plane capability token: ${response.status}`, response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CapabilityAuthError('Invalid Service-Plane capability token response', 500);
    }
    return parseIssuedCapabilityToken(body);
  };
}

export function controlPlaneRpcTokenRequester(binding: ControlPlaneRpcTokenBinding): CreateCapabilityTokenProviderOptions['requestToken'] {
  return async (input) => parseIssuedCapabilityToken(await binding.issueCapabilityToken(input));
}

export function capabilityFetch(options: CapabilityFetchOptions | CapabilityFetchWithProviderOptions): typeof fetch {
  const fetcher = options.fetch ?? fetch;
  const tokenProvider = 'tokenProvider' in options ? options.tokenProvider : createCapabilityTokenProvider(options);
  return async (input, init) => {
    const token = await tokenProvider.token();
    const request = withCapabilityAuthorization(new Request(input, init), token);
    return fetcher(request);
  };
}

export function withCapabilityAuthorization(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set('authorization', servicePlaneAuthorization(token));
  return new Request(request, { headers });
}

export function tokenExpiresAt(token: string): Date {
  return new Date(decodeCapabilityTokenPayload(token).exp * 1000);
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
  if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CapabilityAuthError('Service-Plane capability token TTL must be a positive integer', 500);
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
  const fetcher = options.fetch ?? fetch;
  let cached: { expiresAt: number; jwks: CapabilityJwks } | undefined;
  let inFlight: Promise<CapabilityJwks> | undefined;

  return async () => {
    const now = (options.now?.() ?? new Date()).getTime();
    if (cached && cached.expiresAt > now) return cached.jwks;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const headers = typeof options.headers === 'function' ? await options.headers() : options.headers;
      const request = headers === undefined ? new Request(String(options.url)) : new Request(String(options.url), { headers });
      const response = await fetchJwks(fetcher, request);
      if (!response.ok) {
        throw new CapabilityAuthError(`Unable to fetch Service-Plane JWKS: ${response.status}`, 500);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new CapabilityAuthError('Invalid Service-Plane JWKS response', 500);
      }

      const jwks = parseRemoteJwks(body);
      cached = {
        expiresAt: now + cacheTtlSeconds * 1000,
        jwks,
      };
      return jwks;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

function fetchJwks(fetcher: RemoteJwksFetch, request: Request): Promise<Response> {
  return typeof fetcher === 'function' ? fetcher(request) : fetcher.fetch(request);
}

function fetchToken(fetcher: typeof fetch | FetchLike, request: Request): Promise<Response> {
  return typeof fetcher === 'function' ? fetcher(request) : fetcher.fetch(request);
}

async function resolveServiceClientSecret(secret: ControlPlaneTokenRequesterOptions['serviceClientSecret']): Promise<string> {
  const resolved = typeof secret === 'function' ? await secret() : secret;
  const normalized = resolved.trim();
  if (!normalized) throw new CapabilityAuthError('Service-Plane service client secret cannot be empty', 500);
  return normalized;
}

async function resolveRequestId(requestId: ControlPlaneTokenRequesterOptions['requestId']): Promise<string | undefined> {
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
