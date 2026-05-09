import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { capability, capabilityAuth, defineCapabilities } from '../service/capabilities.js';
import { defineNamespace, defineService, mountDiscovery } from '../service/discovery.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { createControlPlaneProxy } from './proxy.js';
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
        version: '0.1.0',
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

  it('adds STS capability tokens to scoped proxied routes', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.events.ingest', title: 'Ingest example events' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['example.events.ingest'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const providerRoutes = new Hono().post('/events/example', capability('example.events.ingest'), (context) => context.json({ scoped: true }));
    const provider = new Hono();
    provider.use('*', capabilityAuth({ expectedAudience: 'example', issuer: 'control-plane', jwks: await issuer.jwks(), now: new Date('2026-05-09T12:00:01.000Z') }));
    provider.route('/', providerRoutes);
    mountDiscovery(
      provider,
      defineService({
        capabilities,
        id: 'example',
        namespaces: [defineNamespace({ app: providerRoutes, prefix: '/', visibility: 'public' })],
        title: 'Example',
        version: '0.1.0',
      }),
    );
    const registry = createServiceRegistry({
      services: [cloudflareServiceBinding({ binding: { fetch: (request) => provider.fetch(request) }, id: 'example' })],
    });
    const controlPlane = new Hono().use(
      '*',
      createControlPlaneProxy({
        capabilityToken: async (_context, route) =>
          (
            await issuer.issueCapabilityToken({
              callerServiceId: 'control-plane',
              scopes: route.requiredScopes ?? [],
              targetServiceId: route.serviceId,
            })
          ).token,
        registry,
      }),
    );

    expect((await provider.request('/events/example', { method: 'POST' })).status).toBe(401);
    expect(await (await controlPlane.request('/events/example', { body: 'payload', method: 'POST' })).json()).toEqual({ scoped: true });
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
