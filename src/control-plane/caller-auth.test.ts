import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { SERVICE_PLANE_HMAC_AUTHORIZATION_SCHEME } from '../shared/hmac-auth.js';
import { SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME } from '../shared/jwk-auth.js';
import { hmacServiceClientAuth, jwkServiceClientAuth } from './caller-auth.js';

describe('control-plane caller authentication', () => {
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

  it('challenges unauthorized JWK callers with the configured authentication scheme', async () => {
    const authenticate = jwkServiceClientAuth({ clients: [], log: () => undefined });
    const app = new Hono();
    app.post('/', async (context) => {
      const result = await authenticate(context);
      return result instanceof Response ? result : context.text(result);
    });

    const response = await app.request('/', { method: 'POST' });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
  });
});
