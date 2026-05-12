import { CapabilityAuthError } from './errors.js';
import { SERVICE_PLANE_REQUEST_ID_HEADER } from './types.js';

export const SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME = 'ServicePlane-HMAC';
export const SERVICE_PLANE_HMAC_CLIENT_HEADER = 'X-Service-Plane-Client';
export const SERVICE_PLANE_HMAC_TIMESTAMP_HEADER = 'X-Service-Plane-Timestamp';

export type ServicePlaneHmacRequestParts = {
  bodyHash: string;
  clientId: string;
  method: string;
  pathWithQuery: string;
  requestId?: string;
  timestamp: string;
};

export type SignServicePlaneHmacRequestOptions = {
  clientId: string;
  clientIdHeaderName?: string;
  now?: Date;
  requestIdHeaderName?: string;
  secret: string;
  timestampHeaderName?: string;
};

export async function signServicePlaneHmacRequest(request: Request, options: SignServicePlaneHmacRequestOptions): Promise<Request> {
  const headers = new Headers(request.headers);
  const clientIdHeaderName = options.clientIdHeaderName ?? SERVICE_PLANE_HMAC_CLIENT_HEADER;
  const timestampHeaderName = options.timestampHeaderName ?? SERVICE_PLANE_HMAC_TIMESTAMP_HEADER;
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const timestamp = (options.now ?? new Date()).toISOString();

  headers.set(clientIdHeaderName, options.clientId);
  headers.set(timestampHeaderName, timestamp);

  const signed = new Request(request, { headers });
  const signature = await servicePlaneHmacSignature(
    options.secret,
    await servicePlaneHmacRequestParts(signed, options.clientId, timestamp, requestIdHeaderName),
  );
  headers.set('authorization', servicePlaneHmacAuthorization(signature));
  return new Request(signed, { headers });
}

export async function servicePlaneHmacRequestParts(
  request: Request,
  clientId: string,
  timestamp: string,
  requestIdHeaderName = SERVICE_PLANE_REQUEST_ID_HEADER,
): Promise<ServicePlaneHmacRequestParts> {
  const url = new URL(request.url);
  const requestId = request.headers.get(requestIdHeaderName)?.trim() || undefined;
  return {
    bodyHash: await sha256Base64Url(new Uint8Array(await request.clone().arrayBuffer())),
    clientId,
    method: request.method.toUpperCase(),
    pathWithQuery: `${url.pathname}${url.search}`,
    ...(requestId ? { requestId } : {}),
    timestamp,
  };
}

export async function servicePlaneHmacSignature(secret: string, parts: ServicePlaneHmacRequestParts): Promise<string> {
  const normalizedSecret = secret.trim();
  if (!normalizedSecret) throw new CapabilityAuthError('Service-Plane HMAC secret cannot be empty', 500);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizedSecret), { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(servicePlaneHmacCanonicalString(parts)));
  return bytesToBase64Url(new Uint8Array(signature));
}

export function servicePlaneHmacCanonicalString(parts: ServicePlaneHmacRequestParts): string {
  return [
    'service-plane-hmac-v1',
    parts.method.toUpperCase(),
    parts.pathWithQuery,
    parts.bodyHash,
    parts.timestamp,
    parts.clientId,
    parts.requestId ?? '',
  ].join('\n');
}

export function servicePlaneHmacAuthorization(signature: string): string {
  return `${SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME} ${signature}`;
}

export function extractServicePlaneHmacSignature(request: Request): string {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) throw new CapabilityAuthError('Missing Service-Plane HMAC authorization', 401);
  const [scheme, signature] = authorization.split(/\s+/u, 2);
  if (scheme !== SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME || !signature) {
    throw new CapabilityAuthError('Invalid Service-Plane HMAC authorization scheme', 401);
  }
  return signature;
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
