import type { Context } from 'hono';

export type ServicePlaneLogLevel = 'info' | 'warn' | 'error';

/**
 * Minimal shape every Service-Plane log event satisfies; sinks that only need
 * event name, level, and correlation id can accept this instead of a concrete union.
 */
export type ServicePlaneLoggableEvent = {
  event: string;
  level: ServicePlaneLogLevel;
  requestId?: string;
};

/**
 * Sinks receive the Hono context when the event was emitted inside a request so
 * integrations can reach request-scoped loggers; broker events emitted outside a
 * Hono handler omit it.
 */
export type ServicePlaneLogSink<TEvent extends ServicePlaneLoggableEvent = ServicePlaneLoggableEvent> = (
  event: TEvent,
  context?: Context,
) => void;

export type ServicePlaneBrokerLogEvent = {
  event:
    | 'service_plane.broker.call.completed'
    | 'service_plane.broker.call.failed'
    | 'service_plane.mcp.prompt.completed'
    | 'service_plane.mcp.prompt.failed'
    | 'service_plane.mcp.resource.completed'
    | 'service_plane.mcp.resource.failed'
    | 'service_plane.mcp.tool.completed'
    | 'service_plane.mcp.tool.failed'
    | 'service_plane.rest.completed'
    | 'service_plane.rest.failed';
  level: 'info' | 'warn';
  abilityId?: string;
  brokered?: boolean;
  callerId?: string;
  callerKind?: 'service' | 'user';
  callerOrgId?: string;
  /** Application-owned category of a plane-class principal; never an access classification. */
  callerPrincipalKind?: string;
  durationMs?: number;
  error?: {
    message: string;
    name: string;
  };
  method?: string;
  prompt?: string;
  requestId?: string;
  resource?: string;
  scopes?: ReadonlyArray<string>;
  serviceId?: string;
  status?: number;
  tool?: string;
};

export type ServicePlaneControlPlaneLogEvent = {
  event: 'service_plane.caller_auth.not_configured';
  level: 'error';
  message: string;
  path: string;
  requestId?: string;
};

export function defaultServicePlaneLogSink(event: ServicePlaneLoggableEvent): void {
  const message = JSON.stringify(event);
  if (event.level === 'error') {
    console.error(message);
    return;
  }
  if (event.level === 'warn') {
    console.warn(message);
    return;
  }
  console.log(message);
}

/**
 * Emits an operational event without allowing an application-owned sink to change request
 * behavior. Logging is best effort at every Service Plane boundary: synchronous sink failures and
 * rejected async sinks are both contained.
 *
 * @internal
 */
export function emitBestEffortServicePlaneLog<TEvent extends ServicePlaneLoggableEvent>(
  sink: ServicePlaneLogSink<TEvent> | undefined,
  event: TEvent,
  context?: Context,
): void {
  if (!sink) return;
  try {
    const result = (sink as (event: TEvent, context?: Context) => unknown)(event, context);
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
  } catch {
    // An observability integration must never turn a successful request into an application error.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}
