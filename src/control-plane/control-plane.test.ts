import { RpcTarget } from 'capnweb';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  abilityMethod,
  controlPlaneHmacTokenRequester,
  defineAbility,
  defineCapabilities,
  requireScopes,
  ServicePlaneService,
} from '../service/index.js';
import {
  type CapabilityJwks,
  type OpenApiDocument,
  type OpenApiDocumentCache,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_MCP_PATH,
  SERVICE_PLANE_OPENAPI_PATH,
  type ServiceDiscoveryDocument,
} from '../shared/types.js';
import { hmacServiceClientAuth } from './caller-auth.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

const discovery: ServiceDiscoveryDocument = {
  abilities: [
    {
      access: 'service',
      exposure: 'private',
      id: 'example.sync',
      methods: {
        runSync: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scopes: ['example.sync.run'],
        },
      },
      rpc: { path: '/rpc/example.sync', transports: ['http-batch'] },
      scopes: ['example.sync.run'],
    },
    {
      access: 'plane',
      exposure: 'published',
      id: 'example.search',
      methods: {
        search: {
          inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
          mcp: { name: 'example_search' },
          outputSchema: { properties: { results: { type: 'array' } }, type: 'object' },
          rest: { method: 'post', operationId: 'searchExamples', path: '/examples/search', summary: 'Search examples' },
          scopes: ['example.search'],
        },
      },
      rpc: { path: '/rpc/example.search', transports: ['http-batch'] },
      scopes: ['example.search'],
    },
  ],
  capabilities: { scopes: [{ id: 'example.sync.run' }, { id: 'example.search' }], serviceId: 'example' },
  id: 'example',
  title: 'Example',
  version: '0.1.0',
};

describe('ServicePlaneControlPlane', () => {
  it('fails closed when caller authentication is not configured', async () => {
    const plane = new ServicePlaneControlPlane({
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const response = await plane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['example.sync.run'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(500);
  });

  it('mounts token and JWKS endpoints and authenticates HMAC-signed token requests', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: hmacServiceClientAuth({
        clients: [{ clientId: 'worker-a', secret: 'a'.repeat(43) }],
        now: () => new Date('2026-05-09T12:00:00.000Z'),
      }),
      services: () => [serviceEndpoint()],
      signingSecret: () => signingSecret,
    });

    const jwks = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    expect(jwks.status).toBe(200);
    await expect(jwks.json()).resolves.toMatchObject({ keys: [{ kid: 'default' }] });

    const requestToken = controlPlaneHmacTokenRequester({
      clientId: 'worker-a',
      clientSecret: 'a'.repeat(43),
      controlPlaneUrl: 'https://plane.internal',
      fetch: (request) => plane.fetch(request),
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      requestId: 'req-1',
    });

    await expect(
      requestToken({
        callerServiceId: 'worker-a',
        scopes: ['example.sync.run'],
        targetServiceId: 'example',
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('issues private RPC tokens for deployment-bound callers', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const plane = new ServicePlaneControlPlane({
      services: () => [serviceEndpoint()],
      signingSecret: () => signingSecret,
    });

    await expect(
      plane.issueCapabilityTokenForCaller(
        'worker-a',
        {
          scopes: ['example.sync.run'],
          targetServiceId: 'example',
        },
        {},
      ),
    ).resolves.toMatchObject({ token: expect.any(String), tokenType: 'ServicePlane' });
  });

  it('generates and caches centralized OpenAPI from published ability metadata', async () => {
    const cache = memoryOpenApiDocumentCache();
    let discoveryFetches = 0;
    const plane = new ServicePlaneControlPlane({
      openapi: {
        cache,
        title: 'Control Plane APIs',
        version: '2026.05.23',
      },
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: async () => {
              discoveryFetches += 1;
              return Response.json(discovery);
            },
          },
          id: 'example',
        }),
      ],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      info: { title: 'Control Plane APIs', version: '2026.05.23' },
      openapi: '3.1.0',
      paths: {
        '/examples/search': {
          post: {
            operationId: 'searchExamples',
            security: [{ ServicePlane: [] }],
            'x-service-plane': {
              abilityId: 'example.search',
              method: 'search',
              scopes: ['example.search'],
              serviceId: 'example',
            },
          },
        },
      },
    });

    const cached = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`));
    expect(cached.status).toBe(200);
    expect(discoveryFetches).toBe(1);
  });

  it('emits cache headers on OpenAPI and JWKS when httpCache is enabled and never caches token responses', async () => {
    const plane = new ServicePlaneControlPlane({
      httpCache: true,
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const openapi = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`));
    expect(openapi.status).toBe(200);
    expect(openapi.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=300');
    expect(openapi.headers.get('cache-tag')).toBe('service-plane,service-plane:openapi');
    expect(openapi.headers.get('etag')).toBeTruthy();

    const jwks = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    expect(jwks.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=300');
    expect(jwks.headers.get('cache-tag')).toBe('service-plane,service-plane:jwks');

    const token = await plane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['example.sync.run'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(token.headers.get('cache-control')).toBe('no-store');

    const uncachedPlane = new ServicePlaneControlPlane({
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });
    const uncachedOpenapi = await uncachedPlane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`));
    expect(uncachedOpenapi.headers.get('cache-control')).toBeNull();
  });

  it('serves the OpenAPI document without a bundled UI', async () => {
    const plane = new ServicePlaneControlPlane({
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const openapi = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_OPENAPI_PATH}`));
    expect(openapi.status).toBe(200);
    await expect(openapi.json()).resolves.toMatchObject({ openapi: '3.1.0' });

    // The plane only projects the OpenAPI document; a docs UI (e.g. @hono/swagger-ui or
    // @scalar/hono-api-reference) is mounted by the consumer on plane.app.
    const noBundledUi = await plane.fetch(new Request('https://plane.internal/swagger'));
    expect(noBundledUi.status).toBe(404);
  });

  it('fails closed on broker and MCP endpoints until caller authentication is configured', async () => {
    const plane = new ServicePlaneControlPlane({
      broker: {},
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const mcp = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, { method: 'POST' }));
    expect(mcp.status).toBe(500);

    const broker = await plane.fetch(new Request('https://plane.internal/rpc/broker', { method: 'POST' }));
    expect(broker.status).toBe(500);
  });

  it('speaks the MCP streamable-HTTP protocol once a caller resolver is configured', async () => {
    const plane = new ServicePlaneControlPlane({
      mcp: { caller: () => ({ id: 'gateway', kind: 'user' }) },
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const initialize = await mcpRequest(plane, {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' }, protocolVersion: '2025-06-18' },
    });
    expect(initialize.status).toBe(200);
    await expect(initialize.json()).resolves.toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'control-plane' },
      },
    });

    const initialized = await mcpRequest(plane, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(initialized.status).toBe(202);

    const tools = await mcpRequest(plane, { id: 2, jsonrpc: '2.0', method: 'tools/list' });
    await expect(tools.json()).resolves.toMatchObject({
      id: 2,
      result: {
        tools: [
          {
            _meta: { servicePlane: { abilityId: 'example.search', method: 'search', serviceId: 'example' } },
            inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
            name: 'example_search',
          },
        ],
      },
    });

    const unknownTool = await mcpRequest(plane, {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: {}, name: 'missing_tool' },
    });
    await expect(unknownTool.json()).resolves.toMatchObject({ error: { code: -32602 }, id: 3 });

    const get = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`));
    expect(get.status).toBe(405);
  });

  it('uses the control-plane service id rather than the issuer when MCP brokers plane-access calls', async () => {
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.search' }],
      serviceId: 'example',
    });
    let plane: ServicePlaneControlPlane | undefined;
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
              scopes: ['example.search'],
            }),
          },
          scopes: ['example.search'],
          handler: () => new SearchApi() as SearchApi & Record<string, unknown>,
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
      title: 'Example',
      version: '0.1.0',
    });

    const signingSecret = await generateCapabilitySigningSecret();
    plane = new ServicePlaneControlPlane({
      issuer: 'https://issuer.example',
      mcp: { caller: () => ({ id: 'gateway', kind: 'user' }) },
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          grants: [{ caller: 'control-plane', scopes: ['example.search'] }],
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
      signingSecret: () => signingSecret,
    });

    const response = await mcpRequest(plane, {
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { query: 'blue' }, name: 'example_search' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 1,
      result: {
        content: [{ text: JSON.stringify({ caller: 'control-plane', results: ['blue'] }), type: 'text' }],
        structuredContent: { caller: 'control-plane', results: ['blue'] },
      },
    });
  });

  it('forwards the caller request id through the MCP broker to the service', async () => {
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.search' }],
      serviceId: 'example',
    });
    let plane: ServicePlaneControlPlane | undefined;
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
              scopes: ['example.search'],
            }),
          },
          scopes: ['example.search'],
          handler: () => new SearchApi() as SearchApi & Record<string, unknown>,
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
      title: 'Example',
      version: '0.1.0',
    });

    const seenRequests: Request[] = [];
    const signingSecret = await generateCapabilitySigningSecret();
    plane = new ServicePlaneControlPlane({
      issuer: 'https://issuer.example',
      log: false,
      mcp: { caller: () => ({ id: 'gateway', kind: 'user' }) },
      services: () => [
        cloudflareServiceBinding({
          binding: {
            fetch: (request) => {
              seenRequests.push(request);
              return service.fetch(request);
            },
          },
          grants: [{ caller: 'control-plane', scopes: ['example.search'] }],
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
      signingSecret: () => signingSecret,
    });

    const response = await mcpRequest(
      plane,
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { arguments: { query: 'green' }, name: 'example_search' },
      },
      { 'X-Request-Id': 'req-mcp-9' },
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { structuredContent: { caller: 'control-plane', results: ['green'] } },
    });

    const rpcRequest = seenRequests.find((request) => new URL(request.url).pathname === '/rpc/example.search');
    expect(rpcRequest?.headers.get('X-Request-Id')).toBe('req-mcp-9');
  });
});

class SearchApi extends RpcTarget {
  async search(input: { query: string }) {
    const caller = requireScopes(this, 'example.search');
    return { caller: caller.serviceId, results: [input.query] };
  }
}

function serviceEndpoint() {
  return cloudflareServiceBinding({
    binding: {
      fetch: async () => Response.json(discovery),
    },
    grants: [{ caller: 'worker-a', scopes: ['example.sync.run'] }],
    id: 'example',
  });
}

function memoryOpenApiDocumentCache(): OpenApiDocumentCache {
  const values = new Map<string, OpenApiDocument>();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

function mcpRequest(plane: ServicePlaneControlPlane, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return plane.fetch(
    new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
    }),
  );
}
