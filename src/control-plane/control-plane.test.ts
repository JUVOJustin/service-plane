import { RpcSession, RpcTarget, type RpcTransport } from 'capnweb';
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
  SERVICE_PLANE_SWAGGER_PATH,
  type ServiceDiscoveryDocument,
} from '../shared/types.js';
import { hmacServiceClientAuth } from './caller-auth.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

const discovery: ServiceDiscoveryDocument = {
  abilities: [
    {
      auth: 'service',
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
      auth: 'user',
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

  it('serves Swagger UI and MCP tool discovery routes', async () => {
    const plane = new ServicePlaneControlPlane({
      services: () => [serviceEndpoint()],
      signingSecret: async () => generateCapabilitySigningSecret(),
    });

    const swagger = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_SWAGGER_PATH}`));
    expect(swagger.status).toBe(200);
    await expect(swagger.text()).resolves.toContain(SERVICE_PLANE_OPENAPI_PATH);

    const mcp = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, { method: 'POST' }));
    expect(mcp.status).toBe(200);
  });

  it('uses the control-plane service id rather than the issuer when MCP brokers anonymous calls', async () => {
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.search' }],
      serviceId: 'example',
    });
    let plane: ServicePlaneControlPlane | undefined;
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          auth: 'anonymous',
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

    type McpRoot = {
      callTool(name: string, input: unknown): Promise<unknown>;
    };
    const root = new RpcSession<McpRoot>(
      honoBatchTransport((request) => plane?.fetch(request) ?? Promise.resolve(new Response(null, { status: 500 }))),
    ).getRemoteMain();

    await expect(root.callTool('example_search', { query: 'blue' })).resolves.toEqual({
      caller: 'control-plane',
      results: ['blue'],
    });
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

function honoBatchTransport(fetcher: (request: Request) => Promise<Response>): RpcTransport {
  let batchToSend: string[] | null = [];
  let batchToReceive: string[] | undefined;
  let aborted: unknown;
  const scheduled = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (aborted !== undefined) throw aborted;
    const batch = batchToSend ?? [];
    batchToSend = null;
    const response = await fetcher(
      new Request(`https://plane.internal${SERVICE_PLANE_MCP_PATH}`, {
        body: batch.join('\n'),
        method: 'POST',
      }),
    );
    if (!response.ok) {
      response.body?.cancel();
      throw new Error(`Cap'n Web HTTP-batch transport failed: ${response.status}`);
    }
    const body = await response.text();
    batchToReceive = body === '' ? [] : body.split('\n');
  })();

  return {
    abort(reason) {
      aborted = reason;
    },
    async receive() {
      if (!batchToReceive) await scheduled;
      const message = batchToReceive?.shift();
      if (message !== undefined) return message;
      throw new Error('Batch RPC request ended.');
    },
    async send(message) {
      batchToSend?.push(message);
    },
  };
}
