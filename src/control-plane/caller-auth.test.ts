import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME, signServicePlaneHmacRequest } from '../shared/hmac-auth.js';
import { SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME, SERVICE_PLANE_JWK_CLIENT_HEADER } from '../shared/jwk-auth.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH, SERVICE_PLANE_CAPABILITY_TOKEN_PATH, type ServiceEndpoint } from '../shared/types.js';
import {
  type HmacServiceClient,
  type HmacServiceClientAuthOptions,
  hmacServiceClientAuth,
  type JwkServiceClient,
  type JwkServiceClientAuthOptions,
  jwkServiceClientAuth,
} from './caller-auth.js';
import {
  type CallerAuthenticator,
  type CapabilityIssuer,
  type CapabilityIssuerResolver,
  type CapabilityJwksProviderResolver,
  type MountCapabilityEndpointsOptions,
  mountCapabilityEndpoints,
} from './capabilities.js';
import type { ServicePlaneControlPlaneOptions } from './control-plane.js';

const NOW = new Date('2099-08-15T10:00:00.000Z');

type CallerAuthEnv = {
  Bindings: {
    HMAC_CLIENTS: HmacServiceClient[];
    ISSUER: CapabilityIssuer;
    JWK_ASSERTION_AUDIENCE: string;
    JWK_CLIENTS: JwkServiceClient[];
    SERVICES: ServiceEndpoint[];
  };
};

describe('control-plane caller authentication', () => {
  it('threads a configured Hono Env through auth options and endpoint resolvers', () => {
    const hmacOptions: HmacServiceClientAuthOptions<CallerAuthEnv> = {
      clients: (context) => context.env.HMAC_CLIENTS,
      log: () => undefined,
    };
    const jwkOptions: JwkServiceClientAuthOptions<CallerAuthEnv> = {
      assertionAudience: (context) => context.env.JWK_ASSERTION_AUDIENCE,
      clients: (context) => context.env.JWK_CLIENTS,
      log: () => undefined,
      services: (context) => context.env.SERVICES,
    };
    const hmacAuthenticator: CallerAuthenticator<CallerAuthEnv> = hmacServiceClientAuth<CallerAuthEnv>(hmacOptions);
    const jwkAuthenticator: CallerAuthenticator<CallerAuthEnv> = jwkServiceClientAuth<CallerAuthEnv>(jwkOptions);
    const issuer: CapabilityIssuerResolver<CallerAuthEnv> = (context) => context.env.ISSUER;
    const jwks: CapabilityJwksProviderResolver<CallerAuthEnv> = (context) => context.env.ISSUER;
    const endpoints: MountCapabilityEndpointsOptions<CallerAuthEnv> = {
      authenticateCaller: hmacAuthenticator,
      jwks,
    };
    const planeOptions: Pick<ServicePlaneControlPlaneOptions<CallerAuthEnv>, 'authenticateCaller'> = {
      authenticateCaller: hmacAuthenticator,
    };
    const defaultHmacOptions: HmacServiceClientAuthOptions = { clients: [] };
    const defaultJwkOptions: JwkServiceClientAuthOptions = { clients: [] };

    expect(hmacAuthenticator).toBeTypeOf('function');
    expect(jwkAuthenticator).toBeTypeOf('function');
    expect(issuer).toBeTypeOf('function');
    expect(endpoints.authenticateCaller).toBe(hmacAuthenticator);
    expect(planeOptions.authenticateCaller).toBe(hmacAuthenticator);
    expect(hmacServiceClientAuth(defaultHmacOptions)).toBeTypeOf('function');
    expect(jwkServiceClientAuth(defaultJwkOptions)).toBeTypeOf('function');
  });

  it('resolves HMAC clients, issuer, and JWKS from one typed Hono Env configuration', async () => {
    const issuer = testIssuer();
    const bindings: CallerAuthEnv['Bindings'] = {
      HMAC_CLIENTS: [{ clientId: 'workflow', secret: 'test-secret', serviceId: 'workflow-service' }],
      ISSUER: issuer,
      JWK_ASSERTION_AUDIENCE: 'https://plane.example/token',
      JWK_CLIENTS: [],
      SERVICES: [],
    };
    let clientResolutions = 0;
    let issuerResolutions = 0;
    let jwksResolutions = 0;
    const authenticateCaller = hmacServiceClientAuth<CallerAuthEnv>({
      clients: (context) => {
        clientResolutions += 1;
        return context.env.HMAC_CLIENTS;
      },
      log: () => undefined,
      now: () => NOW,
    });
    const app = new Hono<CallerAuthEnv>();
    mountCapabilityEndpoints(
      app,
      (context) => {
        issuerResolutions += 1;
        return context.env.ISSUER;
      },
      {
        authenticateCaller,
        jwks: (context) => {
          jwksResolutions += 1;
          return context.env.ISSUER;
        },
      },
    );
    const request = await signServicePlaneHmacRequest(
      new Request(`https://plane.example${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['tasks.read'], targetServiceId: 'tasks' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      { clientId: 'workflow', now: NOW, secret: 'test-secret' },
    );

    const tokenResponse = await app.request(request, undefined, bindings);
    const jwksResponse = await app.request(`https://plane.example${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`, undefined, bindings);

    expect(tokenResponse.status).toBe(200);
    await expect(tokenResponse.json()).resolves.toMatchObject({ token: 'token-for-workflow-service' });
    expect(jwksResponse.status).toBe(200);
    await expect(jwksResponse.json()).resolves.toEqual({ keys: [] });
    expect({ clientResolutions, issuerResolutions, jwksResolutions }).toEqual({
      clientResolutions: 1,
      issuerResolutions: 1,
      jwksResolutions: 1,
    });
  });

  it('passes typed Hono bindings to JWK client and service resolvers', async () => {
    const issuer = testIssuer();
    const bindings: CallerAuthEnv['Bindings'] = {
      HMAC_CLIENTS: [],
      ISSUER: issuer,
      JWK_ASSERTION_AUDIENCE: 'https://plane.example/token',
      JWK_CLIENTS: [],
      SERVICES: [],
    };
    let observedClients: JwkServiceClient[] | undefined;
    let observedServices: ServiceEndpoint[] | undefined;
    const authenticate = jwkServiceClientAuth<CallerAuthEnv>({
      assertionAudience: (context) => context.env.JWK_ASSERTION_AUDIENCE,
      clients: (context) => {
        observedClients = context.env.JWK_CLIENTS;
        return observedClients;
      },
      log: () => undefined,
      services: (context) => {
        observedServices = context.env.SERVICES;
        return observedServices;
      },
    });
    const app = new Hono<CallerAuthEnv>();
    app.post('/', async (context) => {
      const result = await authenticate(context);
      return result instanceof Response ? result : context.text(result.serviceId);
    });

    const response = await app.request(
      '/',
      {
        headers: {
          authorization: `${SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME} invalid-assertion`,
          [SERVICE_PLANE_JWK_CLIENT_HEADER]: 'missing-client',
        },
        method: 'POST',
      },
      bindings,
    );

    expect(response.status).toBe(401);
    expect(observedClients).toBe(bindings.JWK_CLIENTS);
    expect(observedServices).toBe(bindings.SERVICES);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid HMAC clock skew at setup (%s)', (maxSkewSeconds) => {
    expect(() => hmacServiceClientAuth({ clients: [], maxSkewSeconds })).toThrow(
      'Service-Plane HMAC max clock skew must be a positive safe integer',
    );
  });

  it('rejects invalid JWK clock skew at setup', () => {
    expect(() => jwkServiceClientAuth({ clients: [], maxSkewSeconds: Number.NaN })).toThrow(
      'Service-Plane JWK max clock skew must be a positive safe integer',
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid JWK assertion lifetime at setup (%s)', (maxAssertionTtlSeconds) => {
    expect(() => jwkServiceClientAuth({ clients: [], maxAssertionTtlSeconds })).toThrow(
      'Service-Plane JWK max assertion TTL must be a positive safe integer',
    );
  });

  it('challenges unauthorized HMAC callers with the configured authentication scheme', async () => {
    const authenticate = hmacServiceClientAuth({ clients: [], log: () => undefined });
    const app = new Hono();
    app.post('/', async (context) => {
      const result = await authenticate(context);
      return result instanceof Response ? result : context.text(result);
    });

    const response = await app.request('/', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
  });

  it('does not let a failing HMAC auth log sink replace the unauthorized response', async () => {
    const authenticate = hmacServiceClientAuth({
      clients: [],
      log: () => {
        throw new Error('sink failed');
      },
    });
    const app = new Hono();
    app.post('/', async (context) => {
      const result = await authenticate(context);
      return result instanceof Response ? result : context.text(result);
    });

    const response = await app.request('/', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME);
  });

  it('challenges unauthorized JWK callers with the configured authentication scheme', async () => {
    const authenticate = jwkServiceClientAuth({ clients: [], log: () => undefined });
    const app = new Hono();
    app.post('/', async (context) => {
      const result = await authenticate(context);
      return result instanceof Response ? result : context.text(result.serviceId);
    });

    const response = await app.request('/', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
  });
});

function testIssuer(): CapabilityIssuer {
  return {
    issueBrokeredCapabilityToken: async () => ({ expiresAt: new Date(NOW.getTime() + 60_000), token: 'broker-token' }),
    issueCapabilityToken: async (input) => ({
      expiresAt: new Date(NOW.getTime() + 60_000),
      token: `token-for-${input.callerServiceId}`,
    }),
    jwks: async () => ({ keys: [] }),
  };
}
