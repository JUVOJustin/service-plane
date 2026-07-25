import { RpcTarget } from 'capnweb';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, defineCapabilities, requireScopes, ServicePlaneService } from '../service/index.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import {
  type CapabilityJwks,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_MCP_PATH,
  type ServiceAbilityDiscovery,
  type ServiceEndpoint,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import type { BrokerCaller } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateMcpDiscovery, handleControlPlaneMcpRequest, MCP_PROTOCOL_VERSION } from './mcp.js';
import { createServiceRegistry } from './registry.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

class ExampleApi extends RpcTarget {
  async search(input: { query: string }) {
    const caller = requireScopes(this, 'example.read');
    return { caller: caller.serviceId, results: [input.query] };
  }

  async count(input: { values: string[] }) {
    return input.values.length;
  }

  async list(input: { values: string[] }) {
    return input.values;
  }

  async fail(): Promise<{ ok: boolean }> {
    throw new Error('tool exploded');
  }

  async readme() {
    return '# Example readme';
  }

  async item(input: { itemId: string }) {
    return { id: input.itemId };
  }

  async logo() {
    return { blob: 'aGVsbG8=', mimeType: 'image/png' };
  }

  async icon() {
    return { blob: 'Zm9v' };
  }

  async rawBlob() {
    return { blob: 'YmFy' };
  }

  async notes() {
    return 'note text';
  }

  async nothing() {
    return undefined;
  }

  async data() {
    return { ok: true };
  }

  async styled() {
    return 'styled';
  }

  async summarize(input: { topic: string }) {
    return {
      description: 'Summarize fresh',
      messages: [{ content: { text: `Summarize ${input.topic}`, type: 'text' }, role: 'user' }],
    };
  }

  async plain() {
    return { messages: [{ content: { text: 'plain', type: 'text' }, role: 'user' }] };
  }

  async quick() {
    return 'Say hello';
  }

  async hello() {
    return 'Hi';
  }

  async bad() {
    return { nope: true };
  }

  async internal(input: { query: string }) {
    const caller = requireScopes(this, 'example.read');
    return { caller: caller.serviceId, results: [input.query] };
  }

  async hidden() {
    return 'hidden';
  }
}

type FixtureOptions = {
  caller?: BrokerCaller;
  ingress?: boolean;
  serverInfo?: { name?: string; version?: string };
};

async function createFixture(options: FixtureOptions = {}) {
  const capabilities = defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' });
  let plane: ServicePlaneControlPlane | undefined;
  const service = new ServicePlaneService({
    abilities: [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: 'example.search',
        methods: {
          bad: abilityMethod({
            input: z.object({}),
            mcpPrompt: { name: 'example_bad' },
            output: z.object({ nope: z.boolean() }),
            scopes: ['example.read'],
          }),
          data: abilityMethod({
            input: z.object({}),
            mcpResource: { mimeType: 'application/vnd.example+json', name: 'data', uri: 'example://data' },
            output: z.object({ ok: z.boolean() }),
            scopes: ['example.read'],
          }),
          count: abilityMethod({
            input: z.object({ values: z.array(z.string()) }),
            mcp: { name: 'example_count' },
            output: z.number(),
            scopes: ['example.read'],
          }),
          list: abilityMethod({
            input: z.object({ values: z.array(z.string()) }),
            mcp: { name: 'example_list' },
            output: z.array(z.string()),
            scopes: ['example.read'],
          }),
          fail: abilityMethod({
            input: z.object({}),
            mcp: { name: 'example_fail' },
            output: z.object({ ok: z.boolean() }),
            scopes: ['example.read'],
          }),
          hello: abilityMethod({
            input: z.object({}),
            mcpPrompt: { name: 'example_hello' },
            output: z.string(),
            scopes: ['example.read'],
          }),
          icon: abilityMethod({
            input: z.object({}),
            mcpResource: { mimeType: 'image/gif', name: 'icon', uri: 'example://icon' },
            output: z.object({ blob: z.string() }),
            scopes: ['example.read'],
          }),
          item: abilityMethod({
            input: z.object({ itemId: z.string() }),
            mcpResource: { description: 'One item', name: 'item', uri: 'example://items/{itemId}' },
            output: z.object({ id: z.string() }),
            scopes: ['example.read'],
          }),
          logo: abilityMethod({
            input: z.object({}),
            mcpResource: { name: 'logo', uri: 'example://logo' },
            output: z.object({ blob: z.string(), mimeType: z.string() }),
            scopes: ['example.read'],
          }),
          plain: abilityMethod({
            input: z.object({}),
            mcpPrompt: { name: 'example_plain' },
            output: z.object({ messages: z.array(z.looseObject({})) }),
            scopes: ['example.read'],
          }),
          quick: abilityMethod({
            input: z.object({}),
            mcpPrompt: {
              arguments: [{ description: 'Unused', name: 'noop' }],
              description: 'Quick hello',
              name: 'example_quick',
            },
            output: z.string(),
            scopes: ['example.read'],
          }),
          rawBlob: abilityMethod({
            input: z.object({}),
            mcpResource: { name: 'raw', uri: 'example://raw-blob' },
            output: z.object({ blob: z.string() }),
            scopes: ['example.read'],
          }),
          notes: abilityMethod({
            input: z.object({}),
            mcpResource: { name: 'notes', uri: 'example://notes' },
            output: z.string(),
            scopes: ['example.read'],
          }),
          nothing: abilityMethod({
            input: z.object({}),
            mcp: { name: 'example_nothing' },
            mcpResource: { name: 'empty', uri: 'example://empty' },
            output: z.any(),
            scopes: ['example.read'],
          }),
          styled: abilityMethod({
            input: z.object({ style: z.string().optional() }),
            mcpPrompt: { name: 'example_style' },
            output: z.string(),
            scopes: ['example.read'],
          }),
          readme: abilityMethod({
            input: z.object({}),
            mcpResource: { mimeType: 'text/markdown', name: 'readme', title: 'Readme', uri: 'example://docs/readme' },
            output: z.string(),
            scopes: ['example.read'],
          }),
          search: abilityMethod({
            input: z.object({ query: z.string() }),
            mcp: { description: 'Search examples', name: 'example_search' },
            output: z.object({ caller: z.string(), results: z.array(z.string()) }),
            scopes: ['example.read'],
          }),
          summarize: abilityMethod({
            input: z.object({ style: z.string().optional(), topic: z.string() }),
            mcpPrompt: { description: 'Summarize a topic', name: 'example_summarize', title: 'Summarize' },
            output: z.object({ description: z.string(), messages: z.array(z.looseObject({})) }),
            scopes: ['example.read'],
          }),
        },
        scopes: ['example.read'],
        handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
      }),
      defineAbility({
        access: 'service',
        exposure: 'published',
        id: 'example.internal',
        methods: {
          internal: abilityMethod({
            input: z.object({ query: z.string() }),
            mcp: { name: 'internal_tool' },
            output: z.object({ caller: z.string(), results: z.array(z.string()) }),
            scopes: ['example.read'],
          }),
        },
        scopes: ['example.read'],
        handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
      }),
      defineAbility({
        access: 'plane',
        exposure: 'private',
        id: 'example.hidden',
        methods: {
          hidden: abilityMethod({
            input: z.object({}),
            mcp: { name: 'hidden_tool' },
            mcpResource: { name: 'hidden', uri: 'example://hidden' },
            output: z.string(),
            scopes: ['example.read'],
          }),
        },
        scopes: ['example.read'],
        handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
      }),
    ],
    auth: {
      issuer: 'https://issuer.example',
      jwks: async () => {
        if (!plane) throw new Error('Control plane is not initialized');
        const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
        return response.json() as Promise<CapabilityJwks>;
      },
    },
    capabilities,
    id: 'example',
    ...(options.ingress ? { ingress: { brokerServiceIds: ['control-plane'] } } : {}),
    title: 'Example',
    version: '0.1.0',
  });

  const events: ServicePlaneBrokerLogEvent[] = [];
  const signingSecret = await generateCapabilitySigningSecret();
  plane = new ServicePlaneControlPlane({
    issuer: 'https://issuer.example',
    log: (event) => events.push(event as ServicePlaneBrokerLogEvent),
    mcp: {
      caller: () => options.caller ?? { id: 'gateway', kind: 'user' },
      ...(options.serverInfo ? { serverInfo: options.serverInfo } : {}),
    },
    services: () => [
      cloudflareServiceBinding({
        binding: { fetch: async (request) => service.fetch(request) },
        grants: [
          { caller: 'control-plane', scopes: ['example.read'] },
          { caller: 'gateway-svc', scopes: ['example.read'] },
        ],
        id: 'example',
        origin: 'https://example.internal',
      }),
    ],
    signingSecret: () => signingSecret,
  });

  const boundPlane = plane;
  const mcp = (body: unknown, headers?: Record<string, string>) =>
    boundPlane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
        method: 'POST',
      }),
    );
  return { events, mcp, plane: boundPlane };
}

function rpc(method: string, params?: unknown, id: string | number | null = 1) {
  return { id, jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
}

describe('control-plane MCP endpoint', () => {
  it('lists tools, resources, resource templates, and prompts from published metadata only', async () => {
    const { mcp } = await createFixture();

    const tools = (await (await mcp(rpc('tools/list'))).json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const toolNames = tools.result.tools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(['example_search', 'example_count', 'example_list', 'example_fail', 'internal_tool']));
    expect(toolNames).not.toContain('hidden_tool');
    expect(tools.result.tools.find((tool) => tool.name === 'example_search')).toMatchObject({
      _meta: { servicePlane: { abilityId: 'example.search', method: 'search', scopes: ['example.read'], serviceId: 'example' } },
      description: 'Search examples',
      inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
      outputSchema: { type: 'object' },
    });
    expect(tools.result.tools.find((tool) => tool.name === 'example_count')).not.toHaveProperty('outputSchema');
    expect(tools.result.tools.find((tool) => tool.name === 'example_list')).not.toHaveProperty('outputSchema');

    const resources = (await (await mcp(rpc('resources/list'))).json()) as {
      result: { resources: Array<Record<string, unknown>> };
    };
    const resourceUris = resources.result.resources.map((resource) => resource.uri);
    expect(resourceUris).toEqual(expect.arrayContaining(['example://docs/readme', 'example://logo', 'example://icon']));
    expect(resourceUris).not.toContain('example://hidden');
    expect(resourceUris).not.toContain('example://items/{itemId}');
    expect(resources.result.resources.find((resource) => resource.uri === 'example://docs/readme')).toMatchObject({
      _meta: { servicePlane: { abilityId: 'example.search', method: 'readme', serviceId: 'example' } },
      mimeType: 'text/markdown',
      name: 'readme',
      title: 'Readme',
    });

    const templates = (await (await mcp(rpc('resources/templates/list'))).json()) as {
      result: { resourceTemplates: Array<Record<string, unknown>> };
    };
    expect(templates.result.resourceTemplates).toEqual([
      expect.objectContaining({ description: 'One item', name: 'item', uriTemplate: 'example://items/{itemId}' }),
    ]);

    const prompts = (await (await mcp(rpc('prompts/list'))).json()) as {
      result: { prompts: Array<Record<string, unknown>> };
    };
    expect(prompts.result.prompts.find((prompt) => prompt.name === 'example_summarize')).toMatchObject({
      arguments: [{ name: 'style' }, { name: 'topic', required: true }],
      description: 'Summarize a topic',
      title: 'Summarize',
    });
    expect(prompts.result.prompts.find((prompt) => prompt.name === 'example_style')).toMatchObject({
      arguments: [{ name: 'style' }],
    });
    expect(prompts.result.prompts.find((prompt) => prompt.name === 'example_quick')).toMatchObject({
      arguments: [{ description: 'Unused', name: 'noop' }],
      description: 'Quick hello',
    });
    expect(prompts.result.prompts.find((prompt) => prompt.name === 'example_plain')).not.toHaveProperty('arguments');
  });

  it('negotiates protocol versions and declares tool, resource, and prompt capabilities', async () => {
    const { mcp } = await createFixture();

    const echoed = (await (await mcp(rpc('initialize', { protocolVersion: '2025-03-26' }))).json()) as Record<string, unknown>;
    expect(echoed).toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: {
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          tools: { listChanged: false },
        },
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'control-plane', version: '1.0.0' },
      },
    });

    const previous = (await (await mcp(rpc('initialize', { protocolVersion: '2025-06-18' }))).json()) as {
      result: { protocolVersion: string };
    };
    expect(previous.result.protocolVersion).toBe('2025-06-18');

    const unsupported = (await (await mcp(rpc('initialize', { protocolVersion: '1999-01-01' }))).json()) as {
      result: { protocolVersion: string };
    };
    expect(unsupported.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);

    const noParams = (await (await mcp(rpc('initialize'))).json()) as { result: { protocolVersion: string } };
    expect(noParams.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);

    const named = await createFixture({ serverInfo: { name: 'my-plane', version: '9.9.9' } });
    const custom = (await (await named.mcp(rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION }))).json()) as {
      result: { serverInfo: Record<string, unknown> };
    };
    expect(custom.result.serverInfo).toEqual({ name: 'my-plane', version: '9.9.9' });
  });

  it('calls tools with structured and primitive results and logs completion', async () => {
    const { events, mcp } = await createFixture();

    const search = (await (await mcp(rpc('tools/call', { arguments: { query: 'blue' }, name: 'example_search' }))).json()) as Record<
      string,
      unknown
    >;
    expect(search).toMatchObject({
      id: 1,
      result: {
        content: [{ text: JSON.stringify({ caller: 'control-plane', results: ['blue'] }), type: 'text' }],
        structuredContent: { caller: 'control-plane', results: ['blue'] },
      },
    });

    const count = (await (await mcp(rpc('tools/call', { arguments: { values: ['a', 'b'] }, name: 'example_count' }))).json()) as {
      result: Record<string, unknown>;
    };
    expect(count.result.content).toEqual([{ text: '2', type: 'text' }]);
    expect(count.result).not.toHaveProperty('structuredContent');

    const list = (await (await mcp(rpc('tools/call', { arguments: { values: ['a', 'b'] }, name: 'example_list' }))).json()) as {
      result: Record<string, unknown>;
    };
    expect(list.result.content).toEqual([{ text: '["a","b"]', type: 'text' }]);
    expect(list.result).not.toHaveProperty('structuredContent');

    const nothing = (await (await mcp(rpc('tools/call', { arguments: {}, name: 'example_nothing' }))).json()) as {
      result: Record<string, unknown>;
    };
    expect(nothing.result.content).toEqual([{ text: 'null', type: 'text' }]);

    expect(events).toContainEqual(
      expect.objectContaining({
        abilityId: 'example.search',
        callerId: 'gateway',
        callerKind: 'user',
        event: 'service_plane.mcp.tool.completed',
        method: 'search',
        serviceId: 'example',
        tool: 'example_search',
      }),
    );
  });

  it('reports tool execution failures in-band with isError', async () => {
    const { events, mcp } = await createFixture();

    const failed = (await (await mcp(rpc('tools/call', { arguments: {}, name: 'example_fail' }))).json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0]?.text).toContain('exploded');
    expect(events).toContainEqual(expect.objectContaining({ event: 'service_plane.mcp.tool.failed', tool: 'example_fail' }));

    // Missing arguments fail service-side Zod validation, which is an execution failure, not a protocol error.
    const invalid = (await (await mcp(rpc('tools/call', { name: 'example_search' }))).json()) as {
      result: { isError: boolean };
    };
    expect(invalid.result.isError).toBe(true);
  });

  it('reads static, templated, and binary resources', async () => {
    const { events, mcp } = await createFixture();

    const readme = (await (await mcp(rpc('resources/read', { uri: 'example://docs/readme' }))).json()) as Record<string, unknown>;
    expect(readme).toMatchObject({
      result: { contents: [{ mimeType: 'text/markdown', text: '# Example readme', uri: 'example://docs/readme' }] },
    });

    const item = (await (await mcp(rpc('resources/read', { uri: 'example://items/red%20car' }))).json()) as Record<string, unknown>;
    expect(item).toMatchObject({
      result: {
        contents: [{ mimeType: 'application/json', text: JSON.stringify({ id: 'red car' }), uri: 'example://items/red%20car' }],
      },
    });

    // Invalid percent-encoding falls back to the raw template variable instead of failing the read.
    const rawVariable = (await (await mcp(rpc('resources/read', { uri: 'example://items/%zz' }))).json()) as Record<string, unknown>;
    expect(rawVariable).toMatchObject({ result: { contents: [{ text: JSON.stringify({ id: '%zz' }) }] } });

    const logo = (await (await mcp(rpc('resources/read', { uri: 'example://logo' }))).json()) as Record<string, unknown>;
    expect(logo).toMatchObject({ result: { contents: [{ blob: 'aGVsbG8=', mimeType: 'image/png', uri: 'example://logo' }] } });

    const icon = (await (await mcp(rpc('resources/read', { uri: 'example://icon' }))).json()) as Record<string, unknown>;
    expect(icon).toMatchObject({ result: { contents: [{ blob: 'Zm9v', mimeType: 'image/gif', uri: 'example://icon' }] } });

    const rawBlob = (await (await mcp(rpc('resources/read', { uri: 'example://raw-blob' }))).json()) as Record<string, unknown>;
    expect(rawBlob).toMatchObject({ result: { contents: [{ blob: 'YmFy', mimeType: 'application/octet-stream' }] } });

    const data = (await (await mcp(rpc('resources/read', { uri: 'example://data' }))).json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      result: { contents: [{ mimeType: 'application/vnd.example+json', text: JSON.stringify({ ok: true }) }] },
    });

    const notes = (await (await mcp(rpc('resources/read', { uri: 'example://notes' }))).json()) as Record<string, unknown>;
    expect(notes).toMatchObject({ result: { contents: [{ mimeType: 'text/plain', text: 'note text' }] } });

    // A method that returns nothing serves a JSON `null` body instead of failing the read.
    const empty = (await (await mcp(rpc('resources/read', { uri: 'example://empty' }))).json()) as Record<string, unknown>;
    expect(empty).toMatchObject({ result: { contents: [{ mimeType: 'application/json', text: 'null' }] } });

    expect(events).toContainEqual(
      expect.objectContaining({ event: 'service_plane.mcp.resource.completed', resource: 'example://docs/readme' }),
    );
  });

  it('rejects unknown or private tools, resources, and prompts', async () => {
    const { mcp } = await createFixture();

    const missingTool = (await (await mcp(rpc('tools/call', { arguments: {}, name: 'missing_tool' }))).json()) as Record<string, unknown>;
    expect(missingTool).toMatchObject({ error: { code: -32602, data: { status: 404 } }, id: 1 });

    const hiddenTool = (await (await mcp(rpc('tools/call', { arguments: {}, name: 'hidden_tool' }))).json()) as Record<string, unknown>;
    expect(hiddenTool).toMatchObject({ error: { code: -32602, data: { status: 404 } } });

    const missingResource = (await (await mcp(rpc('resources/read', { uri: 'example://missing' }))).json()) as Record<string, unknown>;
    expect(missingResource).toMatchObject({ error: { code: -32002, data: { status: 404 } } });

    const hiddenResource = (await (await mcp(rpc('resources/read', { uri: 'example://hidden' }))).json()) as Record<string, unknown>;
    expect(hiddenResource).toMatchObject({ error: { code: -32002, data: { status: 404 } } });

    const missingPrompt = (await (await mcp(rpc('prompts/get', { name: 'missing_prompt' }))).json()) as Record<string, unknown>;
    expect(missingPrompt).toMatchObject({ error: { code: -32602, data: { status: 404 } } });
  });

  it('serves prompts with passthrough and wrapped results', async () => {
    const { events, mcp } = await createFixture();

    const summarize = (await (
      await mcp(rpc('prompts/get', { arguments: { topic: 'apples' }, name: 'example_summarize' }))
    ).json()) as Record<string, unknown>;
    expect(summarize).toMatchObject({
      result: {
        description: 'Summarize fresh',
        messages: [{ content: { text: 'Summarize apples', type: 'text' }, role: 'user' }],
      },
    });

    const plain = (await (await mcp(rpc('prompts/get', { arguments: {}, name: 'example_plain' }))).json()) as {
      result: Record<string, unknown>;
    };
    expect(plain.result.messages).toEqual([{ content: { text: 'plain', type: 'text' }, role: 'user' }]);
    expect(plain.result).not.toHaveProperty('description');

    const quick = (await (await mcp(rpc('prompts/get', { name: 'example_quick' }))).json()) as Record<string, unknown>;
    expect(quick).toMatchObject({
      result: { description: 'Quick hello', messages: [{ content: { text: 'Say hello', type: 'text' }, role: 'user' }] },
    });

    const hello = (await (await mcp(rpc('prompts/get', { name: 'example_hello' }))).json()) as { result: Record<string, unknown> };
    expect(hello.result.messages).toEqual([{ content: { text: 'Hi', type: 'text' }, role: 'user' }]);
    expect(hello.result).not.toHaveProperty('description');

    const bad = (await (await mcp(rpc('prompts/get', { arguments: {}, name: 'example_bad' }))).json()) as Record<string, unknown>;
    expect(bad).toMatchObject({ error: { code: -32603 } });
    expect((bad as { error: { message: string } }).error.message).toContain('must return { messages }');

    expect(events).toContainEqual(expect.objectContaining({ event: 'service_plane.mcp.prompt.completed', prompt: 'example_summarize' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'service_plane.mcp.prompt.failed', prompt: 'example_bad' }));
  });

  it('enforces service access across tools, resources, and prompts', async () => {
    const userFixture = await createFixture();
    const denied = (await (
      await userFixture.mcp(rpc('tools/call', { arguments: { query: 'x' }, name: 'internal_tool' }))
    ).json()) as Record<string, unknown>;
    expect(denied).toMatchObject({ error: { code: -32603, data: { status: 403 } } });
    expect(userFixture.events).toContainEqual(expect.objectContaining({ event: 'service_plane.mcp.tool.failed', status: 403 }));

    const serviceFixture = await createFixture({ caller: { id: 'gateway-svc', kind: 'service' } });
    const allowed = (await (
      await serviceFixture.mcp(rpc('tools/call', { arguments: { query: 'x' }, name: 'internal_tool' }))
    ).json()) as Record<string, unknown>;
    expect(allowed).toMatchObject({ result: { structuredContent: { caller: 'gateway-svc', results: ['x'] } } });
  });

  it('mints brokered tokens for ingress-protected services', async () => {
    const { mcp } = await createFixture({ ingress: true });
    const search = (await (await mcp(rpc('tools/call', { arguments: { query: 'safe' }, name: 'example_search' }))).json()) as Record<
      string,
      unknown
    >;
    expect(search).toMatchObject({ result: { structuredContent: { caller: 'control-plane', results: ['safe'] } } });

    const readme = (await (await mcp(rpc('resources/read', { uri: 'example://docs/readme' }))).json()) as Record<string, unknown>;
    expect(readme).toMatchObject({ result: { contents: [{ text: '# Example readme' }] } });
  });

  it('forwards the caller request id to the service', async () => {
    const { events, mcp } = await createFixture();
    await mcp(rpc('resources/read', { uri: 'example://docs/readme' }), { 'X-Request-Id': 'req-res-1' });
    expect(events).toContainEqual(expect.objectContaining({ event: 'service_plane.mcp.resource.completed', requestId: 'req-res-1' }));
  });
});

describe('handleControlPlaneMcpRequest protocol plumbing', () => {
  const stubIssuer = {
    issueBrokeredCapabilityToken: async () => ({ expiresAt: new Date(Date.now() + 60_000), token: 'stub' }),
    issueCapabilityToken: async () => ({ expiresAt: new Date(Date.now() + 60_000), token: 'stub' }),
    jwks: async () => ({ keys: [] }),
  } as unknown as CapabilityIssuer;

  function literalAbility(overrides: Partial<ServiceAbilityDiscovery> & { id: string }): ServiceAbilityDiscovery {
    return {
      access: 'plane',
      exposure: 'published',
      methods: {},
      rpc: { path: `/rpc/${overrides.id}`, transports: ['http-batch'] },
      scopes: ['example.read'],
      ...overrides,
    };
  }

  function literalRegistry(abilities: ServiceAbilityDiscovery[]) {
    return createServiceRegistry({
      services: [
        {
          discovery: {
            abilities,
            capabilities: { scopes: [{ id: 'example.read' }], serviceId: 'example' },
            id: 'example',
            title: 'Example',
            version: '0.1.0',
          },
          fetch: async () => new Response(null, { status: 500 }),
          id: 'example',
          origin: 'http://127.0.0.1:1',
        },
      ],
    });
  }

  function handlerOptions(abilities: ServiceAbilityDiscovery[] = [], caller?: BrokerCaller) {
    return {
      ...(caller ? { caller } : {}),
      controlPlaneServiceId: 'control-plane',
      issuer: stubIssuer,
      registry: literalRegistry(abilities),
    };
  }

  function post(body: string, headers?: HeadersInit) {
    return new Request('https://plane.internal/rpc/mcp', { body, ...(headers ? { headers } : {}), method: 'POST' });
  }

  it('only accepts POST', async () => {
    const get = await handleControlPlaneMcpRequest(new Request('https://plane.internal/rpc/mcp'), handlerOptions());
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const del = await handleControlPlaneMcpRequest(new Request('https://plane.internal/rpc/mcp', { method: 'DELETE' }), handlerOptions());
    expect(del.status).toBe(405);
  });

  it('validates browser origins and permits explicitly configured origins', async () => {
    const body = JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' });
    const sameOrigin = await handleControlPlaneMcpRequest(post(body, { origin: 'https://plane.internal' }), handlerOptions());
    expect(sameOrigin.status).toBe(200);

    const rejected = await handleControlPlaneMcpRequest(post(body, { origin: 'https://app.example' }), handlerOptions());
    expect(rejected.status).toBe(403);

    const allowed = await handleControlPlaneMcpRequest(post(body, { origin: 'https://app.example' }), {
      ...handlerOptions(),
      allowedOrigins: ['https://app.example'],
    });
    expect(allowed.status).toBe(200);
  });

  it('rejects unsupported MCP protocol-version headers', async () => {
    const body = JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' });
    const unsupported = await handleControlPlaneMcpRequest(post(body, { 'mcp-protocol-version': '1999-01-01' }), handlerOptions());
    expect(unsupported.status).toBe(400);

    const previous = await handleControlPlaneMcpRequest(post(body, { 'mcp-protocol-version': '2025-06-18' }), handlerOptions());
    expect(previous.status).toBe(200);

    const initialStreamableHttp = await handleControlPlaneMcpRequest(
      post(body, { 'mcp-protocol-version': '2025-03-26' }),
      handlerOptions(),
    );
    expect(initialStreamableHttp.status).toBe(200);

    const omitted = await handleControlPlaneMcpRequest(post(body), handlerOptions());
    expect(omitted.status).toBe(200);
  });

  it('rejects malformed JSON-RPC payloads', async () => {
    const parse = await handleControlPlaneMcpRequest(post('{nope'), handlerOptions());
    expect(parse.status).toBe(400);
    await expect(parse.json()).resolves.toMatchObject({ error: { code: -32700 }, id: null });

    const batch = await handleControlPlaneMcpRequest(post('[]'), handlerOptions());
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const scalar = await handleControlPlaneMcpRequest(post('"hello"'), handlerOptions());
    expect(scalar.status).toBe(400);
    await expect(scalar.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const wrongVersion = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '1.0', method: 'ping' })),
      handlerOptions(),
    );
    expect(wrongVersion.status).toBe(400);
    await expect(wrongVersion.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it('acknowledges notifications and valid client responses without a body', async () => {
    const notification = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
      handlerOptions(),
    );
    expect(notification.status).toBe(202);

    // Cancellation is optional in MCP. This stateless endpoint acknowledges the notification but
    // cannot correlate it with request-scoped work across isolates.
    const cancelled = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } })),
      handlerOptions(),
    );
    expect(cancelled.status).toBe(202);

    const response = await handleControlPlaneMcpRequest(post(JSON.stringify({ id: 5, jsonrpc: '2.0', result: {} })), handlerOptions());
    expect(response.status).toBe(202);
  });

  it('rejects malformed JSON-RPC ids, methods, and client responses', async () => {
    const invalidId = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: true, jsonrpc: '2.0', method: 'ping' })),
      handlerOptions(),
    );
    expect(invalidId.status).toBe(400);
    await expect(invalidId.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null });

    const invalidMethod = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: true })),
      handlerOptions(),
    );
    expect(invalidMethod.status).toBe(400);
    await expect(invalidMethod.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null });

    const invalidResponse = await handleControlPlaneMcpRequest(post(JSON.stringify({ id: 1, jsonrpc: '2.0' })), handlerOptions());
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null });
  });

  it('answers ping, echoes null ids, and rejects unsupported methods', async () => {
    const ping = await handleControlPlaneMcpRequest(post(JSON.stringify({ id: null, jsonrpc: '2.0', method: 'ping' })), handlerOptions());
    await expect(ping.json()).resolves.toEqual({ id: null, jsonrpc: '2.0', result: {} });

    const subscribe = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'resources/subscribe', params: { uri: 'example://x' } })),
      handlerOptions(),
    );
    await expect(subscribe.json()).resolves.toMatchObject({ error: { code: -32601 }, id: 2 });
  });

  it('requires names and uris on invocation methods', async () => {
    for (const [method, message] of [
      ['tools/call', 'tool name'],
      ['resources/read', 'resource uri'],
      ['prompts/get', 'prompt name'],
    ] as const) {
      const response = await handleControlPlaneMcpRequest(
        post(JSON.stringify({ id: 1, jsonrpc: '2.0', method, params: {} })),
        handlerOptions(),
      );
      const body = (await response.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain(message);
    }
  });

  it('rejects service-access abilities for anonymous handler callers', async () => {
    const abilities = [
      literalAbility({
        access: 'service',
        id: 'example.internal',
        methods: {
          run: {
            inputSchema: { type: 'object' },
            mcp: { name: 'internal_tool' },
            outputSchema: { type: 'object' },
            scopes: ['example.read'],
          },
        },
      }),
    ];
    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'internal_tool' } })),
      handlerOptions(abilities),
    );
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32603, data: { status: 403 } } });
  });

  it('surfaces abilities without a supported transport as internal errors', async () => {
    const abilities = [
      literalAbility({
        id: 'example.broken',
        methods: {
          run: {
            inputSchema: { type: 'object' },
            mcp: { name: 'broken_tool' },
            outputSchema: { type: 'object' },
            scopes: ['example.read'],
          },
        },
        rpc: { path: '/rpc/example.broken', transports: [] },
      }),
    ];
    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'broken_tool' } })),
      handlerOptions(abilities),
    );
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32603, data: { status: 500 } } });
  });

  it('surfaces registry failures as internal protocol errors', async () => {
    const throwingError = { discover: async () => Promise.reject(new Error('registry exploded')) } as unknown as ReturnType<
      typeof literalRegistry
    >;
    const read = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'example://x' } })),
      { controlPlaneServiceId: 'control-plane', issuer: stubIssuer, registry: throwingError },
    );
    await expect(read.json()).resolves.toMatchObject({ error: { code: -32603, message: 'registry exploded' } });

    const throwingValue = {
      discover: async () => Promise.reject('boom'),
    } as unknown as ReturnType<typeof literalRegistry>;
    const prompt = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'prompts/get', params: { name: 'x' } })),
      { controlPlaneServiceId: 'control-plane', issuer: stubIssuer, registry: throwingValue },
    );
    await expect(prompt.json()).resolves.toMatchObject({ error: { code: -32603, message: 'boom' } });
  });

  it('reports non-Error token failures in-band and logs them without caller context', async () => {
    const abilities = [
      literalAbility({
        id: 'example.search',
        methods: {
          search: {
            inputSchema: { type: 'object' },
            mcp: { name: 'lit_tool' },
            outputSchema: { type: 'object' },
            scopes: ['example.read'],
          },
        },
      }),
    ];
    const throwingIssuer = {
      issueBrokeredCapabilityToken: async () => Promise.reject('token boom'),
      issueCapabilityToken: async () => Promise.reject('token boom'),
      jwks: async () => ({ keys: [] }),
    } as unknown as CapabilityIssuer;
    const events: ServicePlaneBrokerLogEvent[] = [];

    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'lit_tool' } })),
      {
        controlPlaneServiceId: 'control-plane',
        issuer: throwingIssuer,
        log: (event) => events.push(event),
        registry: literalRegistry(abilities),
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { content: [{ text: 'token boom', type: 'text' }], isError: true },
    });
    const failed = events.find((event) => event.event === 'service_plane.mcp.tool.failed');
    expect(failed).toMatchObject({ error: { message: 'token boom', name: 'Error' }, tool: 'lit_tool' });
    expect(failed).not.toHaveProperty('callerId');
    expect(failed).not.toHaveProperty('requestId');
    expect(failed).not.toHaveProperty('status');
  });

  it('matches variable-free template URIs literally', async () => {
    const abilities = [
      literalAbility({
        id: 'example.raw',
        methods: {
          raw: {
            inputSchema: { type: 'object' },
            mcpResource: { name: 'raw', uri: 'example://raw{' },
            outputSchema: { type: 'object' },
            scopes: ['example.read'],
          },
        },
      }),
    ];
    // The unreachable endpoint means the read fails after matching, proving the template matched.
    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'resources/read', params: { uri: 'example://raw{' } })),
      handlerOptions(abilities),
    );
    const body = (await response.json()) as { error: { code: number; data?: { status?: number } } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.data?.status).not.toBe(404);
  });

  it('completes invocations without caller or request id context', async () => {
    const { createCapabilityIssuerFromSigningSecret } = await import('./signing-secret.js');
    const capabilities = defineCapabilities({ scopes: [{ id: 'example.read' }], serviceId: 'example' });
    let issuer: CapabilityIssuer | undefined;
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          access: 'plane',
          exposure: 'published',
          id: 'example.search',
          methods: {
            search: abilityMethod({
              input: z.object({ query: z.string() }),
              mcp: { name: 'example_search' },
              output: z.object({ caller: z.string(), results: z.array(z.string()) }),
              scopes: ['example.read'],
            }),
          },
          scopes: ['example.read'],
          handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
        }),
      ],
      auth: {
        issuer: 'https://issuer.example',
        jwks: async () => {
          if (!issuer) throw new Error('Issuer is not initialized');
          return issuer.jwks();
        },
      },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    issuer = await createCapabilityIssuerFromSigningSecret({
      capabilities: [capabilities],
      grants: { grants: [{ caller: 'control-plane', scopes: ['example.read'], target: 'example' }] },
      issuer: 'https://issuer.example',
      signingSecret: await generateCapabilitySigningSecret(),
    });
    const registry = createServiceRegistry({
      services: [{ fetch: async (request: Request) => service.fetch(request), id: 'example', origin: 'https://example.internal' }],
    });
    const events: ServicePlaneBrokerLogEvent[] = [];

    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: { query: 'x' }, name: 'example_search' } })),
      { controlPlaneServiceId: 'control-plane', issuer, log: (event) => events.push(event), registry },
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { structuredContent: { caller: 'control-plane', results: ['x'] } },
    });
    const completed = events.find((event) => event.event === 'service_plane.mcp.tool.completed');
    expect(completed).toMatchObject({ abilityId: 'example.search', tool: 'example_search' });
    expect(completed).not.toHaveProperty('callerId');
    expect(completed).not.toHaveProperty('requestId');
  });

  it('lists prompts without arguments when the input schema declares no properties', async () => {
    const abilities = [
      literalAbility({
        id: 'example.prompted',
        methods: {
          run: {
            inputSchema: { type: 'object' },
            mcpPrompt: { name: 'lit_prompt' },
            outputSchema: { type: 'object' },
            scopes: ['example.read'],
          },
        },
      }),
    ];
    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'prompts/list' })),
      handlerOptions(abilities),
    );
    const body = (await response.json()) as { result: { prompts: Array<Record<string, unknown>> } };
    expect(body.result.prompts).toEqual([expect.objectContaining({ name: 'lit_prompt' })]);
    expect(body.result.prompts[0]).not.toHaveProperty('arguments');
  });

  it('guards against RPC stub reserved property names', async () => {
    const abilities = [
      literalAbility({
        id: 'example.reserved',
        methods: {
          // biome-ignore lint/suspicious/noThenProperty: deliberately probes the RPC stub's reserved `then` handling
          then: { inputSchema: { type: 'object' }, mcp: { name: 'then_tool' }, outputSchema: { type: 'object' }, scopes: ['example.read'] },
        },
      }),
    ];
    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'then_tool' } })),
      handlerOptions(abilities),
    );
    // Cap'n Web stubs special-case `then`, so the handler must fail cleanly rather than crash.
    const body = (await response.json()) as { error?: { code: number }; result?: { isError?: boolean } };
    expect(body.error?.code ?? (body.result?.isError === true ? -32603 : undefined)).toBe(-32603);
  });

  it('answers requests with string ids', async () => {
    const ping = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 'ping-1', jsonrpc: '2.0', method: 'ping' })),
      handlerOptions(),
    );
    await expect(ping.json()).resolves.toEqual({ id: 'ping-1', jsonrpc: '2.0', result: {} });
  });

  it('falls back to the WebSocket transport and reports connection failures in-band', async () => {
    const abilities = [
      literalAbility({
        id: 'example.ws',
        methods: {
          run: { inputSchema: { type: 'object' }, mcp: { name: 'ws_tool' }, outputSchema: { type: 'object' }, scopes: ['example.read'] },
        },
        rpc: { path: '/rpc/example.ws', transports: ['websocket'] },
      }),
    ];
    const response = await handleControlPlaneMcpRequest(
      post(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: 'ws_tool' } })),
      handlerOptions(abilities),
    );
    const body = (await response.json()) as { error?: { code: number }; result?: { isError?: boolean } };
    // The unreachable endpoint fails during the call, which is reported as a tool execution failure.
    expect(body.result?.isError ?? body.error !== undefined).toBe(true);
  });
});

describe('generateMcpDiscovery uniqueness', () => {
  const endpoint: ServiceEndpoint = {
    fetch: async () => new Response(null, { status: 404 }),
    id: 'example',
    origin: 'https://example.internal',
  };

  function publishedMcpAbility(id: string, method: Record<string, unknown>): ServiceRegistrySnapshot['abilities'][number] {
    return {
      access: 'plane',
      exposure: 'published',
      id,
      methods: {
        search: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scopes: [],
          ...method,
        },
      },
      rpc: { path: `/rpc/${id}`, transports: ['http-batch'] },
      scopes: [],
      service: endpoint,
      serviceId: 'example',
      serviceTitle: 'Example',
      serviceVersion: '0.1.0',
    } as ServiceRegistrySnapshot['abilities'][number];
  }

  function snapshotOf(abilities: ServiceRegistrySnapshot['abilities']): ServiceRegistrySnapshot {
    return { abilities, discoveredAt: '2026-07-21T12:00:00.000Z', services: [] };
  }

  it('rejects duplicate tool names across published methods', () => {
    const snapshot = snapshotOf([
      publishedMcpAbility('example.a', { mcp: { name: 'example_search' } }),
      publishedMcpAbility('example.b', { mcp: { name: 'example_search' } }),
    ]);
    expect(() => generateMcpDiscovery(snapshot)).toThrow('Duplicate MCP tool name across published methods: example_search');
  });

  it('rejects duplicate prompt names across published methods', () => {
    const snapshot = snapshotOf([
      publishedMcpAbility('example.a', { mcpPrompt: { name: 'example_prompt' } }),
      publishedMcpAbility('example.b', { mcpPrompt: { name: 'example_prompt' } }),
    ]);
    expect(() => generateMcpDiscovery(snapshot)).toThrow('Duplicate MCP prompt name across published methods: example_prompt');
  });

  it('rejects duplicate resource uris across published methods', () => {
    const snapshot = snapshotOf([
      publishedMcpAbility('example.a', { mcpResource: { name: 'Readme', uri: 'doc://example/readme' } }),
      publishedMcpAbility('example.b', { mcpResource: { name: 'Other', uri: 'doc://example/readme' } }),
    ]);
    expect(() => generateMcpDiscovery(snapshot)).toThrow('Duplicate MCP resource uri across published methods: doc://example/readme');
  });
});
