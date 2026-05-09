import { MachineAuthError } from './errors.js';
import {
  DEFAULT_MAX_SKEW_SECONDS,
  SERVICE_PLANE_BODY_SHA256_HEADER,
  SERVICE_PLANE_KEY_ID_HEADER,
  SERVICE_PLANE_SIGNATURE_HEADER,
  SERVICE_PLANE_TIMESTAMP_HEADER,
  type MachineAuthContext,
  type SignMachineRequestOptions,
  type VerifyMachineRequestOptions,
} from './types.js';
import { pathAndQuery } from './paths.js';

const SIGNATURE_PREFIX = 'hmac-sha256=:';
const CANONICAL_VERSION = 'service-plane-v1';
const textEncoder = new TextEncoder();

export async function signMachineRequest(request: Request, options: SignMachineRequestOptions): Promise<Request> {
  const keyId = options.keyId ?? 'default';
  const timestamp = (options.now ?? new Date()).toISOString();
  const bodySha256 = await requestBodySha256(request);
  const signature = await hmacSha256(options.secret, canonicalRequest(request, { bodySha256, keyId, timestamp }));
  const headers = new Headers(request.headers);
  headers.set(SERVICE_PLANE_KEY_ID_HEADER, keyId);
  headers.set(SERVICE_PLANE_TIMESTAMP_HEADER, timestamp);
  headers.set(SERVICE_PLANE_BODY_SHA256_HEADER, bodySha256);
  headers.set(SERVICE_PLANE_SIGNATURE_HEADER, `${SIGNATURE_PREFIX}${signature}`);
  return new Request(request, { headers });
}

export async function verifyMachineRequest(request: Request, options: VerifyMachineRequestOptions): Promise<MachineAuthContext> {
  const keyId = requiredHeader(request, SERVICE_PLANE_KEY_ID_HEADER);
  const timestamp = requiredHeader(request, SERVICE_PLANE_TIMESTAMP_HEADER);
  const bodySha256 = requiredHeader(request, SERVICE_PLANE_BODY_SHA256_HEADER);
  const signatureHeader = requiredHeader(request, SERVICE_PLANE_SIGNATURE_HEADER);
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) throw new MachineAuthError('Invalid Service-Plane signature scheme');
  assertTimestamp(timestamp, options.now ?? new Date(), options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS);

  const actualBodySha256 = await requestBodySha256(request);
  if (!constantTimeEqual(bodySha256, actualBodySha256)) throw new MachineAuthError('Invalid Service-Plane body hash');

  const secret = await options.resolveSecret(keyId, request);
  if (!secret) throw new MachineAuthError('Unknown Service-Plane key id');

  const expectedSignature = await hmacSha256(secret, canonicalRequest(request, { bodySha256, keyId, timestamp }));
  const actualSignature = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!constantTimeEqual(expectedSignature, actualSignature)) throw new MachineAuthError('Invalid Service-Plane signature');

  return { bodySha256, keyId, timestamp };
}

export async function requestBodySha256(request: Request): Promise<string> {
  const bytes = new Uint8Array(await request.clone().arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return base64Url(new Uint8Array(digest));
}

function canonicalRequest(
  request: Request,
  input: {
    bodySha256: string;
    keyId: string;
    timestamp: string;
  },
): string {
  return [
    CANONICAL_VERSION,
    input.keyId,
    request.method.toUpperCase(),
    pathAndQuery(request),
    input.timestamp,
    input.bodySha256,
  ].join('\n');
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

function requiredHeader(request: Request, header: string): string {
  const value = request.headers.get(header)?.trim();
  if (!value) throw new MachineAuthError(`Missing ${header}`);
  return value;
}

function assertTimestamp(timestamp: string, now: Date, maxSkewSeconds: number): void {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis)) throw new MachineAuthError('Invalid Service-Plane timestamp');
  const skewSeconds = Math.abs(now.getTime() - millis) / 1000;
  if (skewSeconds > maxSkewSeconds) throw new MachineAuthError('Expired Service-Plane signature');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return diff === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
