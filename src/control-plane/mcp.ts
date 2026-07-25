import { abilitySession, disposeAbilitySession } from '../service/index.js';
import type { ConnInfo } from '../shared/conn-info.js';
import { CapabilityAuthError } from '../shared/errors.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
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
  type ServiceAbilityMcpPromptArgument,
  type ServiceAbilityMcpResourceProjection,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import { type BrokerCaller, brokerCallerLogFields, brokerCallerSubject, transportForAbility } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';

export type ControlPlaneMcpServerInfo = {
  name: string;
  version: string;
};

export type ControlPlaneMcpHandlerOptions = {
  // Browser requests must come from the MCP endpoint's own origin by default. Deployments
  // intentionally serving browser clients from another origin can allow exact origins here.
  allowedOrigins?: string[];
  caller?: BrokerCaller;
  // Advisory connection info about the original client, forwarded to the target service.
  connInfo?: ConnInfo;
  controlPlaneServiceId: string;
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  registry: ServiceRegistry;
  requestId?: string;
  serverInfo?: Partial<ControlPlaneMcpServerInfo>;
  // Streaming tools must aggregate into one MCP result, so unbounded sources would grow
  // control-plane memory without limit; calls exceeding these caps fail in-band. maxBytes also
  // independently caps optional progress-notification bytes so an opaque token is not amplified.
  streamLimits?: { maxBytes?: number; maxItems?: number };
};

const DEFAULT_MCP_STREAM_MAX_ITEMS = 10_000;
const DEFAULT_MCP_STREAM_MAX_BYTES = 1_048_576;

export const DEFAULT_MCP_PATH = SERVICE_PLANE_MCP_PATH;

// Latest protocol revision this endpoint implements; preceding Streamable HTTP revisions are
// accepted for stateless requests and can be negotiated during initialization.
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
  scopes: string[];
};

export function generateMcpDiscovery(snapshot: ServiceRegistrySnapshot): McpDiscoveryDocument {
  const prompts: McpPromptDiscovery[] = [];
  const resources: McpResourceDiscovery[] = [];
  const resourceTemplates: McpResourceTemplateDiscovery[] = [];
  const tools: McpToolDiscovery[] = [];
  // Dispatch resolves by first name/uri match, so duplicates across services would make
  // routing order-dependent and silently shadow one projection behind another.
  const seenToolNames = new Set<string>();
  const seenPromptNames = new Set<string>();
  const seenResourceUris = new Set<string>();

  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [methodName, method] of Object.entries(ability.methods)) {
      const meta: McpServicePlaneMeta = {
        servicePlane: {
          abilityId: ability.id,
          method: methodName,
          scopes: method.scopes,
          serviceId: ability.serviceId,
          ...(method.stream ? { stream: true as const } : {}),
        },
      };
      if (method.mcp) {
        if (seenToolNames.has(method.mcp.name)) {
          throw new Error(`Duplicate MCP tool name across published methods: ${method.mcp.name}`);
        }
        seenToolNames.add(method.mcp.name);
        const outputSchema = mcpToolOutputSchema(method);
        tools.push({
          _meta: meta,
          ...(method.mcp.description ? { description: method.mcp.description } : {}),
          inputSchema: method.inputSchema,
          name: method.mcp.name,
          ...(outputSchema ? { outputSchema } : {}),
        });
      }
      if (method.mcpResource) {
        const { uri, ...metadata } = method.mcpResource;
        if (seenResourceUris.has(uri)) {
          throw new Error(`Duplicate MCP resource uri across published methods: ${uri}`);
        }
        seenResourceUris.add(uri);
        if (isResourceTemplateUri(uri)) {
          resourceTemplates.push({ _meta: meta, ...metadata, uriTemplate: uri });
        } else {
          resources.push({ _meta: meta, ...metadata, uri });
        }
      }
      if (method.mcpPrompt) {
        if (seenPromptNames.has(method.mcpPrompt.name)) {
          throw new Error(`Duplicate MCP prompt name across published methods: ${method.mcpPrompt.name}`);
        }
        seenPromptNames.add(method.mcpPrompt.name);
        const args = method.mcpPrompt.arguments ?? derivePromptArguments(method.inputSchema);
        prompts.push({
          _meta: meta,
          ...(args ? { arguments: args } : {}),
          ...(method.mcpPrompt.description ? { description: method.mcpPrompt.description } : {}),
          name: method.mcpPrompt.name,
          ...(method.mcpPrompt.title ? { title: method.mcpPrompt.title } : {}),
        });
      }
    }
  }

  return { prompts, resourceTemplates, resources, tools };
}

// Stateless MCP Streamable HTTP endpoint: each POST carries one JSON-RPC message, responses are
// JSON except streaming tool calls over SSE, and no session id is issued.
export async function handleControlPlaneMcpRequest(request: Request, options: ControlPlaneMcpHandlerOptions): Promise<Response> {
  const transportError = validateControlPlaneMcpTransportRequest(request, options.allowedOrigins);
  if (transportError) return transportError;
  if (request.method !== 'POST') {
    return new Response(null, { headers: { allow: 'POST' }, status: 405 });
  }

  let message: unknown;
  try {
    message = await request.json();
  } catch {
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
  const method = message.method;

  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, initializeResult(message.params, options));
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, { tools: (await discover(options)).tools });
    case 'tools/call':
      return callTool(id, message.params, options, acceptsEventStream(request));
    case 'resources/list':
      return jsonRpcResult(id, { resources: (await discover(options)).resources });
    case 'resources/templates/list':
      return jsonRpcResult(id, { resourceTemplates: (await discover(options)).resourceTemplates });
    case 'resources/read':
      return readResource(id, message.params, options);
    case 'prompts/list':
      return jsonRpcResult(id, { prompts: (await discover(options)).prompts });
    case 'prompts/get':
      return getPrompt(id, message.params, options);
    default:
      return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, `Unsupported MCP method: ${method}`);
  }
}

export function validateControlPlaneMcpTransportRequest(request: Request, configuredOrigins: string[] | undefined): Response | undefined {
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
  return generateMcpDiscovery(await options.registry.discover());
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
    const snapshot = await options.registry.discover();
    const match = findMcpMethod(snapshot, (method) => method.mcp?.name === name);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP tool not found: ${name}`, 404);
    if (match.ability.methods[match.method]?.stream) {
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
      return jsonRpcResult(id, {
        content: [{ text: error instanceof Error ? error.message : String(error), type: 'text' }],
        isError: true,
      });
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

// Streaming tools answer over MCP Streamable HTTP (SSE). The plane opens the backing ability
// over a session transport and forwards items as progress notifications while they arrive
// (when the client sent a progressToken); the final tools/call result aggregates the items,
// because MCP defines exactly one response per request.
async function streamToolCall(
  id: JsonRpcId,
  name: string,
  input: unknown,
  match: McpMethodMatch,
  options: ControlPlaneMcpHandlerOptions,
  params: unknown,
): Promise<Response> {
  const startedAt = Date.now();
  const limits = resolveMcpStreamLimits(options.streamLimits);
  const { api, dispose } = await openMethodSession(match, options);
  let stream: ReadableStream<unknown>;
  try {
    const method = api[match.method];
    if (!method) throw new CapabilityAuthError(`Service-Plane MCP method not found: ${match.method}`, 500);
    const result = await method(input);
    if (!(result instanceof ReadableStream)) {
      throw new Error(`Service-Plane streaming tool did not return a stream: ${name}`);
    }
    stream = result;
  } catch (error) {
    // The session must be closed on every early-exit path; only the happy path hands ownership
    // to streamToolEvents (which disposes after the stream drains).
    await dispose();
    if (error instanceof CapabilityAuthError) throw error;
    // Tool execution failures are reported in-band per the MCP spec, not as protocol errors.
    logMcpFailed(options, 'service_plane.mcp.tool.failed', { tool: name }, error, startedAt);
    return jsonRpcResult(id, {
      content: [{ text: error instanceof Error ? error.message : String(error), type: 'text' }],
      isError: true,
    });
  }
  const reader = stream.getReader();
  const state = { deliveryAborted: false };
  return sseResponse(
    streamToolEvents(id, name, match, options, limits, reader, dispose, state, progressTokenOf(params), startedAt),
    (reason) => {
      // This stateless endpoint has no resumable response path after SSE delivery is abandoned.
      // Abort the request-owned upstream reader promptly so serverless work and its session do
      // not leak; the flag distinguishes delivery abandonment from natural completion.
      state.deliveryAborted = true;
      void reader.cancel(reason).catch(() => undefined);
    },
  );
}

async function* streamToolEvents(
  id: JsonRpcId,
  name: string,
  match: McpMethodMatch,
  options: ControlPlaneMcpHandlerOptions,
  limits: { maxBytes: number; maxItems: number },
  reader: ReadableStreamDefaultReader<unknown>,
  dispose: () => Promise<void>,
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
      const { done, value } = await reader.read();
      // Abandoning SSE delivery resolves the pending read as done via reader.cancel; treat it as
      // an aborted delivery, not a successful completion, and skip pointless aggregation.
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
      // Measure UTF-8 bytes (not UTF-16 code units) so multibyte items count against the cap
      // at their true wire cost.
      aggregatedBytes += encoder.encode(JSON.stringify(value) ?? 'null').length;
      if (items.length > maxItems || aggregatedBytes > maxBytes) {
        // MCP defines exactly one response per request, so the full stream must be held in
        // memory here; unbounded or caller-inflated streams are cut off in-band instead.
        const message = `Service-Plane MCP tool stream exceeded aggregation limits (${maxItems} items / ${maxBytes} bytes); use a session transport for large streams`;
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
          // Progress is optional in MCP. Stop emitting it once its independent wire budget is
          // exhausted, while still returning the complete, bounded tool result.
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
      result: { content: [{ text: error instanceof Error ? error.message : String(error), type: 'text' }], isError: true },
    });
  } finally {
    void reader.cancel().catch(() => undefined);
    await dispose();
  }
}

function progressTokenOf(params: unknown): string | number | undefined {
  if (!isRecord(params) || !isRecord(params._meta)) return undefined;
  const token = params._meta.progressToken;
  if (typeof token === 'string') return token;
  return typeof token === 'number' && Number.isSafeInteger(token) ? token : undefined;
}

function resolveMcpStreamLimits(limits: ControlPlaneMcpHandlerOptions['streamLimits']): { maxBytes: number; maxItems: number } {
  return {
    maxBytes: positiveMcpStreamLimit(limits?.maxBytes, DEFAULT_MCP_STREAM_MAX_BYTES, 'maxBytes'),
    maxItems: positiveMcpStreamLimit(limits?.maxItems, DEFAULT_MCP_STREAM_MAX_ITEMS, 'maxItems'),
  };
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
  return method.outputSchema.type === 'object' ? method.outputSchema : undefined;
}

function streamToolOutputSchema(itemSchema: OpenApiObject): OpenApiObject {
  // Root-relative $refs ("#...") would re-anchor to the aggregate wrapper once the item schema
  // is nested; hoist such schemas into $defs and rewrite their refs so recursive item schemas
  // stay valid. Plain schemas are embedded directly to keep tools/list output simple.
  if (!containsRootRef(itemSchema)) {
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

function containsRootRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRootRef);
  if (!isRecord(value)) return false;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#')) return true;
  return Object.values(value).some(containsRootRef);
}

function rewriteRootRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRootRefs);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] =
      key === '$ref' && typeof entry === 'string' && entry.startsWith('#') ? `#/$defs/item${entry.slice(1)}` : rewriteRootRefs(entry);
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
    const snapshot = await options.registry.discover();
    const match = findResource(snapshot, uri);
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
    const snapshot = await options.registry.discover();
    const match = findMcpMethod(snapshot, (method) => method.mcpPrompt?.name === name);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP prompt not found: ${name}`, 404);

    const result = await invokeMethod(match, input, options);
    const definition = match.ability.methods[match.method]?.mcpPrompt;
    logMcpCompleted(options, 'service_plane.mcp.prompt.completed', { prompt: name }, match, startedAt);
    return jsonRpcResult(id, promptResult(result, definition?.description));
  } catch (error) {
    logMcpFailed(options, 'service_plane.mcp.prompt.failed', { prompt: name }, error, startedAt);
    return protocolError(id, error, JSON_RPC_INVALID_PARAMS);
  }
}

// One shared brokered-invocation path for tools, resources, and prompts: authorize the caller for
// the ability, mint the scoped (or brokered) token, and open the session over the service's RPC
// transport. The caller MUST dispose the session so its transport socket is released.
async function openMethodSession(
  match: McpMethodMatch,
  options: ControlPlaneMcpHandlerOptions,
): Promise<{ api: Record<string, (methodInput: unknown) => Promise<unknown>>; dispose: () => Promise<void> }> {
  authorizePublishedAbility(match.ability, options.caller);
  const subject = brokerCallerSubject(options.caller);
  const api = await abilitySession<Record<string, (methodInput: unknown) => Promise<unknown>>>({
    abilityId: match.ability.id,
    callerServiceId: options.caller?.kind === 'service' ? options.caller.id : options.controlPlaneServiceId,
    ...(options.connInfo ? { connInfo: options.connInfo } : {}),
    ...(subject ? { subject } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    requestToken: (tokenInput) =>
      match.ability.serviceIngress?.required
        ? options.issuer.issueBrokeredCapabilityToken({ ...tokenInput, brokerServiceId: options.controlPlaneServiceId })
        : options.issuer.issueCapabilityToken(tokenInput),
    scopes: match.scopes,
    targetServiceId: match.ability.serviceId,
    transport: transportForAbility(match.ability, {
      requiresStreaming: match.ability.methods[match.method]?.stream === true,
    }),
  });
  return { api, dispose: () => disposeAbilitySession(api) };
}

// Unary invocation: the session is closed as soon as the single result resolves.
async function invokeMethod(match: McpMethodMatch, input: unknown, options: ControlPlaneMcpHandlerOptions): Promise<unknown> {
  const { api, dispose } = await openMethodSession(match, options);
  try {
    const method = api[match.method];
    if (!method) throw new CapabilityAuthError(`Service-Plane MCP method not found: ${match.method}`, 500);
    return await method(input);
  } finally {
    await dispose();
  }
}

function findMcpMethod(
  snapshot: ServiceRegistrySnapshot,
  matches: (method: DiscoveredServiceAbility['methods'][string]) => boolean,
): McpMethodMatch | undefined {
  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [method, definition] of Object.entries(ability.methods)) {
      if (matches(definition)) return { ability, method, scopes: definition.scopes };
    }
  }
  return undefined;
}

type McpResourceMatch = McpMethodMatch & {
  input: Record<string, string>;
  resource: ServiceAbilityMcpResourceProjection;
};

function findResource(snapshot: ServiceRegistrySnapshot, uri: string): McpResourceMatch | undefined {
  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [method, definition] of Object.entries(ability.methods)) {
      const resource = definition.mcpResource;
      if (!resource) continue;
      if (!isResourceTemplateUri(resource.uri)) {
        if (resource.uri === uri) return { ability, input: {}, method, resource, scopes: definition.scopes };
        continue;
      }
      const input = matchResourceTemplate(resource.uri, uri);
      if (input) return { ability, input, method, resource, scopes: definition.scopes };
    }
  }
  return undefined;
}

function isResourceTemplateUri(uri: string): boolean {
  return uri.includes('{');
}

// Template variables become string method inputs; a variable matches one path segment and is URI-decoded.
function matchResourceTemplate(template: string, uri: string): Record<string, string> | undefined {
  const pattern = template
    .split(/(\{[A-Za-z_]\w*\})/gu)
    .map((part) => (/^\{[A-Za-z_]\w*\}$/u.test(part) ? `(?<${part.slice(1, -1)}>[^/?#]+)` : escapeRegExp(part)))
    .join('');
  const matched = new RegExp(`^${pattern}$`, 'u').exec(uri);
  if (!matched) return undefined;
  return Object.fromEntries(Object.entries(matched.groups ?? {}).map(([name, value]) => [name, decodeUriComponentSafe(value)]));
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
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
  const properties = isRecord(inputSchema.properties) ? Object.keys(inputSchema.properties) : [];
  if (properties.length === 0) return undefined;
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  return properties.map((name) => ({ name, ...(required.has(name) ? { required: true } : {}) }));
}

function logMcpCompleted(
  options: ControlPlaneMcpHandlerOptions,
  event: 'service_plane.mcp.prompt.completed' | 'service_plane.mcp.resource.completed' | 'service_plane.mcp.tool.completed',
  subject: { prompt?: string; resource?: string; tool?: string },
  match: McpMethodMatch,
  startedAt: number,
): void {
  options.log?.({
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
  options.log?.({
    ...brokerCallerLogFields(options.caller),
    durationMs: Date.now() - startedAt,
    error: error instanceof Error ? { message: error.message, name: error.name } : { message: String(error), name: 'Error' },
    event,
    level: 'warn',
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(error instanceof CapabilityAuthError ? { status: error.status } : {}),
    ...subject,
  });
}

function authorizePublishedAbility(ability: DiscoveredServiceAbility, caller: BrokerCaller | undefined): void {
  if (ability.access === 'plane') return;
  if (ability.access === 'service' && caller?.kind === 'service') return;
  throw new CapabilityAuthError('Service-Plane MCP call requires service access', 403);
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
    return jsonRpcError(id, code, error.message, 200, { status: error.status });
  }
  return jsonRpcError(id, JSON_RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, status = 200, data?: Record<string, unknown>): Response {
  return Response.json({ error: { code, ...(data ? { data } : {}), message }, id, jsonrpc: '2.0' }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
