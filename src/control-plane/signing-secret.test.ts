import { describe, expect, it } from 'vitest';
import { defineCapabilities } from '../service/capabilities.js';
import { verifyCapabilityToken } from '../shared/capability-tokens.js';
import { defineServiceGrants } from './capabilities.js';
import {
  createCapabilityIssuerFromSigningSecret,
  createCapabilitySigningAuthorityFromSigningSecret,
  generateCapabilitySigningSecret,
  privateJwkFromCapabilitySigningSecret,
} from './signing-secret.js';

describe('control-plane signing secrets', () => {
  it('stores only the P-256 private scalar and rebuilds issuer defaults', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    expect(signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const privateJwk = privateJwkFromCapabilitySigningSecret(signingSecret, 'test-key');
    expect(privateJwk).toMatchObject({
      alg: 'ES256',
      crv: 'P-256',
      d: signingSecret,
      kid: 'test-key',
      kty: 'EC',
    });
    expect(typeof privateJwk.x).toBe('string');
    expect(typeof privateJwk.y).toBe('string');

    const capabilities = defineCapabilities({
      scopes: [{ id: 'fizzy.users.lookup' }],
      serviceId: 'fizzy',
    });
    const issuer = await createCapabilityIssuerFromSigningSecret({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      keyId: 'test-key',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      signingSecret,
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

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

  it('builds a signing authority that publishes the issuer key without a capability catalog', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const authority = createCapabilitySigningAuthorityFromSigningSecret({
      issuer: 'https://issuer.example',
      keyId: 'test-key',
      signingSecret,
    });

    expect(authority.issuer).toBe('https://issuer.example');
    expect(authority.keyId).toBe('test-key');
    const jwks = await authority.jwks();
    expect(jwks.keys[0]).toMatchObject({ crv: 'P-256', kid: 'test-key', kty: 'EC' });
    expect(jwks.keys[0]).not.toHaveProperty('d');

    // The same secret must verify tokens signed by the full issuer, otherwise splitting the
    // signing authority out of the catalog would publish a key that verifies nothing.
    const issuer = await createCapabilityIssuerFromSigningSecret({
      capabilities: [defineCapabilities({ scopes: [{ id: 'fizzy.users.lookup' }], serviceId: 'fizzy' })],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'https://issuer.example',
      keyId: 'test-key',
      signingSecret,
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: authority.issuer,
        jwks,
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });
    await expect(issuer.jwks()).resolves.toEqual(jwks);
  });

  it('defaults the signing-authority issuer and key id to the control-plane defaults', async () => {
    const authority = createCapabilitySigningAuthorityFromSigningSecret({
      signingSecret: await generateCapabilitySigningSecret(),
    });

    expect(authority.issuer).toBe('control-plane');
    expect(authority.keyId).toBe('default');
    await expect(authority.jwks()).resolves.toMatchObject({ keys: [{ kid: 'default' }] });
  });
});
