import { credentialFromAuthorization } from './authorization.js';
import { boundedRequestBodyBytes } from './body-limit.js';
import { bytesToBase64Url, sha256Base64Url } from './encoding.js';
import { requireNonEmpty } from './errors.js';
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
  maxBodyBytes?: number;
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
    await servicePlaneHmacRequestParts(signed, options.clientId, timestamp, requestIdHeaderName, options.maxBodyBytes),
  );
  headers.set('authorization', servicePlaneHmacAuthorization(signature));
  return new Request(signed, { headers });
}

export async function servicePlaneHmacRequestParts(
  request: Request,
  clientId: string,
  timestamp: string,
  requestIdHeaderName = SERVICE_PLANE_REQUEST_ID_HEADER,
  maxBodyBytes?: number,
): Promise<ServicePlaneHmacRequestParts> {
  const url = new URL(request.url);
  const requestId = request.headers.get(requestIdHeaderName)?.trim() || undefined;
  return {
    bodyHash: await sha256Base64Url(await requestBodyBytes(request, maxBodyBytes)),
    clientId,
    method: request.method.toUpperCase(),
    pathWithQuery: `${url.pathname}${url.search}`,
    ...(requestId ? { requestId } : {}),
    timestamp,
  };
}

export async function servicePlaneHmacSignature(secret: string, parts: ServicePlaneHmacRequestParts): Promise<string> {
  const normalizedSecret = requireNonEmpty(secret, 'HMAC secret');
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
  return credentialFromAuthorization(request, SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME, {
    invalid: 'Invalid Service-Plane HMAC authorization scheme',
    missing: 'Missing Service-Plane HMAC authorization',
  });
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

async function requestBodyBytes(request: Request, maxBodyBytes?: number): Promise<Uint8Array> {
  return boundedRequestBodyBytes(request, maxBodyBytes, {
    invalidMaxBodyBytesMessage: 'Service-Plane HMAC max body size must be a positive integer',
    tooLargeMessage: 'Service-Plane HMAC request body is too large',
  });
}
