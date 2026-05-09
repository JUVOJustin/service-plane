import { CapabilityAuthError } from '../shared/errors.js';
import {
  extractServicePlaneToken,
  servicePlaneAuthorization,
  verifyCapabilityToken,
  decodeCapabilityTokenPayload,
} from '../shared/capability-tokens.js';
import {
  SERVICE_PLANE_CAPABILITY_CONTEXT,
  SERVICE_PLANE_CAPABILITY_VERIFIER,
  type CapabilityAuthMiddleware,
  type CapabilityCatalog,
  type CapabilityContextSource,
  type CapabilityIdentity,
  type CapabilityScopeDefinition,
  type CapabilityTokenCache,
  type CapabilityTokenProvider,
  type CapabilityVerifierOptions,
  type HonoAppLike,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
} from '../shared/types.js';

const routeCapabilities = new WeakMap<object, string[]>();

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
  const middleware: CapabilityAuthMiddleware = async (context, next) => {
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
  };
  routeCapabilities.set(middleware, scopes);
  return middleware;
}

export function capabilityAuth(options: CapabilityVerifierOptions): CapabilityAuthMiddleware {
  return async (context, next) => {
    context.set(SERVICE_PLANE_CAPABILITY_VERIFIER, options);
    await next();
  };
}

export function capabilityIdentity(context: CapabilityContextSource): CapabilityIdentity | undefined {
  return context.get(SERVICE_PLANE_CAPABILITY_CONTEXT);
}

export { verifyCapabilityToken };

export function routeRequiredScopes(handler: unknown): string[] {
  return typeof handler === 'function' || (typeof handler === 'object' && handler !== null) ? (routeCapabilities.get(handler) ?? []) : [];
}

export function serviceCapabilities(app: HonoAppLike, catalog: CapabilityCatalog): CapabilityCatalog & { routes: Array<{ method: string; path: string; requiredScopes: string[] }> } {
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
  const cacheKey = options.cacheKey ?? capabilityTokenCacheKey({ callerServiceId, scopes, targetServiceId, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });

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

export function capabilityTokenCacheKey(input: { callerServiceId: string; scopes: string[]; targetServiceId: string; ttlSeconds?: number }): string {
  const parts = {
    callerServiceId: input.callerServiceId,
    scopes: [...input.scopes].sort(),
    targetServiceId: input.targetServiceId,
    ttlSeconds: input.ttlSeconds ?? null,
  };
  return `service-plane:capability-token:${encodeURIComponent(JSON.stringify(parts))}`;
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
