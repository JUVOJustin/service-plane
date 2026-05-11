import { describe, expect, it } from 'vitest';
import { defineService, RpcTarget, serviceDiscoveryDocument } from '../service/discovery.js';
import { defineCapabilities } from '../service/capabilities.js';
import { cloudflareServiceBinding, httpsService, serviceDiscoveryRequest } from './endpoints.js';
import { createServiceRegistry } from './registry.js';
import { memoryRegistryCache } from '../testing/memory-cache.js';
import { SERVICE_DISCOVERY_PATH } from '../shared/types.js';

describe('service registry', () => {
  const exampleCapabilities = defineCapabilities({
    scopes: [{ id: 'example.users.lookup' }],
    serviceId: 'example',
  });
  const service = defineService({
    capabilities: exampleCapabilities,
    exports: [
      { factory: () => new RpcTarget(), id: 'public', scopes: ['example.users.lookup'], visibility: 'public' },
      { factory: () => new RpcTarget(), id: 'internal', scopes: ['example.users.lookup'], visibility: 'internal' },
    ],
    id: 'example',
    title: 'Example',
    version: '0.0.1',
  });
  const document = serviceDiscoveryDocument(service);

  it('discovers services via fetch and caches the result', async () => {
    let fetches = 0;
    let now = Date.parse('2026-05-09T12:00:00.000Z');
    const registry = createServiceRegistry({
      cache: memoryRegistryCache(() => now),
      services: [
        cloudflareServiceBinding({
          binding: {
            fetch: async (request) => {
              const url = new URL(request.url);
              if (url.pathname !== SERVICE_DISCOVERY_PATH) return new Response('Not Found', { status: 404 });
              fetches += 1;
              return Response.json(document);
            },
          },
          id: 'example',
        }),
      ],
    });

    const first = await registry.discover();
    expect(first.services).toHaveLength(1);
    expect(first.services[0]!.exports).toHaveLength(2);
    expect(first.endpoints).toHaveLength(1);
    await registry.discover();
    now += 31_000;
    await registry.discover();
    expect(fetches).toBe(2);
  });

  it('exposes a service endpoint lookup helper', () => {
    const registry = createServiceRegistry({
      services: [cloudflareServiceBinding({ binding: { fetch: async () => new Response() }, id: 'example' })],
    });
    expect(registry.endpoint('example')?.id).toBe('example');
    expect(registry.endpoint('missing')).toBeUndefined();
  });

  it('omits services whose discovery document is malformed', async () => {
    const registry = createServiceRegistry({
      services: [
        httpsService({
          baseUrl: 'https://example.internal',
          fetch: async () => Response.json({ not: 'a service document' }),
          id: 'example',
        }),
      ],
    });
    const snapshot = await registry.discover();
    expect(snapshot.services).toHaveLength(0);
  });

  it('builds discovery requests against the configured origin', () => {
    const endpoint = httpsService({ baseUrl: 'https://example.internal', id: 'example' });
    expect(serviceDiscoveryRequest(endpoint).url).toBe(`https://example.internal${SERVICE_DISCOVERY_PATH}`);
  });
});
