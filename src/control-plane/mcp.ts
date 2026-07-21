import { abilitySession, cloudflareServiceBindingRpc, websocketRpc } from '../service/index.js';
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
import type { BrokerCaller } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';

export type ControlPlaneMcpServerInfo = {
  name: string;
  version: string;
};

export type ControlPlaneMcpHandlerOptions = {
  caller?: BrokerCaller;
  controlPlaneServiceId: string;
  issuer: CapabilityIssuer;
  log?: (event: ServicePlaneBrokerLogEvent) => void;
  registry: ServiceRegistry;
  requestId?: string;
  serverInfo?: Partial<ControlPlaneMcpServerInfo>;
};

export const DEFAULT_MCP_PATH = SERVICE_PLANE_MCP_PATH;

// Latest protocol revision this endpoint implements; older revisions are echoed back when a client asks for one.
export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05'];

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

  for (const ability of snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [methodName, method] of Object.entries(ability.methods)) {
      const meta: McpServicePlaneMeta = {
        servicePlane: {
          abilityId: ability.id,
          method: methodName,
          scopes: method.scopes,
          serviceId: ability.serviceId,
        },
      };
      if (method.mcp) {
        tools.push({
          _meta: meta,
          ...(method.mcp.description ? { description: method.mcp.description } : {}),
          inputSchema: method.inputSchema,
          name: method.mcp.name,
          outputSchema: method.outputSchema,
        });
      }
      if (method.mcpResource) {
        const { uri, ...metadata } = method.mcpResource;
        if (isResourceTemplateUri(uri)) {
          resourceTemplates.push({ _meta: meta, ...metadata, uriTemplate: uri });
        } else {
          resources.push({ _meta: meta, ...metadata, uri });
        }
      }
      if (method.mcpPrompt) {
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

// Stateless MCP streamable-HTTP endpoint: each POST carries one JSON-RPC message, responses are plain
// JSON (no SSE stream, no session id), so stock MCP clients can connect without Cap'n Web.
export async function handleControlPlaneMcpRequest(request: Request, options: ControlPlaneMcpHandlerOptions): Promise<Response> {
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

  const id = jsonRpcIdOf(message);
  const method = typeof message.method === 'string' ? message.method : undefined;
  // Client responses (no method) and notifications (no id) get acknowledged without a body.
  if (method === undefined || id === undefined) {
    return new Response(null, { status: 202 });
  }

  switch (method) {
    case 'initialize':
      return jsonRpcResult(id, initializeResult(message.params, options));
    case 'ping':
      return jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, { tools: (await discover(options)).tools });
    case 'tools/call':
      return callTool(id, message.params, options);
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

async function callTool(id: JsonRpcId, params: unknown, options: ControlPlaneMcpHandlerOptions): Promise<Response> {
  const startedAt = Date.now();
  const name = isRecord(params) && typeof params.name === 'string' ? params.name : undefined;
  if (!name) return jsonRpcError(id, JSON_RPC_INVALID_PARAMS, 'MCP tools/call requires a tool name');
  const input = isRecord(params) && params.arguments !== undefined ? params.arguments : {};

  try {
    const snapshot = await options.registry.discover();
    const match = findMcpMethod(snapshot, (method) => method.mcp?.name === name);
    if (!match) throw new CapabilityAuthError(`Service-Plane MCP tool not found: ${name}`, 404);

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

// One shared brokered-invocation path for tools, resources, and prompts: authorize the caller for the
// ability, mint the scoped (or brokered) token, and invoke the method over the service's RPC transport.
async function invokeMethod(match: McpMethodMatch, input: unknown, options: ControlPlaneMcpHandlerOptions): Promise<unknown> {
  authorizePublishedAbility(match.ability, options.caller);
  const api = await abilitySession<Record<string, (methodInput: unknown) => Promise<unknown>>>({
    abilityId: match.ability.id,
    callerServiceId: options.caller?.kind === 'service' ? options.caller.id : options.controlPlaneServiceId,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    requestToken: (tokenInput) =>
      match.ability.serviceIngress?.required
        ? options.issuer.issueBrokeredCapabilityToken({ ...tokenInput, brokerServiceId: options.controlPlaneServiceId })
        : options.issuer.issueCapabilityToken(tokenInput),
    scopes: match.scopes,
    targetServiceId: match.ability.serviceId,
    transport: transportForAbility(match.ability),
  });
  const method = api[match.method];
  if (!method) throw new CapabilityAuthError(`Service-Plane MCP method not found: ${match.method}`, 500);
  return method(input);
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
    ...(options.caller ? { callerId: options.caller.id, callerKind: options.caller.kind } : {}),
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
    ...(options.caller ? { callerId: options.caller.id, callerKind: options.caller.kind } : {}),
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

function transportForAbility(ability: DiscoveredServiceAbility) {
  if (ability.rpc.transports.includes('http-batch')) {
    return cloudflareServiceBindingRpc(ability.service, ability.rpc.path, ability.service.origin);
  }
  if (ability.rpc.transports.includes('websocket')) {
    return websocketRpc(new URL(ability.rpc.path, ability.service.origin.replace(/^http/u, 'ws')).toString());
  }
  throw new CapabilityAuthError(`Service-Plane ability has no supported RPC transport: ${ability.serviceId}/${ability.id}`, 500);
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
  return typeof value === 'object' && value !== null;
}
