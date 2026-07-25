import { describe, expect, it } from 'vitest';
import { SERVICE_DISCOVERY_PATH, type ServiceDiscoveryDocument } from '../shared/types.js';
import { memoryRegistryCache } from '../testing/index.js';
import { cloudflareServiceBinding, httpsService, serviceDiscoveryRequest } from './endpoints.js';
import { createServiceRegistry } from './registry.js';

describe('service registry', () => {
  const document: ServiceDiscoveryDocument = {
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
    ],
    capabilities: { scopes: [{ id: 'example.sync.run' }], serviceId: 'example' },
    id: 'example',
    title: 'Example',
    version: '0.0.1',
  };

  it('discovers abilities from service endpoints and resolves abilities by id', async () => {
    const registry = createServiceRegistry({
      services: [
        cloudflareServiceBinding({
          binding: {
            fetch: async (request) => {
              expect(new URL(request.url).pathname).toBe(SERVICE_DISCOVERY_PATH);
              return Response.json(document);
            },
          },
          id: 'example',
        }),
      ],
    });

    const snapshot = await registry.discover();
    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.abilities).toMatchObject([{ id: 'example.sync', serviceId: 'example', exposure: 'private' }]);
    await expect(registry.ability('example', 'example.sync')).resolves.toMatchObject({ rpc: { path: '/rpc/example.sync' } });
    expect(registry.endpoint('example')?.id).toBe('example');
  });

  it('caches discovery documents and revalidates stale cache entries with ETags', async () => {
    let now = Date.parse('2026-05-09T12:00:00.000Z');
    let fetches = 0;
    const registry = createServiceRegistry({
      cache: memoryRegistryCache(() => now),
      services: [
        httpsService({
          baseUrl: 'https://example.internal',
          fetch: async (input) => {
            fetches += 1;
            const request = new Request(input);
            if (request.headers.get('if-none-match') === 'v1') return new Response(null, { status: 304 });
            return Response.json(document, { headers: { etag: 'v1' } });
          },
          id: 'example',
        }),
      ],
    });

    await expect(registry.discover()).resolves.toMatchObject({ services: [{ id: 'example' }] });
    await registry.discover();
    now += 31_000;
    await registry.discover();
    expect(fetches).toBe(2);
  });

  it('namespaces the default cache key by resolved service set', async () => {
    const cache = memoryRegistryCache();
    let exampleFetches = 0;
    let otherFetches = 0;
    const otherDocument: ServiceDiscoveryDocument = {
      ...document,
      capabilities: { scopes: [{ id: 'other.sync.run' }], serviceId: 'other' },
      id: 'other',
      title: 'Other',
    };

    const example = createServiceRegistry({
      cache,
      services: [
        httpsService({
          baseUrl: 'https://example.internal',
          fetch: async () => {
            exampleFetches += 1;
            return Response.json(document);
          },
          id: 'example',
        }),
      ],
    });
    const other = createServiceRegistry({
      cache,
      services: [
        httpsService({
          baseUrl: 'https://other.internal',
          fetch: async () => {
            otherFetches += 1;
            return Response.json(otherDocument);
          },
          id: 'other',
        }),
      ],
    });

    await expect(example.discover()).resolves.toMatchObject({ services: [{ id: 'example' }] });
    await expect(other.discover()).resolves.toMatchObject({ services: [{ id: 'other' }] });
    expect(exampleFetches).toBe(1);
    expect(otherFetches).toBe(1);
  });

  it('uses inline discovery and omits malformed documents', async () => {
    const registry = createServiceRegistry({
      services: [
        httpsService({
          baseUrl: 'https://inline.internal',
          discovery: document,
          fetch: async () => {
            throw new Error('should not fetch inline discovery');
          },
          id: 'example',
        }),
        httpsService({
          baseUrl: 'https://bad.internal',
          fetch: async () => Response.json({ not: 'a discovery document' }),
          id: 'bad',
        }),
      ],
    });

    const snapshot = await registry.discover();
    expect(snapshot.services.map((service) => service.id)).toEqual(['example']);
  });

  it('omits discovery documents with RPC paths that replace the configured service origin', async () => {
    const unsafeDocument: ServiceDiscoveryDocument = {
      ...document,
      abilities: document.abilities.map((ability) => ({ ...ability, rpc: { ...ability.rpc, path: '//other.example/rpc' } })),
    };
    const registry = createServiceRegistry({
      services: [
        httpsService({
          baseUrl: 'https://example.internal',
          discovery: unsafeDocument,
          id: 'example',
        }),
      ],
    });

    await expect(registry.discover()).resolves.toMatchObject({ abilities: [], services: [] });
  });

  it('builds discovery requests against the configured origin', () => {
    const endpoint = httpsService({ baseUrl: 'https://example.internal', id: 'example' });
    expect(serviceDiscoveryRequest(endpoint).url).toBe(`https://example.internal${SERVICE_DISCOVERY_PATH}`);
  });
});
