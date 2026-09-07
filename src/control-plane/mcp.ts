import { toAbilityStream } from '../service/ability.js';
import { readBoundedRequestText, ServicePlaneBodyTooLargeError, validateBodyByteLimit } from '../shared/body-limit.js';
import type { ConnInfo } from '../shared/conn-info.js';
import { CapabilityAuthError, servicePlaneErrorInfo } from '../shared/errors.js';
import { isAsyncIterable, isRecord } from '../shared/guards.js';
import { inlineJsonSchemaRoot as inlineSchemaRoot } from '../shared/json-schema.js';
import { emitBestEffortServicePlaneLog, logErrorFields, type ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import { hasOnlySimpleTemplateExpressions, simpleTemplateComponents } from '../shared/paths.js';
import {
  type DiscoveredServiceAbility,
  type McpDiscoveryDocument,
  type McpPromptDiscovery,
  type McpResourceDiscovery,
  type McpResourceTemplateDiscovery,
  type McpServicePlaneMeta,
  type McpToolDiscovery,
  type OpenApiObject,
  SERVICE_PLANE_MCP_PATH,
  type ServiceAbilityMcpProjection,
  type ServiceAbilityMcpPromptArgument,
  type ServiceAbilityMcpPromptProjection,
  type ServiceAbilityMcpResourceProjection,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import { type BrokerCaller, brokerCallerLogFields, type ControlPlaneInvocationAuthorizer } from './caller.js';
import type { CapabilityIssuer } from './capabilities.js';
import { invokeControlPlaneMethod, raceControlPlaneOperation } from './invocation.js';

export type ControlPlaneMcpServerInfo = {
  name: string;
  version: string;
};

/** Published MCP projection selected from one request-scoped discovery snapshot. */
export type ControlPlaneMcpInvocation = {
  /** Ability selected from the discovery snapshot used for MCP matching. */
  readonly abilityId: string;
  /** Method selected after resolving the tool, resource, or prompt identifier. */
  readonly method: string;
  /** Method scopes requested when the plane mints the downstream capability. */
  readonly scopes: ReadonlyArray<string>;
  /** Catalog service that owns the matched ability. */
  readonly serviceId: string;
};

export type ControlPlaneMcpHandlerOptions = {
  /** Product permission check applied to tool, resource, and prompt method invocations. */
  authorizeInvocation?: ControlPlaneInvocationAuthorizer;
  /**
   * Browser requests must come from the MCP endpoint's own origin by default. Deployments
   * intentionally serving browser clients from another origin can allow exact origins here.
   */
  allowedOrigins?: string[];
  caller?: BrokerCaller;
  /**
   * Advisory connection info about the original client, forwarded to the target service.
   */
  connInfo?: ConnInfo;
  controlPlaneServiceId: string;
  /**
   * The caller's key for this attempt, forwarded to the target service.
   */
  idempotencyKey?: string;
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  /** Maximum accepted JSON-RPC request-body size. Defaults to one MiB. */
  maxBodyBytes?: number;
  /** Receives the projected target once a tool, resource, or prompt resolves to an ability method. */
  onInvocation?: (invocation: ControlPlaneMcpInvocation) => void;
  /**
   * When the request reached the plane, for deadline accounting: the budget forwarded to a service
   * is what is left of `timeoutMs` after everything since this instant — JSON-RPC parsing, the
   * catalog fan-out, token minting. Defaults to handler entry.
   */
  receivedAt?: number;
  /** Discovery surface used by MCP projections. A full ServiceRegistry remains assignable. */
  registry: Pick<ServiceRegistry, 'discover'>;
  requestId?: string;
  serverInfo?: Partial<ControlPlaneMcpServerInfo>;
  /**
   * Streaming tools must aggregate into one MCP result, so unbounded sources would grow
   * control-plane memory without limit; calls exceeding these caps fail in-band. maxBytes also
   * independently caps optional progress-notification bytes so an opaque token is not amplified.
   */
  streamLimits?: { maxBytes?: number; maxItems?: number };
  /**
   * The caller's remaining budget in milliseconds, forwarded to the target service so an MCP tool
   * call inherits the same deadline a brokered call would.
   */
  timeoutMs?: number;
};

/** Cheap request-boundary options needed before registry and issuer resolution. */
type ControlPlaneMcpPreflightOptions = Pick<ControlPlaneMcpHandlerOptions, 'allowedOrigins' | 'maxBodyBytes'>;

/** A validated MCP request whose body can be dispatched without reading the Request again. */
export type PreparedControlPlaneMcpRequest = {
  /** Whether the caller can receive an SSE response for a streaming tool. */
  acceptsEventStream: boolean;
  /** Validated JSON-RPC correlation id. */
  id: JsonRpcId;
  /** Validated JSON-RPC method name. */
  method: string;
  /** Method parameters from the parsed JSON-RPC request. */
  params: unknown;
};

const DEFAULT_MCP_STREAM_MAX_ITEMS = 10_000;
const DEFAULT_MCP_STREAM_MAX_BYTES = 1_048_576;
const DEFAULT_MCP_MAX_BODY_BYTES = 1_048_576;
const MCP_BODY_TOO_LARGE_MESSAGE = 'Service-Plane MCP request body is too large';

export const DEFAULT_MCP_PATH = SERVICE_PLANE_MCP_PATH;

/**
 * Latest protocol revision this endpoint implements; preceding Streamable HTTP revisions are
 * accepted for stateless requests and can be negotiated during initialization.
 */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, '2025-06-18', '2025-03-26'];

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;
const MCP_RESOURCE_NOT_FOUND = -32002;

type JsonRpcId = string | number | null;

type McpMethodMatch = {
  ability: DiscoveredServiceAbility;
  method: string;
  scopes: ReadonlyArray<string>;
};

type IndexedMcpMethod<TProjection> = McpMethodMatch & {
  definition: DiscoveredServiceAbility['methods'][string];
  projection: TProjection;
};

type McpProjectionIndex = {
  prompts: Map<string, IndexedMcpMethod<ServiceAbilityMcpPromptProjection>>;
  resources: Map<string, IndexedMcpMethod<ServiceAbilityMcpResourceProjection>>;
  tools: Map<string, IndexedMcpMethod<ServiceAbilityMcpProjection>>;
};

// Listing and invocation share this full-catalog pass so a direct call cannot silently select the
// first of two services that publish the same MCP identifier.
function indexMcpProjections(snapshot: ServiceRegistrySnapshot): McpProjectionIndex {
  const prompts = new Map<string, IndexedMcpMethod<ServiceAbilityMcpPromptProjection>>();
  const resources = new Map<string, IndexedMcpMethod<ServiceAbilityMcpResourceProjection>>();
  const tools = new Map<string, IndexedMcpMethod<ServiceAbilityMcpProjection>>();

  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [method, definition] of Object.entries(ability.methods)) {
      const match = { ability, definition, method, scopes: [...definition.scopes] };
      if (definition.mcp) {
        indexMcpProjection(tools, definition.mcp.name, 'tool name', { ...match, projection: definition.mcp });
      }
      if (definition.mcpResource) {
        if (!hasOnlySimpleTemplateExpressions(definition.mcpResource.uri)) {
          throw new Error(`Service-Plane MCP resource URI has an invalid template expression: ${ability.id}/${method}`);
        }
        indexMcpProjection(resources, definition.mcpResource.uri, 'resource uri', {
          ...match,
          projection: definition.mcpResource,
        });
      }
      if (definition.mcpPrompt) {
        indexMcpProjection(prompts, definition.mcpPrompt.name, 'prompt name', {
          ...match,
          projection: definition.mcpPrompt,
        });
      }
    }
  }

  return { prompts, resources, tools };
}

function indexMcpProjection<T>(
  index: Map<string, T>,
  identifier: string,
  kind: 'prompt name' | 'resource uri' | 'tool name',
  value: T,
): void {
  if (index.has(identifier)) {
    throw new Error(`Duplicate MCP ${kind} across published methods: ${identifier}`);
  }
  index.set(identifier, value);
}

export function generateMcpDiscovery(snapshot: ServiceRegistrySnapshot): McpDiscoveryDocument {
  const prompts: McpPromptDiscovery[] = [];
  const resources: McpResourceDiscovery[] = [];
  const resourceTemplates: McpResourceTemplateDiscovery[] = [];
  const tools: McpToolDiscovery[] = [];
  const index = indexMcpProjections(snapshot);

  for (const match of index.tools.values()) {
    const outputSchema = mcpToolOutputSchema(match.definition);
    tools.push({
      _meta: mcpServicePlaneMeta(match),
      ...(match.projection.description ? { description: match.projection.description } : {}),
      // Root inlined so clients that read `type`/`properties` without a resolver see the
      // object shape even when the vendor rooted the schema at a `$ref`.
      inputSchema: inlineSchemaRoot(match.definition.inputSchema),
      name: match.projection.name,
      ...(outputSchema ? { outputSchema } : {}),
    });
  }

  for (const match of index.resources.values()) {
    const { uri, ...metadata } = match.projection;
    if (isResourceTemplateUri(uri)) {
      resourceTemplates.push({ _meta: mcpServicePlaneMeta(match), ...metadata, uriTemplate: uri });
    } else {
      resources.push({ _meta: mcpServicePlaneMeta(match), ...metadata, uri });
    }
  }

  for (const match of index.prompts.values()) {
    const args = match.projection.arguments ?? derivePromptArguments(match.definition.inputSchema);
    prompts.push({
      _meta: mcpServicePlaneMeta(match),
      ...(args ? { arguments: [...args] } : {}),
      ...(match.projection.description ? { description: match.projection.description } : {}),
      name: match.projection.name,
      ...(match.projection.title ? { title: match.projection.title } : {}),
    });
  }

  return { prompts, resourceTemplates, resources, tools };
}

function mcpServicePlaneMeta(match: IndexedMcpMethod<unknown>): McpServicePlaneMeta {
  return {
    servicePlane: {
      abilityId: match.ability.id,
      method: match.method,
      scopes: [...match.scopes],
      serviceId: match.ability.serviceId,
      ...(match.definition.stream ? { stream: true as const } : {}),
    },
  };
}

/**
 * Stateless MCP Streamable HTTP endpoint: each POST carries one JSON-RPC message, responses are
 * JSON except streaming tool calls over SSE, and no session id is issued.
 */
export async function handleControlPlaneMcpRequest(request: Request, options: ControlPlaneMcpHandlerOptions): Promise<Response> {
  const receivedAt = options.receivedAt ?? Date.now();
  let prepared: PreparedControlPlaneMcpRequest | Response;
  try {
    prepared = await raceControlPlaneOperation(
      prepareControlPlaneMcpRequest(request, options),
      { receivedAt, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
      'MCP request parsing',
    );
  } catch (error) {
    return protocolError(null, error, JSON_RPC_INTERNAL_ERROR);
  }
  if (prepared instanceof Response) return prepared;
  return handlePreparedControlPlaneMcpRequest(prepared, mcpOptionsWithReceivedAt(options, receivedAt));
}

// Keep lazy registry/issuer getters lazy: object spread would resolve every runtime dependency even
// for ping and invalid requests. An inherited view only overrides the request-entry timestamp.
function mcpOptionsWithReceivedAt(options: ControlPlaneMcpHandlerOptions, receivedAt: number): ControlPlaneMcpHandlerOptions {
  if (options.receivedAt === receivedAt) return options;
  const view = Object.create(options) as ControlPlaneMcpHandlerOptions;
  Object.defineProperty(view, 'receivedAt', { enumerable: true, value: receivedAt });
  return view;
}

/**
 * Consumes and validates the cheap HTTP and JSON-RPC boundary before runtime dependencies are
 * resolved. A Response means the request is complete and no registry or issuer is needed.
 */
export async function prepareControlPlaneMcpRequest(
  request: Request,
  options: ControlPlaneMcpPreflightOptions = {},
): Promise<PreparedControlPlaneMcpRequest | Response> {
  const boundaryError = preflightControlPlaneMcpRequest(request, options);
  if (boundaryError) return boundaryError;
  const maxBodyBytes = validateControlPlaneMcpMaxBodyBytes(options.maxBodyBytes);
  let message: unknown;
  try {
    message = JSON.parse(await readBoundedRequestText(request, maxBodyBytes, MCP_BODY_TOO_LARGE_MESSAGE));
  } catch (error) {
    if (error instanceof ServicePlaneBodyTooLargeError) {
      return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, error.message, 413, { status: 413 });
    }
    return jsonRpcError(null, JSON_RPC_PARSE_ERROR, 'Invalid JSON in MCP request body', 400);
  }
  if (Array.isArray(message)) {
    return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'JSON-RPC batching is not supported', 400);
  }
  if (!isRecord(message) || message.jsonrpc !== '2.0') {
    return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC message', 400);
  }

  const hasMethod = Object.hasOwn(message, 'method');
  if (!hasMethod) {
    // This stateless endpoint does not issue server requests, but a well-formed client response is
    // harmless and receives the Streamable HTTP acknowledgement required for responses.
    const hasId = Object.hasOwn(message, 'id');
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (!hasId || jsonRpcIdOf(message) === undefined || hasResult === hasError) {
      return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC response', 400);
    }
    return new Response(null, { status: 202 });
  }
  if (typeof message.method !== 'string') {
    return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC method', 400);
  }
  // Requests without ids are notifications. An explicitly present id must still have one of the
  // JSON-RPC scalar id types; do not silently reinterpret malformed requests as notifications.
  if (!Object.hasOwn(message, 'id')) return new Response(null, { status: 202 });
  const id = jsonRpcIdOf(message);
  if (id === undefined) return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC id', 400);

  return {
    acceptsEventStream: acceptsEventStream(request),
    id,
    method: message.method,
    params: message.params,
  };
}

/**
 * Rejects transport, method, and declared-size failures without consuming the request body. The
 * mounted control plane uses this before authentication, then parses a cloned request afterward so
 * body-bound authentication can still read the original request.
 */
export function preflightControlPlaneMcpRequest(request: Request, options: ControlPlaneMcpPreflightOptions = {}): Response | undefined {
  const transportError = validateMcpTransportRequest(request, options.allowedOrigins);
  if (transportError) return transportError;
  if (request.method !== 'POST') return new Response(null, { headers: { allow: 'POST' }, status: 405 });

  const maxBodyBytes = validateControlPlaneMcpMaxBodyBytes(options.maxBodyBytes);
  const declaredBytes = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
    return jsonRpcError(null, JSON_RPC_INVALID_REQUEST, MCP_BODY_TOO_LARGE_MESSAGE, 413, { status: 413 });
  }
  return undefined;
}

/** Dispatches a parsed request; registry and issuer values may resolve lazily per method. */
export async function handlePreparedControlPlaneMcpRequest(
  request: PreparedControlPlaneMcpRequest,
  options: ControlPlaneMcpHandlerOptions,
): Promise<Response> {
  try {
    return await raceControlPlaneOperation(dispatchPreparedControlPlaneMcpRequest(request, options), options, 'MCP request invocation');
  } catch (error) {
    return protocolError(request.id, error, JSON_RPC_INTERNAL_ERROR);
  }
}

/** Formats a route-entry failure, preserving a JSON-RPC id once parsing reached it. */
export function controlPlaneMcpErrorResponse(error: unknown, id: string | number | null = null): Response {
  if (error instanceof ServicePlaneBodyTooLargeError) {
    return jsonRpcError(id, JSON_RPC_INVALID_REQUEST, error.message, 413, { status: 413 });
  }
  return protocolError(id, error, JSON_RPC_INTERNAL_ERROR);
}

async function dispatchPreparedControlPlaneMcpRequest(
  request: PreparedControlPlaneMcpRequest,
  options: ControlPlaneMcpHandlerOptions,
): Promise<Response> {
  const { id, method, params } = request;
  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, initializeResult(params, options));
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, { tools: (await discover(options)).tools });
    case 'tools/call':
      return callTool(id, params, options, request.acceptsEventStream);
    case 'resources/list':
      return jsonRpcResult(id, { resources: (await discover(options)).resources });
    case 'resources/templates/list':
      return jsonRpcResult(id, { resourceTemplates: (await discover(options)).resourceTemplates });
    case 'resources/read':
      return readResource(id, params, options);
    case 'prompts/list':
      return jsonRpcResult(id, { prompts: (await discover(options)).prompts });
    case 'prompts/get':
      return getPrompt(id, params, options);
    default:
      return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Unsupported MCP method: ${method}`);
  }
}

function validateMcpTransportRequest(request: Request, configuredOrigins: string[] | undefined): Response | undefined {
  const protocolVersion = request.headers.get('mcp-protocol-version')?.trim();
  if (protocolVersion && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return new Response('Unsupported MCP-Protocol-Version', { status: 400 });
  }

  const originHeader = request.headers.get('origin');
  if (!originHeader) return undefined;
  const origin = parseOrigin(originHeader);
  if (!origin) return new Response('Invalid Origin', { status: 403 });

  const allowedOrigins = [new URL(request.url).origin, ...(configuredOrigins ?? [])];
  if (!allowedOrigins.some((allowed) => parseOrigin(allowed) === origin)) {
    return new Response('Origin is not allowed', { status: 403 });
  }
  return undefined;
}

// MCP Streamable HTTP clients are required to accept both `application/json` and
// `text/event-stream` on POST. Treat an absent header as "anything goes" (the HTTP default) so
// clients that only ever call unary tools keep working, but honour an explicit narrow Accept.
function acceptsEventStream(request: Request): boolean {
  const header = request.headers.get('accept');
  if (header === null) return true;
  return header
    .split(',')
    .map((entry) => entry.split(';')[0]?.trim().toLowerCase())
    .some((type) => type === 'text/event-stream' || type === 'text/*' || type === '*/*');
}

function parseOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === 'null' || url.pathname !== '/' || url.search || url.hash ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

async function discover(options: ControlPlaneMcpHandlerOptions): Promise<McpDiscoveryDocument> {
  return generateMcpDiscovery(await discoverSnapshot(options));
}

function discoverSnapshot(options: ControlPlaneMcpHandlerOptions): Promise<ServiceRegistrySnapshot> {
  return raceControlPlaneOperation(options.registry.discover(), options, 'MCP route discovery');
}

function initializeResult(params: unknown, options: ControlPlaneMcpHandlerOptions) {
  const requested = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
  return {
    capabilities: {
      prompts: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      tools: { listChanged: false },
    },
    protocolVersion: requested && SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: options.serverInfo?.name ?? options.controlPlaneServiceId,
      version: options.serverInfo?.version ?? '1.0.0',
    },
  };
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  options: ControlPlaneMcpHandlerOptions,
  clientAcceptsEventStream: boolean,
): Promise<Response> {
  const startedAt = Date.now();
  const name = isRecord(params) && typeof params.name === 'string' ? params.name : undefined;
  if (!name) return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'MCP tools/call requires a tool name');
  const input = isRecord(params) && params.arguments !== undefined ? params.arguments : {};

  try {
    const snapshot = await discoverSnapshot(options);
    const match = indexMcpProjections(snapshot).tools.get(name);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP tool not found: ${name}`, 404);
    if (match.definition.stream) {
      // A streaming tool can only be answered as SSE. Negotiate before opening the backing
      // session so a JSON-only client gets the Streamable HTTP 406 instead of a body it cannot
      // parse — and so the plane does not pay for a session whose result it cannot deliver.
      if (!clientAcceptsEventStream) {
        return new Response('MCP streaming tools require Accept: text/event-stream', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          status: 406,
        });
      }
      return await streamToolCall(id, name, input, match, options, params);
    }

    let result: unknown;
    try {
      result = await invokeMethod(match, input, options);
    } catch (error) {
      if (error instanceof CapabilityAuthError) throw error;
      // Tool execution failures are reported in-band per the MCP spec, not as protocol errors.
      logMcpFailed(options, 'service_plane.mcp.tool.failed', { tool: name }, error, startedAt);
      return toolFailureResult(id, error);
    }

    logMcpCompleted(options, 'service_plane.mcp.tool.completed', { tool: name }, match, startedAt);
    return jsonRpcResult(id, {
      content: [{ text: JSON.stringify(result ?? null), type: 'text' }],
      ...(isRecord(result) ? { structuredContent: result } : {}),
    });
  } catch (error) {
    logMcpFailed(options, 'service_plane.mcp.tool.failed', { tool: name }, error, startedAt);
    return protocolError(id, error, JSON_RPC_INVALID_PARAMS);
  }
}

// Streaming tools answer over MCP Streamable HTTP (SSE). The final tools/call result aggregates the
// bounded stream because MCP defines exactly one response per request.
async function streamToolCall(
  id: JsonRpcId,
  name: string,
  input: unknown,
  match: McpMethodMatch,
  options: ControlPlaneMcpHandlerOptions,
  params: unknown,
): Promise<Response> {
  const startedAt = Date.now();
  const limits = validateControlPlaneMcpStreamLimits(options.streamLimits);
  notifyInvocation(match, options);
  let iterator: AsyncIterator<unknown>;
  try {
    iterator = streamIterator(await invokeControlPlaneMethod(match, input, options), name);
  } catch (error) {
    if (error instanceof CapabilityAuthError) throw error;
    logMcpFailed(options, 'service_plane.mcp.tool.failed', { tool: name }, error, startedAt);
    return toolFailureResult(id, error);
  }
  const state = { deliveryAborted: false };
  return sseResponse(streamToolEvents(id, name, match, options, limits, iterator, state, progressTokenOf(params), startedAt), (reason) => {
    state.deliveryAborted = true;
    void Promise.resolve(iterator.return?.(reason)).catch(() => undefined);
  });
}

async function* streamToolEvents(
  id: JsonRpcId,
  name: string,
  match: McpMethodMatch,
  options: ControlPlaneMcpHandlerOptions,
  limits: { maxBytes: number; maxItems: number },
  iterator: AsyncIterator<unknown>,
  state: { deliveryAborted: boolean },
  progressToken: string | number | undefined,
  startedAt: number,
): AsyncGenerator<string> {
  const { maxBytes, maxItems } = limits;
  const encoder = new TextEncoder();
  const items: unknown[] = [];
  let aggregatedBytes = 0;
  let progressBytes = 0;
  let sendProgress = progressToken !== undefined;
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (state.deliveryAborted) {
        logMcpFailed(
          options,
          'service_plane.mcp.tool.failed',
          { tool: name },
          new CapabilityAuthError('SSE delivery abandoned', 499),
          startedAt,
        );
        return;
      }
      if (done) break;
      items.push(value);
      // Count UTF-8 bytes rather than JavaScript string units so the cap reflects wire size.
      aggregatedBytes += encoder.encode(JSON.stringify(value) ?? 'null').length;
      if (items.length > maxItems || aggregatedBytes > maxBytes) {
        const message = `Service-Plane MCP tool stream exceeded aggregation limits (${maxItems} items / ${maxBytes} bytes); use a typed ability client for large streams`;
        logMcpFailed(options, 'service_plane.mcp.tool.failed', { tool: name }, new CapabilityAuthError(message, 413), startedAt);
        yield sseEvent({ id, jsonrpc: '2.0', result: { content: [{ text: message, type: 'text' }], isError: true } });
        return;
      }
      if (sendProgress) {
        const event = sseEvent({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: items.length, progressToken } });
        const eventBytes = encoder.encode(event).length;
        if (progressBytes + eventBytes <= maxBytes) {
          progressBytes += eventBytes;
          yield event;
        } else {
          // Progress is optional. Stop emitting it while still returning the bounded result.
          sendProgress = false;
        }
      }
    }
    const serialized = JSON.stringify({ items });
    logMcpCompleted(options, 'service_plane.mcp.tool.completed', { tool: name }, match, startedAt);
    yield sseEvent({
      id,
      jsonrpc: '2.0',
      result: {
        content: [{ text: serialized, type: 'text' }],
        structuredContent: { items },
      },
    });
  } catch (error) {
    logMcpFailed(options, 'service_plane.mcp.tool.failed', { tool: name }, error, startedAt);
    yield sseEvent({
      id,
      jsonrpc: '2.0',
      result: { content: [{ text: publicMcpErrorMessage(error), type: 'text' }], isError: true },
    });
  } finally {
    if (!state.deliveryAborted) await iterator.return?.(undefined);
  }
}

// In-band per the MCP spec: a tool that ran and failed is a result, not a protocol error.
function toolFailureResult(id: JsonRpcId, error: unknown): Response {
  return jsonRpcResult(id, { content: [{ text: publicMcpErrorMessage(error), type: 'text' }], isError: true });
}

function streamIterator(value: unknown, name: string): AsyncIterator<unknown> {
  const readable = isRecord(value) && typeof value.getReader === 'function';
  if (!isAsyncIterable(value) && !readable) throw new Error(`Service-Plane streaming tool did not return a stream: ${name}`);
  return toAbilityStream(value as AsyncIterable<unknown> | ReadableStream<unknown>);
}

function progressTokenOf(params: unknown): string | number | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return undefined;
  const token = params._meta.progressToken;
  if (typeof token === 'string') return token;
  return typeof token === 'number' && Number.isSafeInteger(token) ? token : undefined;
}

/** Validates and fills MCP aggregation limits before a stream is consumed. */
export function validateControlPlaneMcpStreamLimits(limits: ControlPlaneMcpHandlerOptions['streamLimits']): {
  maxBytes: number;
  maxItems: number;
} {
  return {
    maxBytes: positiveMcpStreamLimit(limits?.maxBytes, DEFAULT_MCP_STREAM_MAX_BYTES, 'maxBytes'),
    maxItems: positiveMcpStreamLimit(limits?.maxItems, DEFAULT_MCP_STREAM_MAX_ITEMS, 'maxItems'),
  };
}

/** Validates and fills the MCP request-body limit before a request is consumed. */
export function validateControlPlaneMcpMaxBodyBytes(value: number | undefined): number {
  return validateBodyByteLimit(value ?? DEFAULT_MCP_MAX_BODY_BYTES, 'Service-Plane MCP maxBodyBytes must be a positive safe integer');
}

function positiveMcpStreamLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CapabilityAuthError(`Service-Plane MCP streamLimits.${name} must be a positive safe integer`, 500);
  }
  return resolved;
}

function mcpToolOutputSchema(method: DiscoveredServiceAbility['methods'][string]): OpenApiObject | undefined {
  // MCP structuredContent is always a JSON object. Streaming results are explicitly wrapped in
  // `{ items }`; unary primitive and array schemas remain available through text content only.
  if (method.stream) return streamToolOutputSchema(method.outputSchema);
  const schema = inlineSchemaRoot(method.outputSchema);
  return schema.type === 'object' ? schema : undefined;
}

function streamToolOutputSchema(itemSchema: OpenApiObject): OpenApiObject {
  // Root-relative $refs ("#...") would re-anchor to the aggregate wrapper once the item schema
  // is nested — unless the item declares `$id`, which keeps it a schema resource of its own
  // wherever it travels, so it embeds directly with its refs intact. Service setup anchors every
  // ref-carrying schema that way; the hoist-and-rewrite below remains for `$id`-less discovery
  // documents from services on older versions. It must never see an `$id` schema: a nested
  // resource would capture the rewritten wrapper-relative refs and dangle.
  const anchored = typeof itemSchema.$id === 'string' && itemSchema.$id.length > 0;
  if (anchored || !containsRootRef(itemSchema)) {
    return {
      properties: { items: { items: itemSchema, type: 'array' } },
      required: ['items'],
      type: 'object',
    };
  }
  return {
    $defs: { item: rewriteRootRefs(itemSchema) as OpenApiObject },
    properties: { items: { items: { $ref: '#/$defs/item' }, type: 'array' } },
    required: ['items'],
    type: 'object',
  };
}

// Only the empty fragment ('#', the document root) and JSON Pointer fragments ('#/...') move when
// the item schema is nested. A plain-name fragment ('#node') resolves against an `$anchor`, which
// travels inside the hoisted schema and keeps resolving because `$defs/item` declares no `$id` and
// so starts no new schema resource — rewriting it would point at nothing.
function isRootRelativeRef(value: unknown): value is string {
  return typeof value === 'string' && (value === '#' || value.startsWith('#/'));
}

function containsRootRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRootRef);
  if (!isRecord(value)) return false;
  if (isRootRelativeRef(value.$ref)) return true;
  return Object.values(value).some(containsRootRef);
}

function rewriteRootRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRootRefs);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = key === '$ref' && isRootRelativeRef(entry) ? `#/$defs/item${entry.slice(1)}` : rewriteRootRefs(entry);
  }
  return result;
}

function sseEvent(message: unknown): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

function sseResponse(events: AsyncGenerator<string>, onCancel?: (reason: unknown) => void): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    cancel(reason) {
      onCancel?.(reason);
      // Fire-and-forget: awaiting the generator's return() would queue behind an in-flight
      // read while the client is already gone.
      void events.return?.(undefined).catch(() => undefined);
    },
    async pull(controller) {
      const next = await events.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next.value));
    },
  });
  return new Response(body, { headers: { 'cache-control': 'no-store', 'content-type': 'text/event-stream' }, status: 200 });
}

async function readResource(id: JsonRpcId, params: unknown, options: ControlPlaneMcpHandlerOptions): Promise<Response> {
  const startedAt = Date.now();
  const uri = isRecord(params) && typeof params.uri === 'string' ? params.uri : undefined;
  if (!uri) return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'MCP resources/read requires a resource uri');

  try {
    const snapshot = await discoverSnapshot(options);
    const match = findResource(indexMcpProjections(snapshot).resources, uri);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP resource not found: ${uri}`, 404);

    const result = await invokeMethod(match, match.input, options);
    logMcpCompleted(options, 'service_plane.mcp.resource.completed', { resource: uri }, match, startedAt);
    return jsonRpcResult(id, { contents: [resourceContent(uri, match.resource, result)] });
  } catch (error) {
    logMcpFailed(options, 'service_plane.mcp.resource.failed', { resource: uri }, error, startedAt);
    return protocolError(id, error, MCP_RESOURCE_NOT_FOUND);
  }
}

async function getPrompt(id: JsonRpcId, params: unknown, options: ControlPlaneMcpHandlerOptions): Promise<Response> {
  const startedAt = Date.now();
  const name = isRecord(params) && typeof params.name === 'string' ? params.name : undefined;
  if (!name) return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'MCP prompts/get requires a prompt name');
  const input = isRecord(params) && params.arguments !== undefined ? params.arguments : {};

  try {
    const snapshot = await discoverSnapshot(options);
    const match = indexMcpProjections(snapshot).prompts.get(name);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP prompt not found: ${name}`, 404);

    const result = await invokeMethod(match, input, options);
    logMcpCompleted(options, 'service_plane.mcp.prompt.completed', { prompt: name }, match, startedAt);
    return jsonRpcResult(id, promptResult(result, match.projection.description));
  } catch (error) {
    logMcpFailed(options, 'service_plane.mcp.prompt.failed', { prompt: name }, error, startedAt);
    return protocolError(id, error, JSON_RPC_INVALID_PARAMS);
  }
}

// Unary MCP projections share the same authorization and dispatch helper as REST.
async function invokeMethod(match: McpMethodMatch, input: unknown, options: ControlPlaneMcpHandlerOptions): Promise<unknown> {
  notifyInvocation(match, options);
  return invokeControlPlaneMethod(match, input, options);
}

function notifyInvocation(match: McpMethodMatch, options: ControlPlaneMcpHandlerOptions): void {
  options.onInvocation?.({
    abilityId: match.ability.id,
    method: match.method,
    scopes: [...match.scopes],
    serviceId: match.ability.serviceId,
  });
}

type McpResourceMatch = McpMethodMatch & {
  input: Record<string, string>;
  resource: ServiceAbilityMcpResourceProjection;
};

function findResource(
  resources: ReadonlyMap<string, IndexedMcpMethod<ServiceAbilityMcpResourceProjection>>,
  uri: string,
): McpResourceMatch | undefined {
  const exact = resources.get(uri);
  if (exact && !isResourceTemplateUri(exact.projection.uri)) {
    return { ...exact, input: {}, resource: exact.projection };
  }

  let templateMatch: McpResourceMatch | undefined;
  for (const match of resources.values()) {
    const resource = match.projection;
    if (!isResourceTemplateUri(resource.uri)) continue;
    const input = matchResourceTemplate(resource.uri, uri);
    if (!input) continue;
    if (templateMatch) {
      throw new Error(`Multiple MCP resource templates match the requested URI: ${uri}`);
    }
    templateMatch = { ...match, input, resource };
  }
  return templateMatch;
}

function isResourceTemplateUri(uri: string): boolean {
  return uri.includes('{');
}

// Fixed component boundaries and literal affixes leave no competing capture lengths to search.
function matchResourceTemplate(template: string, uri: string): Record<string, string> | undefined {
  const templateComponents = simpleTemplateComponents(template);
  const uriComponents = uri.split(/([/?#])/u);
  if (!templateComponents || templateComponents.length !== uriComponents.length) return undefined;

  const captures: [string, string][] = [];
  for (const [index, component] of templateComponents.entries()) {
    const value = uriComponents[index];
    if (value === undefined) return undefined;
    if (typeof component === 'string') {
      if (component !== value) return undefined;
      continue;
    }

    const { name, prefix, suffix } = component;
    const end = value.length - suffix.length;
    if (end <= prefix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) return undefined;
    captures.push([name, value.slice(prefix.length, end)]);
  }
  return Object.fromEntries(captures.map(([name, value]) => [name, decodeUriComponentSafe(value)]));
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// String outputs are served as-is, `{ blob }` outputs pass through as binary, everything else is JSON text.
function resourceContent(uri: string, resource: ServiceAbilityMcpResourceProjection, result: unknown) {
  if (typeof result === 'string') {
    return { mimeType: resource.mimeType ?? 'text/plain', text: result, uri };
  }
  if (isRecord(result) && typeof result.blob === 'string') {
    const mimeType = typeof result.mimeType === 'string' ? result.mimeType : (resource.mimeType ?? 'application/octet-stream');
    return { blob: result.blob, mimeType, uri };
  }
  return { mimeType: resource.mimeType ?? 'application/json', text: JSON.stringify(result ?? null), uri };
}

// Prompt methods return `{ messages }` (passed through) or a plain string (wrapped as one user message).
function promptResult(result: unknown, description: string | undefined) {
  if (typeof result === 'string') {
    return {
      ...(description ? { description } : {}),
      messages: [{ content: { text: result, type: 'text' }, role: 'user' }],
    };
  }
  if (isRecord(result) && Array.isArray(result.messages)) {
    const resolvedDescription = typeof result.description === 'string' ? result.description : description;
    return {
      ...(resolvedDescription ? { description: resolvedDescription } : {}),
      messages: result.messages,
    };
  }
  throw new CapabilityAuthError('Service-Plane MCP prompt method must return { messages } or a string', 500);
}

function derivePromptArguments(inputSchema: OpenApiObject): ServiceAbilityMcpPromptArgument[] | undefined {
  const schema = inlineSchemaRoot(inputSchema);
  const properties = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  if (properties.length === 0) return undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return properties.map((name) => ({ name, ...(required.has(name) ? { required: true } : {}) }));
}

function logMcpCompleted(
  options: ControlPlaneMcpHandlerOptions,
  event: 'service_plane.mcp.prompt.completed' | 'service_plane.mcp.resource.completed' | 'service_plane.mcp.tool.completed',
  subject: { prompt?: string; resource?: string; tool?: string },
  match: McpMethodMatch,
  startedAt: number,
): void {
  emitBestEffortServicePlaneLog(options.log, {
    abilityId: match.ability.id,
    ...brokerCallerLogFields(options.caller),
    durationMs: Date.now() - startedAt,
    event,
    level: 'info',
    method: match.method,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    serviceId: match.ability.serviceId,
    ...subject,
  });
}

function logMcpFailed(
  options: ControlPlaneMcpHandlerOptions,
  event: 'service_plane.mcp.prompt.failed' | 'service_plane.mcp.resource.failed' | 'service_plane.mcp.tool.failed',
  subject: { prompt?: string; resource?: string; tool?: string },
  error: unknown,
  startedAt: number,
): void {
  emitBestEffortServicePlaneLog(options.log, {
    ...brokerCallerLogFields(options.caller),
    durationMs: Date.now() - startedAt,
    error: logErrorFields(error),
    event,
    level: 'warn',
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(error instanceof CapabilityAuthError ? { status: error.status } : {}),
    ...subject,
  });
}

function jsonRpcIdOf(message: Record<string, unknown>): JsonRpcId | undefined {
  const { id } = message;
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return undefined;
}

function jsonRpcResult(id: JsonRpcId, result: unknown): Response {
  return Response.json({ id, jsonrpc: '2.0', result });
}

// 404s map to the caller-supplied not-found code (-32602 for tools/prompts, -32002 for resources).
function protocolError(id: JsonRpcId, error: unknown, notFoundCode: number): Response {
  if (error instanceof CapabilityAuthError) {
    const code = error.status === 404 ? notFoundCode : JSON_RPC_INTERNAL_ERROR;
    return jsonRpcError(id, code, publicMcpErrorMessage(error), 200, { status: error.status });
  }
  return jsonRpcError(id, JSON_RPC_INTERNAL_ERROR, publicMcpErrorMessage(error));
}

function publicMcpErrorMessage(error: unknown): string {
  const info = servicePlaneErrorInfo(error);
  if (!info || info.code === 'internal' || (info.code === 'capability_auth' && info.status >= 500)) return 'Internal error';
  return info.message || 'Service Plane call failed';
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, status = 200, data?: Record<string, unknown>): Response {
  return Response.json({ error: { code, ...(data ? { data } : {}), message }, id, jsonrpc: '2.0' }, { status });
}
