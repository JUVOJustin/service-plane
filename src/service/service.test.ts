import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { capability, capabilityIdentity, defineCapabilities } from './capabilities.js';
import type { ServicePlaneLogEvent } from './logger.js';
import { ServicePlaneService } from './service.js';

describe('ServicePlaneService', () => {
  it('mounts discovery, default auth, routes, and structured service logs', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.users.lookup', title: 'Lookup users' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['example.users.lookup'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateJwk: keys.privateJwk,
    });
    const logs: ServicePlaneLogEvent[] = [];
    const routes = new Hono().get('/users/:id', capability('example.users.lookup'), (context) =>
      context.json({
        caller: capabilityIdentity(context)?.serviceId,
        id: context.req.param('id'),
      }),
    );
    const service = new ServicePlaneService({
      auth: {
        jwks: await issuer.jwks(),
        now: new Date('2026-05-09T12:00:01.000Z'),
      },
      capabilities,
      id: 'example',
      logging: { log: (event) => logs.push(event) },
      namespaces: [{ app: routes, visibility: 'internal' }],
      title: 'Example',
      version: '0.1.0',
    });

    const discovery = await service.app.request('/.well-known/service-plane/service.json');
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      id: 'example',
      routes: [{ method: 'GET', path: '/users/:id', requiredScopes: ['example.users.lookup'], visibility: 'internal' }],
    });

    expect((await service.app.request('/users/a')).status).toBe(401);

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });
    const response = await service.app.request('/users/a', {
      headers: {
        authorization: `ServicePlane ${issued.token}`,
        'x-request-id': 'service-hop-1',
      },
    });

    await expect(response.json()).resolves.toEqual({ caller: 'moco', id: 'a' });
    expect(logs).toEqual([
      expect.objectContaining({
        event: 'service_plane.discovery.served',
        method: 'GET',
        path: '/.well-known/service-plane/service.json',
        serviceId: 'example',
        status: 200,
      }),
      expect.objectContaining({
        event: 'service_plane.request.completed',
        method: 'GET',
        path: '/users/a',
        route: { requiredScopes: ['example.users.lookup'], visibility: 'internal' },
        serviceId: 'example',
        status: 401,
      }),
      expect.objectContaining({
        callerServiceId: 'moco',
        event: 'service_plane.request.completed',
        method: 'GET',
        path: '/users/a',
        requestId: 'service-hop-1',
        route: { requiredScopes: ['example.users.lookup'], visibility: 'internal' },
        serviceId: 'example',
        status: 200,
      }),
    ]);

    const withoutRequestId = await service.app.request('/users/a', {
      headers: {
        authorization: `ServicePlane ${issued.token}`,
      },
    });
    expect(withoutRequestId.headers.get('x-request-id')).toBeNull();
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
