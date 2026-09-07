import { describe, expect, it, vi } from 'vitest';
import type { CapabilityTokenCache, CapabilityTokenCacheEntry } from '../shared/types.js';
import {
  type CapabilityTokenRequester,
  controlPlaneHmacTokenRequester,
  controlPlaneRpcTokenRequester,
  createCapabilityTokenProvider,
  jwksFromUrl,
} from './capabilities.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');

describe('custom capability token requesters', () => {
  it.each([
    { expiresAt: new Date(NOW.getTime() + 60_000), token: '   ' },
    { expiresAt: 'not-a-date', token: 'opaque-token' },
  ])('rejects malformed requester results', async (issued) => {
    const provider = createProvider(async () => issued);

    await expect(provider.token()).rejects.toThrow('Invalid Service-Plane capability token response');
  });

  it('rejects a token whose declared expiration is not in the future', async () => {
    const provider = createProvider(async () => ({ expiresAt: NOW, token: 'opaque-token' }));

    await expect(provider.token()).rejects.toThrow('Service-Plane capability token response is already expired');
  });

  it('bounds the cached lifetime by the expiration signed into a JWT', async () => {
    const jwtExpiresAt = new Date(NOW.getTime() + 30_000);
    const set = vi.fn<CapabilityTokenCache['set']>(async () => undefined);
    const cache: CapabilityTokenCache = { get: async () => undefined, set };
    const provider = createProvider(
      async () => ({ expiresAt: new Date(NOW.getTime() + 5 * 60_000), token: capabilityToken(jwtExpiresAt) }),
      cache,
    );

    await provider.token();

    expect(set).toHaveBeenCalledOnce();
    expect(set.mock.calls[0]?.[1].expiresAt).toEqual(jwtExpiresAt);
    expect(set.mock.calls[0]?.[2]).toBe(30);
  });

  it('rejects a JWT that is already expired even when the requester advertises a later expiration', async () => {
    const provider = createProvider(async () => ({
      expiresAt: new Date(NOW.getTime() + 60_000),
      token: capabilityToken(new Date(NOW.getTime() - 1_000)),
    }));

    await expect(provider.token()).rejects.toThrow('Service-Plane capability token response is already expired');
  });

  it('partitions shared and in-memory tokens by sender-constraining key', async () => {
    const entries = new Map<string, CapabilityTokenCacheEntry>();
    const cache: CapabilityTokenCache = {
      get: async (key) => entries.get(key),
      set: async (key, value) => {
        entries.set(key, value);
      },
    };
    let requests = 0;
    const requesterFor = (binding: () => string): CapabilityTokenRequester => {
      const requester: CapabilityTokenRequester = async () => {
        requests += 1;
        return { expiresAt: new Date(NOW.getTime() + 60_000), token: `token-${binding()}` };
      };
      requester.cacheBinding = binding;
      requester.proveTokenPossession = async () => 'proof';
      return requester;
    };
    let firstBinding = 'thumbprint-a';
    const firstRequester = requesterFor(() => firstBinding);
    const providerFor = (requestToken: CapabilityTokenRequester) =>
      createCapabilityTokenProvider({
        cache,
        cacheKey: 'shared-caller',
        callerServiceId: 'caller',
        now: () => NOW,
        requestToken,
        scopes: ['catalog:read'],
        targetServiceId: 'catalog',
      });
    const first = providerFor(firstRequester);
    const second = providerFor(requesterFor(() => 'thumbprint-b'));

    await expect(first.token()).resolves.toBe('token-thumbprint-a');
    await expect(second.token()).resolves.toBe('token-thumbprint-b');
    await expect(providerFor(firstRequester).token()).resolves.toBe('token-thumbprint-a');
    expect(requests).toBe(2);

    firstBinding = 'thumbprint-c';
    await expect(first.token()).resolves.toBe('token-thumbprint-c');
    expect(requests).toBe(3);
    expect(entries).toHaveLength(3);
  });

  it('never forwards caller identity through a native token binding', async () => {
    const issueCapabilityToken = vi.fn(async () => ({
      expiresAt: new Date(NOW.getTime() + 60_000),
      token: capabilityToken(new Date(NOW.getTime() + 60_000), 'caller-controlled-value'),
    }));
    const requestToken = controlPlaneRpcTokenRequester({ binding: { issueCapabilityToken } });

    await expect(
      requestToken({
        callerServiceId: 'caller-controlled-value',
        scopes: ['catalog:read'],
        targetServiceId: 'catalog',
        ttlSeconds: 30,
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });
    expect(issueCapabilityToken).toHaveBeenCalledWith({
      scopes: ['catalog:read'],
      targetServiceId: 'catalog',
      ttlSeconds: 30,
    });
  });

  it('rejects a native token binding pinned to a different service', async () => {
    const requestToken = controlPlaneRpcTokenRequester({
      binding: {
        issueCapabilityToken: async () => ({
          expiresAt: new Date(NOW.getTime() + 60_000),
          token: capabilityToken(new Date(NOW.getTime() + 60_000), 'other-service'),
        }),
      },
    });

    await expect(
      requestToken({ callerServiceId: 'workflow-service', scopes: ['catalog:read'], targetServiceId: 'catalog' }),
    ).rejects.toThrow('RPC token binding returned a token not bound to its pinned service caller');
  });

  it('bounds remote token and JWKS responses', async () => {
    const oversizedFetch = async () => new Response('{"keys":[]}', { headers: { 'content-length': '11' } });
    const requestToken = controlPlaneHmacTokenRequester({
      clientId: 'workflow',
      clientSecret: 'secret',
      controlPlaneUrl: 'https://plane.example',
      fetch: oversizedFetch,
      maxResponseBytes: 10,
    });
    await expect(requestToken({ callerServiceId: 'workflow', scopes: ['catalog:read'], targetServiceId: 'catalog' })).rejects.toThrow(
      'Service-Plane capability token response is too large',
    );

    const resolveJwks = jwksFromUrl('https://plane.example/.well-known/jwks.json', {
      fetch: oversizedFetch,
      maxResponseBytes: 10,
    }) as () => Promise<unknown>;
    await expect(resolveJwks()).rejects.toThrow('Service-Plane JWKS response is too large');
  });
});

function createProvider(requestToken: () => Promise<{ expiresAt: Date | string; token: string }>, cache?: CapabilityTokenCache) {
  return createCapabilityTokenProvider({
    ...(cache ? { cache } : {}),
    callerServiceId: 'caller',
    now: () => NOW,
    requestToken,
    scopes: ['catalog:read'],
    targetServiceId: 'catalog',
  });
}

function capabilityToken(expiresAt: Date, subject = 'caller'): string {
  return [
    encodeJwtPart({ alg: 'EdDSA', kid: 'test-key' }),
    encodeJwtPart({
      aud: 'catalog',
      exp: Math.floor(expiresAt.getTime() / 1000),
      iat: Math.floor(NOW.getTime() / 1000),
      iss: 'https://control.example',
      jti: 'test-token',
      nbf: Math.floor(NOW.getTime() / 1000),
      scp: ['catalog:read'],
      spa: 'service',
      sub: subject,
    }),
    'signature',
  ].join('.');
}

function encodeJwtPart(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
