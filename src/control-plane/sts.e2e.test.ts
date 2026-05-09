import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { capability, capabilityAuth, capabilityFetch, capabilityIdentity, createCapabilityTokenProvider, defineCapabilities } from '../service/capabilities.js';
import { createCapabilityIssuer, defineServiceGrants, mountCapabilityTokenEndpoint } from './capabilities.js';

describe('STS direct service topology', () => {
  it('issues short-lived tokens once and lets three services call each other directly', async () => {
    const keys = await testKeys();
    const capabilities = [
      defineCapabilities({
        scopes: [{ id: 'fizzy.users.lookup', title: 'Lookup Fizzy users' }],
        serviceId: 'fizzy',
      }),
      defineCapabilities({
        scopes: [{ id: 'charlie.reports.read', title: 'Read Charlie reports' }],
        serviceId: 'charlie',
      }),
      defineCapabilities({
        scopes: [{ id: 'moco.connections.read', title: 'Read MOCO connections' }],
        serviceId: 'moco',
      }),
    ];
    const issuer = createCapabilityIssuer({
      capabilities,
      grants: defineServiceGrants({
        grants: [
          { caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' },
          { caller: 'fizzy', scopes: ['charlie.reports.read'], target: 'charlie' },
        ],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const jwks = await issuer.jwks();
    const sts = new Hono();
    let stsCalls = 0;
    mountCapabilityTokenEndpoint(sts, issuer, {
      authenticateCaller: (context) => context.req.header('x-service-id') ?? context.json({ error: 'Unauthorized' }, 401),
    });

    const fizzy = serviceApp({
      audience: 'fizzy',
      issuer: 'control-plane',
      jwks,
      path: '/providers/fizzy/v1/users/:email',
      scope: 'fizzy.users.lookup',
    });
    const charlie = serviceApp({
      audience: 'charlie',
      issuer: 'control-plane',
      jwks,
      path: '/providers/charlie/v1/reports',
      scope: 'charlie.reports.read',
    });

    const mocoToFizzy = createCapabilityTokenProvider({
      callerServiceId: 'moco',
      now: () => new Date('2026-05-09T12:00:10.000Z'),
      requestToken: async (input) => {
        stsCalls += 1;
        const response = await sts.request('/.well-known/service-plane/capability-token', {
          body: JSON.stringify(input),
          headers: { 'content-type': 'application/json', 'x-service-id': 'moco' },
          method: 'POST',
        });
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as { expiresAt: string; token: string };
      },
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    const fizzyFetch = capabilityFetch({
      fetch: (request) => fizzy.request(request),
      tokenProvider: mocoToFizzy,
    });

    await expect((await fizzyFetch('https://fizzy.internal/providers/fizzy/v1/users/a@example.com')).json()).resolves.toEqual({
      caller: 'moco',
      ok: true,
      service: 'fizzy',
    });
    await expect((await fizzyFetch('https://fizzy.internal/providers/fizzy/v1/users/b@example.com')).json()).resolves.toEqual({
      caller: 'moco',
      ok: true,
      service: 'fizzy',
    });
    expect(stsCalls).toBe(1);

    const denied = await sts.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        callerServiceId: 'moco',
        scopes: ['charlie.reports.read'],
        targetServiceId: 'charlie',
      }),
      headers: { 'content-type': 'application/json', 'x-service-id': 'moco' },
      method: 'POST',
    });
    expect(denied.status).toBe(403);

    expect((await charlie.request('/providers/charlie/v1/reports')).status).toBe(401);
  });
});

function serviceApp(input: { audience: string; issuer: string; jwks: { keys: JsonWebKey[] }; path: string; scope: string }) {
  const app = new Hono();
  app.use('*', capabilityAuth({ expectedAudience: input.audience, issuer: input.issuer, jwks: input.jwks, now: new Date('2026-05-09T12:00:10.000Z') }));
  app.get(input.path, capability(input.scope), (context) =>
    context.json({
      caller: capabilityIdentity(context)?.serviceId,
      ok: true,
      service: input.audience,
    }),
  );
  return app;
}

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
