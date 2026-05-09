import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { defineService, defineNamespace, serviceDiscoveryDocument } from './discovery.js';

describe('service discovery', () => {
  it('builds a discovery document from explicit Hono namespaces', () => {
    const publicApp = new Hono().post('/events/:source', (context) => context.text(context.req.param('source')));
    const internalApp = new Hono().post('/v1/sync', (context) => context.json({ ok: true }));

    const service = defineService({
      id: 'moco',
      namespaces: [
        defineNamespace({ app: publicApp, prefix: '/', visibility: 'public' }),
        defineNamespace({ app: internalApp, prefix: '/providers/moco', visibility: 'internal' }),
      ],
      title: 'MOCO',
      version: '0.0.1',
    });

    expect(serviceDiscoveryDocument(service)).toEqual({
      id: 'moco',
      routes: [
        { method: 'POST', path: '/events/:source', visibility: 'public' },
        { method: 'POST', path: '/providers/moco/v1/sync', visibility: 'internal' },
      ],
      title: 'MOCO',
      version: '0.0.1',
    });
  });
});
