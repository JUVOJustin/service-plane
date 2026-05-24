import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { SERVICE_DISCOVERY_PATH, SERVICE_PLANE_REQUEST_ID_HEADER, type ServiceAbilityDiscovery } from '../shared/types.js';
import type { ServiceDefinition } from './discovery.js';
import { serviceDiscoveryDocument } from './discovery.js';

export type ServicePlaneLogLevel = 'info' | 'error';

export type ServicePlaneLogEvent = {
  durationMs: number;
  event: 'service_plane.discovery.served' | 'service_plane.request.completed' | 'service_plane.request.failed';
  level: ServicePlaneLogLevel;
  method: string;
  path: string;
  requestId?: string;
  ability?: {
    exposure: string;
    id: string;
    scopes?: string[];
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

  return createMiddleware(async (context, next) => {
    const startedAt = Date.now();
    const url = new URL(context.req.url);
    const ability = discovery.abilities.find((candidate) => candidate.rpc.path === url.pathname);
    const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
    const requestId = options.requestId?.(context) ?? requestIdFromContext(context) ?? context.req.header(requestIdHeaderName) ?? undefined;

    try {
      await next();
      const durationMs = Date.now() - startedAt;
      const event: ServicePlaneLogEvent = {
        durationMs,
        event: url.pathname === SERVICE_DISCOVERY_PATH ? 'service_plane.discovery.served' : 'service_plane.request.completed',
        level: 'info',
        method: context.req.method,
        path: url.pathname,
        serviceId: service.id,
        status: context.res.status,
      };
      if (requestId) event.requestId = requestId;
      if (ability) event.ability = compactAbility(ability);
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
      if (ability) event.ability = compactAbility(ability);
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

function compactAbility(ability: ServiceAbilityDiscovery): NonNullable<ServicePlaneLogEvent['ability']> {
  return {
    exposure: ability.exposure,
    id: ability.id,
    ...(ability.scopes.length ? { scopes: ability.scopes } : {}),
  };
}
