import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, defineCapabilities, RpcTarget, requireScopes, ServicePlaneService } from '../service/index.js';
import { type CapabilityJwks, SERVICE_PLANE_CAPABILITY_JWKS_PATH, SERVICE_PLANE_MCP_PATH } from '../shared/types.js';
import type { BrokerCaller } from './broker.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

class HubApi extends RpcTarget {
  async *readFile(input: { parts: number }) {
    requireScopes(this, 'hub.read');
    for (let index = 0; index < input.parts; index += 1) {
      yield { chunk: `part-${index}` };
    }
  }

  async stat(_input: Record<string, never>) {
    return { size: 3 };
  }
}

type FixtureOptions = {
  caller?: BrokerCaller | undefined;
  ingress?: boolean;
  omitCallerResolver?: boolean;
};

async function createFixture(options: FixtureOptions = {}) {
  const capabilities = defineCapabilities({ scopes: [{ id: 'hub.read' }], serviceId: 'hub' });
  let plane: ServicePlaneControlPlane | undefined;
  const service = new ServicePlaneService({
    abilities: [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: 'hub.files',
        methods: {
          readFile: abilityMethod({
            input: z.object({ parts: z.number() }),
            mcp: { description: 'Read a hub file', name: 'hub_read_file' },
            output: z.object({ chunk: z.string() }),
            scopes: ['hub.read'],
            stream: true,
          }),
          stat: abilityMethod({
            input: z.object({}),
            mcp: { name: 'hub_stat' },
            output: z.object({ size: z.number() }),
            scopes: ['hub.read'],
          }),
        },
        scopes: ['hub.read'],
        handler: () => new HubApi() as HubApi & Record<string, unknown>,
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
    id: 'hub',
    ...(options.ingress ? { ingress: { brokerServiceIds: ['control-plane'] } } : {}),
    title: 'Hub',
    version: '0.1.0',
  });

  const signingSecret = await generateCapabilitySigningSecret();
  plane = new ServicePlaneControlPlane({
    broker: options.omitCallerResolver ? {} : { caller: () => options.caller ?? { id: 'user-1', kind: 'user' } },
    issuer: 'https://issuer.example',
    log: false,
    mcp: { caller: () => options.caller ?? { id: 'user-1', kind: 'user' } },
    services: () => [
      cloudflareServiceBinding({
        binding: { fetch: (request) => service.fetch(request) },
        grants: [{ caller: 'control-plane', scopes: ['hub.read'] }],
        id: 'hub',
        origin: 'https://hub.internal',
      }),
    ],
    signingSecret: () => signingSecret,
  });

  const boundPlane = plane;
  const streamRequest = (body: unknown) =>
    boundPlane.fetch(
      new Request('https://plane.internal/rpc/broker/stream', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
  const mcpRequest = (body: unknown) =>
    boundPlane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
  return { mcpRequest, plane: boundPlane, streamRequest };
}

function parseNdjson(body: string): unknown[] {
  return body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function parseSse(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)));
}

describe('control-plane broker stream lane', () => {
  it('pipes a brokered NDJSON stream through the control plane', async () => {
    const { streamRequest } = await createFixture({ ingress: true });
    const response = await streamRequest({
      abilityId: 'hub.files',
      input: { parts: 2 },
      method: 'readFile',
      scopes: ['hub.read'],
      serviceId: 'hub',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(parseNdjson(await response.text())).toEqual([{ item: { chunk: 'part-0' } }, { item: { chunk: 'part-1' } }, { done: true }]);
  });

  it('fails closed without a caller resolver and rejects anonymous callers', async () => {
    const unconfigured = await createFixture({ omitCallerResolver: true });
    const noResolver = await unconfigured.streamRequest({
      abilityId: 'hub.files',
      method: 'readFile',
      scopes: ['hub.read'],
      serviceId: 'hub',
    });
    expect(noResolver.status).toBe(500);

    const anonymous = await createFixture({ caller: undefined });
    // The fixture defaults to a user caller when options.caller is undefined, so build one that
    // explicitly returns no caller.
    const rejecting = new ServicePlaneControlPlane({
      broker: { caller: () => undefined },
      services: () => [],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });
    const response = await rejecting.fetch(
      new Request('https://plane.internal/rpc/broker/stream', {
        body: JSON.stringify({ abilityId: 'hub.files', method: 'readFile', scopes: ['hub.read'], serviceId: 'hub' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(401);
    expect(anonymous.plane).toBeDefined();
  });

  it('rejects undeclared scopes and non-streaming methods', async () => {
    const { streamRequest } = await createFixture();
    const badScope = await streamRequest({
      abilityId: 'hub.files',
      method: 'readFile',
      scopes: ['hub.write'],
      serviceId: 'hub',
    });
    expect(badScope.status).toBe(403);

    const notStreaming = await streamRequest({
      abilityId: 'hub.files',
      method: 'stat',
      scopes: ['hub.read'],
      serviceId: 'hub',
    });
    expect(notStreaming.status).toBe(405);

    const invalid = await streamRequest({ abilityId: 'hub.files', serviceId: 'hub' });
    expect(invalid.status).toBe(400);
  });
});

describe('control-plane MCP streaming tools', () => {
  it('projects streaming tools with an aggregated output schema and stream marker', async () => {
    const { mcpRequest } = await createFixture();
    const response = await mcpRequest({ id: 1, jsonrpc: '2.0', method: 'tools/list' });
    const parsed = (await response.json()) as { result: { tools: Array<Record<string, unknown>> } };
    const tool = parsed.result.tools.find((candidate) => candidate.name === 'hub_read_file');
    expect(tool).toMatchObject({
      _meta: { servicePlane: { abilityId: 'hub.files', method: 'readFile', serviceId: 'hub', stream: true } },
      outputSchema: {
        properties: { items: { items: { properties: { chunk: { type: 'string' } } }, type: 'array' } },
        required: ['items'],
        type: 'object',
      },
    });
  });

  it('answers streaming tool calls over SSE with progress notifications and a final result', async () => {
    const { mcpRequest } = await createFixture({ ingress: true });
    const response = await mcpRequest({
      id: 7,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { _meta: { progressToken: 'tok-1' }, arguments: { parts: 2 }, name: 'hub_read_file' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const events = parseSse(await response.text());
    expect(events).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1, progressToken: 'tok-1' } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 2, progressToken: 'tok-1' } },
      {
        id: 7,
        jsonrpc: '2.0',
        result: {
          content: [{ text: JSON.stringify({ items: [{ chunk: 'part-0' }, { chunk: 'part-1' }] }), type: 'text' }],
          structuredContent: { items: [{ chunk: 'part-0' }, { chunk: 'part-1' }] },
        },
      },
    ]);
  });

  it('omits progress notifications without a progressToken', async () => {
    const { mcpRequest } = await createFixture();
    const response = await mcpRequest({
      id: 8,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { parts: 1 }, name: 'hub_read_file' },
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = parseSse(await response.text());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 8, result: { structuredContent: { items: [{ chunk: 'part-0' }] } } });
  });

  it('reports upstream stream failures as in-band tool errors', async () => {
    const { mcpRequest } = await createFixture();
    const response = await mcpRequest({
      id: 9,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { parts: 'NaN' }, name: 'hub_read_file' },
    });
    const parsed = (await response.json()) as { result: { isError?: boolean } };
    expect(parsed.result.isError).toBe(true);
  });
});
