import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAbilityBuilder } from '../service/ability.js';
import { defineCapabilities } from '../service/capabilities.js';
import { defineAbility } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import type { CapabilityJwks } from '../shared/types.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH } from '../shared/types.js';
import type { BrokerCaller } from './broker.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

type FixtureOptions = {
  allowedOrigins?: string[];
  caller?: BrokerCaller;
};

function rpc(method: string, params?: unknown, id: string | number | null = 1) {
  return { id, jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
}

async function createFixture(options: FixtureOptions = {}) {
  const capabilities = defineCapabilities({
    scopes: [{ id: 'example.admin' }, { id: 'example.read' }],
    serviceId: 'example',
  });
  const ability = createAbilityBuilder();
  const search = defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'example.search',
    methods: {
      fail: ability
        .method({ mcp: { name: 'example_fail' }, scopes: ['example.read'] })
        .input(z.object({}))
        .output(z.object({ ok: z.boolean() }))
        .handler(() => {
          throw new Error('connection string leaked');
        }),
      quick: ability
        .method({ mcpPrompt: { name: 'example_quick' }, scopes: ['example.read'] })
        .input(z.object({}))
        .output(z.string())
        .handler(() => 'Say hello'),
      readme: ability
        .method({
          mcpResource: { mimeType: 'text/markdown', name: 'readme', uri: 'example://docs/readme' },
          scopes: ['example.read'],
        })
        .input(z.object({}))
        .output(z.string())
        .handler(() => '# Example readme'),
      search: ability
        .method({ mcp: { name: 'example_search' }, scopes: ['example.read'] })
        .input(z.object({ query: z.string() }))
        .output(z.object({ caller: z.string(), results: z.array(z.string()) }))
        .handler(({ context, input }) => ({ caller: context.identity.serviceId, results: [input.query] })),
      // Published ability, but this method carries no MCP metadata, so no projection may list it.
      unprojected: ability
        .method({ scopes: ['example.read'] })
        .input(z.object({}))
        .output(z.object({ ok: z.boolean() }))
        .handler(() => ({ ok: true })),
    },
    rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
    scopes: ['example.read'],
  });
  // The caller below is only granted example.read, so calling this tool must fail at token minting.
  const admin = defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'example.admin',
    methods: {
      purge: ability
        .method({ mcp: { name: 'admin_purge' }, scopes: ['example.admin'] })
        .input(z.object({}))
        .output(z.object({ ok: z.boolean() }))
        .handler(() => ({ ok: true })),
    },
    rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
    scopes: ['example.admin'],
  });
  const internal = defineAbility({
    access: 'service',
    exposure: 'published',
    id: 'example.internal',
    methods: {
      run: ability
        .method({ mcp: { name: 'internal_tool' }, scopes: ['example.read'] })
        .input(z.object({}))
        .output(z.object({ ok: z.boolean() }))
        .handler(() => ({ ok: true })),
    },
    rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
    scopes: ['example.read'],
  });
  const hidden = defineAbility({
    access: 'plane',
    exposure: 'private',
    id: 'example.hidden',
    methods: {
      peek: ability
        .method({
          mcp: { name: 'hidden_tool' },
          mcpPrompt: { name: 'hidden_prompt' },
          mcpResource: { name: 'hidden', uri: 'example://hidden' },
          scopes: ['example.read'],
        })
        .input(z.object({}))
        .output(z.string())
        .handler(() => 'hidden'),
    },
    rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
    scopes: ['example.read'],
  });
  let plane: ServicePlaneControlPlane | undefined;
  const service = new ServicePlaneService({
    abilities: [search, admin, internal, hidden],
    auth: {
      issuer: 'control-plane',
      jwks: async () => {
        if (!plane) throw new Error('Control plane is not initialized');
        const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
        return response.json() as Promise<CapabilityJwks>;
      },
    },
    capabilities,
    id: 'example',
    logger: false,
    title: 'Example',
    version: '1.0.0',
  });
  const signingSecret = await generateCapabilitySigningSecret();
  const resolvedPlane = new ServicePlaneControlPlane({
    controlPlaneServiceId: 'control-plane',
    log: false,
    mcp: {
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
      caller: () => options.caller ?? { id: 'mcp-front', kind: 'service' },
    },
    openapi: false,
    services: () => [
      cloudflareServiceBinding({
        abilityRpc: { invokeAbility: (input) => service.invokeAbility(input) },
        binding: { fetch: async (request) => service.fetch(request) },
        grants: [{ caller: 'mcp-front', scopes: ['example.read'] }],
        id: 'example',
        origin: 'https://example.internal',
      }),
    ],
    signingKeys: () => [{ kid: 'test-key', secret: signingSecret }],
  });
  plane = resolvedPlane;
  const mcp = (body: string | Record<string, unknown>, headers: Record<string, string> = {}) =>
    resolvedPlane.fetch(
      new Request('https://plane.internal/rpc/mcp', {
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
        method: 'POST',
      }),
    );
  return { mcp, plane: resolvedPlane };
}

describe('control-plane MCP protocol hardening', () => {
  it('only accepts POST', async () => {
    const { plane } = await createFixture();
    const get = await plane.fetch(new Request('https://plane.internal/rpc/mcp'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');

    const del = await plane.fetch(new Request('https://plane.internal/rpc/mcp', { method: 'DELETE' }));
    expect(del.status).toBe(405);
  });

  it('refuses disallowed browser origins and honours the configured allow-list', async () => {
    const { mcp } = await createFixture();
    const sameOrigin = await mcp(rpc('ping'), { origin: 'https://plane.internal' });
    expect(sameOrigin.status).toBe(200);

    const mismatched = await mcp(rpc('ping'), { origin: 'https://evil.example' });
    expect(mismatched.status).toBe(403);

    const unparseable = await mcp(rpc('ping'), { origin: 'null' });
    expect(unparseable.status).toBe(403);

    const configured = await createFixture({ allowedOrigins: ['https://app.example'] });
    const allowed = await configured.mcp(rpc('ping'), { origin: 'https://app.example' });
    expect(allowed.status).toBe(200);
    const stillRefused = await configured.mcp(rpc('ping'), { origin: 'https://evil.example' });
    expect(stillRefused.status).toBe(403);
  });

  it('rejects unsupported MCP protocol-version headers', async () => {
    const { mcp } = await createFixture();
    const unsupported = await mcp(rpc('ping'), { 'mcp-protocol-version': '1999-01-01' });
    expect(unsupported.status).toBe(400);
    await expect(unsupported.text()).resolves.toContain('Unsupported MCP-Protocol-Version');

    const previous = await mcp(rpc('ping'), { 'mcp-protocol-version': '2025-06-18' });
    expect(previous.status).toBe(200);

    const omitted = await mcp(rpc('ping'));
    expect(omitted.status).toBe(200);
  });

  it('rejects invalid JSON bodies with a parse error instead of crashing', async () => {
    const { mcp } = await createFixture();
    const parse = await mcp('{nope');
    expect(parse.status).toBe(400);
    await expect(parse.json()).resolves.toMatchObject({ error: { code: -32700 }, id: null });
  });

  it('rejects batched, non-object, and non-2.0 payloads as invalid requests', async () => {
    const { mcp } = await createFixture();
    const batch = await mcp('[]');
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const scalar = await mcp('"hello"');
    expect(scalar.status).toBe(400);
    await expect(scalar.json()).resolves.toMatchObject({ error: { code: -32600 } });

    const wrongVersion = await mcp({ id: 1, jsonrpc: '1.0', method: 'ping' });
    expect(wrongVersion.status).toBe(400);
    await expect(wrongVersion.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it('rejects malformed JSON-RPC ids, methods, and bodiless client responses', async () => {
    const { mcp } = await createFixture();
    const invalidId = await mcp({ id: true, jsonrpc: '2.0', method: 'ping' });
    expect(invalidId.status).toBe(400);
    await expect(invalidId.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null });

    const invalidMethod = await mcp({ id: 1, jsonrpc: '2.0', method: true });
    expect(invalidMethod.status).toBe(400);
    await expect(invalidMethod.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null });

    const invalidResponse = await mcp({ id: 1, jsonrpc: '2.0' });
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null });
  });

  it('rejects unsupported MCP methods with method-not-found', async () => {
    const { mcp } = await createFixture();
    const subscribe = await mcp(rpc('resources/subscribe', { uri: 'example://docs/readme' }, 7));
    expect(subscribe.status).toBe(200);
    await expect(subscribe.json()).resolves.toMatchObject({ error: { code: -32601 }, id: 7 });
  });

  it('requires names and uris on invocation methods', async () => {
    const { mcp } = await createFixture();
    for (const [method, fragment] of [
      ['tools/call', 'tool name'],
      ['resources/read', 'resource uri'],
      ['prompts/get', 'prompt name'],
    ] as const) {
      const response = await mcp(rpc(method, {}));
      const body = (await response.json()) as { error: { code: number; message: string } };
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain(fragment);
    }
  });

  it('returns an in-band not-found error for unknown tools', async () => {
    const { mcp } = await createFixture();
    const response = await mcp(rpc('tools/call', { arguments: {}, name: 'missing_tool' }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32602, data: { status: 404 } }, id: 1 });
  });

  it('returns in-band not-found errors for unknown resources and prompts', async () => {
    const { mcp } = await createFixture();
    const resource = await mcp(rpc('resources/read', { uri: 'example://missing' }));
    await expect(resource.json()).resolves.toMatchObject({ error: { code: -32002, data: { status: 404 } } });

    const prompt = await mcp(rpc('prompts/get', { name: 'missing_prompt' }));
    await expect(prompt.json()).resolves.toMatchObject({ error: { code: -32602, data: { status: 404 } } });
  });

  it('excludes private abilities and unprojected methods from listings and refuses calls to them', async () => {
    const { mcp } = await createFixture();
    const tools = (await (await mcp(rpc('tools/list'))).json()) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((tool) => tool.name).sort()).toEqual(['admin_purge', 'example_fail', 'example_search', 'internal_tool']);

    const resources = (await (await mcp(rpc('resources/list'))).json()) as { result: { resources: { uri: string }[] } };
    expect(resources.result.resources.map((resource) => resource.uri)).toEqual(['example://docs/readme']);

    const prompts = (await (await mcp(rpc('prompts/list'))).json()) as { result: { prompts: { name: string }[] } };
    expect(prompts.result.prompts.map((prompt) => prompt.name)).toEqual(['example_quick']);

    const hiddenTool = await mcp(rpc('tools/call', { arguments: {}, name: 'hidden_tool' }));
    await expect(hiddenTool.json()).resolves.toMatchObject({ error: { code: -32602, data: { status: 404 } } });

    const hiddenResource = await mcp(rpc('resources/read', { uri: 'example://hidden' }));
    await expect(hiddenResource.json()).resolves.toMatchObject({ error: { code: -32002, data: { status: 404 } } });

    const hiddenPrompt = await mcp(rpc('prompts/get', { name: 'hidden_prompt' }));
    await expect(hiddenPrompt.json()).resolves.toMatchObject({ error: { code: -32602, data: { status: 404 } } });
  });

  it('maps missing grants to an in-band auth error without leaking issuer internals', async () => {
    const { mcp } = await createFixture();
    const denied = await mcp(rpc('tools/call', { arguments: {}, name: 'admin_purge' }));
    expect(denied.status).toBe(200);
    const body = (await denied.json()) as { error: { code: number; data: { status: number }; message: string } };
    expect(body.error).toMatchObject({ code: -32603, data: { status: 403 } });
    expect(body.error.message).toBe('Service-Plane capability grant denied');
  });

  it('rejects service-access tools for non-service callers', async () => {
    const { mcp } = await createFixture({ caller: { id: 'end-user-1', kind: 'user' } });
    const denied = await mcp(rpc('tools/call', { arguments: {}, name: 'internal_tool' }));
    const body = (await denied.json()) as { error: { code: number; data: { status: number }; message: string } };
    expect(body.error).toMatchObject({ code: -32603, data: { status: 403 } });
    expect(body.error.message).toContain('requires service access');
  });

  it('reports tool handler failures in-band with isError without leaking the cause', async () => {
    const { mcp } = await createFixture();
    const failed = await mcp(rpc('tools/call', { arguments: {}, name: 'example_fail' }));
    expect(failed.status).toBe(200);
    const body = (await failed.json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    // The service replaces handler failures with an opaque error before it leaves the process.
    expect(body.result.content[0]?.text).toContain('Service-Plane ability handler failed');
    expect(body.result.content[0]?.text).not.toContain('connection string');
  });
});
