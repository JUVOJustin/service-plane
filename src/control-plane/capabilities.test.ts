import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { publicJwkFromPrivateJwk, verifyCapabilityToken } from '../shared/capability-tokens.js';
import { defineCapabilities } from '../service/capabilities.js';
import {
  createCapabilityIssuer,
  createCapabilityIssuerFromJwks,
  defineServiceGrants,
  mountCapabilityEndpoints,
  mountCapabilityTokenEndpoint,
  type CreateCapabilityIssuerOptions,
} from './capabilities.js';

describe('capability issuer', () => {
  it('issues tokens for granted service scopes', async () => {
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

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    expect(issued.expiresAt).toEqual(new Date('2026-05-09T12:02:00.000Z'));

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await issuer.jwks(),
        now: new Date('2026-05-09T12:00:01.000Z'),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });
  });

  it('rejects unknown scopes and unauthorized grants', async () => {
    const keys = await testKeys();

    expect(() =>
      createCapabilityIssuer({
        capabilities: [fizzyCapabilities],
        grants: defineServiceGrants({
          grants: [{ caller: 'moco', scopes: ['fizzy.unknown'], target: 'fizzy' }],
        }),
        issuer: 'control-plane',
        keyId: 'test-key',
        privateKey: keys.privateKey,
        publicJwk: keys.publicJwk,
      }),
    ).toThrow('Unknown Service-Plane capability scope: fizzy.unknown');

    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });

    await expect(
      issuer.issueCapabilityToken({
        callerServiceId: 'moco',
        scopes: ['fizzy.boards.sync'],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Service-Plane capability grant denied');
  });

  it('rejects empty scope token requests', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });

    await expect(
      issuer.issueCapabilityToken({
        callerServiceId: 'moco',
        scopes: [],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Service-Plane capability token requires at least one scope');
  });

  it('clamps and validates caller requested token TTLs', async () => {
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
      ttlSeconds: 300,
    });

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
      ttlSeconds: 3600,
    });
    expect(issued.expiresAt).toEqual(new Date('2026-05-09T12:05:00.000Z'));

    await expect(
      issuer.issueCapabilityToken({
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 0,
      }),
    ).rejects.toThrow('Service-Plane capability token TTL must be a positive integer');

    await expect(
      issuer.issueCapabilityToken({
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 1.5,
      }),
    ).rejects.toThrow('Service-Plane capability token TTL must be a positive integer');
  });

  it('rejects malformed token endpoint TTLs', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const app = new Hono();
    mountCapabilityTokenEndpoint(app, issuer, {
      authenticateCaller: () => 'moco',
    });

    const nonNumberResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: '3600',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const zeroResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 0,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(nonNumberResponse.status).toBe(400);
    expect(zeroResponse.status).toBe(400);
  });

  it('can mount token and JWKS endpoints together', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const app = new Hono();
    mountCapabilityEndpoints(app, issuer, {
      authenticateCaller: () => 'moco',
    });

    expect((await app.request('/.well-known/service-plane/jwks.json')).status).toBe(200);
    expect(
      (
        await app.request('/.well-known/service-plane/capability-token', {
          body: JSON.stringify({
            scopes: ['fizzy.users.lookup'],
            targetServiceId: 'fizzy',
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).status,
    ).toBe(200);
  });

  it('requires public JWKS material and supports non-extractable private keys', async () => {
    const keys = await testKeys();
    expect(() =>
      createCapabilityIssuer({
        capabilities: [fizzyCapabilities],
        grants: defineServiceGrants({
          grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
        }),
        issuer: 'control-plane',
        keyId: 'test-key',
        privateKey: keys.privateKey,
      } as CreateCapabilityIssuerOptions),
    ).toThrow('Service-Plane capability issuer requires a public JWK');

    const privateJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    const nonExtractablePrivateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: nonExtractablePrivateKey,
      publicJwk: keys.publicJwk,
    });

    await expect(issuer.jwks()).resolves.toEqual({ keys: [keys.publicJwk] });
  });

  it('can create issuers directly from JWK material and validates key pairs', async () => {
    const keys = await testKeys();
    const issuer = await createCapabilityIssuerFromJwks({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateJwk: keys.privateJwk,
      publicJwks: { keys: [keys.publicJwk] },
    });

    await expect(issuer.jwks()).resolves.toEqual({ keys: [keys.publicJwk] });

    const otherKeys = await testKeys();
    await expect(
      createCapabilityIssuerFromJwks({
        capabilities: [fizzyCapabilities],
        grants: defineServiceGrants({
          grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
        }),
        issuer: 'control-plane',
        keyId: 'test-key',
        privateJwk: keys.privateJwk,
        publicJwks: { keys: [otherKeys.publicJwk] },
      }),
    ).rejects.toThrow('Service-Plane public JWK does not match private signing key');
  });

  it('requires the configured key id in JWKS material', async () => {
    const keys = await testKeys();

    await expect(
      createCapabilityIssuerFromJwks({
        capabilities: [fizzyCapabilities],
        grants: defineServiceGrants({
          grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
        }),
        issuer: 'control-plane',
        keyId: 'missing-key',
        privateJwk: keys.privateJwk,
        publicJwks: { keys: [keys.publicJwk] },
      }),
    ).rejects.toThrow('Service-Plane JWKS is missing key id: missing-key');
  });
});

const fizzyCapabilities = defineCapabilities({
  scopes: [
    { id: 'fizzy.users.lookup', title: 'Lookup Fizzy users' },
    { id: 'fizzy.boards.sync', title: 'Sync Fizzy boards' },
  ],
  serviceId: 'fizzy',
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    privateKey: pair.privateKey,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
