import { readBoundedResponseJson, validateBodyByteLimit } from '../shared/body-limit.js';
import {
  decodeCapabilityTokenPayload,
  normalizeCapabilitySubject,
  publicJwkFromPrivateJwk,
  verifyCapabilityToken,
} from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { SERVICE_PLANE_HMAC_CLIENT_HEADER, SERVICE_PLANE_HMAC_TIMESTAMP_HEADER, signServicePlaneHmacRequest } from '../shared/hmac-auth.js';
import {
  SERVICE_PLANE_JWK_ASSERTION_AUDIENCE,
  SERVICE_PLANE_JWK_CLIENT_HEADER,
  SERVICE_PLANE_JWK_KEY_ID_HEADER,
  servicePlaneJwkThumbprint,
  signServicePlaneJwkRequest,
} from '../shared/jwk-auth.js';
import { signCapabilityProof } from '../shared/proof-of-possession.js';
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
  type ControlPlaneRpcTokenBinding,
  DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS,
  type FetchLike,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
  MAX_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
} from '../shared/types.js';

const serviceBindingJwksResolvers = new WeakMap<object, Map<string, CapabilityJwksResolver>>();
const urlJwksResolvers = new Map<string, CapabilityJwksResolver>();

/** Default maximum response size for a capability-token endpoint: 64 KiB. */
export const DEFAULT_CAPABILITY_TOKEN_RESPONSE_MAX_BYTES = 65_536;

/** Default maximum response size for a JWKS endpoint: 256 KiB. */
export const DEFAULT_CAPABILITY_JWKS_RESPONSE_MAX_BYTES = 262_144;

export type RemoteJwksFetch = typeof fetch | FetchLike;

export type JwksFromUrlOptions = {
  cache?: CapabilityJwksCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  fetch?: RemoteJwksFetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Maximum accepted JWKS response size. Defaults to 256 KiB. */
  maxResponseBytes?: number;
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
  /**
   * Property-function on purpose, not method syntax: methods compare parameters bivariantly, which
   * would let a raw `CapabilityIssuer` (whose input additionally requires `callerAccess`) slot in
   * here and compile — then fail at runtime on the first request. This shape makes that a type error;
   * wrap the issuer in a closure that supplies `callerAccess` instead.
   */
  requestToken: (input: IssueCapabilityTokenInput) => Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
  scopes: string[];
  subject?: CapabilitySubject;
  targetServiceId: string;
  ttlSeconds?: number;
};

type ControlPlaneTokenRequestOptions = {
  controlPlaneUrl: string | URL;
  fetch?: typeof fetch | FetchLike;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Maximum accepted token response size. Defaults to 64 KiB. */
  maxResponseBytes?: number;
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

export type ControlPlaneRpcTokenRequesterOptions = {
  /** A per-caller control-plane binding whose implementation pins the service identity. */
  binding: ControlPlaneRpcTokenBinding;
};

/**
 * Signs a proof of possession for a sender-constrained token. Supplied by the caller because only the
 * caller holds the private key its tokens are bound to.
 */
export type CapabilityProofSigner = (input: { abilityId: string; targetServiceId: string; token: string }) => Promise<string> | string;

/**
 * A token requester, optionally carrying the prover for the key it authenticates with. Callers that use
 * a shipped requester therefore need no extra wiring for sender-constrained tokens: the key is already
 * configured once, in one place.
 */
export type CapabilityTokenRequester = CreateCapabilityTokenProviderOptions['requestToken'] & {
  /** Stable public discriminator used to partition shared tokens by sender-constraining key. */
  cacheBinding?: () => Promise<string> | string;
  proveTokenPossession?: CapabilityProofSigner;
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
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_CAPABILITY_JWKS_RESPONSE_MAX_BYTES,
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
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_CAPABILITY_JWKS_RESPONSE_MAX_BYTES,
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
  let cached: { cacheKey: string; expiresAt: Date; token: string } | undefined;
  const inFlight = new Map<string, Promise<string>>();
  const refreshSkewSeconds = normalizeRefreshSkewSeconds(options.refreshSkewSeconds ?? 10);
  const callerServiceId = normalizeValue(options.callerServiceId, 'caller service id');
  const targetServiceId = normalizeValue(options.targetServiceId, 'target service id');
  const scopes = normalizeScopes(options.scopes);
  const ttlSeconds = options.ttlSeconds === undefined ? undefined : normalizeTtlSeconds(options.ttlSeconds);
  const subject = options.subject === undefined ? undefined : normalizeCapabilitySubject(options.subject);
  const requester = options.requestToken as CapabilityTokenRequester;
  const senderConstrained = Boolean(requester.proveTokenPossession);

  return {
    async token() {
      const now = options.now?.() ?? new Date();
      const cacheKey = await capabilityProviderCacheKey({
        abilityId: options.abilityId,
        cacheKey: options.cacheKey,
        callerServiceId,
        requester,
        scopes,
        senderConstrained,
        subject,
        targetServiceId,
        ttlSeconds,
      });
      if (cached?.cacheKey === cacheKey && cached.expiresAt.getTime() - refreshSkewSeconds * 1000 > now.getTime()) {
        return cached.token;
      }
      const pending = inFlight.get(cacheKey);
      if (pending) return pending;

      const request = (async () => {
        const shared = await readCapabilityTokenCache(options.cache, cacheKey, now, refreshSkewSeconds);
        if (shared) {
          cached = { ...shared, cacheKey };
          return shared.token;
        }

        const issued = await options.requestToken({
          callerServiceId,
          scopes,
          ...(subject ? { subject } : {}),
          targetServiceId,
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        });
        const validatedAt = options.now?.() ?? new Date();
        cached = { ...validateRequestedCapabilityToken(issued, validatedAt), cacheKey };
        await writeCapabilityTokenCache(options.cache, cacheKey, cached, validatedAt);
        return cached.token;
      })();
      inFlight.set(cacheKey, request);

      try {
        return await request;
      } finally {
        if (inFlight.get(cacheKey) === request) inFlight.delete(cacheKey);
      }
    },
  };
}

async function capabilityProviderCacheKey(options: {
  abilityId: string | undefined;
  cacheKey: string | undefined;
  callerServiceId: string;
  requester: CapabilityTokenRequester;
  scopes: string[];
  senderConstrained: boolean;
  subject: CapabilitySubject | undefined;
  targetServiceId: string;
  ttlSeconds: number | undefined;
}): Promise<string> {
  const senderConstraint = options.requester.cacheBinding
    ? normalizeValue(await options.requester.cacheBinding(), 'capability token cache binding')
    : undefined;
  const bindingSuffix = senderConstraint ? `:cnf:${encodeURIComponent(senderConstraint)}` : options.senderConstrained ? ':cnf' : '';
  if (options.cacheKey) {
    return options.subject
      ? `${options.cacheKey}${bindingSuffix}:subject:${encodeURIComponent(JSON.stringify(capabilitySubjectCacheIdentity(options.subject)))}`
      : `${options.cacheKey}${bindingSuffix}`;
  }
  return capabilityTokenCacheKey({
    ...(options.abilityId ? { abilityId: normalizeValue(options.abilityId, 'ability id') } : {}),
    callerServiceId: options.callerServiceId,
    scopes: options.scopes,
    ...(senderConstraint ? { senderConstraint } : {}),
    ...(options.senderConstrained ? { senderConstrained: true } : {}),
    ...(options.subject ? { subject: options.subject } : {}),
    targetServiceId: options.targetServiceId,
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  });
}

export function capabilityTokenCacheKey(input: {
  abilityId?: string;
  callerServiceId: string;
  scopes: string[];
  senderConstraint?: string;
  senderConstrained?: boolean;
  subject?: CapabilitySubject;
  targetServiceId: string;
  ttlSeconds?: number;
}): string {
  const parts = {
    abilityId: input.abilityId ?? null,
    callerServiceId: input.callerServiceId,
    scopes: [...input.scopes].sort(),
    // Partitions proof-capable entries from unbound ones. A shared cache can hold an unbound token for
    // the same caller, target, and scopes — minted through HMAC, or before binding existed — and reusing
    // it would skip the proof and hand the service a bearer token, silently losing the binding.
    ...(input.senderConstrained ? { senderConstrained: true } : {}),
    ...(input.senderConstraint ? { senderConstraint: input.senderConstraint } : {}),
    // Included conditionally so subject-less keys stay byte-identical with earlier releases; tokens
    // delegated to a subject must never be shared across subjects through the token cache.
    ...(input.subject ? { subject: capabilitySubjectCacheIdentity(input.subject) } : {}),
    targetServiceId: input.targetServiceId,
    ttlSeconds: input.ttlSeconds ?? null,
  };
  return `service-plane:capability-token:${encodeURIComponent(JSON.stringify(parts))}`;
}

function capabilitySubjectCacheIdentity(subject: CapabilitySubject): { id: string; kind?: string; orgId: string | null } {
  return { id: subject.id, ...(subject.kind ? { kind: subject.kind } : {}), orgId: subject.orgId ?? null };
}

export function controlPlaneHmacTokenRequester(
  options: ControlPlaneHmacTokenRequesterOptions,
): CreateCapabilityTokenProviderOptions['requestToken'] {
  const fetcher = options.fetch ?? fetch;
  const tokenUrl = new URL(options.tokenPath ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH, options.controlPlaneUrl);
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const clientIdHeaderName = options.clientIdHeaderName ?? SERVICE_PLANE_HMAC_CLIENT_HEADER;
  const timestampHeaderName = options.timestampHeaderName ?? SERVICE_PLANE_HMAC_TIMESTAMP_HEADER;
  const maxResponseBytes = validateBodyByteLimit(
    options.maxResponseBytes ?? DEFAULT_CAPABILITY_TOKEN_RESPONSE_MAX_BYTES,
    'Service-Plane capability token maxResponseBytes must be a positive safe integer',
  );

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
    return parseIssuedCapabilityToken(
      await readBoundedResponseJson(response, maxResponseBytes, {
        invalidJsonMessage: 'Invalid Service-Plane capability token response',
        tooLargeMessage: 'Service-Plane capability token response is too large',
      }),
    );
  };
}

export type JwkCapabilityProofSignerOptions = {
  now?: () => Date;
  privateJwk: JsonWebKey | (() => Promise<JsonWebKey> | JsonWebKey);
  ttlSeconds?: number;
};

/**
 * Signs proofs with the same private key the caller authenticates to the control plane with, so a
 * sender-constrained token can be used without registering or distributing anything further.
 */
export function jwkCapabilityProofSigner(options: JwkCapabilityProofSignerOptions): CapabilityProofSigner {
  return async (input) => {
    const privateJwk = await resolvePrivateJwk(options.privateJwk);
    // A rotating key resolver can outrun the token cache: the provider may still hold a token bound to
    // the previous key, and signing that with the new one produces a proof the service rejects. Catch
    // it here, where the cause is visible, instead of shipping a proof that fails remotely as a 401.
    await assertProofKeyMatchesToken(privateJwk, input.token);
    return signCapabilityProof({
      abilityId: input.abilityId,
      ...(options.now ? { now: options.now() } : {}),
      privateJwk,
      targetServiceId: input.targetServiceId,
      token: input.token,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    });
  };
}

async function assertProofKeyMatchesToken(privateJwk: JsonWebKey, token: string): Promise<void> {
  const bound = decodeCapabilityTokenPayload(token).cnf?.jkt;
  if (!bound) return;
  const thumbprint = await servicePlaneJwkThumbprint(publicJwkFromPrivateJwk(privateJwk, 'service-plane-pop'));
  if (thumbprint !== bound) {
    throw new CapabilityAuthError(
      'Service-Plane proof of possession key does not match the capability token it accompanies; the token was issued for a different key (a rotated signing key outrunning a cached token is the usual cause)',
      401,
    );
  }
}

export function controlPlaneJwkTokenRequester(options: ControlPlaneJwkTokenRequesterOptions): CapabilityTokenRequester {
  const fetcher = options.fetch ?? fetch;
  const tokenUrl = new URL(options.tokenPath ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH, options.controlPlaneUrl);
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const clientIdHeaderName = options.clientIdHeaderName ?? SERVICE_PLANE_JWK_CLIENT_HEADER;
  const keyIdHeaderName = options.keyIdHeaderName ?? SERVICE_PLANE_JWK_KEY_ID_HEADER;
  const maxResponseBytes = validateBodyByteLimit(
    options.maxResponseBytes ?? DEFAULT_CAPABILITY_TOKEN_RESPONSE_MAX_BYTES,
    'Service-Plane capability token maxResponseBytes must be a positive safe integer',
  );

  const requestToken: CapabilityTokenRequester = async (input) => {
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
    return parseIssuedCapabilityToken(
      await readBoundedResponseJson(response, maxResponseBytes, {
        invalidJsonMessage: 'Invalid Service-Plane capability token response',
        tooLargeMessage: 'Service-Plane capability token response is too large',
      }),
    );
  };

  // The same key authenticates the token request and proves possession of the token it returns, so a
  // client using this requester satisfies sender-constrained calls without further configuration.
  requestToken.proveTokenPossession = jwkCapabilityProofSigner({
    privateJwk: options.privateJwk,
    ...(options.now ? { now: options.now } : {}),
  });
  requestToken.cacheBinding = senderConstraintCacheBinding(options.privateJwk);
  return requestToken;
}

function senderConstraintCacheBinding(privateJwk: ControlPlaneJwkTokenRequesterOptions['privateJwk']): () => Promise<string> {
  let memo: { fingerprint: string; thumbprint: Promise<string> } | undefined;
  return async () => {
    const publicJwk = publicJwkFromPrivateJwk(await resolvePrivateJwk(privateJwk), 'service-plane-pop');
    // Cache by a copied public-key fingerprint rather than object identity so stable resolvers avoid
    // a digest per token-cache hit while in-place rotations still invalidate immediately.
    const fingerprint = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
    if (memo?.fingerprint === fingerprint) return memo.thumbprint;
    const thumbprint = servicePlaneJwkThumbprint(publicJwk);
    memo = { fingerprint, thumbprint };
    thumbprint.catch(() => {
      if (memo?.thumbprint === thumbprint) memo = undefined;
    });
    return thumbprint;
  };
}

export function controlPlaneRpcTokenRequester(
  options: ControlPlaneRpcTokenRequesterOptions,
): CreateCapabilityTokenProviderOptions['requestToken'] {
  return async (input) => {
    rejectRequesterSubject(input);
    const issued = parseIssuedCapabilityToken(
      await options.binding.issueCapabilityToken({
        scopes: input.scopes,
        targetServiceId: input.targetServiceId,
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      }),
    );
    const claims = decodeCapabilityTokenPayload(issued.token);
    if (claims.act || claims.spa !== 'service' || claims.sub !== input.callerServiceId) {
      throw new CapabilityAuthError('Service-Plane RPC token binding returned a token not bound to its pinned service caller', 500);
    }
    return issued;
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

function normalizeRefreshSkewSeconds(refreshSkewSeconds: number): number {
  if (!Number.isSafeInteger(refreshSkewSeconds) || refreshSkewSeconds < 0) {
    throw new CapabilityAuthError('Service-Plane capability token refresh skew must be a non-negative integer', 500);
  }
  return refreshSkewSeconds;
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
  const maxResponseBytes = validateBodyByteLimit(
    options.maxResponseBytes ?? DEFAULT_CAPABILITY_JWKS_RESPONSE_MAX_BYTES,
    'Service-Plane JWKS maxResponseBytes must be a positive safe integer',
  );
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
      const jwks = parseRemoteJwks(
        await readBoundedResponseJson(response, maxResponseBytes, {
          invalidJsonMessage: 'Invalid Service-Plane JWKS response',
          tooLargeMessage: 'Service-Plane JWKS response is too large',
        }),
      );
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
  const expiresAt = issued.expiresAt instanceof Date ? new Date(issued.expiresAt.getTime()) : new Date(issued.expiresAt);
  const token = issued.token.trim();
  if (!token || !Number.isFinite(expiresAt.getTime())) {
    throw new CapabilityAuthError('Invalid Service-Plane capability token response', 500);
  }
  return {
    expiresAt,
    token,
  };
}

function validateRequestedCapabilityToken(value: unknown, now: Date): IssuedCapabilityToken {
  const issued = parseIssuedCapabilityToken(value);
  const jwtExpiresAt = decodedCapabilityTokenExpiration(issued.token);
  const expiresAt = jwtExpiresAt && jwtExpiresAt < issued.expiresAt ? jwtExpiresAt : issued.expiresAt;
  if (expiresAt.getTime() <= now.getTime()) {
    throw new CapabilityAuthError('Service-Plane capability token response is already expired', 500);
  }
  return { expiresAt, token: issued.token };
}

// A custom requester may use an opaque token, so JWT decoding is deliberately best effort. When it
// does return a Service Plane JWT, its signed expiry is the authoritative upper bound for caching.
function decodedCapabilityTokenExpiration(token: string): Date | undefined {
  try {
    const expiresAt = tokenExpiresAt(token);
    return Number.isFinite(expiresAt.getTime()) ? expiresAt : undefined;
  } catch {
    return undefined;
  }
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
