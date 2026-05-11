import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { capability, capabilityAuth, capabilityIdentity, defineCapabilities } from '../service/capabilities.js';
import { defineNamespace, defineService, mountDiscovery } from '../service/discovery.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { createControlPlaneProxy } from './proxy.js';
import { createServiceRegistry } from './registry.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('service-plane end-to-end topology', () => {
  it('runs one control plane against three Hono services with STS-scoped worker traffic only', async () => {
    const keys = await testKeys();
    const services = ['alpha', 'bravo', 'charlie'].map((id) => createMicroservice(id, keys));
    const issuer = createCapabilityIssuer({
      capabilities: services.map((service) => service.capabilities),
      grants: defineServiceGrants({
        grants: services.map((service) => ({
          caller: 'control-plane',
          scopes: [`${service.id}.events.ingest`, `${service.id}.console.read`],
          target: service.id,
        })),
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });
    let controlPlaneAuthChecks = 0;

    const registry = createServiceRegistry({
      services: services.map((service) =>
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.app.fetch(request) },
          id: service.id,
          origin: `https://${service.id}.internal`,
        }),
      ),
    });

    const controlPlane = new Hono().use(
      '*',
      createControlPlaneProxy({
        authorizeAuthRoute: (context) => {
          controlPlaneAuthChecks += 1;
          const principal = context.req.header('authorization')?.replace(/^Bearer\s+/iu, '').trim();
          if (!principal) return context.json({ error: 'Unauthorized' }, 401);
        },
        capabilityToken: async (_context, route) =>
          (
            await issuer.issueCapabilityToken({
              callerServiceId: 'control-plane',
              scopes: route.requiredScopes ?? [],
              targetServiceId: route.serviceId,
            })
          ).token,
        forwardHeaders: (context) => {
          const principal = context.req.header('authorization')?.replace(/^Bearer\s+/iu, '').trim();
          return principal ? { 'x-user-id': principal } : undefined;
        },
        registry,
      }),
    );

    for (const service of services) {
      expect((await service.app.request(`/events/${service.id}/created`, { method: 'POST' })).status).toBe(401);
      expect(service.calls.public).toBe(0);

      const publicViaControl = await controlPlane.request(`/events/${service.id}/created`, {
        body: `${service.id}-payload`,
        method: 'POST',
      });
      await expect(publicViaControl.json()).resolves.toEqual({
        body: `${service.id}-payload`,
        caller: 'control-plane',
        service: service.id,
        type: 'public',
        userId: null,
      });
      expect(service.calls.public).toBe(1);
    }

    const alpha = services[0]!;
    expect((await alpha.app.request('/console/alpha/summary')).status).toBe(401);
    expect(alpha.calls.auth).toBe(0);
    expect(controlPlaneAuthChecks).toBe(0);

    const unauthorizedControlAuth = await controlPlane.request('/console/alpha/summary');
    expect(unauthorizedControlAuth.status).toBe(401);
    expect(alpha.calls.auth).toBe(0);
    expect(controlPlaneAuthChecks).toBe(1);

    const authorizedControlAuth = await controlPlane.request('/console/alpha/summary', {
      headers: { authorization: 'Bearer user-123' },
    });
    await expect(authorizedControlAuth.json()).resolves.toEqual({
      caller: 'control-plane',
      service: 'alpha',
      type: 'auth',
      userId: 'user-123',
    });
    expect(alpha.calls.auth).toBe(1);
    expect(controlPlaneAuthChecks).toBe(2);

    const internalViaControl = await controlPlane.request('/internal/alpha/reindex', { method: 'POST' });
    expect(internalViaControl.status).toBe(404);
    expect(alpha.calls.internal).toBe(0);

    expect((await alpha.app.request('/internal/alpha/reindex', { method: 'POST' })).status).toBe(401);
    expect(alpha.calls.internal).toBe(0);
  });
});

function createMicroservice(id: string, keys: { publicJwk: JsonWebKey }) {
  const calls = {
    auth: 0,
    internal: 0,
    public: 0,
  };
  const capabilities = defineCapabilities({
    scopes: [
      { id: `${id}.events.ingest`, title: `Ingest ${id} events` },
      { id: `${id}.console.read`, title: `Read ${id} console` },
      { id: `${id}.internal.reindex`, title: `Reindex ${id}` },
    ],
    serviceId: id,
  });

  const publicRoutes = new Hono().post(`/events/${id}/:event`, capability(`${id}.events.ingest`), async (context) => {
    calls.public += 1;
    return context.json({
      body: await context.req.text(),
      caller: capabilityIdentity(context)?.serviceId,
      service: id,
      type: 'public',
      userId: context.req.header('x-user-id') ?? null,
    });
  });

  const authRoutes = new Hono().get(`/console/${id}/summary`, capability(`${id}.console.read`), (context) => {
    calls.auth += 1;
    return context.json({
      caller: capabilityIdentity(context)?.serviceId,
      service: id,
      type: 'auth',
      userId: context.req.header('x-user-id') ?? null,
    });
  });

  const internalRoutes = new Hono().post(`/internal/${id}/reindex`, capability(`${id}.internal.reindex`), (context) => {
    calls.internal += 1;
    return context.json({
      service: id,
      type: 'internal',
    });
  });

  const service = defineService({
    capabilities,
    id,
    namespaces: [
      defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
      defineNamespace({ app: authRoutes, prefix: '/', visibility: 'auth' }),
      defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
    ],
    title: id.toUpperCase(),
    version: '0.1.0',
  });

  const app = new Hono();
  mountDiscovery(app, service);
  app.use(
    '*',
    capabilityAuth({
      expectedAudience: id,
      issuer: 'control-plane',
      jwks: { keys: [keys.publicJwk] },
      now: VERIFIED_AT,
    }),
  );
  app.route('/', publicRoutes);
  app.route('/', authRoutes);
  app.route('/', internalRoutes);

  return { app, calls, capabilities, id };
}

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
