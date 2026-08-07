import { ServicePlaneError } from './errors.js';

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

/**
 * Turns a requested budget into the effective one under a policy: the default fills in when the
 * caller asked for nothing, and the ceiling clamps what may be asked — including the default.
 */
export function resolveTimeoutMs(requested: number | undefined, policy: ServicePlaneTimeoutPolicy | undefined): number | undefined {
  const asked = normalizeTimeoutMs(requested) ?? normalizeTimeoutMs(policy?.defaultMs);
  if (asked === undefined) return undefined;
  const max = normalizeTimeoutMs(policy?.maxMs);
  return max === undefined ? asked : Math.min(asked, max);
}

/**
 * Rejects a policy whose values the normalizer would silently drop. `maxMs: 0` would otherwise
 * remove the clamp entirely — the exact opposite of what an operator writing it intends — so
 * misconfiguration fails at construction rather than silently loosening at runtime.
 */
export function validateTimeoutPolicy(policy: ServicePlaneTimeoutPolicy | undefined): ServicePlaneTimeoutPolicy | undefined {
  if (!policy) return policy;
  for (const [field, value] of [
    ['defaultMs', policy.defaultMs],
    ['maxMs', policy.maxMs],
  ] as const) {
    if (value === undefined) continue;
    if (normalizeTimeoutMs(value) !== value) {
      throw new ServicePlaneError(
        `Service-Plane timeout policy ${field} must be a positive integer no greater than ${MAX_SERVICE_PLANE_TIMEOUT_MS} milliseconds`,
      );
    }
  }
  return policy;
}

/**
 * The header-or-query read both shells share. Header wins because it is the primary channel; the
 * query parameter exists only for WebSocket upgrades, which cannot carry custom headers portably.
 * One implementation so the plane and the service cannot disagree about a request carrying both.
 */
export function timeoutMsFromRequest(request: ForwardedValueSource): number | undefined {
  return parseTimeoutMs(request.header(SERVICE_PLANE_TIMEOUT_HEADER) ?? request.query(SERVICE_PLANE_TIMEOUT_QUERY_PARAM));
}

/**
 * Structural view of a Hono request: just enough to read a forwarded value from header or query.
 */
export type ForwardedValueSource = {
  header(name: string): string | undefined;
  query(name: string): string | undefined;
};

/**
 * Bounds for one in-flight call, raced by {@link raceDeadline}. `deadlineAt` is the caller's
 * absolute deadline on this machine's clock; `ceilingMs` is the method's own limit measured from
 * now. Whichever is nearer arms the single timer.
 */
export type RaceDeadlineOptions = {
  ceilingError?: (ceilingMs: number) => Error;
  ceilingMs?: number;
  deadlineAt?: number;
  deadlineError: () => Error;
  /**
   * Called with a result that arrived after the race was lost, so a disposable value — a Cap'n Web
   * stub, a ReadableStream — is released instead of pinning its remote resource on a live session.
   */
  discardLateValue?: (value: unknown) => void;
};

/**
 * One race, one clearable timer, both settle paths released. An already-expired deadline rejects
 * immediately — an abort listener would never fire for it — and the losing outcome stays handled so
 * a late rejection cannot surface as an unhandled one.
 */
export function raceDeadline<T>(call: Promise<T>, options: RaceDeadlineOptions): Promise<T> {
  const now = Date.now();
  const remaining = options.deadlineAt === undefined ? undefined : options.deadlineAt - now;
  if (remaining !== undefined && remaining <= 0) {
    // The call is already running; its eventual outcome must stay handled and any late value freed.
    call.then(
      (value) => options.discardLateValue?.(value),
      () => undefined,
    );
    return Promise.reject(options.deadlineError());
  }
  const ceiling = options.ceilingMs;
  if (remaining === undefined && ceiling === undefined) return call;

  const deadlineIsNearer = ceiling === undefined || (remaining !== undefined && remaining < ceiling);
  const waitMs = deadlineIsNearer ? (remaining as number) : (ceiling as number);
  return new Promise<T>((resolve, reject) => {
    let lost = false;
    const timer = setTimeout(() => {
      lost = true;
      reject(deadlineIsNearer || !options.ceilingError ? options.deadlineError() : options.ceilingError(ceiling as number));
    }, waitMs);
    call.then(
      (value) => {
        clearTimeout(timer);
        if (lost) {
          options.discardLateValue?.(value);
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * Best-effort release of a value nobody will consume: Cap'n Web stubs expose the platform dispose
 * hooks, and a streaming method's ReadableStream must be cancelled or its source stays pinned.
 */
export function discardDisposableValue(value: unknown): void {
  try {
    if (value instanceof ReadableStream) {
      void value.cancel().catch(() => undefined);
      return;
    }
    const disposable = value as Record<symbol, (() => unknown) | undefined> | null;
    if (typeof value === 'object' && value !== null) {
      const dispose = disposable?.[Symbol.asyncDispose as unknown as symbol] ?? disposable?.[Symbol.dispose as unknown as symbol];
      if (typeof dispose === 'function') void Promise.resolve(dispose.call(value)).catch(() => undefined);
    }
  } catch {
    // Cleanup must never turn a timeout into a different failure.
  }
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

/**
 * Wire form of a budget, or nothing when the value is not one a peer would accept.
 */
export function serializeTimeoutMs(timeoutMs: number | undefined): string | undefined {
  const normalized = normalizeTimeoutMs(timeoutMs);
  return normalized === undefined ? undefined : String(normalized);
}

/**
 * Reads the wire form a peer sent. Digits only, bounded, clamped — never trusted merely because it
 * arrived from the plane.
 */
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
