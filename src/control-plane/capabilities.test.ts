import { describe, expect, it } from 'vitest';
import { publicJwkFromPrivateJwk, verifyCapabilityToken } from '../shared/capability-tokens.js';
import { defineCapabilities } from '../service/capabilities.js';
import {
  capabilityEndpointsHandler,
  capabilityJwksHandler,
  capabilityTokenHandler,
  createCapabilityIssuer,
  createCapabilityIssuerFromJwks,
  defineServiceGrants,
  type CreateCapabilityIssuerOptions,
} from './capabilities.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH, SERVICE_PLANE_CAPABILITY_TOKEN_PATH } from '../shared/types.js';

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
  });

  it('serves token requests via a framework-agnostic Request handler', async () => {
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
    const handler = capabilityTokenHandler(issuer, { authenticateCaller: () => 'moco' });

    const ok = await handler(new Request(`https://control.example.com${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
      body: JSON.stringify({ scopes: ['fizzy.users.lookup'], targetServiceId: 'fizzy' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string };
    expect(typeof body.token).toBe('string');

    const malformedTtl = await handler(new Request(`https://control.example.com${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
      body: JSON.stringify({ scopes: ['fizzy.users.lookup'], targetServiceId: 'fizzy', ttlSeconds: '10' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    expect(malformedTtl.status).toBe(400);
  });

  it('serves both token and JWKS endpoints from a single handler', async () => {
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
    const handler = capabilityEndpointsHandler(issuer, { authenticateCaller: () => 'moco' });

    const jwksHandler = capabilityJwksHandler(issuer);
    const directJwks = await jwksHandler(new Request(`https://control.example.com${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    expect(directJwks.status).toBe(200);

    const otherPath = await handler(new Request('https://control.example.com/healthz'));
    expect(otherPath).toBeUndefined();

    const jwks = await handler(new Request(`https://control.example.com${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    expect(jwks?.status).toBe(200);
    const body = (await jwks!.json()) as { keys: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);

    const token = await handler(new Request(`https://control.example.com${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
      body: JSON.stringify({ scopes: ['fizzy.users.lookup'], targetServiceId: 'fizzy' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
    expect(token?.status).toBe(200);
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

  it('builds issuers from a private JWK and validates the key pair', async () => {
    const keys = await testKeys();
    const issuer = await createCapabilityIssuerFromJwks({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateJwk: keys.privateJwk,
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
