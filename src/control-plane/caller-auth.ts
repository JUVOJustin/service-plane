import type { Context } from 'hono';
import { CapabilityAuthError } from '../shared/errors.js';
import {
  extractServicePlaneHmacSignature,
  SERVICE_PLANE_HMAC_CLIENT_HEADER,
  SERVICE_PLANE_HMAC_TIMESTAMP_HEADER,
  servicePlaneHmacRequestParts,
  servicePlaneHmacSignature,
  timingSafeEqual,
} from '../shared/hmac-auth.js';
import { SERVICE_PLANE_REQUEST_ID_HEADER } from '../shared/types.js';

const SERVICE_CLIENT_SECRET_BYTES = 32;
const SERVICE_CLIENT_SECRET_HASH_PREFIX = 'sha256:';
const DEFAULT_HMAC_MAX_SKEW_SECONDS = 60;

export type ServiceClientCredential = {
  secretHash: string;
  serviceId: string;
};

export type ServiceClientCredentialsAuthLogEvent = {
  event: 'service_plane.caller_auth.unauthorized';
  level: 'warn';
  message: string;
  path: string;
  reason: 'invalid_credentials' | 'missing_credentials';
  requestId?: string;
};

export type ServiceClientCredentialsAuthOptions = {
  credentials: ServiceClientCredential[] | ((context: Context) => Promise<ServiceClientCredential[]> | ServiceClientCredential[]);
  header?: string;
  log?: (event: ServiceClientCredentialsAuthLogEvent) => void;
  scheme?: string;
};

export type HmacServiceClient = {
  clientId: string;
  secret: string;
  serviceId?: string;
};

export type HmacServiceClientAuthLogEvent = {
  event: 'service_plane.caller_auth.hmac_unauthorized';
  level: 'warn';
  message: string;
  path: string;
  reason:
    | 'client_not_found'
    | 'invalid_signature'
    | 'invalid_timestamp'
    | 'missing_client'
    | 'missing_signature'
    | 'missing_timestamp'
    | 'timestamp_skew';
  requestId?: string;
};

export type HmacServiceClientAuthOptions = {
  clientIdHeader?: string;
  clients: HmacServiceClient[] | ((context: Context) => Promise<HmacServiceClient[]> | HmacServiceClient[]);
  log?: (event: HmacServiceClientAuthLogEvent) => void;
  maxSkewSeconds?: number;
  now?: () => Date;
  replayCache?: HmacServiceClientReplayCache;
  requestIdHeader?: string;
  timestampHeader?: string;
};

export type HmacServiceClientReplayCache = {
  get(key: string): Promise<boolean> | boolean;
  set(key: string, ttlSeconds: number): Promise<void> | void;
};

// Generates the caller-side secret for authenticating to the control-plane token endpoint.
export function generateServiceClientSecret(): string {
  const bytes = new Uint8Array(SERVICE_CLIENT_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

// Stores only a hash in the control plane; the raw secret belongs to the caller service.
export async function hashServiceClientSecret(secret: string): Promise<string> {
  const value = secret.trim();
  if (!value) throw new Error('Service-Plane service client secret cannot be empty');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `${SERVICE_CLIENT_SECRET_HASH_PREFIX}${bytesToBase64Url(new Uint8Array(digest))}`;
}

// Authenticates callers with a bearer service secret and returns the matched service id.
export function serviceClientCredentialsAuth(options: ServiceClientCredentialsAuthOptions) {
  const header = options.header ?? 'authorization';
  const scheme = options.scheme ?? 'Bearer';
  const log = options.log ?? defaultCallerAuthLog;

  return async (context: Context): Promise<Response | string> => {
    const credential = extractCredential(context, header, scheme);
    if (!credential) {
      log(unauthorizedEvent(context, 'missing_credentials', `Missing ${scheme} service client credentials`));
      return context.json({ error: 'Unauthorized' }, 401);
    }

    const credentialHash = await hashServiceClientSecret(credential);
    const credentials = typeof options.credentials === 'function' ? await options.credentials(context) : options.credentials;
    const match = findMatchingCredential(credentialHash, credentials);
    if (!match) {
      log(unauthorizedEvent(context, 'invalid_credentials', 'Invalid service client credentials'));
      return context.json({ error: 'Unauthorized' }, 401);
    }

    return match.serviceId;
  };
}

// Authenticates token requests with an HMAC signature bound to method, path, body, timestamp, client id, and request id.
export function hmacServiceClientAuth(options: HmacServiceClientAuthOptions) {
  const clientIdHeader = options.clientIdHeader ?? SERVICE_PLANE_HMAC_CLIENT_HEADER;
  const timestampHeader = options.timestampHeader ?? SERVICE_PLANE_HMAC_TIMESTAMP_HEADER;
  const requestIdHeader = options.requestIdHeader ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  const maxSkewSeconds = options.maxSkewSeconds ?? DEFAULT_HMAC_MAX_SKEW_SECONDS;
  const log = options.log ?? defaultHmacCallerAuthLog;

  return async (context: Context): Promise<Response | string> => {
    try {
      const clientId = context.req.header(clientIdHeader)?.trim();
      if (!clientId) {
        log(hmacUnauthorizedEvent(context, 'missing_client', 'Missing Service-Plane HMAC client id'));
        return context.json({ error: 'Unauthorized' }, 401);
      }

      const timestamp = context.req.header(timestampHeader)?.trim();
      if (!timestamp) {
        log(hmacUnauthorizedEvent(context, 'missing_timestamp', 'Missing Service-Plane HMAC timestamp'));
        return context.json({ error: 'Unauthorized' }, 401);
      }

      const timestampError = validateHmacTimestamp(timestamp, options.now?.() ?? new Date(), maxSkewSeconds);
      if (timestampError) {
        log(hmacUnauthorizedEvent(context, timestampError, hmacTimestampMessage(timestampError)));
        return context.json({ error: 'Unauthorized' }, 401);
      }

      let signature: string;
      try {
        signature = extractServicePlaneHmacSignature(context.req.raw);
      } catch (error) {
        if (error instanceof CapabilityAuthError) {
          log(hmacUnauthorizedEvent(context, 'missing_signature', error.message));
          return context.json({ error: 'Unauthorized' }, 401);
        }
        throw error;
      }

      const clients = typeof options.clients === 'function' ? await options.clients(context) : options.clients;
      const client = clients.find((candidate) => timingSafeEqual(candidate.clientId, clientId));
      if (!client) {
        log(hmacUnauthorizedEvent(context, 'client_not_found', 'Unknown Service-Plane HMAC client'));
        return context.json({ error: 'Unauthorized' }, 401);
      }

      const expected = await servicePlaneHmacSignature(
        client.secret,
        await servicePlaneHmacRequestParts(context.req.raw, clientId, timestamp, requestIdHeader),
      );
      if (!timingSafeEqual(signature, expected)) {
        log(hmacUnauthorizedEvent(context, 'invalid_signature', 'Invalid Service-Plane HMAC signature'));
        return context.json({ error: 'Unauthorized' }, 401);
      }
      if (
        options.replayCache &&
        (await isHmacReplay(options.replayCache, clientId, requestIdFromContext(context) ?? signature, maxSkewSeconds))
      ) {
        log(hmacUnauthorizedEvent(context, 'invalid_signature', 'Replayed Service-Plane HMAC signature'));
        return context.json({ error: 'Unauthorized' }, 401);
      }

      return client.serviceId ?? client.clientId;
    } catch (error) {
      if (error instanceof CapabilityAuthError) {
        log(hmacUnauthorizedEvent(context, 'invalid_signature', error.message));
        return context.json({ error: 'Unauthorized' }, 401);
      }
      throw error;
    }
  };
}

function extractCredential(context: Context, header: string, scheme: string): string | undefined {
  const value = context.req.header(header)?.trim();
  if (!value) return undefined;
  const [actualScheme, credential] = value.split(/\s+/u, 2);
  if (actualScheme !== scheme || !credential) return undefined;
  return credential;
}

function findMatchingCredential(secretHash: string, credentials: ServiceClientCredential[]): ServiceClientCredential | undefined {
  let match: ServiceClientCredential | undefined;
  for (const credential of credentials) {
    if (timingSafeEqual(secretHash, credential.secretHash)) match = credential;
  }
  return match;
}

function unauthorizedEvent(
  context: Context,
  reason: ServiceClientCredentialsAuthLogEvent['reason'],
  message: string,
): ServiceClientCredentialsAuthLogEvent {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  return {
    event: 'service_plane.caller_auth.unauthorized',
    level: 'warn',
    message,
    path: new URL(context.req.url).pathname,
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

function defaultCallerAuthLog(event: ServiceClientCredentialsAuthLogEvent): void {
  console.warn(JSON.stringify(event));
}

function hmacUnauthorizedEvent(
  context: Context,
  reason: HmacServiceClientAuthLogEvent['reason'],
  message: string,
): HmacServiceClientAuthLogEvent {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  return {
    event: 'service_plane.caller_auth.hmac_unauthorized',
    level: 'warn',
    message,
    path: new URL(context.req.url).pathname,
    reason,
    ...(requestId ? { requestId } : {}),
  };
}

function defaultHmacCallerAuthLog(event: HmacServiceClientAuthLogEvent): void {
  console.warn(JSON.stringify(event));
}

function validateHmacTimestamp(timestamp: string, now: Date, maxSkewSeconds: number): 'invalid_timestamp' | 'timestamp_skew' | undefined {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return 'invalid_timestamp';
  const skewMs = Math.abs(now.getTime() - parsed.getTime());
  if (skewMs > maxSkewSeconds * 1000) return 'timestamp_skew';
  return undefined;
}

function hmacTimestampMessage(reason: 'invalid_timestamp' | 'timestamp_skew'): string {
  return reason === 'invalid_timestamp'
    ? 'Invalid Service-Plane HMAC timestamp'
    : 'Service-Plane HMAC timestamp is outside the allowed skew';
}

async function isHmacReplay(
  replayCache: HmacServiceClientReplayCache,
  clientId: string,
  idempotencyKey: string,
  ttlSeconds: number,
): Promise<boolean> {
  const key = `service-plane:hmac:${clientId}:${idempotencyKey}`;
  if (await replayCache.get(key)) return true;
  await replayCache.set(key, ttlSeconds);
  return false;
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
