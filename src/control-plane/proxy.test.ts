import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { defineNamespace, defineService, mountDiscovery } from '../service/discovery.js';
import { machineAuth } from '../service/auth.js';
import { verifyMachineRequest } from '../shared/crypto.js';
import { signMachineRequest } from './auth.js';
import { createControlPlaneProxy } from './proxy.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { createServiceRegistry } from './registry.js';

describe('control-plane proxy', () => {
  it('proxies public and auth routes but not internal routes', async () => {
    const publicRoutes = new Hono().post('/events/example/:target', async (context) => context.text(await context.req.text()));
    const authRoutes = new Hono().get('/connections/example', (context) => context.json({ owner: context.req.header('x-owner-id') }));
    const internalRoutes = new Hono().post('/providers/example/v1/sync', (context) => context.json({ ok: true }));
    const provider = new Hono()
      .route('/', publicRoutes)
      .route('/', authRoutes)
      .route('/', internalRoutes);
    mountDiscovery(
      provider,
      defineService({
        id: 'example',
        namespaces: [
          defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
          defineNamespace({ app: authRoutes, prefix: '/', visibility: 'auth' }),
          defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
        ],
        title: 'Example',
        version: '0.0.1',
      }),
    );
    const registry = createServiceRegistry({
      services: [cloudflareServiceBinding({ binding: { fetch: (request) => provider.fetch(request) }, id: 'example' })],
    });
    const controlPlane = new Hono().use(
      '*',
      createControlPlaneProxy({
        authorizeAuthRoute: () => undefined,
        forwardHeaders: () => ({ 'x-owner-id': 'owner-1' }),
        registry,
      }),
    );

    await expect(await (await controlPlane.request('/events/example/project', { body: 'raw-body', method: 'POST' })).text()).toBe('raw-body');
    await expect(await (await controlPlane.request('/connections/example')).json()).toEqual({ owner: 'owner-1' });
    expect((await controlPlane.request('/providers/example/v1/sync', { method: 'POST' })).status).toBe(404);
  });

  it('signs proxied requests', async () => {
    const providerRoutes = new Hono().post(
      '/events/example',
      machineAuth({
        now: new Date('2026-05-09T12:00:01.000Z'),
        resolveSecret: () => 'shared-secret',
      }),
      (context) => context.json({ signed: true }),
    );
    const provider = new Hono().route('/', providerRoutes);
    mountDiscovery(
      provider,
      defineService({
        id: 'example',
        namespaces: [defineNamespace({ app: providerRoutes, prefix: '/', visibility: 'public' })],
        title: 'Example',
        version: '0.0.1',
      }),
    );
    const registry = createServiceRegistry({
      services: [cloudflareServiceBinding({ binding: { fetch: (request) => provider.fetch(request) }, id: 'example' })],
    });
    const controlPlane = new Hono().use(
      '*',
      createControlPlaneProxy({
        registry,
        signer: (request) =>
          signMachineRequest(request, {
            now: new Date('2026-05-09T12:00:00.000Z'),
            secret: 'shared-secret',
          }),
      }),
    );

    expect(await (await controlPlane.request('/events/example', { body: 'payload', method: 'POST' })).json()).toEqual({ signed: true });
  });

  it('can use the pure verifier for service-side adapters', async () => {
    const signed = await signMachineRequest(new Request('https://example.test/internal'), {
      now: new Date('2026-05-09T12:00:00.000Z'),
      secret: 'shared-secret',
    });
    await expect(
      verifyMachineRequest(signed, {
        now: new Date('2026-05-09T12:00:01.000Z'),
        resolveSecret: () => 'shared-secret',
      }),
    ).resolves.toMatchObject({ keyId: 'default' });
  });
});
