import { RpcSession } from 'capnweb';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, defineCapabilities, RpcTarget, requireScopes, ServicePlaneService } from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import type { ServiceEndpoint, ServiceRegistrySnapshot } from '../shared/types.js';
import { memoryRpcTransportPair } from '../testing/index.js';
import { createControlPlaneRpcBroker } from './broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateMcpDiscovery, handleControlPlaneMcpRequest } from './mcp.js';
import { createServiceRegistry } from './registry.js';

const ISSUED_AT = new Date('2026-07-22T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-22T12:00:01.000Z');

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
  ingress?: boolean;
  streamLimits?: { maxBytes?: number; maxItems?: number };
  // Drop connectAbility from the endpoint so only HTTP-batch remains reachable.
  withoutNativeRpc?: boolean;
};

async function createFixture(options: FixtureOptions = {}) {
  const keys = await testKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'hub.read' }], serviceId: 'hub' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({
      grants: [{ caller: 'control-plane', scopes: ['hub.read'], target: 'hub' }],
    }),
    issuer: 'control-plane',
    keyId: 'test-key',
    now: () => ISSUED_AT,
    privateJwk: keys.privateJwk,
  });

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
        rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
        scopes: ['hub.read'],
        handler: () => new HubApi() as HubApi & Record<string, unknown>,
      }),
    ],
    auth: {
      issuer: 'control-plane',
      jwks: { keys: [keys.publicJwk] },
      now: () => VERIFIED_AT,
    },
    capabilities,
    id: 'hub',
    ...(options.ingress ? { ingress: { brokerServiceIds: ['control-plane'] } } : {}),
    title: 'Hub',
    version: '0.1.0',
  });

  const endpoint = cloudflareServiceBinding({
    binding: options.withoutNativeRpc
      ? { fetch: async (request: Request) => service.fetch(request) }
      : {
          connectAbility: (input: { abilityId: string; requestId?: string; token: string }) => service.connectAbility(input),
          fetch: async (request: Request) => service.fetch(request),
        },
    id: 'hub',
    origin: 'https://hub.internal',
  });
  const registry = createServiceRegistry({ services: [endpoint] });

  const mcpRequest = (body: unknown) =>
    handleControlPlaneMcpRequest(
      new Request('https://plane.internal/rpc/mcp', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      {
        caller: { id: 'user-1', kind: 'user' },
        controlPlaneServiceId: 'control-plane',
        issuer,
        registry,
        ...(options.streamLimits ? { streamLimits: options.streamLimits } : {}),
      },
    );

  return { issuer, mcpRequest, registry, service };
}

async function drainStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const items: T[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return items;
    items.push(value as T);
  }
}

function parseSse(body: string): unknown[] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)));
}

describe('brokered streaming abilities', () => {
  it('proxies a native ReadableStream through the broker for an ingress-protected service', async () => {
    const fixture = await createFixture({ ingress: true });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer: fixture.issuer,
      registry: fixture.registry,
    });

    type Brokered = {
      connect(scopes: string[]): Promise<{ readFile(input: { parts: number }): Promise<ReadableStream<{ chunk: string }>> }>;
    };
    const root = broker.rootCapability({ id: 'user-1', kind: 'user' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<Brokered>;
    };
    const api = await (await root.ability('hub', 'hub.files')).connect(['hub.read']);
    const stream = await api.readFile({ parts: 2 });
    await expect(drainStream(stream)).resolves.toEqual([{ chunk: 'part-0' }, { chunk: 'part-1' }]);
  });
});

describe('remote broker sessions', () => {
  it('serves unary calls and streams to a caller connected over a Cap’n Web session', async () => {
    const fixture = await createFixture({ ingress: true });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer: fixture.issuer,
      registry: fixture.registry,
    });

    // The caller talks to the broker over an actual wire: every message is serialized, so this
    // catches session objects that would not survive being returned by reference.
    const { left, right } = memoryRpcTransportPair();
    new RpcSession(right, broker.rootCapability({ id: 'user-1', kind: 'user' }));
    const root = new RpcSession<{
      ability(
        serviceId: string,
        abilityId: string,
      ): Promise<{
        connect(scopes: string[]): Promise<{
          readFile(input: { parts: number }): Promise<ReadableStream<{ chunk: string }>>;
          stat(input: Record<string, never>): Promise<{ size: number }>;
        }>;
      }>;
    }>(left).getRemoteMain();

    const api = await (await root.ability('hub', 'hub.files')).connect(['hub.read']);
    await expect(api.stat({})).resolves.toEqual({ size: 3 });
    // Cast: raw capnweb stub types cannot express typed item streams (see PR notes).
    const stream = (await api.readFile({ parts: 3 })) as unknown as ReadableStream<{ chunk: string }>;
    await expect(drainStream(stream)).resolves.toEqual([{ chunk: 'part-0' }, { chunk: 'part-1' }, { chunk: 'part-2' }]);
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

  it('caps stream aggregation and fails the tool call in-band', async () => {
    const { mcpRequest } = await createFixture({ streamLimits: { maxItems: 2 } });
    const response = await mcpRequest({
      id: 20,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { parts: 5 }, name: 'hub_read_file' },
    });
    const events = parseSse(await response.text());
    const final = events.at(-1) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(final.result.isError).toBe(true);
    expect(final.result.content[0]?.text).toContain('aggregation limits');
  });

  it('hoists root-relative $refs when wrapping a streaming tool output schema', () => {
    const endpoint: ServiceEndpoint = { fetch: async () => new Response(null, { status: 404 }), id: 'x', origin: 'https://x.internal' };
    const snapshot: ServiceRegistrySnapshot = {
      abilities: [
        {
          access: 'plane',
          exposure: 'published',
          id: 'x.tree',
          methods: {
            walk: {
              inputSchema: { type: 'object' },
              mcp: { name: 'x_walk' },
              outputSchema: {
                properties: { children: { items: { $ref: '#' }, type: 'array' }, name: { type: 'string' } },
                type: 'object',
              },
              scopes: ['s'],
              stream: true,
            },
          },
          rpc: { path: '/rpc/x.tree', transports: ['cloudflare-binding-rpc'] },
          scopes: ['s'],
          service: endpoint,
          serviceId: 'x',
          serviceTitle: 'X',
          serviceVersion: '1',
        },
      ],
      discoveredAt: new Date(0).toISOString(),
      services: [],
    };
    expect(generateMcpDiscovery(snapshot).tools[0]?.outputSchema).toEqual({
      $defs: {
        item: {
          properties: { children: { items: { $ref: '#/$defs/item' }, type: 'array' }, name: { type: 'string' } },
          type: 'object',
        },
      },
      properties: { items: { items: { $ref: '#/$defs/item' }, type: 'array' } },
      required: ['items'],
      type: 'object',
    });
  });

  it('drops discovered documents whose streaming methods claim single-response projections', async () => {
    const registry = createServiceRegistry({
      services: [
        {
          discovery: {
            abilities: [
              {
                access: 'plane' as const,
                exposure: 'published' as const,
                id: 'bad.a',
                methods: {
                  m: {
                    inputSchema: { type: 'object' },
                    outputSchema: { type: 'object' },
                    rest: { method: 'post' as const, path: '/x' },
                    scopes: ['s'],
                    stream: true as const,
                  },
                },
                rpc: { path: '/rpc/bad.a', transports: ['websocket' as const] },
                scopes: ['s'],
              },
            ],
            id: 'bad',
            title: 'Bad',
            version: '1',
          },
          fetch: async () => new Response(null, { status: 404 }),
          id: 'bad',
          origin: 'https://bad.internal',
        },
      ],
    });
    const snapshot = await registry.discover();
    expect(snapshot.services).toHaveLength(0);
  });

  it('reports invalid input as an in-band tool error before any stream starts', async () => {
    const { mcpRequest } = await createFixture();
    const response = await mcpRequest({
      id: 9,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { parts: 'NaN' }, name: 'hub_read_file' },
    });
    expect(response.headers.get('content-type')).toContain('application/json');
    const parsed = (await response.json()) as { result: { isError?: boolean } };
    expect(parsed.result.isError).toBe(true);
  });

  it('degrades to an in-band error when the endpoint has no session transport', async () => {
    const { mcpRequest } = await createFixture({ withoutNativeRpc: true });
    const response = await mcpRequest({
      id: 10,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { parts: 1 }, name: 'hub_read_file' },
    });
    const parsed = (await response.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(parsed.result.isError).toBe(true);
    expect(parsed.result.content[0]?.text).toContain('session transport');

    // Unary tools on the same ability keep working over HTTP-batch.
    const unary = await mcpRequest({
      id: 11,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'hub_stat' },
    });
    const unaryParsed = (await unary.json()) as { result: { structuredContent?: unknown } };
    expect(unaryParsed.result.structuredContent).toEqual({ size: 3 });
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
