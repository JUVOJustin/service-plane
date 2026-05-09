import type { Context, MiddlewareHandler } from 'hono';
import type { DiscoveredServiceRoute, ServiceRegistry } from '../shared/types.js';
import { servicePlaneAuthorization } from '../shared/capability-tokens.js';

export type ControlPlaneProxyOptions = {
  authorizeAuthRoute?: (context: Context, route: DiscoveredServiceRoute) => Promise<void | Response> | void | Response;
  capabilityToken?: (context: Context, route: DiscoveredServiceRoute) => Promise<string | undefined> | string | undefined;
  forwardHeaders?: (context: Context, route: DiscoveredServiceRoute) => HeadersInit | Promise<HeadersInit | undefined> | undefined;
  registry: ServiceRegistry;
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

    let request = rewriteRequest(context.req.raw, route);
    const headers = await options.forwardHeaders?.(context, route);
    if (headers) request = withHeaders(request, headers);
    if (route.requiredScopes?.length) {
      const token = await options.capabilityToken?.(context, route);
      if (!token) return context.json({ error: 'Capability token required' }, 500);
      request = withHeaders(request, { authorization: servicePlaneAuthorization(token) });
    }
    return route.service.fetch(request);
  };
}

function rewriteRequest(request: Request, route: DiscoveredServiceRoute): Request {
  const source = new URL(request.url);
  const target = new URL(route.service.origin);
  target.pathname = source.pathname;
  target.search = source.search;
  return new Request(target, request);
}

function withHeaders(request: Request, headersInit: HeadersInit): Request {
  const headers = new Headers(request.headers);
  new Headers(headersInit).forEach((value, key) => headers.set(key, value));
  return new Request(request, { headers });
}
