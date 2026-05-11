import {
  newHttpBatchRpcSession,
  newWebSocketRpcSession,
  RpcSession,
  type RpcCompatible,
  type RpcSessionOptions,
  type RpcStub,
  type RpcTransport,
} from 'capnweb';
import { CapabilityAuthError } from '../shared/errors.js';
import { decodeCapabilityTokenPayload } from '../shared/capability-tokens.js';
import {
  type CapabilityTokenCache,
  type CapabilityTokenProvider,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
} from '../shared/types.js';
import { normalizeScopes, normalizeValue } from './capabilities.js';

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

export type CreateCapabilityTokenProviderOptions = {
  cache?: CapabilityTokenCache;
  cacheKey?: string;
  callerServiceId: string;
  now?: () => Date;
  refreshSkewSeconds?: number;
  requestToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken | { expiresAt: Date | string; token: string }>;
  scopes: string[];
  targetServiceId: string;
  ttlSeconds?: number;
};

export function createCapabilityTokenProvider(options: CreateCapabilityTokenProviderOptions): CapabilityTokenProvider {
  let cached: { expiresAt: Date; token: string } | undefined;
  const refreshSkewSeconds = options.refreshSkewSeconds ?? 10;
  const callerServiceId = normalizeValue(options.callerServiceId, 'caller service id');
  const targetServiceId = normalizeValue(options.targetServiceId, 'target service id');
  const scopes = normalizeScopes(options.scopes);
  const ttlSeconds = options.ttlSeconds === undefined ? undefined : normalizeTtlSeconds(options.ttlSeconds);
  const cacheKey = options.cacheKey ?? capabilityTokenCacheKey({
    callerServiceId,
    scopes,
    targetServiceId,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  });

  return {
    async token() {
      const now = options.now?.() ?? new Date();
      if (cached && cached.expiresAt.getTime() - refreshSkewSeconds * 1000 > now.getTime()) return cached.token;

      const shared = await readCapabilityTokenCache(options.cache, cacheKey, now, refreshSkewSeconds);
      if (shared) {
        cached = shared;
        return shared.token;
      }

      const issued = await options.requestToken({
        callerServiceId,
        scopes,
        targetServiceId,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
      });
      cached = {
        expiresAt: issued.expiresAt instanceof Date ? issued.expiresAt : new Date(issued.expiresAt),
        token: issued.token,
      };
      await writeCapabilityTokenCache(options.cache, cacheKey, cached, now);
      return cached.token;
    },
  };
}

export function capabilityTokenCacheKey(input: { callerServiceId: string; scopes: string[]; targetServiceId: string; ttlSeconds?: number }): string {
  const parts = {
    callerServiceId: input.callerServiceId,
    scopes: [...input.scopes].sort(),
    targetServiceId: input.targetServiceId,
    ttlSeconds: input.ttlSeconds ?? null,
  };
  return `service-plane:capability-token:${encodeURIComponent(JSON.stringify(parts))}`;
}

export function tokenExpiresAt(token: string): Date {
  return new Date(decodeCapabilityTokenPayload(token).exp * 1000);
}

// ---------------------------------------------------------------------------
// RPC client sessions
//
// Cap'n Web sessions carry the bootstrap token in-band. `api.authenticate(t)`
// returns a pipelined `RpcPromise<ScopedApi>` that doubles as an `RpcStub`,
// so the caller's first method call rides the same round trip on HTTP-batch
// transport.
// ---------------------------------------------------------------------------

/**
 * Conventional shape of a service's exported public root capability that
 * supports the Service-Plane authentication handshake. Service authors
 * should make their own root types extend this so clients get end-to-end
 * type inference:
 *
 *     interface ExampleRoot extends AuthenticatedRoot<ExampleScopedApi> {}
 */
export interface AuthenticatedRoot<Scoped> {
  authenticate(token: string): Scoped;
}

export type CapabilityRpcTransport =
  | { kind: 'http-batch'; url: string | URL }
  | { kind: 'websocket'; url: string }
  | { kind: 'custom'; transport: RpcTransport };

export type CapabilityRpcSessionOptions<Scoped> = (
  | (CreateCapabilityTokenProviderOptions & { tokenProvider?: undefined })
  | ({ tokenProvider: CapabilityTokenProvider } & Pick<CreateCapabilityTokenProviderOptions, 'callerServiceId' | 'scopes' | 'targetServiceId'>)
) & {
  /** Cap'n Web session options forwarded to the underlying transport. */
  rpcSessionOptions?: RpcSessionOptions;
  /** Transport. Use the `'http-batch'` preset for service-to-service calls,
   * `'websocket'` for long-lived browser sessions, or `'custom'` to plug in
   * an in-memory `RpcTransport` (e.g. for tests). */
  transport: CapabilityRpcTransport;
  /**
   * Optional adapter for services that name their handshake differently
   * from the default `authenticate(token)`.
   */
  authenticate?: (root: RpcStub<AuthenticatedRoot<Scoped>>, token: string) => RpcStub<Scoped>;
};

/**
 * Open a Cap'n Web RPC session against a target service, request a capability
 * token for the configured caller/scopes, and return the authenticated
 * pipelined stub. Promise pipelining means the bootstrap call and the
 * caller's first method call ride the same network round trip on HTTP-batch
 * transport.
 *
 * Cap'n Web invalidates HTTP-batch stubs after the batch completes; use
 * `'websocket'` (or open a fresh session per batch) for long-lived
 * interactive flows.
 */
export async function capabilityRpcSession<Scoped extends RpcCompatible<Scoped>>(
  options: CapabilityRpcSessionOptions<Scoped>,
): Promise<RpcStub<Scoped>> {
  const tokenProvider = options.tokenProvider ?? createCapabilityTokenProvider(options as CreateCapabilityTokenProviderOptions);
  const token = await tokenProvider.token();
  const root = openSession<Scoped>(options.transport, options.rpcSessionOptions);
  const authenticate = options.authenticate ?? defaultAuthenticate<Scoped>;
  return authenticate(root, token);
}

function defaultAuthenticate<Scoped>(
  root: RpcStub<AuthenticatedRoot<Scoped>>,
  token: string,
): RpcStub<Scoped> {
  return root.authenticate(token) as unknown as RpcStub<Scoped>;
}

function openSession<Scoped extends RpcCompatible<Scoped>>(
  transport: CapabilityRpcTransport,
  rpcSessionOptions?: RpcSessionOptions,
): RpcStub<AuthenticatedRoot<Scoped>> {
  if (transport.kind === 'http-batch') {
    return newHttpBatchRpcSession<AuthenticatedRoot<Scoped>>(String(transport.url), rpcSessionOptions);
  }
  if (transport.kind === 'websocket') {
    return newWebSocketRpcSession<AuthenticatedRoot<Scoped>>(transport.url, undefined, rpcSessionOptions);
  }
  const session = new RpcSession<AuthenticatedRoot<Scoped>>(transport.transport, undefined, rpcSessionOptions);
  return session.getRemoteMain();
}

// ---------------------------------------------------------------------------
// Cache plumbing
// ---------------------------------------------------------------------------

async function readCapabilityTokenCache(
  cache: CapabilityTokenCache | undefined,
  key: string,
  now: Date,
  refreshSkewSeconds: number,
): Promise<{ expiresAt: Date; token: string } | undefined> {
  if (!cache) return undefined;
  try {
    const value = await cache.get(key);
    if (!value) return undefined;
    const expiresAt = value.expiresAt instanceof Date ? value.expiresAt : new Date(value.expiresAt);
    if (expiresAt.getTime() - refreshSkewSeconds * 1000 <= now.getTime()) return undefined;
    return { expiresAt, token: value.token };
  } catch {
    return undefined;
  }
}

async function writeCapabilityTokenCache(
  cache: CapabilityTokenCache | undefined,
  key: string,
  value: { expiresAt: Date; token: string },
  now: Date,
): Promise<void> {
  if (!cache) return;
  const ttlSeconds = Math.floor((value.expiresAt.getTime() - now.getTime()) / 1000);
  if (ttlSeconds <= 0) return;
  try {
    await cache.set(key, value, ttlSeconds);
  } catch {
    return;
  }
}

function normalizeTtlSeconds(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CapabilityAuthError('Service-Plane capability token TTL must be a positive integer', 500);
  }
  return ttlSeconds;
}
