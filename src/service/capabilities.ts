import { CapabilityAuthError } from '../shared/errors.js';
import {
  DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  type CapabilityCatalog,
  type CapabilityJwks,
  type CapabilityJwksResolver,
  type CapabilityScopeDefinition,
  type FetchLike,
} from '../shared/types.js';

/**
 * Validate, deduplicate, and freeze a capability catalog. The catalog is the
 * source of truth for the scopes a service exports — it is consumed by
 * `defineService(...)`, by the control-plane issuer when validating grants,
 * and by `requireScopes(...)` for compile-time scope literal narrowing.
 */
export function defineCapabilities<T extends CapabilityCatalog>(catalog: T): T {
  const scopes = catalog.scopes.map((scope) => ({
    ...scope,
    id: normalizeScope(scope.id),
  }));
  const duplicate = firstDuplicate(scopes.map((scope) => scope.id));
  if (duplicate) throw new CapabilityAuthError(`Duplicate Service-Plane capability scope: ${duplicate}`, 500);
  return {
    ...catalog,
    scopes: scopes as CapabilityScopeDefinition[],
    serviceId: normalizeValue(catalog.serviceId, 'service id'),
  } as T;
}

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

const serviceBindingJwksResolvers = new WeakMap<object, Map<string, CapabilityJwksResolver>>();
const urlJwksResolvers = new Map<string, CapabilityJwksResolver>();

export function jwksFromUrl(url: string | URL, options: JwksFromUrlOptions = {}): CapabilityJwksResolver {
  const key = JSON.stringify({
    cacheTtlSeconds: options.cacheTtlSeconds ?? DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
    url: String(url),
  });
  if (!options.fetch && !options.headers && !options.now) {
    const existing = urlJwksResolvers.get(key);
    if (existing) return existing;
  }
  const resolver = createRemoteJwksResolver({ ...options, url });
  if (!options.fetch && !options.headers && !options.now) urlJwksResolvers.set(key, resolver);
  return resolver;
}

export function jwksFromServiceBinding(binding: FetchLike, options: JwksFromServiceBindingOptions = {}): CapabilityJwksResolver {
  const origin = options.origin ?? 'https://service-plane-control-plane.internal';
  const path = options.path ?? SERVICE_PLANE_CAPABILITY_JWKS_PATH;
  const url = new URL(path, origin);
  if (options.headers || options.now) {
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
      const response = await (typeof fetcher === 'function' ? fetcher(request) : fetcher.fetch(request));
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
      cached = { expiresAt: now + cacheTtlSeconds * 1000, jwks };
      return jwks;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
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

export function normalizeScope(scope: string): string {
  const normalized = normalizeValue(scope, 'scope');
  if (normalized.includes('*')) throw new CapabilityAuthError('Service-Plane capability wildcards are not supported', 500);
  return normalized;
}

export function normalizeScopes(scopes: readonly string[]): string[] {
  if (scopes.length === 0) throw new CapabilityAuthError('Service-Plane capability requires at least one scope', 500);
  return [...new Set(scopes.map(normalizeScope))];
}

export function normalizeValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane capability ${field} cannot be empty`, 500);
  return normalized;
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}
