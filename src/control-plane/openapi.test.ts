import { describe, expect, it } from 'vitest';
import type { DiscoveredServiceAbility, ServiceEndpoint, ServiceRegistrySnapshot } from '../shared/types.js';
import { controlPlaneOpenApiCacheKey, generateControlPlaneOpenApi } from './openapi.js';

const endpoint: ServiceEndpoint = {
  fetch: async () => new Response(null, { status: 404 }),
  id: 'example',
  origin: 'https://example.internal',
};

function publishedAbility(overrides: Partial<DiscoveredServiceAbility> = {}): DiscoveredServiceAbility {
  return {
    access: 'plane',
    exposure: 'published',
    id: 'example.search',
    methods: {
      search: {
        inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
        outputSchema: { type: 'object' },
        rest: { method: 'post', operationId: 'searchExamples', path: '/examples/search', status: 202, summary: 'Search examples' },
        scopes: ['example.search'],
      },
    },
    rpc: { path: '/rpc/v1/example.search', transports: ['fetch'] },
    scopes: ['example.search'],
    service: endpoint,
    serviceId: 'example',
    serviceTitle: 'Example',
    serviceVersion: '0.1.0',
    ...overrides,
  };
}

function snapshotOf(abilities: DiscoveredServiceAbility[]): ServiceRegistrySnapshot {
  return { abilities, discoveredAt: '2026-05-09T12:00:00.000Z', services: [] };
}

describe('generateControlPlaneOpenApi', () => {
  it('uses a neutral API version instead of inheriting the package release version', () => {
    const document = generateControlPlaneOpenApi({ snapshot: snapshotOf([]) });

    expect(document.info).toEqual({ title: 'Service Plane API', version: '1.0.0' });
    expect(controlPlaneOpenApiCacheKey([], {})).toContain('"version":"1.0.0"');
  });

  it('projects published REST methods from Zod-derived schemas into an OpenAPI 3.2 document', () => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([publishedAbility()]),
      title: 'Control Plane APIs',
      version: '2026.05.23',
    });

    expect(document.openapi).toBe('3.2.0');
    expect(document.info).toMatchObject({ title: 'Control Plane APIs', version: '2026.05.23' });

    const operation = document.paths['/examples/search']?.post as Record<string, unknown> | undefined;
    expect(operation?.operationId).toBe('searchExamples');
    expect(operation?.security).toBeUndefined();

    const requestBody = operation?.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined;
    expect(requestBody?.content?.['application/json']?.schema).toMatchObject({
      properties: { query: { type: 'string' } },
      type: 'object',
    });
    expect(operation?.responses).toMatchObject({ 202: { description: 'Successful response' } });
    expect(operation?.responses).not.toHaveProperty('200');

    // Invocation middleware is application-owned, so the document does not invent an auth scheme.
    expect(document.components).toBeUndefined();
  });

  it('projects a QUERY method onto the 3.2 query field of the path item', () => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([
        publishedAbility({
          methods: {
            search: {
              inputSchema: { properties: { query: { type: 'string' } }, type: 'object' },
              outputSchema: { type: 'object' },
              // QUERY (RFC 10008): safe and idempotent, parameters travel in the request body —
              // OpenAPI 3.2 models it as a fixed `query` field beside get/post/put.
              rest: { method: 'query', path: '/examples/search', summary: 'Search examples' },
              scopes: ['example.search'],
            },
          },
        }),
      ]),
    });

    const operation = document.paths['/examples/search']?.query as Record<string, unknown> | undefined;
    expect(operation?.operationId).toBe('example.example.search.search');
    const requestBody = operation?.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined;
    expect(requestBody?.content?.['application/json']?.schema).toMatchObject({ type: 'object' });
    expect(operation?.responses).toHaveProperty('200');
    expect(document.paths['/examples/search']?.post).toBeUndefined();
  });

  it('documents path, query fallback, and JSON body inputs with their runtime precedence', () => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([
        publishedAbility({
          methods: {
            search: {
              inputSchema: {
                additionalProperties: false,
                properties: {
                  connectionId: { type: 'string' },
                  dryRun: { type: 'string' },
                  limit: { type: 'number' },
                },
                required: ['connectionId', 'dryRun', 'limit'],
                type: 'object',
              },
              outputSchema: { type: 'object' },
              rest: { method: 'post', path: '/connections/{connectionId}/search' },
              scopes: [],
            },
          },
        }),
      ]),
    });

    const operation = document.paths['/connections/{connectionId}/search']?.post as Record<string, unknown>;
    expect(operation.parameters).toEqual([
      { in: 'path', name: 'connectionId', required: true, schema: { type: 'string' } },
      {
        description: 'Query fallback; a JSON body value with the same name takes precedence.',
        in: 'query',
        name: 'dryRun',
        required: false,
        schema: { type: 'string' },
      },
    ]);
    expect(operation.requestBody).toEqual({
      content: {
        'application/json': {
          schema: {
            additionalProperties: false,
            properties: { dryRun: { type: 'string' }, limit: { type: 'number' } },
            required: ['limit'],
            type: 'object',
          },
        },
      },
      required: true,
    });
  });

  it('uses explicitly configured public authentication instead of assuming Service Plane bearer tokens', () => {
    const document = generateControlPlaneOpenApi({
      security: [{ ProductApiKey: [] }],
      securitySchemes: { ProductApiKey: { in: 'header', name: 'X-API-Key', type: 'apiKey' } },
      snapshot: snapshotOf([publishedAbility()]),
    });

    expect(document.security).toEqual([{ ProductApiKey: [] }]);
    expect(document.components).toEqual({
      securitySchemes: { ProductApiKey: { in: 'header', name: 'X-API-Key', type: 'apiKey' } },
    });
  });

  it('excludes private abilities and methods without REST metadata', () => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([
        publishedAbility({ exposure: 'private' }),
        publishedAbility({
          id: 'example.rpc-only',
          methods: { run: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, scopes: [] } },
          rpc: { path: '/rpc/v1/example.rpc-only', transports: ['fetch'] },
          scopes: [],
        }),
      ]),
    });

    expect(Object.keys(document.paths)).toHaveLength(0);
    expect(document.components).toBeUndefined();
  });

  it('omits response content for bodyless success statuses', () => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([
        publishedAbility({
          methods: {
            remove: {
              inputSchema: { type: 'object' },
              outputSchema: { type: 'null' },
              rest: { method: 'delete', path: '/examples/{id}', status: 204 },
              scopes: [],
            },
          },
        }),
      ]),
    });

    const operation = document.paths['/examples/{id}']?.delete as Record<string, unknown> | undefined;
    expect(operation?.responses).toEqual({ 204: { description: 'Successful response' } });
    expect(operation?.parameters).toEqual([{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }]);
  });

  it.each([
    { expectedStatus: 201, status: 201 },
    { expectedStatus: 205, status: 205 },
  ])('projects the declared $expectedStatus success status', ({ expectedStatus, status }) => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([
        publishedAbility({
          methods: {
            write: {
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              rest: { method: 'post', path: '/examples', status },
              scopes: [],
            },
          },
        }),
      ]),
    });

    const operation = document.paths['/examples']?.post as { responses: Record<string, unknown> } | undefined;
    const responses = operation?.responses ?? {};
    expect(responses).toHaveProperty(String(expectedStatus));
    expect(responses).not.toHaveProperty('200');
    if (status === 205) expect(responses[status]).toEqual({ description: 'Successful response' });
  });
});

describe('generateControlPlaneOpenApi operation ids', () => {
  it('defaults operation ids to service-qualified names', () => {
    const ability = publishedAbility({
      methods: {
        search: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          rest: { method: 'post', path: '/examples/search' },
          scopes: [],
        },
      },
    });

    const document = generateControlPlaneOpenApi({ snapshot: snapshotOf([ability]) });
    const operation = document.paths['/examples/search']?.post as Record<string, unknown> | undefined;
    expect(operation?.operationId).toBe('example.example.search.search');
  });

  it('rejects duplicate operation ids across published methods', () => {
    const other = publishedAbility({
      id: 'example.other',
      methods: {
        search: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          rest: { method: 'post', operationId: 'searchExamples', path: '/examples/other' },
          scopes: [],
        },
      },
      rpc: { path: '/rpc/v1/example.other', transports: ['fetch'] },
    });

    expect(() => generateControlPlaneOpenApi({ snapshot: snapshotOf([publishedAbility(), other]) })).toThrow(
      'Duplicate OpenAPI operationId across published methods: searchExamples',
    );
  });
});

describe('controlPlaneOpenApiCacheKey', () => {
  it('namespaces the cache key by endpoint origin', () => {
    const eu = [{ id: 'example', origin: 'https://eu.example.internal' }];
    const us = [{ id: 'example', origin: 'https://us.example.internal' }];
    expect(controlPlaneOpenApiCacheKey(eu, {})).not.toBe(controlPlaneOpenApiCacheKey(us, {}));
  });

  it('is insensitive to endpoint order', () => {
    const services = [
      { id: 'alpha', origin: 'https://alpha.internal' },
      { id: 'beta', origin: 'https://beta.internal' },
    ];
    expect(controlPlaneOpenApiCacheKey(services, {})).toBe(controlPlaneOpenApiCacheKey([...services].reverse(), {}));
  });

  it('includes the configured public security contract', () => {
    const security = { security: [{ ProductApiKey: [] }], securitySchemes: { ProductApiKey: { type: 'apiKey' } } };
    expect(controlPlaneOpenApiCacheKey([endpoint], security)).not.toBe(controlPlaneOpenApiCacheKey([endpoint], {}));
  });

  it('namespaces and normalizes reserved REST routes', () => {
    expect(controlPlaneOpenApiCacheKey([endpoint], {}, ['/mcp'])).not.toBe(controlPlaneOpenApiCacheKey([endpoint], {}));
    expect(controlPlaneOpenApiCacheKey([endpoint], {}, ['/rpc/v1/', ' /mcp'])).toBe(
      controlPlaneOpenApiCacheKey([endpoint], {}, ['/mcp/', '/rpc/v1']),
    );
  });
});
