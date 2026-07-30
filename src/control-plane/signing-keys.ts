import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { type CapabilityCatalog, DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS, type ServiceGrantDefinition } from '../shared/types.js';
import {
  type CapabilityIssuer,
  type CapabilitySigningAuthority,
  type CapabilitySigningJwk,
  type CreateCapabilityIssuerFromPrivateJwkOptions,
  createCapabilityIssuerFromPrivateJwk,
  createCapabilitySigningAuthority,
  validateEs256KeyPair,
} from './capabilities.js';

const DEFAULT_CAPABILITY_ISSUER = 'control-plane';
const P256_P = hexToBigInt('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const P256_N = hexToBigInt('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_A = P256_P - 3n;
const P256_G = {
  x: hexToBigInt('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  y: hexToBigInt('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
};

type Point = { x: bigint; y: bigint } | undefined;

// One stored secret plus the key id verifiers select it by. Ordering carries the rotation state:
// `keys[0]` signs, and every later entry stays published so tokens minted before the rotation — and
// by control-plane replicas that have not restarted yet — keep verifying.
export type CapabilitySigningKey = {
  kid: string;
  secret: string;
};

export type CreateCapabilityIssuerFromSigningKeysOptions = {
  capabilities: CapabilityCatalog[];
  grants: ServiceGrantDefinition;
  issuer?: string;
  keys: CapabilitySigningKey[];
  now?: () => Date;
  ttlSeconds?: number;
  validateKeyPair?: boolean;
};

export type CreateCapabilitySigningAuthorityFromSigningKeysOptions = {
  issuer?: string;
  keys: CapabilitySigningKey[];
};

// Generates the only value that needs to be stored as the control-plane secret.
export async function generateCapabilitySigningSecret(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (typeof privateJwk.d !== 'string') throw new CapabilityAuthError('Unable to export Service-Plane signing secret', 500);
  return privateJwk.d;
}

// Identity check for a caller memoizing per key set. Order matters as much as content: `keys[0]`
// signs, so a reorder after a rollback is a different key set even with the same members. A direct
// compare rather than a digest keeps the memo's hit path synchronous and keeps the secrets out of
// any derived value that would then need its own handling.
export function sameCapabilitySigningKeys(left: CapabilitySigningKey[], right: CapabilitySigningKey[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((key, index) => key.kid === right[index]?.kid && key.secret === right[index]?.secret);
}

// Rebuilds the ES256 private JWK from the stored P-256 scalar and library defaults.
export function privateJwkFromCapabilitySigningSecret(signingSecret: string, keyId: string): CapabilitySigningJwk {
  const d = normalizeSigningSecret(signingSecret);
  const scalar = base64UrlToBigInt(d);
  if (scalar <= 0n || scalar >= P256_N) throw new CapabilityAuthError('Invalid Service-Plane signing secret', 500);
  const publicPoint = multiply(P256_G, scalar);
  if (!publicPoint) throw new CapabilityAuthError('Invalid Service-Plane signing secret', 500);

  return {
    alg: 'ES256',
    crv: 'P-256',
    d,
    key_ops: ['sign'],
    kid: keyId,
    kty: 'EC',
    use: 'sig',
    x: bigIntToBase64Url(publicPoint.x),
    y: bigIntToBase64Url(publicPoint.y),
  };
}

// Builds only the signing authority from the stored scalars. Publishing JWKS needs nothing else, so
// this path never touches the service catalog.
export function createCapabilitySigningAuthorityFromSigningKeys(
  options: CreateCapabilitySigningAuthorityFromSigningKeysOptions,
): CapabilitySigningAuthority {
  return createCapabilitySigningAuthority({
    issuer: options.issuer ?? DEFAULT_CAPABILITY_ISSUER,
    privateJwks: privateJwksFromSigningKeys(options.keys),
  });
}

// Builds a full issuer from the stored scalars plus strong Service-Plane defaults.
export async function createCapabilityIssuerFromSigningKeys(
  options: CreateCapabilityIssuerFromSigningKeysOptions,
): Promise<CapabilityIssuer> {
  const input: CreateCapabilityIssuerFromPrivateJwkOptions = {
    capabilities: options.capabilities,
    grants: options.grants,
    issuer: options.issuer ?? DEFAULT_CAPABILITY_ISSUER,
    privateJwks: privateJwksFromSigningKeys(options.keys),
    ttlSeconds: options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
    validateKeyPair: options.validateKeyPair ?? true,
    ...(options.now ? { now: options.now } : {}),
  };
  return createCapabilityIssuerFromPrivateJwk(input);
}

// Everything about an issuer that is expensive lives here, and none of it depends on the service
// catalog or the grants: deriving each private JWK is a P-256 scalar multiplication (~8.7ms) and
// proving the active key signs and verifies is a further round-trip (~3.5ms), while assembling the
// issuer around them costs microseconds. Split out so a caller can memoize this per key set — one
// entry for the life of a rotation — instead of paying it again for every configuration.
export async function validatedPrivateJwksFromSigningKeys(keys: CapabilitySigningKey[]): Promise<CapabilitySigningJwk[]> {
  const privateJwks = privateJwksFromSigningKeys(keys);
  // Only the active key is round-tripped: retired entries are allowed to be public-only, so there
  // is no private half left to check against them. Same rule as createCapabilityIssuerFromPrivateJwk.
  const signingJwk = privateJwks[0] as CapabilitySigningJwk;
  await validateEs256KeyPair(signingJwk, publicJwkFromPrivateJwk(signingJwk, signingJwk.kid), signingJwk.kid);
  return privateJwks;
}

function privateJwksFromSigningKeys(keys: CapabilitySigningKey[]): CapabilitySigningJwk[] {
  if (keys.length === 0) throw new CapabilityAuthError('Service-Plane signing keys cannot be empty', 500);
  return keys.map((key) => privateJwkFromCapabilitySigningSecret(key.secret, key.kid));
}

function normalizeSigningSecret(signingSecret: string): string {
  const trimmed = signingSecret.trim();
  if (!trimmed) throw new CapabilityAuthError('Service-Plane signing secret cannot be empty', 500);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(trimmed)) throw new CapabilityAuthError('Invalid Service-Plane signing secret', 500);
  return trimmed;
}

function multiply(point: Point, scalar: bigint): Point {
  let result: Point;
  let addend = point;
  let remaining = scalar;

  while (remaining > 0n) {
    if (remaining & 1n) result = add(result, addend);
    addend = add(addend, addend);
    remaining >>= 1n;
  }

  return result;
}

function add(left: Point, right: Point): Point {
  if (!left) return right;
  if (!right) return left;
  if (left.x === right.x && mod(left.y + right.y) === 0n) return undefined;

  const slope =
    left.x === right.x && left.y === right.y
      ? mod((3n * left.x * left.x + P256_A) * invert(2n * left.y))
      : mod((right.y - left.y) * invert(right.x - left.x));
  const x = mod(slope * slope - left.x - right.x);
  return {
    x,
    y: mod(slope * (left.x - x) - left.y),
  };
}

function invert(value: bigint): bigint {
  let low = mod(value);
  let high = P256_P;
  let lm = 1n;
  let hm = 0n;

  while (low > 1n) {
    const ratio = high / low;
    const nm = hm - lm * ratio;
    const next = high - low * ratio;
    high = low;
    hm = lm;
    low = next;
    lm = nm;
  }

  return mod(lm);
}

function mod(value: bigint): bigint {
  const result = value % P256_P;
  return result >= 0n ? result : result + P256_P;
}

function hexToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

function base64UrlToBigInt(value: string): bigint {
  const bytes = base64UrlToBytes(value);
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function bigIntToBase64Url(value: bigint): string {
  const hex = value.toString(16).padStart(64, '0');
  return bytesToBase64Url(hexToBytes(hex));
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
