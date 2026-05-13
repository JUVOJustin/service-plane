import type { Context, MiddlewareHandler } from 'hono';
import { proxy } from 'hono/proxy';
import { servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { type DiscoveredServiceRoute, SERVICE_PLANE_REQUEST_ID_HEADER, type ServiceRegistry } from '../shared/types.js';

export type ControlPlaneProxyOptions = {
  authorizeAuthRoute?: (context: Context, route: DiscoveredServiceRoute) => Promise<Response | undefined> | Response | undefined;
  capabilityToken?: (context: Context, route: DiscoveredServiceRoute) => Promise<string | undefined> | string | undefined;
  forwardHeaders?: (context: Context, route: DiscoveredServiceRoute) => HeadersInit | Promise<HeadersInit | undefined> | undefined;
  registry: ServiceRegistry;
  requestIdHeaderName?: string;
  shouldProxyPath?: (path: string) => boolean;
};

export function createControlPlaneProxy(options: ControlPlaneProxyOptions): MiddlewareHandler {
  return async (context, next) => {
    const url = new URL(context.req.url);
    if (options.shouldProxyPath && !options.shouldProxyPath(url.pathname)) {
      await next();
      return;
    }

    const route = await options.registry.match(context.req.method, url.pathname);
    if (!route || route.visibility === 'internal') {
      await next();
      return;
    }

    if (route.visibility === 'auth') {
      const authorizationResponse = await options.authorizeAuthRoute?.(context, route);
      if (authorizationResponse instanceof Response) return authorizationResponse;
      if (!options.authorizeAuthRoute) return context.json({ error: 'Authentication required' }, 401);
    }

    const headers = new Headers(context.req.raw.headers);
    headers.delete('authorization');
    const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
    const requestId = requestIdFromContext(context) ?? headers.get(requestIdHeaderName) ?? undefined;
    if (requestId) headers.set(requestIdHeaderName, requestId);
    const forwardHeaders = await options.forwardHeaders?.(context, route);
    if (forwardHeaders) mergeHeaders(headers, forwardHeaders);
    if (route.requiredScopes?.length) {
      const token = await options.capabilityToken?.(context, route);
      if (!token) return context.json({ error: 'Capability token required' }, 500);
      headers.set('authorization', servicePlaneAuthorization(token));
    }
    const response = await proxy(proxyTargetUrl(context.req.raw, route), {
      customFetch: (request) => route.service.fetch(request),
      raw: new Request(context.req.raw, { headers }),
    });
    return requestId ? withResponseHeader(response, requestIdHeaderName, requestId) : response;
  };
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

function proxyTargetUrl(request: Request, route: DiscoveredServiceRoute): URL {
  const source = new URL(request.url);
  const target = new URL(route.service.origin);
  target.pathname = source.pathname;
  target.search = source.search;
  return target;
}

function mergeHeaders(headers: Headers, headersInit: HeadersInit): void {
  new Headers(headersInit).forEach((value, key) => {
    headers.set(key, value);
  });
}

function withResponseHeader(response: Response, key: string, value: string): Response {
  const headers = new Headers(response.headers);
  if (!headers.has(key)) headers.set(key, value);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
