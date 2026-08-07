import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { defaultServicePlaneLogSink, type ServicePlaneLogLevel } from '../shared/logging.js';
import {
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  SERVICE_PLANE_REQUEST_ID_QUERY_PARAM,
  type ServiceAbilityDiscovery,
} from '../shared/types.js';
import type { ServiceDefinition } from './discovery.js';
import { serviceDiscoveryDocument } from './discovery.js';

export type { ServicePlaneLogLevel } from '../shared/logging.js';

/**
 * One HTTP request through the service shell.
 */
export type ServicePlaneRequestLogEvent = {
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

/**
 * An unshaped handler throw the validating wrapper replaced with an opaque error. The caller only
 * ever sees the replacement, so this event is the service's record of what actually broke; the RPC
 * response itself is a 200 batch, which is why `request.failed` never fires for it.
 */
export type ServicePlaneHandlerFailureLogEvent = {
  abilityId: string;
  error: {
    message: string;
    name: string;
  };
  event: 'service_plane.ability.handler_failed';
  level: 'error';
  method: string;
  requestId?: string;
  serviceId: string;
};

export type ServicePlaneLogEvent = ServicePlaneHandlerFailureLogEvent | ServicePlaneRequestLogEvent;

/**
 * Hono context variables the logger maintains so app middleware mounted outside it
 * can read the emitted events after `await next()`.
 */
export type ServicePlaneLogVariables = {
  servicePlaneLogEvents?: ServicePlaneLogEvent[];
};

export type ServicePlaneLoggerOptions = {
  log?: (event: ServicePlaneLogEvent, context?: Context) => void;
  requestIdHeaderName?: string;
  requestId?: (context: Context) => string | undefined;
};

/**
 * Emits structured, token-safe logs for service requests without owning the app logger.
 */
export function servicePlaneLogger(service: ServiceDefinition, options: ServicePlaneLoggerOptions = {}) {
  const discovery = serviceDiscoveryDocument(service);
  const write = options.log ?? defaultServicePlaneLogSink;

  return createMiddleware(async (context, next) => {
    const startedAt = Date.now();
    const url = new URL(context.req.url);
    const ability = discovery.abilities.find((candidate) => candidate.rpc.path === url.pathname);
    const requestId = resolveRequestId(context, options);

    try {
      await next();
      const durationMs = Date.now() - startedAt;
      const event: ServicePlaneRequestLogEvent = {
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
      stashLogEvent(context, event);
      write(event, context);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const event: ServicePlaneRequestLogEvent = {
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
      stashLogEvent(context, event);
      write(event, context);
      throw error;
    }
  });
}

export function servicePlaneLogEvents(context: Context): ServicePlaneLogEvent[] {
  const value = context.get('servicePlaneLogEvents' as never) as unknown;
  return Array.isArray(value) ? (value as ServicePlaneLogEvent[]) : [];
}

// Incoming header (and its WebSocket query-param fallback) wins over the context variable so
// brokered request ids survive even when a local request-id middleware generated a fresh id.
function resolveRequestId(context: Context, options: ServicePlaneLoggerOptions): string | undefined {
  const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
  return (
    options.requestId?.(context) ??
    (context.req.header(requestIdHeaderName)?.trim() || undefined) ??
    (context.req.query(SERVICE_PLANE_REQUEST_ID_QUERY_PARAM)?.trim() || undefined) ??
    requestIdFromContext(context) ??
    undefined
  );
}

/**
 * Appends an event to the request's `servicePlaneLogEvents` context variable, creating it when the
 * logger middleware has not run. Exported for the shell's own out-of-band events (handler failures
 * surface mid-RPC, not at request completion) so app middleware reads one list either way.
 */
export function recordServicePlaneLogEvent(context: Context, event: ServicePlaneLogEvent): void {
  stashLogEvent(context, event);
}

function stashLogEvent(context: Context, event: ServicePlaneLogEvent): void {
  const events = context.get('servicePlaneLogEvents' as never) as ServicePlaneLogEvent[] | undefined;
  if (Array.isArray(events)) {
    events.push(event);
    return;
  }
  context.set('servicePlaneLogEvents' as never, [event] as never);
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

function compactAbility(ability: ServiceAbilityDiscovery): NonNullable<ServicePlaneRequestLogEvent['ability']> {
  return {
    exposure: ability.exposure,
    id: ability.id,
    ...(ability.scopes.length ? { scopes: ability.scopes } : {}),
  };
}
