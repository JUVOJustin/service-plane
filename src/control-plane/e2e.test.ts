import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { defineNamespace, defineService, mountDiscovery } from '../service/discovery.js';
import { machineAuth } from '../service/auth.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { createServiceRegistry } from './registry.js';
import { createControlPlaneProxy } from './proxy.js';
import { signMachineRequest } from './auth.js';

const SECRET = 'shared-service-plane-secret';
const SIGNED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('service-plane end-to-end topology', () => {
  it('runs one control plane against three Hono services with signed worker traffic only', async () => {
    const services = ['alpha', 'bravo', 'charlie'].map(createMicroservice);
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
        forwardHeaders: (context) => {
          const principal = context.req.header('authorization')?.replace(/^Bearer\s+/iu, '').trim();
          return principal ? { 'x-user-id': principal } : undefined;
        },
        registry,
        signer: (request) =>
          signMachineRequest(request, {
            now: SIGNED_AT,
            secret: SECRET,
          }),
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
        service: service.id,
        type: 'public',
        userId: null,
      });
      expect(service.calls.public).toBe(1);

      const signedDirectPublic = await signMachineRequest(
        new Request(`https://${service.id}.internal/events/${service.id}/created`, {
          body: 'direct-signed-public',
          method: 'POST',
        }),
        { now: SIGNED_AT, secret: SECRET },
      );
      expect((await service.app.fetch(signedDirectPublic)).status).toBe(200);
      expect(service.calls.public).toBe(2);
    }

    const alpha = services[0]!;
    expect((await alpha.app.request('/console/alpha/summary')).status).toBe(401);
    expect(alpha.calls.auth).toBe(0);

    const signedDirectAuth = await signMachineRequest(new Request('https://alpha.internal/console/alpha/summary'), {
      now: SIGNED_AT,
      secret: SECRET,
    });
    await expect((await alpha.app.fetch(signedDirectAuth)).json()).resolves.toEqual({
      service: 'alpha',
      type: 'auth',
      userId: null,
    });
    expect(alpha.calls.auth).toBe(1);
    expect(controlPlaneAuthChecks).toBe(0);

    const unauthorizedControlAuth = await controlPlane.request('/console/alpha/summary');
    expect(unauthorizedControlAuth.status).toBe(401);
    expect(alpha.calls.auth).toBe(1);
    expect(controlPlaneAuthChecks).toBe(1);

    const authorizedControlAuth = await controlPlane.request('/console/alpha/summary', {
      headers: { authorization: 'Bearer user-123' },
    });
    await expect(authorizedControlAuth.json()).resolves.toEqual({
      service: 'alpha',
      type: 'auth',
      userId: 'user-123',
    });
    expect(alpha.calls.auth).toBe(2);
    expect(controlPlaneAuthChecks).toBe(2);

    const internalViaControl = await controlPlane.request('/internal/alpha/reindex', { method: 'POST' });
    expect(internalViaControl.status).toBe(404);
    expect(alpha.calls.internal).toBe(0);

    expect((await alpha.app.request('/internal/alpha/reindex', { method: 'POST' })).status).toBe(401);
    expect(alpha.calls.internal).toBe(0);

    const signedDirectInternal = await signMachineRequest(
      new Request('https://alpha.internal/internal/alpha/reindex', { method: 'POST' }),
      { now: SIGNED_AT, secret: SECRET },
    );
    await expect((await alpha.app.fetch(signedDirectInternal)).json()).resolves.toEqual({
      service: 'alpha',
      type: 'internal',
    });
    expect(alpha.calls.internal).toBe(1);
  });
});

function createMicroservice(id: string) {
  const calls = {
    auth: 0,
    internal: 0,
    public: 0,
  };

  const publicRoutes = new Hono().post(`/events/${id}/:event`, async (context) => {
    calls.public += 1;
    return context.json({
      body: await context.req.text(),
      service: id,
      type: 'public',
      userId: context.req.header('x-user-id') ?? null,
    });
  });

  const authRoutes = new Hono().get(`/console/${id}/summary`, (context) => {
    calls.auth += 1;
    return context.json({
      service: id,
      type: 'auth',
      userId: context.req.header('x-user-id') ?? null,
    });
  });

  const internalRoutes = new Hono().post(`/internal/${id}/reindex`, (context) => {
    calls.internal += 1;
    return context.json({
      service: id,
      type: 'internal',
    });
  });

  const service = defineService({
    id,
    namespaces: [
      defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
      defineNamespace({ app: authRoutes, prefix: '/', visibility: 'auth' }),
      defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
    ],
    title: id.toUpperCase(),
    version: '0.0.1',
  });

  const app = new Hono();
  mountDiscovery(app, service);
  app.use(
    '*',
    machineAuth({
      now: VERIFIED_AT,
      resolveSecret: () => SECRET,
    }),
  );
  app.route('/', publicRoutes);
  app.route('/', authRoutes);
  app.route('/', internalRoutes);

  return { app, calls, id };
}
