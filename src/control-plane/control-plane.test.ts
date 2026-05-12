import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  capability,
  capabilityAuth,
  capabilityFetch,
  capabilityIdentity,
  controlPlaneHmacTokenRequester,
  controlPlaneRpcTokenRequester,
  defineCapabilities,
} from '../service/capabilities.js';
import { defineNamespace, defineService, mountDiscovery } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { signServicePlaneHmacRequest } from '../shared/hmac-auth.js';
import { hashServiceClientSecret, hmacServiceClientAuth, serviceClientCredentialsAuth } from './caller-auth.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret, privateJwkFromCapabilitySigningSecret } from './signing-secret.js';

describe('ServicePlaneControlPlane', () => {
  it('fails closed and logs when caller authentication is not configured', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const service = new Hono();
    mountDiscovery(
      service,
      defineService({
        capabilities: defineCapabilities({
          scopes: [{ id: 'example.events.ingest' }],
          serviceId: 'example',
        }),
        id: 'example',
        namespaces: [
          defineNamespace({ app: new Hono().post('/events', capability('example.events.ingest')), prefix: '/', visibility: 'internal' }),
        ],
        title: 'Example',
        version: '0.1.0',
      }),
    );
    const controlPlane = new ServicePlaneControlPlane({
      services: () => [cloudflareServiceBinding({ binding: { fetch: (request) => service.fetch(request) }, id: 'example' })],
      signingSecret: () => signingSecret,
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message) => {
      errors.push(String(message));
    };

    try {
      const response = await controlPlane.app.request('/.well-known/service-plane/capability-token', {
        body: JSON.stringify({ scopes: ['example.events.ingest'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json', 'x-request-id': 'caller-auth-missing-1' },
        method: 'POST',
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: 'Service-Plane caller authentication is not configured' });
      expect(errors).toEqual([
        JSON.stringify({
          event: 'service_plane.caller_auth.not_configured',
          level: 'error',
          message: 'Service-Plane caller authentication is not configured',
          path: '/.well-known/service-plane/capability-token',
          requestId: 'caller-auth-missing-1',
        }),
      ]);
    } finally {
      console.error = originalError;
    }
  });

  it('mounts token/JWKS endpoints and proxies scoped public routes with default STS tokens', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.events.ingest' }],
      serviceId: 'example',
    });
    const publicJwk = publicJwkFromPrivateJwk(privateJwkFromCapabilitySigningSecret(signingSecret), 'default');
    const routes = new Hono().post('/events/example', capability('example.events.ingest'), (context) =>
      context.json({
        caller: capabilityIdentity(context)?.serviceId,
        requestId: context.req.header('x-request-id'),
      }),
    );
    const provider = new Hono();
    mountDiscovery(
      provider,
      defineService({
        capabilities,
        id: 'example',
        namespaces: [defineNamespace({ app: routes, prefix: '/', visibility: 'public' })],
        title: 'Example',
        version: '0.1.0',
      }),
    );
    provider.use('*', capabilityAuth({ expectedAudience: 'example', issuer: 'control-plane', jwks: { keys: [publicJwk] } }));
    provider.route('/', routes);

    const callerSecret = 'moco-client-secret';
    const controlPlane = new ServicePlaneControlPlane({
      authenticateCaller: serviceClientCredentialsAuth({
        credentials: [{ secretHash: await hashServiceClientSecret(callerSecret), serviceId: 'moco' }],
      }),
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: (request) => provider.fetch(request) },
          grants: [
            { caller: 'control-plane', scopes: ['example.events.ingest'] },
            { caller: 'moco', scopes: ['example.events.ingest'] },
          ],
          id: 'example',
        }),
      ],
      signingSecret: () => signingSecret,
    });

    expect((await controlPlane.app.request('/.well-known/service-plane/jwks.json')).status).toBe(200);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message) => {
      warnings.push(String(message));
    };
    try {
      const unauthorizedToken = await controlPlane.app.request('/.well-known/service-plane/capability-token', {
        body: JSON.stringify({ scopes: ['example.events.ingest'], targetServiceId: 'example' }),
        headers: { 'content-type': 'application/json', 'x-request-id': 'missing-service-credentials-1' },
        method: 'POST',
      });
      await expect(unauthorizedToken.json()).resolves.toEqual({ error: 'Unauthorized' });
      expect(unauthorizedToken.status).toBe(401);
      expect(warnings).toEqual([
        JSON.stringify({
          event: 'service_plane.caller_auth.unauthorized',
          level: 'warn',
          message: 'Missing Bearer service client credentials',
          path: '/.well-known/service-plane/capability-token',
          reason: 'missing_credentials',
          requestId: 'missing-service-credentials-1',
        }),
      ]);
    } finally {
      console.warn = originalWarn;
    }

    expect(
      (
        await controlPlane.app.request('/.well-known/service-plane/capability-token', {
          body: JSON.stringify({ scopes: ['example.events.ingest'], targetServiceId: 'example' }),
          headers: { authorization: `Bearer ${callerSecret}`, 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
    ).toBe(200);

    const generatedRequestIdResponse = await controlPlane.app.request('/events/example', { method: 'POST' });
    const generatedRequestIdBody = (await generatedRequestIdResponse.json()) as { caller: string; requestId: string };
    expect(generatedRequestIdBody.caller).toBe('control-plane');
    expect(generatedRequestIdBody.requestId).toBe(generatedRequestIdResponse.headers.get('x-request-id'));
    expect(generatedRequestIdBody.requestId).toMatch(/^[\w\-=]+$/u);

    await expect(
      (
        await controlPlane.app.request('/events/example', {
          headers: { 'x-request-id': 'edge-to-worker-1' },
          method: 'POST',
        })
      ).json(),
    ).resolves.toEqual({
      caller: 'control-plane',
      requestId: 'edge-to-worker-1',
    });
  });

  it('authenticates token requests with HMAC signed service credentials', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const service = new Hono();
    mountDiscovery(
      service,
      defineService({
        capabilities,
        id: 'example',
        namespaces: [
          defineNamespace({ app: new Hono().post('/sync', capability('example.sync.run')), prefix: '/', visibility: 'internal' }),
        ],
        title: 'Example',
        version: '0.1.0',
      }),
    );

    const clientSecret = 'moco-hmac-secret';
    const controlPlane = new ServicePlaneControlPlane({
      authenticateCaller: hmacServiceClientAuth({
        clients: [{ clientId: 'moco-client', secret: clientSecret, serviceId: 'moco' }],
        now: () => new Date('2026-05-12T10:15:00.000Z'),
        replayCache: memoryReplayCache(),
      }),
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          grants: [{ caller: 'moco', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingSecret: () => signingSecret,
    });
    const requestToken = controlPlaneHmacTokenRequester({
      clientId: 'moco-client',
      clientSecret,
      controlPlaneUrl: 'https://control-plane.internal',
      fetch: (request) => controlPlane.app.request(request),
      now: () => new Date('2026-05-12T10:15:00.000Z'),
      requestId: 'hmac-token-1',
    });

    await expect(
      requestToken({
        callerServiceId: 'moco',
        scopes: ['example.sync.run'],
        targetServiceId: 'example',
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
    await expect(
      requestToken({
        callerServiceId: 'moco',
        scopes: ['example.sync.run'],
        targetServiceId: 'example',
      }),
    ).rejects.toThrow('Unable to fetch Service-Plane capability token: 401');

    const staleRequestToken = controlPlaneHmacTokenRequester({
      clientId: 'moco-client',
      clientSecret,
      controlPlaneUrl: 'https://control-plane.internal',
      fetch: (request) => controlPlane.app.request(request),
      now: () => new Date('2026-05-12T10:12:00.000Z'),
      requestId: 'hmac-token-stale-1',
    });
    await expect(
      staleRequestToken({
        callerServiceId: 'moco',
        scopes: ['example.sync.run'],
        targetServiceId: 'example',
      }),
    ).rejects.toThrow('Unable to fetch Service-Plane capability token: 401');
  });

  it('rejects replayed HMAC token requests even when request ids are generated by middleware', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const service = new Hono();
    mountDiscovery(
      service,
      defineService({
        capabilities,
        id: 'example',
        namespaces: [
          defineNamespace({ app: new Hono().post('/sync', capability('example.sync.run')), prefix: '/', visibility: 'internal' }),
        ],
        title: 'Example',
        version: '0.1.0',
      }),
    );

    const clientSecret = 'moco-hmac-secret';
    const controlPlane = new ServicePlaneControlPlane({
      authenticateCaller: hmacServiceClientAuth({
        clients: [{ clientId: 'moco-client', secret: clientSecret, serviceId: 'moco' }],
        now: () => new Date('2026-05-12T10:15:00.000Z'),
        replayCache: memoryReplayCache(),
      }),
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          grants: [{ caller: 'moco', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingSecret: () => signingSecret,
    });
    const signedRequest = await signServicePlaneHmacRequest(
      new Request('https://control-plane.internal/.well-known/service-plane/capability-token', {
        body: JSON.stringify({
          callerServiceId: 'moco',
          scopes: ['example.sync.run'],
          targetServiceId: 'example',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      {
        clientId: 'moco-client',
        now: new Date('2026-05-12T10:15:00.000Z'),
        secret: clientSecret,
      },
    );

    expect((await controlPlane.app.request(signedRequest.clone())).status).toBe(200);
    expect((await controlPlane.app.request(signedRequest.clone())).status).toBe(401);
  });

  it('issues RPC tokens for deployment-bound Cloudflare callers without service-client secrets', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const service = new Hono();
    mountDiscovery(
      service,
      defineService({
        capabilities,
        id: 'example',
        namespaces: [
          defineNamespace({ app: new Hono().post('/sync', capability('example.sync.run')), prefix: '/', visibility: 'internal' }),
        ],
        title: 'Example',
        version: '0.1.0',
      }),
    );
    const controlPlane = new ServicePlaneControlPlane<{ Bindings: { STS_SIGNING_SECRET: string } }>({
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          grants: [{ caller: 'moco', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingSecret: (env) => env.STS_SIGNING_SECRET,
    });

    await expect(
      controlPlane.issueCapabilityTokenForCaller(
        'moco',
        {
          scopes: ['example.sync.run'],
          targetServiceId: 'example',
        },
        { STS_SIGNING_SECRET: signingSecret },
      ),
    ).resolves.toMatchObject({ token: expect.any(String), tokenType: 'ServicePlane' });

    await expect(
      controlPlane.issueCapabilityTokenForCaller(
        'moco',
        {
          callerServiceId: 'other',
          scopes: ['example.sync.run'],
          targetServiceId: 'example',
        },
        { STS_SIGNING_SECRET: signingSecret },
      ),
    ).rejects.toThrow('Caller service mismatch');
  });

  it('runs the Cloudflare same-account fast path with inline discovery and RPC token issuance', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const publicJwk = publicJwkFromPrivateJwk(privateJwkFromCapabilitySigningSecret(signingSecret), 'default');
    const routes = new Hono().post('/sync', capability('example.sync.run'), (context) =>
      context.json({
        caller: capabilityIdentity(context)?.serviceId,
        ok: true,
      }),
    );
    const service = new ServicePlaneService({
      auth: { jwks: { keys: [publicJwk] } },
      capabilities,
      id: 'example',
      namespaces: [{ app: routes, visibility: 'internal' }],
      title: 'Example',
      version: '0.1.0',
    });
    let serviceBindingFetches = 0;
    const binding = {
      fetch: (request: Request) => {
        serviceBindingFetches += 1;
        return service.fetch(request);
      },
    };
    const controlPlane = new ServicePlaneControlPlane<{ Bindings: { STS_SIGNING_SECRET: string } }>({
      proxy: false,
      services: () => [
        cloudflareServiceBinding({
          binding,
          discovery: service.discovery,
          grants: [{ caller: 'moco', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingSecret: (env) => env.STS_SIGNING_SECRET,
    });
    const tokenBinding = {
      issueCapabilityToken: (input: Parameters<ReturnType<typeof controlPlaneRpcTokenRequester>>[0]) =>
        controlPlane.issueCapabilityTokenForCaller('moco', input, { STS_SIGNING_SECRET: signingSecret }),
    };
    const fetchWithCapability = capabilityFetch({
      callerServiceId: 'moco',
      fetch: (request) => binding.fetch(request),
      requestToken: controlPlaneRpcTokenRequester(tokenBinding),
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
    });

    await expect((await fetchWithCapability('https://example.internal/sync', { method: 'POST' })).json()).resolves.toEqual({
      caller: 'moco',
      ok: true,
    });
    expect(serviceBindingFetches).toBe(1);
  });
});

function memoryReplayCache() {
  const seen = new Set<string>();
  return {
    get: (key: string) => seen.has(key),
    set: (key: string) => {
      seen.add(key);
    },
  };
}
