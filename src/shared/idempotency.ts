/**
 * A caller-chosen key identifying one logical attempt, so a service can recognize a retry of it.
 * The package forwards the key and nothing else: deduplicating needs a store with a retention
 * policy, and that belongs to the service, the same way discovery snapshots and token caches do.
 */
export const SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER = 'X-Service-Plane-Idempotency-Key';
/**
 * WebSocket upgrades cannot carry custom headers portably, mirroring the request id.
 */
export const SERVICE_PLANE_IDEMPOTENCY_KEY_QUERY_PARAM = 'idempotency_key';

// One rule for every forwarded token-shaped value (request ids share it): the value reaches logs
// and a service's store key, so it must not be able to smuggle separators into either.
const FORWARDED_TOKEN_PATTERN = /^[\w\-=]+$/u;

/**
 * The trim / length / charset rule shared by every token-shaped forwarded value — idempotency keys
 * here, request ids in the service shell. One implementation so the two cannot drift into accepting
 * different alphabets for values that ride the same channels.
 */
export function normalizeForwardedToken(value: unknown, maxLength = 255): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !FORWARDED_TOKEN_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Applied on both send and receive: the plane must not emit a value the service would reject, and
 * the service must not trust a value merely because it arrived from the plane.
 */
export function normalizeIdempotencyKey(value: unknown): string | undefined {
  return normalizeForwardedToken(value);
}

/**
 * The header-or-query read both shells share, mirroring the timeout reader: header wins, the query
 * parameter exists for WebSocket upgrades.
 */
export function idempotencyKeyFromRequest(request: {
  header(name: string): string | undefined;
  query(name: string): string | undefined;
}): string | undefined {
  return normalizeIdempotencyKey(
    request.header(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER) ?? request.query(SERVICE_PLANE_IDEMPOTENCY_KEY_QUERY_PARAM),
  );
}
