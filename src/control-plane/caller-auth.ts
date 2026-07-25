import type { Context } from 'hono';
import { CapabilityAuthError } from '../shared/errors.js';
import {
  extractServicePlaneHmacSignature,
  SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_HMAC_CLIENT_HEADER,
  SERVICE_PLANE_HMAC_TIMESTAMP_HEADER,
  servicePlaneHmacRequestParts,
  servicePlaneHmacSignature,
  timingSafeEqual,
} from '../shared/hmac-auth.js';
import {
  decodeServicePlaneJwkAssertion,
  extractServicePlaneJwkAssertion,
  SERVICE_PLANE_JWK_ALGORITHM,
  SERVICE_PLANE_JWK_ASSERTION_AUDIENCE,
  SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_JWK_CLIENT_HEADER,
  SERVICE_PLANE_JWK_KEY_ID_HEADER,
  servicePlaneJwkRequestParts,
  servicePlaneJwkSigner,
  servicePlaneJwkThumbprint,
  verifyServicePlaneJwkSignature,
} from '../shared/jwk-auth.js';
import { type CapabilityJwks, type RegistryCache, SERVICE_PLANE_REQUEST_ID_HEADER, type ServiceEndpoint } from '../shared/types.js';
import type { CallerAuthResult } from './capabilities.js';
import { createServiceRegistry } from './registry.js';

const HMAC_CLIENT_SECRET_BYTES = 32;
const DEFAULT_HMAC_MAX_SKEW_SECONDS = 60;
const DEFAULT_HMAC_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_JWK_MAX_SKEW_SECONDS = 60;
const DEFAULT_JWK_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_JWK_MAX_ASSERTION_TTL_SECONDS = 300;

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

export type HmacServiceClientAuthOptions = {
  clientIdHeader?: string;
  clients: HmacServiceClient[] | ((context: Context) => Promise<HmacServiceClient[]> | HmacServiceClient[]);
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

export type JwkServiceClientAuthOptions = {
  assertionAudience?: string | ((context: Context) => Promise<string> | string);
  clientIdHeader?: string;
  clients?: JwkServiceClient[] | ((context: Context) => Promise<JwkServiceClient[]> | JwkServiceClient[]);
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
  // Binds issued tokens to the key that authenticated (RFC 7800 `cnf`), so the token cannot be used
  // by anyone else. Opt-in: a bound token is refused without a matching proof, so callers must also
  // pass `proveTokenPossession` when opening sessions. Turning it on without that breaks them.
  senderConstrained?: boolean;
  services?: ServiceEndpoint[] | ((context: Context) => Promise<ServiceEndpoint[]> | ServiceEndpoint[]);
};

// Generates the caller-side HMAC secret for authenticating to the control-plane token endpoint.
export function generateHmacClientSecret(): string {
  const bytes = new Uint8Array(HMAC_CLIENT_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

// Authenticates token requests with an HMAC signature bound to method, path, body, timestamp, client id, and request id.
export function hmacServiceClientAuth(options: HmacServiceClientAuthOptions) {
  const clientIdHeader = options.clientIdHeader ?? SERVICE_PLANE_HMAC_CLIENT_HEADER;
  const timestampHeader = options.timestampHeader ?? SERVICE_PLANE_HMAC_TIMESTAMP_HEADER;
  const requestIdHeader = options.requestIdHeader ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const maxSkewSeconds = normalizePositiveAuthLimit(options.maxSkewSeconds ?? DEFAULT_HMAC_MAX_SKEW_SECONDS, 'HMAC max clock skew');
  const maxBodyBytes = normalizePositiveAuthLimit(options.maxBodyBytes ?? DEFAULT_HMAC_MAX_BODY_BYTES, 'HMAC max body size');
  const log = options.log ?? defaultHmacCallerAuthLog;

  return async (context: Context): Promise<Response | string> => {
    const now = options.now?.() ?? new Date();
    try {
      const clientId = context.req.header(clientIdHeader)?.trim();
      if (!clientId) {
        log(hmacUnauthorizedEvent(context, 'missing_client', 'Missing Service-Plane HMAC client id'));
        return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
      }

      const timestamp = context.req.header(timestampHeader)?.trim();
      if (!timestamp) {
        log(hmacUnauthorizedEvent(context, 'missing_timestamp', 'Missing Service-Plane HMAC timestamp'));
        return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
      }

      const timestampError = validateHmacTimestamp(timestamp, now, maxSkewSeconds);
      if (timestampError) {
        log(hmacUnauthorizedEvent(context, timestampError, hmacTimestampMessage(timestampError)));
        return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
      }

      let signature: string;
      try {
        signature = extractServicePlaneHmacSignature(context.req.raw);
      } catch (error) {
        if (error instanceof CapabilityAuthError) {
          log(hmacUnauthorizedEvent(context, 'missing_signature', error.message));
          return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
        }
        throw error;
      }

      const clients = typeof options.clients === 'function' ? await options.clients(context) : options.clients;
      const client = clients.find((candidate) => timingSafeEqual(candidate.clientId, clientId));
      if (!client) {
        log(hmacUnauthorizedEvent(context, 'client_not_found', 'Unknown Service-Plane HMAC client'));
        return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
      }

      const expected = await servicePlaneHmacSignature(
        client.secret,
        await servicePlaneHmacRequestParts(context.req.raw, clientId, timestamp, requestIdHeader, maxBodyBytes),
      );
      if (!timingSafeEqual(signature, expected)) {
        log(hmacUnauthorizedEvent(context, 'invalid_signature', 'Invalid Service-Plane HMAC signature'));
        return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
      }
      return client.serviceId ?? client.clientId;
    } catch (error) {
      if (error instanceof CapabilityAuthError) {
        log(hmacUnauthorizedEvent(context, 'invalid_signature', error.message));
        return callerAuthUnauthorized(context, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
      }
      throw error;
    }
  };
}

// Authenticates token requests with a short-lived asymmetric JWT assertion. Signature
// verification uses Hono's verifyWithJwks helper directly because its JWK middleware only
// accepts the Bearer scheme, while these request-bound assertions have their own scheme.
export function jwkServiceClientAuth(options: JwkServiceClientAuthOptions) {
  const clientIdHeader = options.clientIdHeader ?? SERVICE_PLANE_JWK_CLIENT_HEADER;
  const keyIdHeader = options.keyIdHeader ?? SERVICE_PLANE_JWK_KEY_ID_HEADER;
  const requestIdHeader = options.requestIdHeader ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const maxSkewSeconds = normalizePositiveAuthLimit(options.maxSkewSeconds ?? DEFAULT_JWK_MAX_SKEW_SECONDS, 'JWK max clock skew');
  const maxBodyBytes = normalizePositiveAuthLimit(options.maxBodyBytes ?? DEFAULT_JWK_MAX_BODY_BYTES, 'JWK max body size');
  const maxAssertionTtlSeconds = normalizePositiveAuthLimit(
    options.maxAssertionTtlSeconds ?? DEFAULT_JWK_MAX_ASSERTION_TTL_SECONDS,
    'JWK max assertion TTL',
  );
  const log = options.log ?? defaultJwkCallerAuthLog;

  return async (context: Context): Promise<Response | CallerAuthResult> => {
    const clientId = context.req.header(clientIdHeader)?.trim();
    if (!clientId) {
      log(jwkUnauthorizedEvent(context, 'missing_client', 'Missing Service-Plane JWK client id'));
      return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
    }

    let assertion: string;
    try {
      assertion = extractServicePlaneJwkAssertion(context.req.raw);
    } catch (error) {
      if (error instanceof CapabilityAuthError) {
        log(jwkUnauthorizedEvent(context, 'missing_signature', error.message));
        return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
      }
      throw error;
    }

    const client = await resolveJwkServiceClient(context, options, clientId);
    if (!client) {
      log(jwkUnauthorizedEvent(context, 'client_not_found', 'Unknown Service-Plane JWK client'));
      return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
    }

    const jwks = await resolveJwkClientJwks(client);
    if (jwks.keys.length === 0) {
      log(jwkUnauthorizedEvent(context, 'missing_key', 'Service-Plane JWK client has no verification keys'));
      return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
    }

    try {
      await verifyServicePlaneJwkSignature(assertion, jwks);

      const { header, payload } = decodeServicePlaneJwkAssertion(assertion);
      const claims = parseJwkAssertionClaims(payload);
      const keyId = context.req.header(keyIdHeader)?.trim();
      if (!keyId) {
        log(jwkUnauthorizedEvent(context, 'missing_key', 'Missing Service-Plane JWK key id'));
        return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
      }
      const headerKeyId = validateJwkAssertionHeader(header, keyId);
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
      const serviceId = client.serviceId ?? client.clientId;
      if (!options.senderConstrained) return { serviceId };

      // Report the key that actually authenticated, so issuance can sender-constrain the token to it.
      // `verifyWithJwks` pins the signer by `kid`, so selecting on the validated key id names the
      // signer rather than a key the caller merely claimed to use.
      return {
        confirmation: { jkt: await servicePlaneJwkThumbprint(servicePlaneJwkSigner(jwks, headerKeyId)) },
        serviceId,
      };
    } catch (error) {
      if (error instanceof CapabilityAuthError) {
        log(jwkUnauthorizedEvent(context, 'invalid_claims', error.message));
        return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
      }
      log(jwkUnauthorizedEvent(context, 'invalid_assertion', 'Invalid Service-Plane JWK assertion'));
      return callerAuthUnauthorized(context, SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
    }
  };
}

function callerAuthUnauthorized(context: Context, scheme: string): Response {
  context.header('www-authenticate', scheme);
  return context.json({ error: 'Unauthorized' }, 401);
}

function hmacUnauthorizedEvent(
  context: Context,
  reason: HmacServiceClientAuthLogEvent['reason'],
  message: string,
): HmacServiceClientAuthLogEvent {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  return {
    event: 'service_plane.caller_auth.hmac_unauthorized',
    level: 'warn',
    message,
    path: new URL(context.req.url).pathname,
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

function defaultHmacCallerAuthLog(event: HmacServiceClientAuthLogEvent): void {
  console.warn(JSON.stringify(event));
}

function jwkUnauthorizedEvent(
  context: Context,
  reason: JwkServiceClientAuthLogEvent['reason'],
  message: string,
): JwkServiceClientAuthLogEvent {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  return {
    event: 'service_plane.caller_auth.jwk_unauthorized',
    level: 'warn',
    message,
    path: new URL(context.req.url).pathname,
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

function defaultJwkCallerAuthLog(event: JwkServiceClientAuthLogEvent): void {
  console.warn(JSON.stringify(event));
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

async function resolveJwkServiceClient(
  context: Context,
  options: JwkServiceClientAuthOptions,
  clientId: string,
): Promise<JwkServiceClient | undefined> {
  const clients = typeof options.clients === 'function' ? await options.clients(context) : (options.clients ?? []);
  const configured = clients.find((candidate) => timingSafeEqual(candidate.clientId, clientId));
  if (configured) return configured;

  if (!options.services) return undefined;
  const services = typeof options.services === 'function' ? await options.services(context) : options.services;
  const registry = createServiceRegistry({
    ...(options.registryCache
      ? {
          cache: options.registryCache,
          ...(options.registryCacheKey ? { cacheKey: options.registryCacheKey } : {}),
          ...(options.registryCacheTtlSeconds ? { cacheTtlSeconds: options.registryCacheTtlSeconds } : {}),
        }
      : {}),
    services,
  });
  const snapshot = await registry.discover();
  const service = snapshot.services.find((candidate) => timingSafeEqual(candidate.id, clientId));
  if (!service?.callerAuth?.jwks) return undefined;
  return {
    clientId: service.id,
    jwks: service.callerAuth.jwks,
    serviceId: service.id,
  };
}

async function resolveJwkClientJwks(client: JwkServiceClient): Promise<CapabilityJwks> {
  return typeof client.jwks === 'function' ? client.jwks() : client.jwks;
}

async function resolveJwkAssertionAudience(context: Context, options: JwkServiceClientAuthOptions): Promise<string> {
  if (typeof options.assertionAudience === 'function') return options.assertionAudience(context);
  return options.assertionAudience ?? SERVICE_PLANE_JWK_ASSERTION_AUDIENCE;
}

type ParsedJwkAssertionClaims = {
  aud: string;
  bodyHash: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  keyId: string;
  method: string;
  nbf: number;
  path: string;
  requestId?: string;
  sub: string;
};

function parseJwkAssertionClaims(value: unknown): ParsedJwkAssertionClaims {
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
  if (!isRecord(header) || header.alg !== SERVICE_PLANE_JWK_ALGORITHM || typeof header.kid !== 'string') {
    throw new CapabilityAuthError('Invalid Service-Plane JWK assertion header', 401);
  }
  if (header.kid !== expectedKeyId) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK key id', 401);
  }
  return header.kid;
}

async function validateJwkAssertionClaims(
  context: Context,
  claims: ParsedJwkAssertionClaims,
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
  claims: Pick<ParsedJwkAssertionClaims, 'exp' | 'iat' | 'nbf'>,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
