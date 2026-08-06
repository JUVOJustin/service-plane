/**
 * A call deadline travels as the milliseconds still available, not as an absolute timestamp. Two
 * clocks that disagree would shift an absolute deadline by the whole skew, and this package already
 * assumes clocks can differ — proofs of possession tolerate 60 seconds of it. A relative value is
 * immune to that: each hop measures its own elapsed time on its own clock and forwards what is left.
 * gRPC's `grpc-timeout` makes the same trade for the same reason.
 */
export const SERVICE_PLANE_TIMEOUT_HEADER = 'X-Service-Plane-Timeout';
/**
 * WebSocket upgrades cannot carry custom headers portably, mirroring the request id and conn info.
 */
export const SERVICE_PLANE_TIMEOUT_QUERY_PARAM = 'timeout';

/**
 * Ceiling on a forwarded deadline. A caller asking for more is clamped rather than refused: the
 * request is still answerable, and an unbounded budget is the condition a deadline exists to remove.
 */
export const MAX_SERVICE_PLANE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Applied on both send and receive, like conn info: the plane must not emit a value the service
 * would reject, and the service must not trust a value merely because it arrived from the plane.
 * Returns undefined for anything that is not a usable positive budget.
 */
export function normalizeTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return Math.min(value, MAX_SERVICE_PLANE_TIMEOUT_MS);
}

export function serializeTimeoutMs(timeoutMs: number | undefined): string | undefined {
  const normalized = normalizeTimeoutMs(timeoutMs);
  return normalized === undefined ? undefined : String(normalized);
}

export function parseTimeoutMs(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim();
  // Digits only, and short enough that a hostile value cannot turn into a huge Number parse. The
  // ceiling above still clamps anything inside that shape.
  if (!trimmed || trimmed.length > 12 || !/^\d+$/u.test(trimmed)) return undefined;
  return normalizeTimeoutMs(Number(trimmed));
}

/**
 * What is left of `timeoutMs` after `elapsedMs` on this hop. Returns 0 once the budget is gone, so
 * callers can distinguish "no deadline" (undefined) from "deadline already exceeded" (0).
 */
export function remainingTimeoutMs(timeoutMs: number | undefined, elapsedMs: number): number | undefined {
  const normalized = normalizeTimeoutMs(timeoutMs);
  if (normalized === undefined) return undefined;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return normalized;
  return Math.max(0, Math.floor(normalized - elapsedMs));
}
