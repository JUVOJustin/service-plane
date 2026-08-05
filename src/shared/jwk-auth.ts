import { decode, sign, verifyWithJwks } from 'hono/jwt';
import { CapabilityAuthError } from './errors.js';
import { boundedRequestBodyBytes } from './request-body.js';
import { type CapabilityJwks, SERVICE_PLANE_REQUEST_ID_HEADER } from './types.js';

export const SERVICE_PLANE_JWK_ALGORITHM = 'ES256';
export const SERVICE_PLANE_JWK_ASSERTION_AUDIENCE = 'service-plane-control-plane';
export const SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME = 'ServicePlane-JWK';
export const SERVICE_PLANE_JWK_CLIENT_HEADER = 'X-Service-Plane-Client';
export const SERVICE_PLANE_JWK_KEY_ID_HEADER = 'X-Service-Plane-Key-Id';

const DEFAULT_JWK_ASSERTION_TTL_SECONDS = 60;
const MAX_JWK_ASSERTION_TTL_SECONDS = 300;

export type ServicePlaneJwkRequestParts = {
  bodyHash: string;
  clientId: string;
  keyId: string;
  method: string;
  pathWithQuery: string;
  requestId?: string;
};

export type ServicePlaneJwkAssertionClaims = {
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

export type SignServicePlaneJwkRequestOptions = {
  assertionTtlSeconds?: number;
  audience?: string;
  clientId: string;
  clientIdHeaderName?: string;
  keyId: string;
  keyIdHeaderName?: string;
  maxBodyBytes?: number;
  now?: Date;
  privateJwk: JsonWebKey;
  requestIdHeaderName?: string;
};

export type GenerateServicePlaneJwkSigningKeyOptions = {
  keyId?: string;
};

export async function generateServicePlaneJwkSigningKey(options: GenerateServicePlaneJwkSigningKeyOptions = {}): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return servicePlaneJwkSigningKey(privateJwk, options.keyId);
}

export async function signServicePlaneJwkRequest(request: Request, options: SignServicePlaneJwkRequestOptions): Promise<Request> {
  const headers = new Headers(request.headers);
  const clientIdHeaderName = options.clientIdHeaderName ?? SERVICE_PLANE_JWK_CLIENT_HEADER;
  const keyIdHeaderName = options.keyIdHeaderName ?? SERVICE_PLANE_JWK_KEY_ID_HEADER;
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;

  headers.set(clientIdHeaderName, options.clientId);
  headers.set(keyIdHeaderName, options.keyId);

  const signed = new Request(request, { headers });
  const assertion = await servicePlaneJwkAssertion({
    audience: options.audience ?? SERVICE_PLANE_JWK_ASSERTION_AUDIENCE,
    parts: await servicePlaneJwkRequestParts(signed, options.clientId, options.keyId, requestIdHeaderName, options.maxBodyBytes),
    privateJwk: options.privateJwk,
    ...(options.now ? { now: options.now } : {}),
    ...(options.assertionTtlSeconds === undefined ? {} : { ttlSeconds: options.assertionTtlSeconds }),
  });
  headers.set('authorization', servicePlaneJwkAuthorization(assertion));
  return new Request(signed, { headers });
}

export async function servicePlaneJwkRequestParts(
  request: Request,
  clientId: string,
  keyId: string,
  requestIdHeaderName = SERVICE_PLANE_REQUEST_ID_HEADER,
  maxBodyBytes?: number,
): Promise<ServicePlaneJwkRequestParts> {
  const url = new URL(request.url);
  const requestId = request.headers.get(requestIdHeaderName)?.trim() || undefined;
  return {
    bodyHash: await sha256Base64Url(await requestBodyBytes(request, maxBodyBytes)),
    clientId,
    keyId,
    method: request.method.toUpperCase(),
    pathWithQuery: `${url.pathname}${url.search}`,
    ...(requestId ? { requestId } : {}),
  };
}

export async function servicePlaneJwkAssertion(options: {
  audience: string;
  now?: Date;
  parts: ServicePlaneJwkRequestParts;
  privateJwk: JsonWebKey;
  ttlSeconds?: number;
}): Promise<string> {
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = normalizeAssertionTtlSeconds(options.ttlSeconds ?? DEFAULT_JWK_ASSERTION_TTL_SECONDS);
  const claims: ServicePlaneJwkAssertionClaims = {
    aud: normalizeClaimString(options.audience, 'JWK assertion audience'),
    bodyHash: options.parts.bodyHash,
    exp: issuedAt + ttlSeconds,
    iat: issuedAt,
    iss: options.parts.clientId,
    jti: randomServicePlaneJwkId(),
    keyId: options.parts.keyId,
    method: options.parts.method,
    nbf: issuedAt,
    path: options.parts.pathWithQuery,
    ...(options.parts.requestId ? { requestId: options.parts.requestId } : {}),
    sub: options.parts.clientId,
  };
  return sign(claims, servicePlaneJwkSigningKey(options.privateJwk, options.parts.keyId), SERVICE_PLANE_JWK_ALGORITHM);
}

export function servicePlaneJwkAuthorization(assertion: string): string {
  return `${SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME} ${assertion}`;
}

export function extractServicePlaneJwkAssertion(request: Request): string {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) throw new CapabilityAuthError('Missing Service-Plane JWK authorization', 401);
  const parts = authorization.split(/\s+/u);
  const [scheme, assertion] = parts;
  if (parts.length !== 2 || scheme?.toLowerCase() !== SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME.toLowerCase() || !assertion) {
    throw new CapabilityAuthError('Invalid Service-Plane JWK authorization scheme', 401);
  }
  return assertion;
}

export function decodeServicePlaneJwkAssertion(assertion: string): { header: unknown; payload: unknown } {
  return decodeServicePlaneJwkToken(assertion, 'Invalid Service-Plane JWK assertion encoding', 401);
}

export function decodeServicePlaneJwkToken(token: string, errorMessage: string, status = 401): { header: unknown; payload: unknown } {
  try {
    return decode(token);
  } catch {
    throw new CapabilityAuthError(errorMessage, status);
  }
}

export function publicJwkFromPrivateJwk(privateJwk: JsonWebKey, keyId: string): JsonWebKey & { kid?: string } {
  const { d: _d, dp: _dp, dq: _dq, k: _k, oth: _oth, p: _p, q: _q, qi: _qi, ...publicJwk } = privateJwk;
  return {
    ...publicJwk,
    alg: SERVICE_PLANE_JWK_ALGORITHM,
    kid: keyId,
    key_ops: ['verify'],
    use: 'sig',
  };
}

export function servicePlaneJwkSigningKey(privateJwk: JsonWebKey, keyId?: string): JsonWebKey {
  return {
    ...privateJwk,
    alg: SERVICE_PLANE_JWK_ALGORITHM,
    ...(keyId ? { kid: keyId } : {}),
    key_ops: ['sign'],
    use: 'sig',
  };
}

export async function verifyServicePlaneJwkSignature(token: string, jwks: CapabilityJwks): Promise<unknown> {
  return verifyWithJwks(token, {
    allowedAlgorithms: [SERVICE_PLANE_JWK_ALGORITHM],
    keys: jwks.keys,
    verification: {
      exp: false,
      iat: false,
      nbf: false,
    },
  });
}

/**
 * RFC 7638 JWK thumbprint: SHA-256 over the required members only, lexicographically ordered, no
 * whitespace. For the EC keys this package signs with that is exactly crv, kty, x, y — so the digest
 * is stable across any extra members (kid, use, alg) a caller happens to publish.
 */
export async function servicePlaneJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  if (jwk.kty !== 'EC' || typeof jwk.crv !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new CapabilityAuthError('Service-Plane JWK thumbprint requires an EC public key', 500);
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y });
  return sha256Base64Url(new TextEncoder().encode(canonical));
}

/**
 * Picks the key a verified assertion was actually signed with. Hono's verifyWithJwks requires a `kid`
 * header and verifies against that one key, so matching on `kid` after a successful verification
 * identifies the signer rather than merely a key the caller claims to have used.
 */
export function servicePlaneJwkSigner(jwks: CapabilityJwks, keyId: string): JsonWebKey {
  const key = jwks.keys.find((candidate) => candidate.kid === keyId);
  if (!key) throw new CapabilityAuthError('Service-Plane JWK signer is not in the client key set', 401);
  return key;
}

async function requestBodyBytes(request: Request, maxBodyBytes?: number): Promise<Uint8Array> {
  return boundedRequestBodyBytes(request, maxBodyBytes, {
    invalidMaxBodyBytesMessage: 'Service-Plane JWK max body size must be a positive integer',
    tooLargeMessage: 'Service-Plane JWK request body is too large',
  });
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function normalizeAssertionTtlSeconds(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_JWK_ASSERTION_TTL_SECONDS) {
    throw new CapabilityAuthError(
      `Service-Plane JWK assertion TTL must be a positive integer no greater than ${MAX_JWK_ASSERTION_TTL_SECONDS} seconds`,
      500,
    );
  }
  return ttlSeconds;
}

function normalizeClaimString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane ${field} cannot be empty`, 500);
  return normalized;
}

export function randomServicePlaneJwkId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
