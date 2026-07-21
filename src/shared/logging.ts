import type { Context } from 'hono';

export type ServicePlaneLogLevel = 'info' | 'warn' | 'error';

// Minimal shape every Service-Plane log event satisfies; sinks that only need
// event name, level, and correlation id can accept this instead of a concrete union.
export type ServicePlaneLoggableEvent = {
  event: string;
  level: ServicePlaneLogLevel;
  requestId?: string;
};

// Sinks receive the Hono context when the event was emitted inside a request so
// integrations can reach request-scoped loggers; broker events emitted outside a
// Hono handler omit it.
export type ServicePlaneLogSink<TEvent extends ServicePlaneLoggableEvent = ServicePlaneLoggableEvent> = (
  event: TEvent,
  context?: Context,
) => void;

export type ServicePlaneBrokerLogEvent = {
  event:
    | 'service_plane.broker.connect.completed'
    | 'service_plane.broker.connect.failed'
    | 'service_plane.mcp.prompt.completed'
    | 'service_plane.mcp.prompt.failed'
    | 'service_plane.mcp.resource.completed'
    | 'service_plane.mcp.resource.failed'
    | 'service_plane.mcp.tool.completed'
    | 'service_plane.mcp.tool.failed';
  level: 'info' | 'warn';
  abilityId?: string;
  brokered?: boolean;
  callerId?: string;
  callerKind?: 'service' | 'user';
  durationMs?: number;
  error?: {
    message: string;
    name: string;
  };
  method?: string;
  prompt?: string;
  requestId?: string;
  resource?: string;
  scopes?: string[];
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
