// A remote cache slower than fresh work is no longer helping the call. This is deliberately short
// and internal: cache implementations retain their own retry policy while the plane retains its
// availability boundary.
const DEFAULT_BEST_EFFORT_CACHE_TIMEOUT_MS = 1_000;

const CACHE_OPERATION_TIMED_OUT = Symbol('service-plane.cache-operation-timed-out');

// Cache availability must never become control-plane availability; callers still own validation
// and fresh generation after a miss.
export async function runBestEffortCacheOperation<T>(
  operation: (() => Promise<T>) | undefined,
  timeoutMs = DEFAULT_BEST_EFFORT_CACHE_TIMEOUT_MS,
): Promise<T | undefined> {
  if (!operation) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = Promise.resolve().then(operation);
    const timeout = new Promise<typeof CACHE_OPERATION_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(CACHE_OPERATION_TIMED_OUT), timeoutMs);
    });
    const value = await Promise.race([result, timeout]);
    return value === CACHE_OPERATION_TIMED_OUT ? undefined : value;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
