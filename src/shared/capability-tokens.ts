import { decode, sign, verifyWithJwks } from 'hono/jwt';
import { CapabilityAuthError } from './errors.js';
import {
  type CapabilityClaims,
  type CapabilityIdentity,
  type CapabilityJwks,
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  type IssuedCapabilityToken,
  MAX_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_AUTHORIZATION_SCHEME,
  type VerifyCapabilityTokenOptions,
} from './types.js';

const JWS_ALGORITHM = 'ES256';
const MAX_CAPABILITY_TOKEN_LENGTH = 8192;
const MAX_CAPABILITY_CLAIM_STRING_LENGTH = 512;
const MAX_CAPABILITY_SCOPE_COUNT = 128;

export type SignCapabilityTokenOptions = {
  claims: Omit<CapabilityClaims, 'exp' | 'iat' | 'jti' | 'nbf'> & Partial<Pick<CapabilityClaims, 'jti'>>;
  keyId: string;
  now?: Date;
  privateJwk: JsonWebKey;
  ttlSeconds?: number;
};

export async function signCapabilityToken(options: SignCapabilityTokenOptions): Promise<IssuedCapabilityToken> {
  const now = options.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const ttlSeconds = normalizeTtlSeconds(options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS);
  const expiresAtSeconds = issuedAt + ttlSeconds;
  const claims: CapabilityClaims = {
    ...options.claims,
    exp: expiresAtSeconds,
    iat: issuedAt,
    jti: options.claims.jti ?? randomId(),
    nbf: issuedAt,
  };

  const signingKey = {
    ...options.privateJwk,
    alg: JWS_ALGORITHM,
    kid: options.keyId,
    key_ops: ['sign'],
    use: 'sig',
  };

  return {
    expiresAt: new Date(expiresAtSeconds * 1000),
    token: await sign(claims, signingKey, JWS_ALGORITHM),
  };
}

export async function verifyCapabilityToken(token: string, options: VerifyCapabilityTokenOptions): Promise<CapabilityIdentity> {
  if (token.length > MAX_CAPABILITY_TOKEN_LENGTH) throw new CapabilityAuthError('Service-Plane capability token is too large');

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new CapabilityAuthError('Invalid Service-Plane capability token');

  const { header, payload } = decodeCapabilityToken(token);
  if (!isRecord(header) || header.alg !== JWS_ALGORITHM || typeof header.kid !== 'string') {
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

  await verifyTokenSignature(token, jwks);

  return {
    audience: claims.aud,
    expiresAt: new Date(claims.exp * 1000),
    issuer: claims.iss,
    scopes: claims.scp,
    serviceId: claims.sub,
    tokenId: claims.jti,
  };
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

export function publicJwkFromPrivateJwk(privateJwk: JsonWebKey, keyId: string): JsonWebKey & { kid?: string } {
  const { d: _d, ...publicJwk } = privateJwk;
  return {
    ...publicJwk,
    alg: JWS_ALGORITHM,
    kid: keyId,
    key_ops: ['verify'],
    use: 'sig',
  };
}

async function resolveJwks(jwks: VerifyCapabilityTokenOptions['jwks']): Promise<CapabilityJwks> {
  return typeof jwks === 'function' ? jwks() : jwks;
}

function decodeCapabilityToken(token: string): { header: unknown; payload: unknown } {
  try {
    return decode(token);
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane capability token encoding');
  }
}

function parseCapabilityClaims(value: unknown): CapabilityClaims {
  if (!isRecord(value)) throw new CapabilityAuthError('Invalid Service-Plane capability claims');
  const { aud, exp, iat, iss, jti, nbf, scp, sub } = value;
  if (
    typeof aud !== 'string' ||
    typeof exp !== 'number' ||
    typeof iat !== 'number' ||
    typeof iss !== 'string' ||
    typeof jti !== 'string' ||
    typeof nbf !== 'number' ||
    typeof sub !== 'string' ||
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
    scp.length > MAX_CAPABILITY_SCOPE_COUNT ||
    !scp.every(isBoundedClaimString)
  ) {
    throw new CapabilityAuthError('Invalid Service-Plane capability claims');
  }
  return { aud, exp, iat, iss, jti, nbf, scp, sub };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedClaimString(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CAPABILITY_CLAIM_STRING_LENGTH;
}

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyTokenSignature(token: string, jwks: CapabilityJwks): Promise<void> {
  try {
    await verifyWithJwks(token, {
      allowedAlgorithms: [JWS_ALGORITHM],
      keys: jwks.keys,
      verification: {
        exp: false,
        iat: false,
        nbf: false,
      },
    });
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane capability signature');
  }
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
