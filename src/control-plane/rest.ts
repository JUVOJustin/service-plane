import { CapabilityAuthError, servicePlaneErrorInfo } from '../shared/errors.js';
import { jsonSchemaRootProperties } from '../shared/json-schema.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import type {
  DiscoveredServiceAbility,
  OpenApiObject,
  ServiceHttpMethod,
  ServiceRegistry,
  ServiceRegistrySnapshot,
} from '../shared/types.js';
import { brokerCallerLogFields } from './broker.js';
import { type ControlPlaneInvocationOptions, invokeControlPlaneMethod } from './invocation.js';

const DEFAULT_REST_MAX_BODY_BYTES = 1_048_576;
const REST_METHODS = ['delete', 'get', 'patch', 'post', 'put', 'query'] as const satisfies readonly ServiceHttpMethod[];

export type ControlPlaneRestInvocation = {
  /** Discovered ability id. */
  abilityId: string;
  /** Ability method name. */
  method: string;
  /** Published REST path template. */
  path: string;
  /** Scopes minted for this operation. */
  scopes: string[];
  /** Service that owns the ability. */
  serviceId: string;
  /** Projection surface discriminator. */
  surface: 'rest';
};

export type ControlPlaneRestHandlerOptions = {
  /** Maximum JSON request-body size. Defaults to one MiB. */
  maxBodyBytes?: number;
  /** Structured event sink. */
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  /** Receives the resolved service, ability, and method before invocation. */
  onInvocation?: (invocation: ControlPlaneRestInvocation) => void;
  /** Continues application routing when no published REST path matches. */
  onNotFound?: () => Promise<Response> | Response;
  /** Time the HTTP request entered the plane, used for deadline accounting. */
  receivedAt?: number;
  /** Registry used to resolve published REST metadata. */
  registry: ServiceRegistry;
  /** Lazily resolves authenticated invocation facts from the snapshot that matched the route. */
  resolveInvocation: (snapshot: ServiceRegistrySnapshot) => Promise<ControlPlaneInvocationOptions | Response>;
  /** Runs invocation-only Hono middleware around a matched REST operation. */
  runInvocationMiddleware?: (next: () => Promise<Response>) => Promise<Response>;
};

type RestMatch = {
  ability: DiscoveredServiceAbility;
  method: string;
  params: Record<string, string>;
  scopes: string[];
  staticSegments: number;
};

/** Dispatches one HTTP request through published REST projection metadata. */
export async function handleControlPlaneRestRequest(request: Request, options: ControlPlaneRestHandlerOptions): Promise<Response> {
  const startedAt = Date.now();
  let matched: RestMatch | undefined;
  let invocationOptions: ControlPlaneInvocationOptions | undefined;
  const failureResponse = (error: unknown): Response => {
    if (matched) {
      const errorInfo = servicePlaneErrorInfo(error);
      options.log?.({
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
  try {
    const snapshot = await options.registry.discover();
    const url = new URL(request.url);
    const method = request.method.toLowerCase();
    if (!isRestMethod(method)) return restRouteMiss(snapshot, url.pathname, options.onNotFound);

    const match = findRestMethod(snapshot, method, url.pathname);
    if (!match) return restRouteMiss(snapshot, url.pathname, options.onNotFound);
    matched = match;

    options.onInvocation?.({
      abilityId: match.ability.id,
      method: match.method,
      path: match.ability.methods[match.method]?.rest?.path ?? url.pathname,
      scopes: match.scopes,
      serviceId: match.ability.serviceId,
      surface: 'rest',
    });
    const invoke = async () => {
      try {
        const resolved = await options.resolveInvocation(snapshot);
        if (resolved instanceof Response) return resolved;
        invocationOptions = resolved;
        const input = await restInput(
          request,
          url,
          match.params,
          options.maxBodyBytes ?? DEFAULT_REST_MAX_BODY_BYTES,
          match.ability.methods[match.method]?.inputSchema,
        );
        const result = await invokeControlPlaneMethod(match, input, invocationOptions);
        const status = match.ability.methods[match.method]?.rest?.status ?? 200;
        options.log?.({
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
    return options.runInvocationMiddleware ? options.runInvocationMiddleware(invoke) : invoke();
  } catch (error) {
    return failureResponse(error);
  }
}

function findRestMethod(snapshot: ServiceRegistrySnapshot, method: ServiceHttpMethod, pathname: string): RestMatch | undefined {
  const matches = restMatches(snapshot, pathname).filter((match) => match.ability.methods[match.method]?.rest?.method === method);
  if (matches.length === 0) return undefined;
  matches.sort((left, right) => right.staticSegments - left.staticSegments);
  const best = matches[0];
  if (!best) return undefined;
  if (matches[1]?.staticSegments === best.staticSegments) {
    throw new CapabilityAuthError(`Ambiguous Service-Plane REST route: ${method.toUpperCase()} ${pathname}`, 500);
  }
  return best;
}

function restMatches(snapshot: ServiceRegistrySnapshot, pathname: string): RestMatch[] {
  const matches: RestMatch[] = [];
  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [method, definition] of Object.entries(ability.methods)) {
      if (!definition.rest || definition.stream) continue;
      const pathMatch = matchRestPath(definition.rest.path, pathname);
      if (pathMatch) {
        matches.push({ ability, method, params: pathMatch.params, scopes: definition.scopes, staticSegments: pathMatch.staticSegments });
      }
    }
  }
  return matches;
}

function restRouteMiss(
  snapshot: ServiceRegistrySnapshot,
  pathname: string,
  onNotFound: ControlPlaneRestHandlerOptions['onNotFound'],
): Promise<Response> | Response {
  const allowed = [
    ...new Set(
      restMatches(snapshot, pathname)
        .map((match) => match.ability.methods[match.method]?.rest?.method)
        .filter((method): method is ServiceHttpMethod => method !== undefined),
    ),
  ].sort();
  if (allowed.length === 0) {
    return onNotFound ? onNotFound() : Response.json({ error: 'Not Found' }, { status: 404 });
  }
  return Response.json(
    { error: 'Method Not Allowed' },
    { headers: { allow: allowed.map((method) => method.toUpperCase()).join(', ') }, status: 405 },
  );
}

function matchRestPath(template: string, pathname: string): { params: Record<string, string>; staticSegments: number } | undefined {
  const templateSegments = normalizedSegments(template);
  const requestSegments = normalizedSegments(pathname);
  if (templateSegments.length !== requestSegments.length) return undefined;

  // Template names are metadata, but a null prototype also keeps reserved object keys inert.
  const params = Object.create(null) as Record<string, string>;
  let staticSegments = 0;
  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index];
    const requestSegment = requestSegments[index];
    if (templateSegment === undefined || requestSegment === undefined) return undefined;
    const variable = /^\{([A-Za-z_]\w*)\}$/u.exec(templateSegment)?.[1];
    const decoded = decodePathSegment(requestSegment);
    if (decoded === undefined) return undefined;
    if (variable) {
      if (decoded.length === 0) return undefined;
      params[variable] = decoded;
      continue;
    }
    if (templateSegment !== decoded) return undefined;
    staticSegments += 1;
  }
  return { params, staticSegments };
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

async function restInput(
  request: Request,
  url: URL,
  path: Record<string, string>,
  maxBodyBytes: number,
  inputSchema: OpenApiObject | undefined,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new CapabilityAuthError('Service-Plane REST maxBodyBytes must be a positive integer', 500);
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

  const bodyText = await readBoundedBody(request, maxBodyBytes);
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

async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new CapabilityAuthError('Service-Plane REST request body is too large', 413);
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new CapabilityAuthError('Service-Plane REST request body is too large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
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
