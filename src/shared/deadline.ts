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
 * How long one unary ability method may run when nobody configured anything.
 *
 * A deadline nobody sets is a deadline nobody has: gRPC and Connect leave this to the caller, and
 * gRPC's own guidance is the standing reminder to "always set a deadline" — a rule that exists
 * because the unset case is unbounded. Systems that own a default instead do not need the reminder:
 * Envoy routes time out at 15s, Armeria's server request timeout is 10s. 10s matches the closest
 * analogue, a server bounding its own request handling.
 *
 * Per call and per method, never per session, for the reason Envoy documents about its route
 * timeout: a bound that suits a request is wrong for a stream. Streaming methods are exempt, and
 * session lifetime is untouched.
 */
export const DEFAULT_ABILITY_TIMEOUT_MS = 10_000;

/**
 * Added to a caller's own local wait, on top of the budget it forwards.
 *
 * Armeria defaults its client response timeout (15s) above its server request timeout (10s) so a
 * server-side timeout produces a real response instead of the client giving up first. Same idea: the
 * service's own enforcement should win, so the caller sees a `timeout` error the service actually
 * raised rather than a local abort that tells it nothing about what happened downstream.
 */
export const SERVICE_PLANE_TIMEOUT_GRACE_MS = 250;

/**
 * Policy for turning a requested budget into an effective one: a default when nothing was asked
 * for, and a ceiling on what may be asked.
 */
export type ServicePlaneTimeoutPolicy = {
  /**
   * Applied when the caller sent no budget of its own.
   */
  defaultMs?: number;
  /**
   * Clamps a caller-supplied budget. Clamped rather than refused, like the package-wide ceiling.
   */
  maxMs?: number;
};

export function resolveTimeoutMs(requested: number | undefined, policy: ServicePlaneTimeoutPolicy | undefined): number | undefined {
  const asked = normalizeTimeoutMs(requested) ?? normalizeTimeoutMs(policy?.defaultMs);
  if (asked === undefined) return undefined;
  const max = normalizeTimeoutMs(policy?.maxMs);
  return max === undefined ? asked : Math.min(asked, max);
}

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
