import type { Context, Env } from 'hono';
import { bytesToBase64Url } from '../shared/encoding.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { isRecord } from '../shared/guards.js';
import {
  extractServicePlaneHmacSignature,
  SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_HMAC_CLIENT_HEADER,
  SERVICE_PLANE_HMAC_TIMESTAMP_HEADER,
  servicePlaneHmacRequestParts,
  servicePlaneHmacSignature,
  timingSafeEqual,
} from '../shared/hmac-auth.js';
import { requestIdFromContext } from '../shared/hono-context.js';
import {
  decodeServicePlaneJwkAssertion,
  extractServicePlaneJwkAssertion,
  randomServicePlaneJwkId,
  SERVICE_PLANE_JWK_ALGORITHM,
  SERVICE_PLANE_JWK_ASSERTION_AUDIENCE,
  SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_JWK_CLIENT_HEADER,
  SERVICE_PLANE_JWK_KEY_ID_HEADER,
  type ServicePlaneJwkAssertionClaims,
  servicePlaneJwkRequestParts,
  servicePlaneJwkSigner,
  servicePlaneJwkThumbprint,
  verifyServicePlaneJwkSignature,
} from '../shared/jwk-auth.js';
import { defaultServicePlaneLogSink, emitBestEffortServicePlaneLog } from '../shared/logging.js';
import {
  type CapabilityJwks,
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  type RegistryCache,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceCallerAuthDiscovery,
  type ServiceEndpoint,
} from '../shared/types.js';
import type { CallerAuthResult } from './capabilities.js';
import { serviceEndpointDiscoverySource } from './endpoints.js';
import { createServiceRegistry } from './registry.js';

const HMAC_CLIENT_SECRET_BYTES = 32;
const DEFAULT_HMAC_MAX_SKEW_SECONDS = 60;
const DEFAULT_HMAC_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_JWK_MAX_SKEW_SECONDS = 60;
const DEFAULT_JWK_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_JWK_MAX_ASSERTION_TTL_SECONDS = 300;
const JWK_DISCOVERY_MAX_ENTRIES = 128;
const JWK_DISCOVERY_TIMEOUT_MS = 10_000;
const JWK_DISCOVERY_RETRY_MS = 1_000;
// ES256 signatures contain 64 bytes, encoded without base64url padding.
const JWK_ASSERTION_SIGNATURE_LENGTH = 86;

export type HmacServiceClient = {
  clientId: string;
  secret: string;
  serviceId?: string;
};

export type HmacServiceClientAuthLogEvent = {
  event: 'service_plane.caller_auth.hmac_unauthorized';
  level: 'warn';
  message: string;
  path: string;
  reason:
    | 'client_not_found'
    | 'invalid_signature'
    | 'invalid_timestamp'
    | 'missing_client'
    | 'missing_signature'
    | 'missing_timestamp'
    | 'timestamp_skew';
  requestId?: string;
};

export type HmacServiceClientAuthOptions<TEnv extends Env = Env> = {
  clientIdHeader?: string;
  clients: HmacServiceClient[] | ((context: Context<TEnv>) => Promise<HmacServiceClient[]> | HmacServiceClient[]);
  log?: (event: HmacServiceClientAuthLogEvent) => void;
  maxBodyBytes?: number;
  maxSkewSeconds?: number;
  now?: () => Date;
  requestIdHeader?: string;
  timestampHeader?: string;
};

export type JwkServiceClient = {
  clientId: string;
  jwks: CapabilityJwks | (() => Promise<CapabilityJwks> | CapabilityJwks);
  serviceId?: string;
};

export type JwkServiceClientAuthLogEvent = {
  event: 'service_plane.caller_auth.jwk_unauthorized';
  level: 'warn';
  message: string;
  path: string;
  reason:
    | 'client_not_found'
    | 'invalid_assertion'
    | 'invalid_claims'
    | 'invalid_timestamp'
    | 'missing_client'
    | 'missing_key'
    | 'missing_signature'
    | 'timestamp_skew';
  requestId?: string;
};

export type JwkServiceClientAuthOptions<TEnv extends Env = Env> = {
  assertionAudience?: string | ((context: Context<TEnv>) => Promise<string> | string);
  clientIdHeader?: string;
  clients?: JwkServiceClient[] | ((context: Context<TEnv>) => Promise<JwkServiceClient[]> | JwkServiceClient[]);
  keyIdHeader?: string;
  log?: (event: JwkServiceClientAuthLogEvent) => void;
  maxAssertionTtlSeconds?: number;
  maxBodyBytes?: number;
  maxSkewSeconds?: number;
  now?: () => Date;
  registryCache?: RegistryCache;
  registryCacheKey?: string;
  registryCacheTtlSeconds?: number;
  requestIdHeader?: string;
  services?: ServiceEndpoint[] | ((context: Context<TEnv>) => Promise<ServiceEndpoint[]> | ServiceEndpoint[]);
};

/**
 * Generates the caller-side HMAC secret for authenticating to the control-plane token endpoint.
 */
export function generateHmacClientSecret(): string {
  const bytes = new Uint8Array(HMAC_CLIENT_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * Authenticates token requests with an HMAC signature bound to method, path, body, timestamp, client id, and request id.
 */
export function hmacServiceClientAuth<TEnv extends Env = Env>(options: HmacServiceClientAuthOptions<TEnv>) {
  const clientIdHeader = options.clientIdHeader ?? SERVICE_PLANE_HMAC_CLIENT_HEADER;
  const timestampHeader = options.timestampHeader ?? SERVICE_PLANE_HMAC_TIMESTAMP_HEADER;
  const requestIdHeader = options.requestIdHeader ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const maxSkewSeconds = normalizePositiveAuthLimit(options.maxSkewSeconds ?? DEFAULT_HMAC_MAX_SKEW_SECONDS, 'HMAC max clock skew');
  const maxBodyBytes = normalizePositiveAuthLimit(options.maxBodyBytes ?? DEFAULT_HMAC_MAX_BODY_BYTES, 'HMAC max body size');
  const log = options.log ?? defaultServicePlaneLogSink;

  return async (context: Context<TEnv>): Promise<Response | string> => {
    const now = options.now?.() ?? new Date();
    const refuse = (reason: HmacServiceClientAuthLogEvent['reason'], message: string): Response => {
      emitBestEffortServicePlaneLog(
        log,
        callerAuthUnauthorizedEvent(context, 'service_plane.caller_auth.hmac_unauthorized', reason, message),
      );
      return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
    };
    try {
      const clientId = context.req.header(clientIdHeader)?.trim();
      if (!clientId) return refuse('missing_client', 'Missing Service-Plane HMAC client id');

      const timestamp = context.req.header(timestampHeader)?.trim();
      if (!timestamp) return refuse('missing_timestamp', 'Missing Service-Plane HMAC timestamp');

      const timestampError = validateHmacTimestamp(timestamp, now, maxSkewSeconds);
      if (timestampError) return refuse(timestampError, hmacTimestampMessage(timestampError));

      let signature: string;
      try {
        signature = extractServicePlaneHmacSignature(context.req.raw);
      } catch (error) {
        if (error instanceof CapabilityAuthError) return refuse('missing_signature', error.message);
        throw error;
      }

      const clients = typeof options.clients === 'function' ? await options.clients(context) : options.clients;
      const client = clients.find((candidate) => timingSafeEqual(candidate.clientId, clientId));
      if (!client) return refuse('client_not_found', 'Unknown Service-Plane HMAC client');

      const expected = await servicePlaneHmacSignature(
        client.secret,
        await servicePlaneHmacRequestParts(context.req.raw, clientId, timestamp, requestIdHeader, maxBodyBytes),
      );
      if (!timingSafeEqual(signature, expected)) return refuse('invalid_signature', 'Invalid Service-Plane HMAC signature');
      return client.serviceId ?? client.clientId;
    } catch (error) {
      if (error instanceof CapabilityAuthError) return refuse('invalid_signature', error.message);
      throw error;
    }
  };
}

/**
 * Authenticates token requests with a short-lived asymmetric JWT assertion. Signature
 * verification uses Hono's verifyWithJwks helper directly because its JWK middleware only
 * accepts the Bearer scheme, while these request-bound assertions have their own scheme.
 */
export function jwkServiceClientAuth<TEnv extends Env = Env>(options: JwkServiceClientAuthOptions<TEnv>) {
  const clientIdHeader = options.clientIdHeader ?? SERVICE_PLANE_JWK_CLIENT_HEADER;
  const keyIdHeader = options.keyIdHeader ?? SERVICE_PLANE_JWK_KEY_ID_HEADER;
  const requestIdHeader = options.requestIdHeader ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const maxSkewSeconds = normalizePositiveAuthLimit(options.maxSkewSeconds ?? DEFAULT_JWK_MAX_SKEW_SECONDS, 'JWK max clock skew');
  const maxBodyBytes = normalizePositiveAuthLimit(options.maxBodyBytes ?? DEFAULT_JWK_MAX_BODY_BYTES, 'JWK max body size');
  const maxAssertionTtlSeconds = normalizePositiveAuthLimit(
    options.maxAssertionTtlSeconds ?? DEFAULT_JWK_MAX_ASSERTION_TTL_SECONDS,
    'JWK max assertion TTL',
  );
  const discovery = new JwkCallerDiscovery(options);
  const log = options.log ?? defaultServicePlaneLogSink;

  return async (context: Context<TEnv>): Promise<Response | CallerAuthResult> => {
    const refuse = (reason: JwkServiceClientAuthLogEvent['reason'], message: string): Response => {
      emitBestEffortServicePlaneLog(
        log,
        callerAuthUnauthorizedEvent(context, 'service_plane.caller_auth.jwk_unauthorized', reason, message),
      );
      return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
    };
    const clientId = context.req.header(clientIdHeader)?.trim();
    if (!clientId) return refuse('missing_client', 'Missing Service-Plane JWK client id');

    let assertion: string;
    try {
      assertion = extractServicePlaneJwkAssertion(context.req.raw);
    } catch (error) {
      if (error instanceof CapabilityAuthError) return refuse('missing_signature', error.message);
      throw error;
    }

    const keyId = context.req.header(keyIdHeader)?.trim();
    if (!keyId) return refuse('missing_key', 'Missing Service-Plane JWK key id');

    let decoded: ReturnType<typeof decodeServicePlaneJwkAssertion>;
    let headerKeyId: string;
    try {
      // Only reject impossible assertions here; unverified claims never authenticate a caller.
      const parts = assertion.split('.');
      if (
        parts.length !== 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part) || part.length % 4 === 1) ||
        parts[2]?.length !== JWK_ASSERTION_SIGNATURE_LENGTH
      ) {
        return refuse('invalid_assertion', 'Invalid Service-Plane JWK assertion encoding');
      }
      decoded = decodeServicePlaneJwkAssertion(assertion);
      headerKeyId = validateJwkAssertionHeader(decoded.header, keyId);
    } catch {
      return refuse('invalid_assertion', 'Invalid Service-Plane JWK assertion');
    }

    const client = await resolveJwkServiceClient(context, options, clientId, discovery);
    if (!client) return refuse('client_not_found', 'Unknown Service-Plane JWK client');

    const jwks = typeof client.jwks === 'function' ? await client.jwks() : client.jwks;
    if (jwks.keys.length === 0) return refuse('missing_key', 'Service-Plane JWK client has no verification keys');

    try {
      await verifyServicePlaneJwkSignature(assertion, jwks);

      const claims = parseJwkAssertionClaims(decoded.payload);
      const audience = await resolveJwkAssertionAudience(context, options);
      const now = options.now?.() ?? new Date();
      await validateJwkAssertionClaims(context, claims, {
        audience,
        clientId,
        headerKeyId,
        keyId,
        maxAssertionTtlSeconds,
        maxBodyBytes,
        maxSkewSeconds,
        now,
        requestIdHeader,
      });
      // Report the key that actually authenticated, so issuance sender-constrains the token to it. Not
      // optional: reaching here means the caller signed with a private key, so it can always prove
      // possession, and leaving the token usable by anyone holding the bytes would be the weaker default.
      // `verifyWithJwks` pins the signer by `kid`, so selecting on the validated key id names the
      // signer rather than a key the caller merely claimed to use.
      return {
        confirmation: { jkt: await servicePlaneJwkThumbprint(servicePlaneJwkSigner(jwks, headerKeyId)) },
        serviceId: client.serviceId ?? client.clientId,
      };
    } catch (error) {
      if (error instanceof CapabilityAuthError) return refuse('invalid_claims', error.message);
      return refuse('invalid_assertion', 'Invalid Service-Plane JWK assertion');
    }
  };
}

function callerAuthUnauthorized<TEnv extends Env>(context: Context<TEnv>, scheme: string): Response {
  context.header('www-authenticate', scheme);
  return context.json({ error: 'Unauthorized' }, 401);
}

function callerAuthUnauthorizedEvent<TEvent extends string, TReason extends string>(
  context: Context,
  event: TEvent,
  reason: TReason,
  message: string,
): { event: TEvent; level: 'warn'; message: string; path: string; reason: TReason; requestId?: string } {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER);
  return {
    event,
    level: 'warn',
    message,
    path: new URL(context.req.url).pathname,
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

function validateHmacTimestamp(timestamp: string, now: Date, maxSkewSeconds: number): 'invalid_timestamp' | 'timestamp_skew' | undefined {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'invalid_timestamp';
  const skewMs = Math.abs(now.getTime() - parsed.getTime());
  if (skewMs > maxSkewSeconds * 1000) return 'timestamp_skew';
  return undefined;
}

function normalizePositiveAuthLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CapabilityAuthError(`Service-Plane ${name} must be a positive safe integer`, 500);
  }
  return value;
}

function hmacTimestampMessage(reason: 'invalid_timestamp' | 'timestamp_skew'): string {
  return reason === 'invalid_timestamp'
    ? 'Invalid Service-Plane HMAC timestamp'
    : 'Service-Plane HMAC timestamp is outside the allowed skew';
}

async function resolveJwkServiceClient<TEnv extends Env>(
  context: Context<TEnv>,
  options: JwkServiceClientAuthOptions<TEnv>,
  clientId: string,
  discovery: JwkCallerDiscovery,
): Promise<JwkServiceClient | undefined> {
  const clients = typeof options.clients === 'function' ? await options.clients(context) : (options.clients ?? []);
  const configured = clients.find((candidate) => timingSafeEqual(candidate.clientId, clientId));
  if (configured) return configured;

  if (!options.services) return undefined;
  const services = typeof options.services === 'function' ? await options.services(context) : options.services;
  const endpoint = services.find((candidate) => candidate.id === clientId);
  return endpoint ? discovery.resolve(endpoint) : undefined;
}

type JwkDiscoveryEntry = { expiresAt: number; pending: Promise<JwkServiceClient | undefined> };

// Cache only selected caller keys. Instance and source identities prevent unrelated bindings from
// sharing verification trust, including when applications supply the same external cache key.
class JwkCallerDiscovery {
  private readonly entries = new Map<string, JwkDiscoveryEntry>();
  private readonly sources = new WeakMap<object, number>();
  private namespace: string | undefined;
  private nextSourceId = 0;
  private readonly ttlSeconds: number;

  // Hono-dependent service and client resolvers remain request-owned.
  constructor(
    private readonly options: Pick<JwkServiceClientAuthOptions, 'registryCache' | 'registryCacheKey' | 'registryCacheTtlSeconds'>,
  ) {
    this.ttlSeconds = options.registryCacheTtlSeconds ?? DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
  }

  // Store the pending promise before yielding, so misses coalesce without an external registry cache.
  resolve(endpoint: ServiceEndpoint): Promise<JwkServiceClient | undefined> {
    const key = this.cacheKey(endpoint);
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.pending;
    }
    this.entries.delete(key);
    if (this.entries.size >= JWK_DISCOVERY_MAX_ENTRIES) {
      // Never evict running fills: saturation must not disable the coalescing bound.
      const oldest = [...this.entries].find(([, entry]) => entry.expiresAt !== Number.POSITIVE_INFINITY)?.[0];
      if (oldest === undefined) return Promise.resolve(undefined);
      this.entries.delete(oldest);
    }
    const entry: JwkDiscoveryEntry = {
      expiresAt: Number.POSITIVE_INFINITY,
      pending: this.discover(endpoint, key).then((client) => {
        entry.expiresAt = Date.now() + (client ? this.ttlSeconds * 1_000 : JWK_DISCOVERY_RETRY_MS);
        return client;
      }),
    };
    this.entries.set(key, entry);
    return entry.pending;
  }

  // Replacing a fetch binding or inline document changes the verification-key authority.
  private cacheKey(endpoint: ServiceEndpoint): string {
    // Workers permit randomness during requests, not module-scope configuration.
    this.namespace ??= randomServicePlaneJwkId();
    const source = serviceEndpointDiscoverySource(endpoint);
    let sourceId = this.sources.get(source);
    if (sourceId === undefined) {
      sourceId = ++this.nextSourceId;
      this.sources.set(source, sourceId);
    }
    return JSON.stringify([
      'service-plane:caller-jwk:v1',
      this.namespace,
      this.options.registryCacheKey,
      endpoint.id,
      endpoint.origin,
      sourceId,
    ]);
  }

  // Bound the whole fill, including cache access and discovery response bodies. A timed-out source
  // cannot publish a late cache entry; its failed result is retried after a short local cooldown.
  private async discover(endpoint: ServiceEndpoint, cacheKey: string): Promise<JwkServiceClient | undefined> {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const backing = this.options.registryCache;
    const cache: RegistryCache | undefined = backing
      ? {
          get: (key) => backing.get(key),
          ...(backing.getStale ? { getStale: (key: string) => backing.getStale?.(key) ?? Promise.resolve(undefined) } : {}),
          set: (key, snapshot, ttl) => (active ? backing.set(key, snapshot, ttl) : Promise.resolve()),
        }
      : undefined;
    const registry = createServiceRegistry({
      ...(cache ? { cache } : {}),
      cacheKey,
      cacheTtlSeconds: this.ttlSeconds,
      services: [{ ...endpoint, fetch: (request) => fetchJwkDiscovery(endpoint, request, controller.signal) }],
    });
    try {
      const snapshot = await Promise.race([
        registry.discover(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            active = false;
            controller.abort();
            resolve(undefined);
          }, JWK_DISCOVERY_TIMEOUT_MS);
        }),
      ]);
      const service = snapshot?.services.find((candidate) => candidate.id === endpoint.id);
      if (!service?.callerAuth?.jwks) return undefined;
      return { clientId: service.id, jwks: { keys: service.callerAuth.jwks.keys.map(mutableJsonWebKey) }, serviceId: service.id };
    } catch {
      return undefined;
    } finally {
      active = false;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// Binding responses need explicit reader cancellation: neither their Request nor an intermediate
// pipe is guaranteed to interrupt a pending source read promptly in every supported runtime.
async function fetchJwkDiscovery(endpoint: ServiceEndpoint, request: Request, signal: AbortSignal): Promise<Response> {
  const response = await endpoint.fetch(new Request(request, { signal }));
  if (signal.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new CapabilityAuthError('Service-Plane JWK discovery timed out', 401);
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const release = () => {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  };
  const cancel = (reason: unknown) => {
    if (finished) return;
    finished = true;
    void reader.cancel(reason).catch(() => undefined);
    release();
  };
  const abort = () => {
    if (finished) return;
    output.error(signal.reason);
    cancel(signal.reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) return;
        if (!result.done) {
          controller.enqueue(result.value);
          return;
        }
        finished = true;
        release();
        controller.close();
      } catch (error) {
        if (finished) return;
        finished = true;
        release();
        controller.error(error);
      }
    },
    cancel,
  });
  return new Response(body, response);
}

function mutableJsonWebKey(key: ServiceCallerAuthDiscovery['jwks']['keys'][number]): JsonWebKey & { kid?: string } {
  return structuredClone(key) as JsonWebKey & { kid?: string };
}

async function resolveJwkAssertionAudience<TEnv extends Env>(
  context: Context<TEnv>,
  options: JwkServiceClientAuthOptions<TEnv>,
): Promise<string> {
  if (typeof options.assertionAudience === 'function') return options.assertionAudience(context);
  return options.assertionAudience ?? SERVICE_PLANE_JWK_ASSERTION_AUDIENCE;
}

function parseJwkAssertionClaims(value: unknown): ServicePlaneJwkAssertionClaims {
  if (!isRecord(value)) throw new CapabilityAuthError('Invalid Service-Plane JWK assertion claims', 401);
  const { aud, bodyHash, exp, iat, iss, jti, keyId, method, nbf, path, requestId, sub } = value;
  if (
    typeof aud !== 'string' ||
    typeof bodyHash !== 'string' ||
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    typeof iss !== 'string' ||
    typeof jti !== 'string' ||
    typeof keyId !== 'string' ||
    typeof method !== 'string' ||
    typeof nbf !== 'number' ||
    typeof path !== 'string' ||
    typeof sub !== 'string' ||
    (requestId !== undefined && typeof requestId !== 'string')
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK assertion claims', 401);
  }
  return { aud, bodyHash, exp, iat, iss, jti, keyId, method, nbf, path, ...(requestId ? { requestId } : {}), sub };
}

function validateJwkAssertionHeader(header: unknown, expectedKeyId: string): string {
  if (
    !isRecord(header) ||
    header.alg !== SERVICE_PLANE_JWK_ALGORITHM ||
    typeof header.kid !== 'string' ||
    (header.typ !== undefined && header.typ !== 'JWT')
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK assertion header', 401);
  }
  if (header.kid !== expectedKeyId) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK key id', 401);
  }
  return header.kid;
}

async function validateJwkAssertionClaims<TEnv extends Env>(
  context: Context<TEnv>,
  claims: ServicePlaneJwkAssertionClaims,
  options: {
    audience: string;
    clientId: string;
    headerKeyId: string;
    keyId: string;
    maxAssertionTtlSeconds: number;
    maxBodyBytes: number;
    maxSkewSeconds: number;
    now: Date;
    requestIdHeader: string;
  },
): Promise<void> {
  if (claims.iss !== options.clientId || claims.sub !== options.clientId) {
    throw new CapabilityAuthError('Service-Plane JWK caller mismatch', 401);
  }
  if (claims.aud !== options.audience) throw new CapabilityAuthError('Invalid Service-Plane JWK audience', 401);
  if (claims.keyId !== options.keyId || claims.keyId !== options.headerKeyId) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK key id', 401);
  }
  const requestId = context.req.header(options.requestIdHeader)?.trim() || undefined;
  if ((claims.requestId || undefined) !== requestId) throw new CapabilityAuthError('Invalid Service-Plane JWK request id', 401);

  validateJwkAssertionTimestamps(claims, options.now, options.maxSkewSeconds, options.maxAssertionTtlSeconds);

  const parts = await servicePlaneJwkRequestParts(
    context.req.raw,
    options.clientId,
    claims.keyId,
    options.requestIdHeader,
    options.maxBodyBytes,
  );
  if (
    claims.method !== parts.method ||
    claims.path !== parts.pathWithQuery ||
    claims.bodyHash !== parts.bodyHash ||
    claims.keyId !== parts.keyId
  ) {
    throw new CapabilityAuthError('Service-Plane JWK request binding mismatch', 401);
  }
}

function validateJwkAssertionTimestamps(
  claims: Pick<ServicePlaneJwkAssertionClaims, 'exp' | 'iat' | 'nbf'>,
  now: Date,
  maxSkewSeconds: number,
  maxAssertionTtlSeconds: number,
): void {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.nbf > nowSeconds + maxSkewSeconds) throw new CapabilityAuthError('Service-Plane JWK assertion is not active yet', 401);
  if (claims.iat > nowSeconds + maxSkewSeconds)
    throw new CapabilityAuthError('Service-Plane JWK assertion issued-at is in the future', 401);
  if (claims.exp <= nowSeconds - maxSkewSeconds) throw new CapabilityAuthError('Expired Service-Plane JWK assertion', 401);
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxAssertionTtlSeconds) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK assertion lifetime', 401);
  }
}
