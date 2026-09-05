import { Context, type Env } from 'hono';
import { preserveRuntimeRequestMetadata } from './request-preparation.js';

/** Reads the request id that hono/request-id or a Service Plane shell stored on the context. */
export function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

/** Overlays one logical call's headers, as the private engine presents them, onto the physical request's. */
export function mergedRequestHeaders(physical: Headers, logical: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers(physical);
  for (const [name, value] of Object.entries(logical)) {
    if (value === undefined) continue;
    headers.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * A per-call Hono context that keeps the physical request's env, execution context, path, and
 * variables while carrying the logical call's own headers, method, signal, and request id. Handlers
 * and middleware then see one request per call even when a batch or a socket multiplexed several.
 */
export function deriveRequestContext<TEnv extends Env>(
  base: Context<TEnv>,
  init: { headers: Headers; method?: string | undefined; signal?: AbortSignal | undefined },
  requestId: string | undefined,
): Context<TEnv> {
  const request = preserveRuntimeRequestMetadata(
    base.req.raw,
    new Request(base.req.url, {
      headers: init.headers,
      method: init.method ?? base.req.method,
      ...(init.signal ? { signal: init.signal } : {}),
    }),
  );
  const context = new Context<TEnv>(request, { env: base.env, ...executionOptions(base), path: base.req.path });
  for (const [name, value] of Object.entries(base.var)) context.set(name as never, value as never);
  if (requestId) context.set('requestId' as never, requestId as never);
  return context;
}

// Hono throws when a context has no execution context, which is the case for plain Node requests.
function executionOptions(context: Context): { executionCtx?: Context['executionCtx'] } {
  try {
    return { executionCtx: context.executionCtx };
  } catch {
    return {};
  }
}
