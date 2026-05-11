import { describe, expect, it } from 'vitest';
import { CapabilityAuthError } from './errors.js';
import { publicJwkFromPrivateJwk, signCapabilityToken, verifyCapabilityToken } from './capability-tokens.js';

const NOW = new Date('2026-05-09T12:00:00.000Z');

describe('STS capability tokens', () => {
  it('issues and verifies ES256 JWS tokens', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        aud: 'fizzy',
        iss: 'control-plane',
        scp: ['fizzy.users.lookup'],
        sub: 'moco',
      },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({
      audience: 'fizzy',
      issuer: 'control-plane',
      scopes: ['fizzy.users.lookup'],
      serviceId: 'moco',
    });
  });

  it('rejects invalid signatures', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        aud: 'fizzy',
        iss: 'control-plane',
        scp: ['fizzy.users.lookup'],
        sub: 'moco',
      },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
    });
    const parts = issued.token.split('.');
    const tamperedPayload = btoa(JSON.stringify({ aud: 'fizzy', exp: 9999999999, iat: 1, iss: 'control-plane', jti: 'x', nbf: 1, scp: ['fizzy.users.lookup'], sub: 'evil' }))
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    await expect(
      verifyCapabilityToken(tampered, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow(CapabilityAuthError);
  });

  it('rejects malformed signatures and invalid JWKS keys as capability auth errors', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        aud: 'fizzy',
        iss: 'control-plane',
        scp: ['fizzy.users.lookup'],
        sub: 'moco',
      },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
    });
    const [header, payload] = issued.token.split('.');

    await expect(
      verifyCapabilityToken(`${header}.${payload}.@@`, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow(CapabilityAuthError);

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        jwks: { keys: [{ crv: 'P-256', kid: 'test-key', kty: 'EC', x: 'bad', y: 'bad' }] },
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow(CapabilityAuthError);
  });

  it('rejects tokens without scopes', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        aud: 'fizzy',
        iss: 'control-plane',
        scp: [],
        sub: 'moco',
      },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow('Invalid Service-Plane capability claims');
  });

  it('rejects expired, wrong-audience, and missing-scope tokens', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        aud: 'fizzy',
        iss: 'control-plane',
        scp: ['fizzy.users.lookup'],
        sub: 'moco',
      },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
      ttlSeconds: 60,
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'moco',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:00:01.000Z'),
      }),
    ).rejects.toThrow('Invalid Service-Plane capability audience');

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:00:01.000Z'),
        requiredScopes: ['fizzy.boards.sync'],
      }),
    ).rejects.toThrow('Missing Service-Plane capability scope: fizzy.boards.sync');

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:02:00.000Z'),
      }),
    ).rejects.toThrow('Expired Service-Plane capability token');
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    jwks: { keys: [publicJwkFromPrivateJwk(privateJwk, 'test-key')] },
    privateJwk,
  };
}
