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
        rest: { method: 'post', operationId: 'searchExamples', path: '/examples/search', summary: 'Search examples' },
        scopes: ['example.search'],
      },
    },
    rpc: { path: '/rpc/example.search', transports: ['http-batch'] },
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
    expect(operation?.security).toEqual([{ ServicePlane: [] }]);

    const requestBody = operation?.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined;
    expect(requestBody?.content?.['application/json']?.schema).toMatchObject({
      properties: { query: { type: 'string' } },
      type: 'object',
    });

    // A security scheme is emitted only because a projected operation declares scopes.
    expect(document.components).toMatchObject({
      securitySchemes: { ServicePlane: { scheme: 'bearer', type: 'http' } },
    });
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
    expect(document.paths['/examples/search']?.post).toBeUndefined();
  });

  it('excludes private abilities and methods without REST metadata', () => {
    const document = generateControlPlaneOpenApi({
      snapshot: snapshotOf([
        publishedAbility({ exposure: 'private' }),
        publishedAbility({
          id: 'example.rpc-only',
          methods: { run: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, scopes: [] } },
          rpc: { path: '/rpc/example.rpc-only', transports: ['http-batch'] },
          scopes: [],
        }),
      ]),
    });

    expect(Object.keys(document.paths)).toHaveLength(0);
    expect(document.components).toBeUndefined();
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
      rpc: { path: '/rpc/example.other', transports: ['http-batch'] },
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
});
