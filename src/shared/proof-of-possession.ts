import { decode, sign, verify } from 'hono/jwt';
import { CapabilityAuthError } from './errors.js';
import { sha256Base64Url } from './hmac-auth.js';
import { randomServicePlaneJwkId, SERVICE_PLANE_JWK_ALGORITHM, servicePlaneJwkThumbprint } from './jwk-auth.js';
import type { CapabilityConfirmation } from './types.js';

// A proof of possession is a short-lived JWS the caller signs with the key its capability token is
// bound to. Modelled on RFC 9449 (DPoP): the public key travels with the proof, so a service needs no
// key distribution — it thumbprints that key and compares it against the token's `cnf.jkt`.
//
// DPoP carries the key in the JWS header; here it is a claim, because the JWT helpers in use build
// their own header and reject any `typ` other than `JWT`. Both are covered by the signature, so the
// binding is equally sound.
//
// Claims tie one proof to one token on one service, so a captured proof cannot be aimed elsewhere:
//   cnk  the caller's public key, thumbprinted against the token's confirmation
//   ath  hash of the capability token it accompanies
//   aud  target service id
//   abl  ability id the session is being opened for
//   jti/iat/exp  freshness
const DEFAULT_PROOF_TTL_SECONDS = 60;
const MAX_PROOF_TTL_SECONDS = 300;
const MAX_PROOF_LENGTH = 8192;
const MAX_PROOF_SKEW_SECONDS = 60;

export type SignCapabilityProofOptions = {
  abilityId: string;
  now?: Date;
  privateJwk: JsonWebKey;
  targetServiceId: string;
  token: string;
  ttlSeconds?: number;
};

export type VerifyCapabilityProofOptions = {
  abilityId: string;
  confirmation: CapabilityConfirmation;
  now?: Date;
  targetServiceId: string;
  token: string;
};

export async function signCapabilityProof(options: SignCapabilityProofOptions): Promise<string> {
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = normalizeProofTtlSeconds(options.ttlSeconds ?? DEFAULT_PROOF_TTL_SECONDS);

  return sign(
    {
      abl: normalizeProofField(options.abilityId, 'proof of possession ability id'),
      ath: await capabilityTokenHash(options.token),
      aud: normalizeProofField(options.targetServiceId, 'proof of possession audience'),
      cnk: proofPublicJwk(options.privateJwk),
      exp: issuedAt + ttlSeconds,
      iat: issuedAt,
      jti: randomServicePlaneJwkId(),
    },
    options.privateJwk as Parameters<typeof sign>[1],
    SERVICE_PLANE_JWK_ALGORITHM,
  );
}

// Order matters: the embedded key is thumbprinted and matched against `cnf.jkt` *before* the signature
// is checked against it. A proof signed by any other key therefore fails at the thumbprint, and can
// never be verified using its own public half.
export async function verifyCapabilityProof(proof: string, options: VerifyCapabilityProofOptions): Promise<void> {
  if (typeof proof !== 'string' || !proof || proof.length > MAX_PROOF_LENGTH) {
    throw new CapabilityAuthError('Invalid Service-Plane proof of possession', 401);
  }

  const claims = parseProofClaims(decodeProof(proof));
  if ((await servicePlaneJwkThumbprint(claims.cnk)) !== options.confirmation.jkt) {
    throw new CapabilityAuthError('Service-Plane proof of possession key does not match the token confirmation', 401);
  }

  try {
    // Freshness is checked below with an explicit skew allowance, so the helper's own exp/iat/nbf
    // handling stays off rather than applying a second, stricter clock.
    await verify(proof, claims.cnk as Parameters<typeof verify>[1], {
      alg: SERVICE_PLANE_JWK_ALGORITHM,
      exp: false,
      iat: false,
      nbf: false,
    });
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane proof of possession signature', 401);
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iat > nowSeconds + MAX_PROOF_SKEW_SECONDS) {
    throw new CapabilityAuthError('Service-Plane proof of possession issued-at is in the future', 401);
  }
  if (claims.exp <= nowSeconds - MAX_PROOF_SKEW_SECONDS) {
    throw new CapabilityAuthError('Expired Service-Plane proof of possession', 401);
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_PROOF_TTL_SECONDS) {
    throw new CapabilityAuthError('Invalid Service-Plane proof of possession lifetime', 401);
  }
  if (claims.aud !== options.targetServiceId) {
    throw new CapabilityAuthError('Service-Plane proof of possession audience mismatch', 401);
  }
  if (claims.abl !== options.abilityId) {
    throw new CapabilityAuthError('Service-Plane proof of possession ability mismatch', 401);
  }
  if (claims.ath !== (await capabilityTokenHash(options.token))) {
    throw new CapabilityAuthError('Service-Plane proof of possession is bound to a different token', 401);
  }
}

async function capabilityTokenHash(token: string): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(token));
}

// Strips the private scalar: a proof publishes the public half only.
function proofPublicJwk(privateJwk: JsonWebKey): JsonWebKey {
  if (
    privateJwk.kty !== 'EC' ||
    typeof privateJwk.crv !== 'string' ||
    typeof privateJwk.x !== 'string' ||
    typeof privateJwk.y !== 'string'
  ) {
    throw new CapabilityAuthError('Service-Plane proof of possession requires an EC private key', 500);
  }
  return {
    alg: SERVICE_PLANE_JWK_ALGORITHM,
    crv: privateJwk.crv,
    key_ops: ['verify'],
    kty: 'EC',
    use: 'sig',
    x: privateJwk.x,
    y: privateJwk.y,
  };
}

function decodeProof(proof: string): unknown {
  try {
    return decode(proof).payload;
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane proof of possession', 401);
  }
}

type ParsedProofClaims = {
  abl: string;
  ath: string;
  aud: string;
  cnk: JsonWebKey;
  exp: number;
  iat: number;
  jti: string;
};

function parseProofClaims(payload: unknown): ParsedProofClaims {
  if (!isRecord(payload)) throw new CapabilityAuthError('Invalid Service-Plane proof of possession claims', 401);
  const { abl, ath, aud, cnk, exp, iat, jti } = payload;
  if (
    typeof abl !== 'string' ||
    typeof ath !== 'string' ||
    typeof aud !== 'string' ||
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    typeof jti !== 'string' ||
    !isRecord(cnk)
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane proof of possession claims', 401);
  }
  // Fully validated here rather than left to the thumbprint helper: the embedded key is
  // attacker-controlled, so a malformed one must be an authentication failure, not a 500.
  // A private half would also mean the caller leaked its own signing key — refuse rather than use it.
  if (
    typeof cnk.d === 'string' ||
    cnk.kty !== 'EC' ||
    typeof cnk.crv !== 'string' ||
    typeof cnk.x !== 'string' ||
    typeof cnk.y !== 'string'
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane proof of possession key', 401);
  }
  return { abl, ath, aud, cnk: cnk as JsonWebKey, exp, iat, jti };
}

function normalizeProofTtlSeconds(ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_PROOF_TTL_SECONDS) {
    throw new CapabilityAuthError(
      `Service-Plane proof of possession TTL must be a positive integer no greater than ${MAX_PROOF_TTL_SECONDS} seconds`,
      500,
    );
  }
  return ttlSeconds;
}

function normalizeProofField(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane ${field} cannot be empty`, 500);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
