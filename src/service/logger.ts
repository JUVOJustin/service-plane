import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { pathMatches } from '../shared/paths.js';
import {
  type CapabilityAuthVariables,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceDefinition,
  type ServiceRouteDiscovery,
} from '../shared/types.js';
import { capabilityIdentity } from './capabilities.js';
import { serviceDiscoveryDocument } from './discovery.js';

export type ServicePlaneLogLevel = 'info' | 'error';

export type ServicePlaneLogEvent = {
  durationMs: number;
  event: 'service_plane.discovery.served' | 'service_plane.request.completed' | 'service_plane.request.failed';
  level: ServicePlaneLogLevel;
  method: string;
  path: string;
  requestId?: string;
  route?: {
    requiredScopes?: string[];
    visibility: ServiceRouteDiscovery['visibility'];
  };
  serviceId: string;
  status: number;
  callerServiceId?: string;
  error?: {
    message: string;
    name: string;
  };
};

export type ServicePlaneLoggerOptions = {
  log?: (event: ServicePlaneLogEvent) => void;
  requestIdHeaderName?: string;
  requestId?: (context: Context) => string | undefined;
};

// Emits structured, token-safe logs for service requests without owning the app logger.
export function servicePlaneLogger(service: ServiceDefinition, options: ServicePlaneLoggerOptions = {}) {
  const discovery = serviceDiscoveryDocument(service);
  const write = options.log ?? defaultLog;

  return createMiddleware<CapabilityAuthVariables>(async (context, next) => {
    const startedAt = Date.now();
    const url = new URL(context.req.url);
    const route = discovery.routes.find(
      (candidate) => candidate.method === context.req.method.toUpperCase() && pathMatches(candidate.path, url.pathname),
    );
    const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
    const requestId = options.requestId?.(context) ?? requestIdFromContext(context) ?? context.req.header(requestIdHeaderName) ?? undefined;

    try {
      await next();
      const durationMs = Date.now() - startedAt;
      const identity = capabilityIdentity(context);
      const event: ServicePlaneLogEvent = {
        durationMs,
        event: url.pathname === SERVICE_DISCOVERY_PATH ? 'service_plane.discovery.served' : 'service_plane.request.completed',
        level: 'info',
        method: context.req.method,
        path: url.pathname,
        serviceId: service.id,
        status: context.res.status,
      };
      if (identity) event.callerServiceId = identity.serviceId;
      if (requestId) event.requestId = requestId;
      if (route) event.route = compactRoute(route);
      write(event);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const event: ServicePlaneLogEvent = {
        durationMs,
        error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error), name: 'Error' },
        event: 'service_plane.request.failed',
        level: 'error',
        method: context.req.method,
        path: url.pathname,
        serviceId: service.id,
        status: context.res.status >= 400 ? context.res.status : 500,
      };
      if (requestId) event.requestId = requestId;
      if (route) event.route = compactRoute(route);
      write(event);
      throw error;
    }
  });
}

function defaultLog(event: ServicePlaneLogEvent): void {
  const message = JSON.stringify(event);
  if (event.level === 'error') {
    console.error(message);
    return;
  }
  console.log(message);
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

function compactRoute(route: ServiceRouteDiscovery): NonNullable<ServicePlaneLogEvent['route']> {
  return {
    ...(route.requiredScopes?.length ? { requiredScopes: route.requiredScopes } : {}),
    visibility: route.visibility,
  };
}
