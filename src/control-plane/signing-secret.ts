import { CapabilityAuthError } from '../shared/errors.js';
import { type CapabilityCatalog, DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS, type ServiceGrantDefinition } from '../shared/types.js';
import {
  type CapabilityIssuer,
  type CreateCapabilityIssuerFromPrivateJwkOptions,
  createCapabilityIssuerFromPrivateJwk,
} from './capabilities.js';

const DEFAULT_CAPABILITY_ISSUER = 'control-plane';
const DEFAULT_CAPABILITY_KEY_ID = 'default';
const P256_P = hexToBigInt('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const P256_N = hexToBigInt('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const P256_A = P256_P - 3n;
const P256_G = {
  x: hexToBigInt('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
  y: hexToBigInt('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'),
};

type Point = { x: bigint; y: bigint } | undefined;

export type CreateCapabilityIssuerFromSigningSecretOptions = {
  capabilities: CapabilityCatalog[];
  grants: ServiceGrantDefinition;
  issuer?: string;
  keyId?: string;
  now?: () => Date;
  signingSecret: string;
  ttlSeconds?: number;
  validateKeyPair?: boolean;
};

// Generates the only value that needs to be stored as the control-plane secret.
export async function generateCapabilitySigningSecret(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (typeof privateJwk.d !== 'string') throw new CapabilityAuthError('Unable to export Service-Plane signing secret', 500);
  return privateJwk.d;
}

// Rebuilds the ES256 private JWK from the stored P-256 scalar and library defaults.
export function privateJwkFromCapabilitySigningSecret(
  signingSecret: string,
  keyId = DEFAULT_CAPABILITY_KEY_ID,
): JsonWebKey & { kid?: string } {
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

// Builds a full issuer from a single stored scalar plus strong Service-Plane defaults.
export async function createCapabilityIssuerFromSigningSecret(
  options: CreateCapabilityIssuerFromSigningSecretOptions,
): Promise<CapabilityIssuer> {
  const keyId = options.keyId ?? DEFAULT_CAPABILITY_KEY_ID;
  const input: CreateCapabilityIssuerFromPrivateJwkOptions = {
    capabilities: options.capabilities,
    grants: options.grants,
    issuer: options.issuer ?? DEFAULT_CAPABILITY_ISSUER,
    keyId,
    privateJwk: privateJwkFromCapabilitySigningSecret(options.signingSecret, keyId),
    ttlSeconds: options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
    validateKeyPair: options.validateKeyPair ?? true,
    ...(options.now ? { now: options.now } : {}),
  };
  return createCapabilityIssuerFromPrivateJwk(input);
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
