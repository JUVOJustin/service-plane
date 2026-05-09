import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { defineNamespace, defineService, mountDiscovery } from '../service/discovery.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { createServiceRegistry } from './registry.js';
import { memoryRegistryCache } from '../testing/memory-cache.js';

describe('service registry', () => {
  it('discovers routes from service endpoints', async () => {
    const app = new Hono().get('/connections/example', (context) => context.json({ ok: true }));
    mountDiscovery(
      app,
      defineService({
        id: 'example',
        namespaces: [defineNamespace({ app, prefix: '/', visibility: 'auth' })],
        title: 'Example',
        version: '0.0.1',
      }),
    );
    const registry = createServiceRegistry({
      services: [cloudflareServiceBinding({ binding: { fetch: (request) => app.fetch(request) }, id: 'example' })],
    });

    await expect(registry.match('GET', '/connections/example')).resolves.toMatchObject({
      path: '/connections/example',
      serviceId: 'example',
      visibility: 'auth',
    });
  });

  it('can cache discovery documents through a callback cache', async () => {
    let now = Date.parse('2026-05-09T12:00:00.000Z');
    let discoveryFetches = 0;
    const app = new Hono().get('/ping', (context) => context.text('pong'));
    mountDiscovery(
      app,
      defineService({
        id: 'cached',
        namespaces: [defineNamespace({ app, prefix: '/', visibility: 'public' })],
        title: 'Cached',
        version: '0.0.1',
      }),
    );
    const registry = createServiceRegistry({
      cache: memoryRegistryCache(() => now),
      services: [
        cloudflareServiceBinding({
          binding: {
            fetch: (request) => {
              discoveryFetches += 1;
              return app.fetch(request);
            },
          },
          id: 'cached',
        }),
      ],
    });

    await registry.discover();
    await registry.discover();
    now += 31_000;
    await registry.discover();

    expect(discoveryFetches).toBe(2);
  });
});
