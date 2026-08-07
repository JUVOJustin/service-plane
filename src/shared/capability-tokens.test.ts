import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';
import { extractServicePlaneToken, publicJwkFromPrivateJwk, signCapabilityToken, verifyCapabilityToken } from './capability-tokens.js';
import { CapabilityAuthError } from './errors.js';
import { SERVICE_PLANE_JWK_ALGORITHM, servicePlaneJwkSigningKey } from './jwk-auth.js';

const NOW = new Date('2026-05-09T12:00:00.000Z');

describe('STS capability tokens', () => {
  it('parses the authorization scheme case-insensitively and rejects extra credentials', () => {
    expect(extractServicePlaneToken(new Request('https://service.internal', { headers: { authorization: 'serviceplane token' } }))).toBe(
      'token',
    );

    expect(() =>
      extractServicePlaneToken(new Request('https://service.internal', { headers: { authorization: 'ServicePlane token extra' } })),
    ).toThrow('Invalid Service-Plane authorization scheme');
  });

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

  it('surfaces RFC 8693 delegated subjects with the acting service from the act claim', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        act: { sub: 'control-plane' },
        aud: 'fizzy',
        iss: 'control-plane',
        scp: ['fizzy.users.lookup'],
        spo: 'org-42',
        sub: 'user-7',
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
      }),
    ).resolves.toMatchObject({
      serviceId: 'control-plane',
      subject: { id: 'user-7', orgId: 'org-42' },
    });
  });

  it('omits the subject for tokens without an act claim', async () => {
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

    const identity = await verifyCapabilityToken(issued.token, {
      expectedAudience: 'fizzy',
      jwks: keys.jwks,
      now: new Date('2026-05-09T12:01:00.000Z'),
    });
    expect(identity.serviceId).toBe('moco');
    expect(identity.subject).toBeUndefined();
  });

  it('reads the caller access claim, defaulting a token without one to the plane class', async () => {
    const keys = await testKeys();
    const verify = (token: string) =>
      verifyCapabilityToken(token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      });
    const claims = { aud: 'fizzy', iss: 'control-plane', scp: ['fizzy.users.lookup'], sub: 'moco' };
    const signed = (spa?: unknown) =>
      signCapabilityToken({
        claims: spa === undefined ? claims : { ...claims, spa: spa as never },
        keyId: 'test-key',
        now: NOW,
        privateJwk: keys.privateJwk,
      });

    await expect(verify((await signed('service')).token)).resolves.toMatchObject({ callerAccess: 'service' });
    await expect(verify((await signed('plane')).token)).resolves.toMatchObject({ callerAccess: 'plane' });

    // A control plane that predates the claim. Reading it as plane-class keeps such a token usable
    // for everything except the service-only abilities it was never attested for.
    await expect(verify((await signed()).token)).resolves.toMatchObject({ callerAccess: 'plane' });

    for (const spa of ['', 'user', 'SERVICE', 42, null, {}]) {
      await expect(verify((await signed(spa)).token)).rejects.toThrow('Invalid Service-Plane capability claims');
    }
  });

  it('rejects malformed actor claims and org claims without delegation', async () => {
    const keys = await testKeys();
    const malformedActors: unknown[] = ['control-plane', {}, { sub: '' }, { sub: 42 }, { sub: 'x'.repeat(600) }];

    for (const act of malformedActors) {
      const issued = await signCapabilityToken({
        claims: {
          act: act as never,
          aud: 'fizzy',
          iss: 'control-plane',
          scp: ['fizzy.users.lookup'],
          sub: 'user-7',
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
      ).rejects.toThrow('Invalid Service-Plane capability actor claim');
    }

    // The public signer refuses this combination, so sign the malformed but authentic claims
    // directly to prove the verifier enforces the same invariant after signature validation.
    const orgWithoutAct = await sign(
      {
        aud: 'fizzy',
        exp: 9999999999,
        iat: 1,
        iss: 'control-plane',
        jti: 'x',
        nbf: 1,
        scp: ['fizzy.users.lookup'],
        spo: 'org-42',
        sub: 'moco',
      },
      servicePlaneJwkSigningKey(keys.privateJwk, 'test-key'),
      SERVICE_PLANE_JWK_ALGORITHM,
    );

    await expect(
      verifyCapabilityToken(orgWithoutAct, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow('Invalid Service-Plane capability claims');
  });

  it('refuses to sign an spo claim without an act claim', async () => {
    const keys = await testKeys();

    await expect(
      signCapabilityToken({
        claims: {
          aud: 'fizzy',
          iss: 'control-plane',
          scp: ['fizzy.users.lookup'],
          spo: 'org-42',
          sub: 'moco',
        },
        keyId: 'test-key',
        now: NOW,
        privateJwk: keys.privateJwk,
      }),
    ).rejects.toThrow('Service-Plane capability spo claim requires an act claim');
  });

  it('rejects invalid signatures', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: {
        aud: 'fizzy',
        iss: 'control-plane',
        scp: ['fizzy.other'],
        sub: 'moco',
      },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
    });
    const parts = issued.token.split('.');
    const tamperedPayload = btoa(
      JSON.stringify({
        aud: 'fizzy',
        exp: 9999999999,
        iat: 1,
        iss: 'control-plane',
        jti: 'x',
        nbf: 1,
        scp: ['fizzy.users.lookup'],
        sub: 'evil',
      }),
    )
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    await expect(
      verifyCapabilityToken(tampered, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).rejects.toThrow('Invalid Service-Plane capability signature');
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

  it('rejects oversized tokens before parsing untrusted claims', async () => {
    const keys = await testKeys();
    const token = `${btoa(JSON.stringify({ alg: 'ES256', kid: 'test-key' }))}.${'a'.repeat(8200)}.signature`;

    await expect(
      verifyCapabilityToken(token, {
        expectedAudience: 'fizzy',
        jwks: keys.jwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow('Service-Plane capability token is too large');
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

  it('rejects unsafe or excessive token TTLs', async () => {
    const keys = await testKeys();

    await expect(
      signCapabilityToken({
        claims: {
          aud: 'fizzy',
          iss: 'control-plane',
          scp: ['fizzy.users.lookup'],
          sub: 'moco',
        },
        keyId: 'test-key',
        now: NOW,
        privateJwk: keys.privateJwk,
        ttlSeconds: 90_000,
      }),
    ).rejects.toThrow('Service-Plane capability token TTL must be a positive integer');
  });

  it('removes private JWK material when deriving public keys', async () => {
    const keys = await testKeys();
    const publicJwk = publicJwkFromPrivateJwk(
      {
        ...keys.privateJwk,
        dp: 'private-dp',
        dq: 'private-dq',
        k: 'private-k',
        oth: [{ d: 'private-other-prime' }],
        p: 'private-p',
        q: 'private-q',
        qi: 'private-qi',
      },
      'test-key',
    );

    expect(publicJwk).not.toHaveProperty('d');
    expect(publicJwk).not.toHaveProperty('dp');
    expect(publicJwk).not.toHaveProperty('dq');
    expect(publicJwk).not.toHaveProperty('k');
    expect(publicJwk).not.toHaveProperty('oth');
    expect(publicJwk).not.toHaveProperty('p');
    expect(publicJwk).not.toHaveProperty('q');
    expect(publicJwk).not.toHaveProperty('qi');
  });

  it('rejects a token when the matched JWK advertises a non-ES256 algorithm', async () => {
    const keys = await testKeys();
    const issued = await signCapabilityToken({
      claims: { aud: 'fizzy', iss: 'control-plane', scp: ['fizzy.users.lookup'], sub: 'moco' },
      keyId: 'test-key',
      now: NOW,
      privateJwk: keys.privateJwk,
    });
    // Same EC P-256 point, but the operator marked the key for a different algorithm — WebCrypto
    // import ignores `alg`, so Service-Plane must honour it (matching hono's verifyWithJwks).
    const mismatchedJwks = { keys: [{ ...keys.jwks.keys[0], alg: 'ES384' }] };

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: mismatchedJwks,
        now: new Date('2026-05-09T12:01:00.000Z'),
      }),
    ).rejects.toThrow('Invalid Service-Plane capability signature');
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
