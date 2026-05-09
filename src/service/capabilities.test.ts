import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { hc } from 'hono/client';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { defineNamespace, defineService, serviceDiscoveryDocument } from './discovery.js';
import {
  capability,
  capabilityAuth,
  capabilityFetch,
  capabilityIdentity,
  capabilityTokenCacheKey,
  createCapabilityTokenProvider,
  defineCapabilities,
  jwksFromServiceBinding,
  jwksFromUrl,
  serviceCapabilities,
} from './capabilities.js';
import { memoryCapabilityTokenCache } from '../testing/index.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH } from '../shared/types.js';

describe('service capabilities', () => {
  it('protects annotated Hono routes and exposes capability identity', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const jwks = await issuer.jwks();

    const routes = new Hono().get('/providers/fizzy/v1/users/:email', capability('fizzy.users.lookup'), (context) =>
      context.json({
        caller: capabilityIdentity(context)?.serviceId,
        email: context.req.param('email'),
      }),
    );
    const app = new Hono();
    app.use('*', capabilityAuth({ expectedAudience: 'fizzy', issuer: 'control-plane', jwks, now: new Date('2026-05-09T12:00:01.000Z') }));
    app.route('/', routes);

    expect((await app.request('/providers/fizzy/v1/users/test@example.com')).status).toBe(401);

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    const response = await app.request('/providers/fizzy/v1/users/test@example.com', {
      headers: { authorization: `ServicePlane ${issued.token}` },
    });

    await expect(response.json()).resolves.toEqual({
      caller: 'moco',
      email: 'test@example.com',
    });
  });

  it('adds route scopes to discovery documents', () => {
    const routes = new Hono().get('/providers/fizzy/v1/users/:email', capability('fizzy.users.lookup'), (context) => context.json({ ok: true }));
    const service = defineService({
      capabilities: fizzyCapabilities,
      id: 'fizzy',
      namespaces: [defineNamespace({ app: routes, prefix: '/', visibility: 'internal' })],
      title: 'Fizzy',
      version: '0.1.0',
    });

    expect(serviceCapabilities(routes, fizzyCapabilities).routes).toEqual([
      {
        method: 'GET',
        path: '/providers/fizzy/v1/users/:email',
        requiredScopes: ['fizzy.users.lookup'],
      },
    ]);
    expect(serviceDiscoveryDocument(service)).toMatchObject({
      capabilities: fizzyCapabilities,
      routes: [
        {
          method: 'GET',
          path: '/providers/fizzy/v1/users/:email',
          requiredScopes: ['fizzy.users.lookup'],
          visibility: 'internal',
        },
      ],
    });
  });

  it('caches capability tokens and attaches them to Hono RPC fetches', async () => {
    const routes = new Hono().get('/users/:id', (context) => context.json({ id: context.req.param('id') }));
    type Routes = typeof routes;
    let issuedTokens = 0;
    const provider = createCapabilityTokenProvider({
      callerServiceId: 'moco',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      requestToken: async () => {
        issuedTokens += 1;
        return {
          expiresAt: new Date('2026-05-09T12:05:00.000Z'),
          token: `token-${issuedTokens}`,
        };
      },
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    const requests: string[] = [];
    const fetcher = capabilityFetch({
      fetch: async (request) => {
        requests.push(request.headers.get('authorization') ?? '');
        return new Response('ok');
      },
      tokenProvider: provider,
    });
    const client = hc<Routes>('https://fizzy.internal', { fetch: fetcher });

    expect((await client.users[':id'].$get({ param: { id: 'a' } })).status).toBe(200);
    expect((await client.users[':id'].$get({ param: { id: 'b' } })).status).toBe(200);

    expect(issuedTokens).toBe(1);
    expect(requests).toEqual(['ServicePlane token-1', 'ServicePlane token-1']);
  });

  it('can create authenticated fetch clients without manually creating a provider', async () => {
    let issuedTokens = 0;
    const fetcher = capabilityFetch({
      callerServiceId: 'moco',
      fetch: async (request) => {
        expect(request.headers.get('authorization')).toBe('ServicePlane token-1');
        return new Response('ok');
      },
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      requestToken: async () => {
        issuedTokens += 1;
        return {
          expiresAt: new Date('2026-05-09T12:02:00.000Z'),
          token: `token-${issuedTokens}`,
        };
      },
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

    expect((await fetcher('https://fizzy.internal/providers/fizzy/v1/users/a')).status).toBe(200);
    expect(issuedTokens).toBe(1);
  });

  it('verifies routes with JWKS fetched from the control-plane service binding', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const controlPlane = new Hono().get(SERVICE_PLANE_CAPABILITY_JWKS_PATH, async (context) => context.json(await issuer.jwks()));
    let jwksRequests = 0;
    const binding = {
      fetch: async (request: Request) => {
        jwksRequests += 1;
        return controlPlane.fetch(request);
      },
    };

    const app = new Hono();
    app.use('*', (context, next) =>
      capabilityAuth({
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: jwksFromServiceBinding(binding),
        now: new Date('2026-05-09T12:00:01.000Z'),
      })(context, next),
    );
    app.get('/providers/fizzy/v1/users/:email', capability('fizzy.users.lookup'), (context) => context.json({ email: context.req.param('email') }));

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

    const first = await app.request('/providers/fizzy/v1/users/test@example.com', {
      headers: { authorization: `ServicePlane ${issued.token}` },
    });
    const second = await app.request('/providers/fizzy/v1/users/test@example.com', {
      headers: { authorization: `ServicePlane ${issued.token}` },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(jwksRequests).toBe(1);
  });

  it('fetches and caches remote JWKS from URLs', async () => {
    const keys = await testKeys();
    let jwksRequests = 0;
    const resolver = jwksFromUrl('https://control-plane.example.com/.well-known/service-plane/jwks.json', {
      fetch: async () => {
        jwksRequests += 1;
        return Response.json({ keys: [keys.publicJwk] });
      },
    });

    await expect(resolver()).resolves.toEqual({ keys: [keys.publicJwk] });
    await expect(resolver()).resolves.toEqual({ keys: [keys.publicJwk] });
    expect(jwksRequests).toBe(1);
  });

  it('rejects invalid caller token provider configuration early', () => {
    expect(() =>
      createCapabilityTokenProvider({
        callerServiceId: 'moco',
        requestToken: async () => ({ expiresAt: new Date(), token: 'token' }),
        scopes: [],
        targetServiceId: 'fizzy',
      }),
    ).toThrow('Service-Plane capability requires at least one scope');

    expect(() =>
      createCapabilityTokenProvider({
        callerServiceId: 'moco',
        requestToken: async () => ({ expiresAt: new Date(), token: 'token' }),
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 0,
      }),
    ).toThrow('Service-Plane capability token TTL must be a positive integer');
  });

  it('can reuse capability tokens through a shared cache adapter', async () => {
    let issuedTokens = 0;
    let now = new Date('2026-05-09T12:00:00.000Z');
    const cache = memoryCapabilityTokenCache(() => now.getTime());
    const requestToken = async () => {
      issuedTokens += 1;
      return {
        expiresAt: new Date('2026-05-09T12:05:00.000Z'),
        token: `token-${issuedTokens}`,
      };
    };
    const first = createCapabilityTokenProvider({
      cache,
      callerServiceId: 'moco',
      now: () => now,
      requestToken,
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    const second = createCapabilityTokenProvider({
      cache,
      callerServiceId: 'moco',
      now: () => now,
      requestToken,
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

    await expect(first.token()).resolves.toBe('token-1');
    await expect(second.token()).resolves.toBe('token-1');
    expect(issuedTokens).toBe(1);

    now = new Date('2026-05-09T12:04:55.000Z');
    await expect(second.token()).resolves.toBe('token-2');
    expect(issuedTokens).toBe(2);
  });

  it('builds stable capability token cache keys independent of scope order', () => {
    expect(
      capabilityTokenCacheKey({
        callerServiceId: 'moco',
        scopes: ['fizzy.users.update', 'fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
    ).toBe(
      capabilityTokenCacheKey({
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup', 'fizzy.users.update'],
        targetServiceId: 'fizzy',
      }),
    );
  });
});

const fizzyCapabilities = defineCapabilities({
  scopes: [{ id: 'fizzy.users.lookup', title: 'Lookup Fizzy users' }],
  serviceId: 'fizzy',
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
