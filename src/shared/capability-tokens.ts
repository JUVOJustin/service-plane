import { sign } from 'hono/jwt';
import { verifying } from 'hono/utils/jwt/jws';
import { CapabilityAuthError } from './errors.js';
import {
  decodeServicePlaneJwkToken,
  publicJwkFromPrivateJwk,
  randomServicePlaneJwkId,
  SERVICE_PLANE_JWK_ALGORITHM,
  servicePlaneJwkSigningKey,
} from './jwk-auth.js';
import {
  type CapabilityActorClaim,
  type CapabilityClaims,
  type CapabilityIdentity,
  type CapabilityJwks,
  type CapabilitySubject,
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  type IssuedCapabilityToken,
  MAX_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_AUTHORIZATION_SCHEME,
  type VerifyCapabilityTokenOptions,
} from './types.js';

const MAX_CAPABILITY_TOKEN_LENGTH = 8192;
const MAX_CAPABILITY_CLAIM_STRING_LENGTH = 512;
const MAX_CAPABILITY_SCOPE_COUNT = 128;

export { publicJwkFromPrivateJwk };

export type SignCapabilityTokenOptions = {
  claims: Omit<CapabilityClaims, 'exp' | 'iat' | 'jti' | 'nbf'> & Partial<Pick<CapabilityClaims, 'jti'>>;
  keyId: string;
  now?: Date;
  privateJwk: JsonWebKey;
  ttlSeconds?: number;
};

export async function signCapabilityToken(options: SignCapabilityTokenOptions): Promise<IssuedCapabilityToken> {
  // Mirror the verifier's delegation invariant at signing so a mis-built token fails here with a
  // clear error instead of signing cleanly and being rejected by every verifier.
  if (options.claims.spo !== undefined && options.claims.act === undefined) {
    throw new CapabilityAuthError('Service-Plane capability spo claim requires an act claim', 500);
  }
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = normalizeTtlSeconds(options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS);
  const expiresAtSeconds = issuedAt + ttlSeconds;
  const claims: CapabilityClaims = {
    ...options.claims,
    exp: expiresAtSeconds,
    iat: issuedAt,
    jti: options.claims.jti ?? randomServicePlaneJwkId(),
    nbf: issuedAt,
  };

  return {
    expiresAt: new Date(expiresAtSeconds * 1000),
    token: await sign(claims, servicePlaneJwkSigningKey(options.privateJwk, options.keyId), SERVICE_PLANE_JWK_ALGORITHM),
  };
}

export async function verifyCapabilityToken(token: string, options: VerifyCapabilityTokenOptions): Promise<CapabilityIdentity> {
  if (token.length > MAX_CAPABILITY_TOKEN_LENGTH) throw new CapabilityAuthError('Service-Plane capability token is too large');

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new CapabilityAuthError('Invalid Service-Plane capability token');

  const { header, payload } = decodeCapabilityToken(token);
  if (!isRecord(header) || header.alg !== SERVICE_PLANE_JWK_ALGORITHM || typeof header.kid !== 'string') {
    throw new CapabilityAuthError('Invalid Service-Plane capability token header');
  }

  const claims = parseCapabilityClaims(payload);
  if (options.issuer && claims.iss !== options.issuer) throw new CapabilityAuthError('Invalid Service-Plane capability issuer');
  if (claims.aud !== options.expectedAudience) throw new CapabilityAuthError('Invalid Service-Plane capability audience');

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.nbf > nowSeconds) throw new CapabilityAuthError('Service-Plane capability token is not active yet');
  if (claims.iat > nowSeconds) throw new CapabilityAuthError('Service-Plane capability token issued-at is in the future');
  if (claims.exp <= nowSeconds) throw new CapabilityAuthError('Expired Service-Plane capability token');

  const missingScope = (options.requiredScopes ?? []).find((scope) => !claims.scp.includes(scope));
  if (missingScope) throw new CapabilityAuthError(`Missing Service-Plane capability scope: ${missingScope}`, 403);

  const jwks = await resolveJwks(options.jwks);
  const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!key) throw new CapabilityAuthError('Unknown Service-Plane capability key id');

  await verifyTokenSignature(token, key);

  // RFC 8693 delegation: with an act claim, sub is the end-user subject and act.sub is the acting
  // service; without one, sub is the calling service itself.
  const { serviceId, subject } = claims.act
    ? { serviceId: claims.act.sub, subject: toCapabilitySubject(claims.sub, claims.spo) }
    : { serviceId: claims.sub, subject: undefined };
  return {
    audience: claims.aud,
    ...(claims.spb ? { brokerServiceId: claims.spb } : {}),
    expiresAt: new Date(claims.exp * 1000),
    issuer: claims.iss,
    scopes: claims.scp,
    serviceId,
    ...(subject ? { subject } : {}),
    tokenId: claims.jti,
  };
}

export function normalizeCapabilitySubject(subject: CapabilitySubject): CapabilitySubject {
  const id = subject.id.trim();
  const orgId = subject.orgId?.trim();
  if (!isBoundedClaimString(id) || (orgId !== undefined && !isBoundedClaimString(orgId))) {
    throw new CapabilityAuthError('Invalid Service-Plane capability subject', 400);
  }
  return toCapabilitySubject(id, orgId);
}

function toCapabilitySubject(id: string, orgId: string | undefined): CapabilitySubject {
  return { id, ...(orgId ? { orgId } : {}) };
}

export function servicePlaneAuthorization(token: string): string {
  return `${SERVICE_PLANE_AUTHORIZATION_SCHEME} ${token}`;
}

export function extractServicePlaneToken(request: Request): string {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) throw new CapabilityAuthError('Missing Service-Plane capability token');
  const [scheme, token] = authorization.split(/\s+/u, 2);
  if (scheme !== SERVICE_PLANE_AUTHORIZATION_SCHEME || !token) throw new CapabilityAuthError('Invalid Service-Plane authorization scheme');
  return token;
}

export function decodeCapabilityTokenPayload(token: string): CapabilityClaims {
  return parseCapabilityClaims(decodeCapabilityToken(token).payload);
}

async function resolveJwks(jwks: VerifyCapabilityTokenOptions['jwks']): Promise<CapabilityJwks> {
  return typeof jwks === 'function' ? jwks() : jwks;
}

function decodeCapabilityToken(token: string): { header: unknown; payload: unknown } {
  return decodeServicePlaneJwkToken(token, 'Invalid Service-Plane capability token encoding');
}

function parseCapabilityClaims(value: unknown): CapabilityClaims {
  if (!isRecord(value)) throw new CapabilityAuthError('Invalid Service-Plane capability claims');
  const { act, aud, exp, iat, iss, jti, nbf, scp, spb, spo, sub } = value;
  if (
    typeof aud !== 'string' ||
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    typeof iss !== 'string' ||
    typeof jti !== 'string' ||
    typeof nbf !== 'number' ||
    typeof sub !== 'string' ||
    !(spb === undefined || typeof spb === 'string') ||
    !Array.isArray(scp) ||
    scp.length === 0 ||
    !scp.every((scope) => typeof scope === 'string')
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane capability claims');
  }
  if (
    !isBoundedClaimString(aud) ||
    !isBoundedClaimString(iss) ||
    !isBoundedClaimString(jti) ||
    !isBoundedClaimString(sub) ||
    !(spb === undefined || isBoundedClaimString(spb)) ||
    scp.length > MAX_CAPABILITY_SCOPE_COUNT ||
    !scp.every(isBoundedClaimString)
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane capability claims');
  }
  const actor = parseActorClaim(act);
  // A subject-org claim is only meaningful on delegated tokens; reject it without an act claim
  // so a plain service token cannot smuggle tenant context.
  if (spo !== undefined) {
    if (actor === undefined || typeof spo !== 'string' || !isBoundedClaimString(spo)) {
      throw new CapabilityAuthError('Invalid Service-Plane capability claims');
    }
  }
  return { ...(actor ? { act: actor } : {}), aud, exp, iat, iss, jti, nbf, scp, ...(spb ? { spb } : {}), ...(spo ? { spo } : {}), sub };
}

function parseActorClaim(value: unknown): CapabilityActorClaim | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new CapabilityAuthError('Invalid Service-Plane capability actor claim');
  const { sub } = value;
  if (typeof sub !== 'string' || !isBoundedClaimString(sub)) {
    throw new CapabilityAuthError('Invalid Service-Plane capability actor claim');
  }
  return { sub };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedClaimString(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CAPABILITY_CLAIM_STRING_LENGTH;
}

// Deviation from the ready-made hono helper, on purpose: hono/jwt's verifyWithJwks re-imports
// the CryptoKey from the JWK on EVERY call, which measured 206us/op vs 100us/op with a cached
// key on Node — capability tokens are verified per request on HTTP-batch transports, so that
// doubling matters. The JWS signature check itself still uses hono's own low-level `verifying`
// primitive (hono/utils/jwt/jws); only kid-matching and key caching are ours. Everything here
// is web-standard (crypto.subtle, atob, TextEncoder), so it behaves identically on Node 20+,
// Bun, workerd, and Deno — the same matrix hono itself targets.
async function verifyTokenSignature(token: string, key: JsonWebKey & { kid?: string }): Promise<void> {
  try {
    const [headerPart, payloadPart, signaturePart] = token.split('.');
    if (!headerPart || !payloadPart || !signaturePart) throw new Error('malformed token');
    const verified = await verifying(
      await importedVerificationKey(key),
      SERVICE_PLANE_JWK_ALGORITHM,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!verified) throw new Error('signature mismatch');
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane capability signature');
  }
}

// Imported keys are cached by their public key material, so a rotated key is a different cache
// entry by construction and a poisoned/failed import never sticks (the catch below evicts it).
// The bound exists only to keep a pathological JWKS from growing the map without limit.
const verificationKeyCache = new Map<string, Promise<CryptoKey>>();

function importedVerificationKey(key: JsonWebKey & { kid?: string }): Promise<CryptoKey> {
  const cacheKey = `${key.kid ?? ''}:${key.kty ?? ''}:${key.crv ?? ''}:${key.x ?? ''}:${key.y ?? ''}`;
  const cached = verificationKeyCache.get(cacheKey);
  if (cached) return cached;
  if (verificationKeyCache.size >= 64) verificationKeyCache.clear();
  const imported = crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  verificationKeyCache.set(cacheKey, imported);
  imported.catch(() => verificationKeyCache.delete(cacheKey));
  return imported;
}

// atob + manual byte copy instead of a library helper: hono does not export its base64url
// decoder, and atob is a web-standard global on every target runtime (Node 16+, Bun, workerd,
// Deno). Signatures are ~64 bytes, so the char loop is irrelevant to performance.
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
    );
  }
  return ttlSeconds;
}
