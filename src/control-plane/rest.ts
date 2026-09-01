import { readBoundedRequestText } from '../shared/body-limit.js';
import { CapabilityAuthError, servicePlaneErrorInfo } from '../shared/errors.js';
import { jsonSchemaRootProperties } from '../shared/json-schema.js';
import { emitBestEffortServicePlaneLog, type ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import type {
  DiscoveredServiceAbility,
  OpenApiObject,
  ServiceHttpMethod,
  ServiceRegistry,
  ServiceRegistrySnapshot,
} from '../shared/types.js';
import { brokerCallerLogFields } from './caller.js';
import {
  assertControlPlaneOperationCanStart,
  type ControlPlaneInvocationOptions,
  invokeControlPlaneMethod,
  raceControlPlaneOperation,
} from './invocation.js';

const DEFAULT_REST_MAX_BODY_BYTES = 1_048_576;
const REST_BODY_TOO_LARGE_MESSAGE = 'Service-Plane REST request body is too large';
const REST_METHODS = ['delete', 'get', 'patch', 'post', 'put', 'query'] as const satisfies readonly ServiceHttpMethod[];

/** Published REST operation selected from one request-scoped discovery snapshot. */
export type ControlPlaneRestInvocation = {
  /** Ability selected from the discovery snapshot used for route matching. */
  abilityId: string;
  /** Method selected after matching the request verb and path template. */
  method: string;
  /** Published path template that matched the request, before parameter substitution. */
  path: string;
  /** Method scopes requested when the plane mints the downstream capability. */
  readonly scopes: ReadonlyArray<string>;
  /** Catalog service that owns the matched ability. */
  serviceId: string;
  /**
   * Discriminator for shared invocation middleware and audit-event unions. Keep it literal so
   * consumers can narrow to REST route metadata without inspecting route-specific fields.
   */
  surface: 'rest';
};

/** Dependencies and policy hooks for the low-level REST projection dispatcher. */
export type ControlPlaneRestHandlerOptions = {
  /** Maximum JSON request-body size. Defaults to one MiB. */
  maxBodyBytes?: number;
  /** Receives completion and failure events for matched REST invocations. */
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  /** Receives the resolved service, ability, and method before invocation. */
  onInvocation?: (invocation: ControlPlaneRestInvocation) => void;
  /** Continues application routing when no published REST path matches. */
  onNotFound?: () => Promise<Response> | Response;
  /** Time the HTTP request entered the plane, used for deadline accounting. */
  receivedAt?: number;
  /** Registry used to resolve published REST metadata. */
  registry: Pick<ServiceRegistry, 'discover'>;
  /** Lazily resolves authenticated invocation facts from the snapshot that matched the route. */
  resolveInvocation: (snapshot: ServiceRegistrySnapshot) => Promise<ControlPlaneInvocationOptions | Response>;
  /** Runs authentication before discovery; matched invocation metadata is available after `next()`. */
  runInvocationMiddleware?: (next: () => Promise<Response>) => Promise<Response>;
  /** Effective request-entry deadline used while the public route is still being resolved. */
  timeoutMs?: number;
};

type RestMatch = {
  ability: DiscoveredServiceAbility;
  httpMethod: ServiceHttpMethod;
  method: string;
  params: Record<string, string>;
  scopes: ReadonlyArray<string>;
  staticSegments: number;
};

type CompiledRestPathSegment = { parameter: string } | { static: string };

type CompiledRestRoute = {
  abilityIndex: number;
  method: string;
  segments: CompiledRestPathSegment[];
  staticSegments: number;
};

type RestRouteIndex = Map<number, CompiledRestRoute[]>;

// A registry cache preserves the discovery document's services array while rebuilding endpoint-
// bound abilities for each request. Cache only route coordinates and tokens against that stable
// array: matching becomes allocation-light without retaining an old binding or grant set.
const restRouteIndexes = new WeakMap<ServiceRegistrySnapshot['services'], RestRouteIndex>();

/** Dispatches one HTTP request through published REST projection metadata. */
export async function handleControlPlaneRestRequest(request: Request, options: ControlPlaneRestHandlerOptions): Promise<Response> {
  const startedAt = Date.now();
  let matched: RestMatch | undefined;
  let invocationOptions: ControlPlaneInvocationOptions | undefined;
  const failureResponse = (error: unknown): Response => {
    if (matched) {
      const errorInfo = servicePlaneErrorInfo(error);
      emitBestEffortServicePlaneLog(options.log, {
        abilityId: matched.ability.id,
        ...brokerCallerLogFields(invocationOptions?.caller),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error), name: 'Error' },
        event: 'service_plane.rest.failed',
        level: 'warn',
        method: matched.method,
        ...(invocationOptions?.requestId ? { requestId: invocationOptions.requestId } : {}),
        scopes: matched.scopes,
        serviceId: matched.ability.serviceId,
        ...(errorInfo ? { status: errorInfo.status } : {}),
      });
    }
    return restErrorResponse(error);
  };
  // Authentication may bind a signature to the body. Give the decoder a separate branch before
  // middleware runs, and release both branches on every miss, refusal, timeout, or invocation.
  const decodingRequest = options.runInvocationMiddleware ? request.clone() : request;
  const dispatch = async (): Promise<Response> => {
    try {
      // Middleware may call next after the outer deadline race has already returned a 504. Refuse
      // that late continuation before it can fan out discovery work in the background.
      assertControlPlaneOperationCanStart(options, 'REST route discovery');
      const snapshot = await raceControlPlaneOperation(options.registry.discover(), options, 'REST route discovery');
      const url = new URL(request.url);
      const method = request.method.toLowerCase();
      const pathMatches = restMatches(snapshot, url.pathname);
      if (!isRestMethod(method)) return restRouteMiss(pathMatches, options.onNotFound);

      const match = findRestMethod(pathMatches, method, url.pathname);
      if (!match) return restRouteMiss(pathMatches, options.onNotFound);
      matched = match;

      options.onInvocation?.({
        abilityId: match.ability.id,
        method: match.method,
        path: match.ability.methods[match.method]?.rest?.path ?? url.pathname,
        scopes: match.scopes,
        serviceId: match.ability.serviceId,
        surface: 'rest',
      });
      const resolved = await raceControlPlaneOperation(options.resolveInvocation(snapshot), options, 'REST caller and issuer resolution');
      if (resolved instanceof Response) return resolved;
      invocationOptions = resolved;
      const input = await raceControlPlaneOperation(
        restInput(
          decodingRequest,
          url,
          match.params,
          options.maxBodyBytes ?? DEFAULT_REST_MAX_BODY_BYTES,
          match.ability.methods[match.method]?.inputSchema,
        ),
        options,
        'REST request decoding',
      );
      const result = await invokeControlPlaneMethod(match, input, invocationOptions);
      const status = match.ability.methods[match.method]?.rest?.status ?? 200;
      emitBestEffortServicePlaneLog(options.log, {
        abilityId: match.ability.id,
        ...brokerCallerLogFields(invocationOptions.caller),
        durationMs: Date.now() - startedAt,
        event: 'service_plane.rest.completed',
        level: 'info',
        method: match.method,
        ...(invocationOptions.requestId ? { requestId: invocationOptions.requestId } : {}),
        scopes: match.scopes,
        serviceId: match.ability.serviceId,
        status,
      });
      if (status === 204 || status === 205) return new Response(null, { status });
      return Response.json(result ?? null, { status });
    } catch (error) {
      return failureResponse(error);
    }
  };
  try {
    return await raceControlPlaneOperation(
      options.runInvocationMiddleware ? options.runInvocationMiddleware(dispatch) : dispatch(),
      options,
      'REST request invocation',
    );
  } catch (error) {
    return failureResponse(error);
  } finally {
    cancelUnusedRequestBody(decodingRequest);
    if (decodingRequest !== request) cancelUnusedRequestBody(request);
  }
}

function findRestMethod(pathMatches: RestMatch[], method: ServiceHttpMethod, pathname: string): RestMatch | undefined {
  let best: RestMatch | undefined;
  let ambiguous = false;
  for (const match of pathMatches) {
    if (match.httpMethod !== method) continue;
    if (!best || match.staticSegments > best.staticSegments) {
      best = match;
      ambiguous = false;
      continue;
    }
    if (match.staticSegments === best.staticSegments) ambiguous = true;
  }
  if (ambiguous) throw new CapabilityAuthError(`Ambiguous Service-Plane REST route: ${method.toUpperCase()} ${pathname}`, 500);
  return best;
}

function restMatches(snapshot: ServiceRegistrySnapshot, pathname: string): RestMatch[] {
  const requestSegments = decodedPathSegments(pathname);
  if (!requestSegments) return [];

  const matches: RestMatch[] = [];
  const routes = restRouteIndex(snapshot).get(requestSegments.length) ?? [];
  for (const route of routes) {
    const params = matchCompiledRestPath(route.segments, requestSegments);
    if (!params) continue;
    const ability = snapshot.abilities[route.abilityIndex];
    const definition = ability?.methods[route.method];
    if (!ability || !definition?.rest || definition.stream) continue;
    matches.push({
      ability,
      httpMethod: definition.rest.method,
      method: route.method,
      params,
      scopes: definition.scopes,
      staticSegments: route.staticSegments,
    });
  }
  return matches;
}

function restRouteIndex(snapshot: ServiceRegistrySnapshot): RestRouteIndex {
  const cached = restRouteIndexes.get(snapshot.services);
  if (cached) return cached;

  const index: RestRouteIndex = new Map();
  for (let abilityIndex = 0; abilityIndex < snapshot.abilities.length; abilityIndex += 1) {
    const ability = snapshot.abilities[abilityIndex];
    if (ability?.exposure !== 'published') continue;
    for (const [method, definition] of Object.entries(ability.methods)) {
      if (!definition.rest || definition.stream) continue;
      const route = compileRestRoute(abilityIndex, method, definition.rest.path);
      const routes = index.get(route.segments.length);
      if (routes) routes.push(route);
      else index.set(route.segments.length, [route]);
    }
  }
  restRouteIndexes.set(snapshot.services, index);
  return index;
}

function compileRestRoute(abilityIndex: number, method: string, path: string): CompiledRestRoute {
  let staticSegments = 0;
  const segments = normalizedSegments(path).map((segment): CompiledRestPathSegment => {
    const parameter = /^\{([A-Za-z_]\w*)\}$/u.exec(segment)?.[1];
    if (parameter) return { parameter };
    staticSegments += 1;
    return { static: segment };
  });
  return { abilityIndex, method, segments, staticSegments };
}

function restRouteMiss(pathMatches: RestMatch[], onNotFound: ControlPlaneRestHandlerOptions['onNotFound']): Promise<Response> | Response {
  const allowed = [...new Set(pathMatches.map((match) => match.httpMethod))].sort();
  if (allowed.length === 0) {
    return onNotFound ? onNotFound() : Response.json({ error: 'Not Found' }, { status: 404 });
  }
  return Response.json(
    { error: 'Method Not Allowed' },
    { headers: { allow: allowed.map((method) => method.toUpperCase()).join(', ') }, status: 405 },
  );
}

function matchCompiledRestPath(segments: CompiledRestPathSegment[], requestSegments: string[]): Record<string, string> | undefined {
  // Reject the common case without allocating a parameter object. Large catalogs usually share a
  // segment count but differ in a static prefix, so this first pass keeps non-matches cheap.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const requestSegment = requestSegments[index];
    if (!segment || requestSegment === undefined) return undefined;
    if ('static' in segment && segment.static !== requestSegment) return undefined;
  }

  // Template names are metadata, but a null prototype also keeps reserved object keys inert.
  const params = Object.create(null) as Record<string, string>;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const requestSegment = requestSegments[index];
    if (!segment || requestSegment === undefined) return undefined;
    if ('parameter' in segment) {
      if (requestSegment.length === 0) return undefined;
      params[segment.parameter] = requestSegment;
    }
  }
  return params;
}

function normalizedSegments(path: string): string[] {
  const normalized = path.length > 1 ? path.replace(/\/+$/u, '') : path;
  return normalized === '/' ? [] : normalized.replace(/^\//u, '').split('/');
}

function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function decodedPathSegments(path: string): string[] | undefined {
  const decoded: string[] = [];
  for (const segment of normalizedSegments(path)) {
    const value = decodePathSegment(segment);
    if (value === undefined) return undefined;
    decoded.push(value);
  }
  return decoded;
}

async function restInput(
  request: Request,
  url: URL,
  path: Record<string, string>,
  maxBodyBytes: number,
  inputSchema: OpenApiObject | undefined,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new CapabilityAuthError('Service-Plane REST maxBodyBytes must be a positive safe integer', 500);
  }
  // Query names are caller-controlled and must never reach Object.prototype setters.
  const query = Object.create(null) as Record<string, string | string[]>;
  const arrayQueryNames = inputSchema ? stringArrayQueryNames(inputSchema) : new Set<string>();
  for (const [name, value] of url.searchParams) {
    const previous = query[name];
    if (arrayQueryNames.has(name)) {
      query[name] = previous === undefined ? [value] : [...(Array.isArray(previous) ? previous : [previous]), value];
      continue;
    }
    query[name] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
  }

  const bodyText = await readBoundedRequestText(request, maxBodyBytes, REST_BODY_TOO_LARGE_MESSAGE);
  if (!bodyText) return { ...query, ...path };
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw new CapabilityAuthError('Service-Plane REST request body must use application/json', 415);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new CapabilityAuthError('Invalid JSON in Service-Plane REST request body', 400);
  }
  if (isRecord(body)) return { ...query, ...body, ...path };
  if (Object.keys(query).length === 0 && Object.keys(path).length === 0) return body;
  throw new CapabilityAuthError('Service-Plane REST path and query inputs require an object request body', 400);
}

function stringArrayQueryNames(schema: OpenApiObject): Set<string> {
  const properties = jsonSchemaRootProperties(schema);
  if (!properties) return new Set();
  return new Set(
    Object.entries(properties).flatMap(([name, property]) => {
      if (!isRecord(property) || property.type !== 'array' || !isRecord(property.items) || property.items.type !== 'string') return [];
      return [name];
    }),
  );
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const type = value.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'application/json' || Boolean(type?.endsWith('+json'));
}

function isRestMethod(value: string): value is ServiceHttpMethod {
  return (REST_METHODS as readonly string[]).includes(value);
}

function restErrorResponse(error: unknown): Response {
  const info = servicePlaneErrorInfo(error);
  if (!info)
    return Response.json({ error: { code: 'internal', message: 'Service-Plane REST request failed', retryable: false } }, { status: 500 });
  return Response.json(
    {
      error: {
        code: info.code,
        message: info.message,
        ...(info.reason ? { reason: info.reason } : {}),
        retryable: info.retryable,
      },
    },
    { status: info.status },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cancelUnusedRequestBody(request: Request): void {
  if (!request.bodyUsed) void request.body?.cancel().catch(() => undefined);
}
