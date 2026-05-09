import { CapabilityAuthError } from './errors.js';
import {
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_AUTHORIZATION_SCHEME,
  type CapabilityClaims,
  type CapabilityIdentity,
  type CapabilityJwks,
  type IssuedCapabilityToken,
  type VerifyCapabilityTokenOptions,
} from './types.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const JWS_ALGORITHM = 'ES256';
const ECDSA_IMPORT_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export type SignCapabilityTokenOptions = {
  claims: Omit<CapabilityClaims, 'exp' | 'iat' | 'jti' | 'nbf'> & Partial<Pick<CapabilityClaims, 'jti'>>;
  keyId: string;
  now?: Date;
  privateKey: CryptoKey;
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

  const header = {
    alg: JWS_ALGORITHM,
    kid: options.keyId,
    typ: 'JWT',
  };
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN_ALGORITHM, options.privateKey, textEncoder.encode(signingInput)));

  return {
    expiresAt: new Date(expiresAtSeconds * 1000),
    token: `${signingInput}.${base64Url(signature)}`,
  };
}

export async function verifyCapabilityToken(token: string, options: VerifyCapabilityTokenOptions): Promise<CapabilityIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new CapabilityAuthError('Invalid Service-Plane capability token');
  const checkedParts: [string, string, string] = [parts[0], parts[1], parts[2]];

  const header = decodeJson(checkedParts[0]);
  if (!isRecord(header) || header.alg !== JWS_ALGORITHM || typeof header.kid !== 'string') {
    throw new CapabilityAuthError('Invalid Service-Plane capability token header');
  }

  const payload = decodeJson(checkedParts[1]);
  const claims = parseCapabilityClaims(payload);
  if (options.issuer && claims.iss !== options.issuer) throw new CapabilityAuthError('Invalid Service-Plane capability issuer');
  if (claims.aud !== options.expectedAudience) throw new CapabilityAuthError('Invalid Service-Plane capability audience');

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.nbf > nowSeconds) throw new CapabilityAuthError('Service-Plane capability token is not active yet');
  if (claims.exp <= nowSeconds) throw new CapabilityAuthError('Expired Service-Plane capability token');

  const missingScope = (options.requiredScopes ?? []).find((scope) => !claims.scp.includes(scope));
  if (missingScope) throw new CapabilityAuthError(`Missing Service-Plane capability scope: ${missingScope}`, 403);

  const jwks = await resolveJwks(options.jwks);
  const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
  if (!key) throw new CapabilityAuthError('Unknown Service-Plane capability key id');

  const valid = await verifySignature(key, checkedParts);
  if (!valid) throw new CapabilityAuthError('Invalid Service-Plane capability signature');

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
  const [, payload] = token.split('.');
  if (!payload) throw new CapabilityAuthError('Invalid Service-Plane capability token');
  return parseCapabilityClaims(decodeJson(payload));
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

function encodeJson(value: unknown): string {
  return base64Url(textEncoder.encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(textDecoder.decode(base64UrlDecode(value))) as unknown;
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
  return { aud, exp, iat, iss, jti, nbf, scp, sub };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function randomId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): ArrayBuffer {
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function verifySignature(key: JsonWebKey, parts: [string, string, string]): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey('jwk', key, ECDSA_IMPORT_ALGORITHM, false, ['verify']);
    const signature = base64UrlDecode(parts[2]);
    return await crypto.subtle.verify(ECDSA_SIGN_ALGORITHM, publicKey, signature, textEncoder.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane capability signature');
  }
}

function normalizeTtlSeconds(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CapabilityAuthError('Service-Plane capability token TTL must be a positive integer');
  }
  return ttlSeconds;
}
