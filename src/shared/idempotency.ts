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

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
// Same character class the request id accepts, for the same reason: the value reaches logs and a
// service's store key, so it must not be able to smuggle separators into either.
const IDEMPOTENCY_KEY_PATTERN = /^[\w\-=]+$/u;

/**
 * Applied on both send and receive: the plane must not emit a value the service would reject, and
 * the service must not trust a value merely because it arrived from the plane.
 */
export function normalizeIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}
