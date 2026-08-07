import { describe, expect, it } from 'vitest';
import { defineCapabilities } from '../service/capabilities.js';
import { verifyCapabilityToken } from '../shared/capability-tokens.js';
import { decodeServicePlaneJwkToken } from '../shared/jwk-auth.js';
import { defineServiceGrants } from './capabilities.js';
import {
  type CapabilitySigningKey,
  createCapabilityIssuerFromSigningKeys,
  createCapabilitySigningAuthorityFromSigningKeys,
  generateCapabilitySigningSecret,
  privateJwkFromCapabilitySigningSecret,
} from './signing-keys.js';

const CAPABILITIES = defineCapabilities({ scopes: [{ id: 'fizzy.users.lookup' }], serviceId: 'fizzy' });
const GRANTS = defineServiceGrants({ grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }] });

async function signingKey(kid: string): Promise<CapabilitySigningKey> {
  return { kid, secret: await generateCapabilitySigningSecret() };
}

function issuerFor(keys: CapabilitySigningKey[], issuer = 'control-plane') {
  return createCapabilityIssuerFromSigningKeys({ capabilities: [CAPABILITIES], grants: GRANTS, issuer, keys });
}

function issue(issuer: Awaited<ReturnType<typeof issuerFor>>) {
  return issuer.issueCapabilityToken({
    callerAccess: 'service',
    callerServiceId: 'moco',
    scopes: ['fizzy.users.lookup'],
    targetServiceId: 'fizzy',
  });
}

describe('control-plane signing keys', () => {
  it('stores only the P-256 private scalar and rebuilds issuer defaults', async () => {
    const key = await signingKey('test-key');
    expect(key.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const privateJwk = privateJwkFromCapabilitySigningSecret(key.secret, key.kid);
    expect(privateJwk).toMatchObject({ alg: 'ES256', crv: 'P-256', d: key.secret, kid: 'test-key', kty: 'EC' });
    expect(typeof privateJwk.x).toBe('string');
    expect(typeof privateJwk.y).toBe('string');

    const issuer = await issuerFor([key]);
    const issued = await issue(issuer);

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await issuer.jwks(),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });
  });

  it('builds a signing authority that publishes the issuer key without a capability catalog', async () => {
    const key = await signingKey('test-key');
    const authority = createCapabilitySigningAuthorityFromSigningKeys({ issuer: 'https://issuer.example', keys: [key] });

    expect(authority.issuer).toBe('https://issuer.example');
    expect(authority.keyId).toBe('test-key');
    const jwks = await authority.jwks();
    expect(jwks.keys[0]).toMatchObject({ crv: 'P-256', kid: 'test-key', kty: 'EC' });
    expect(jwks.keys[0]).not.toHaveProperty('d');

    // The same secret must verify tokens signed by the full issuer, otherwise splitting the
    // signing authority out of the catalog would publish a key that verifies nothing.
    const issuer = await issuerFor([key], 'https://issuer.example');
    await expect(
      verifyCapabilityToken((await issue(issuer)).token, {
        expectedAudience: 'fizzy',
        issuer: authority.issuer,
        jwks,
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });
    await expect(issuer.jwks()).resolves.toEqual(jwks);
  });

  it('defaults the signing-authority issuer to the control-plane default', async () => {
    const authority = createCapabilitySigningAuthorityFromSigningKeys({ keys: [await signingKey('default')] });

    expect(authority.issuer).toBe('control-plane');
    expect(authority.keyId).toBe('default');
    await expect(authority.jwks()).resolves.toMatchObject({ keys: [{ kid: 'default' }] });
  });

  it('publishes every configured key but signs only with the first', async () => {
    const active = await signingKey('2026-07');
    const retired = await signingKey('2026-01');
    const issuer = await issuerFor([active, retired]);

    const jwks = await issuer.jwks();
    expect(jwks.keys.map((key) => key.kid)).toEqual(['2026-07', '2026-01']);
    expect(jwks.keys.every((key) => !('d' in key))).toBe(true);

    const issued = await issue(issuer);
    const { header } = decodeServicePlaneJwkToken(issued.token, 'unreadable');
    expect((header as { kid: string }).kid).toBe('2026-07');
  });

  it('hands out a key list a caller cannot edit the authority through', async () => {
    const authority = createCapabilitySigningAuthorityFromSigningKeys({ keys: [await signingKey('2026-07')] });

    // Aggregating several planes' JWKS into one document is an ordinary thing to do, and it must not
    // leave this authority publishing a key it was never configured with.
    const aggregated = await authority.jwks();
    aggregated.keys.push({ kid: 'not-ours', kty: 'EC' });

    await expect(authority.jwks()).resolves.toEqual({ keys: [expect.objectContaining({ kid: '2026-07' })] });
  });

  it('keeps tokens signed with a retired key verifiable while it is still published', async () => {
    const oldKey = await signingKey('2026-01');
    const newKey = await signingKey('2026-07');

    // Signed before the rotation, by a replica that still had the old key active.
    const beforeRotation = await issue(await issuerFor([oldKey]));
    // After: the new key signs, the old one stays published for the overlap window.
    const rotated = await issuerFor([newKey, oldKey]);

    await expect(
      verifyCapabilityToken(beforeRotation.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await rotated.jwks(),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });

    // Dropping the old key at the end of the overlap window is what finally invalidates it.
    const completed = await issuerFor([newKey]);
    await expect(
      verifyCapabilityToken(beforeRotation.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await completed.jwks(),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).rejects.toThrow('Unknown Service-Plane capability key id');
  });

  it('refuses a key set that a verifier could not tell apart', async () => {
    const first = await signingKey('same');
    const second = await signingKey('same');

    await expect(issuerFor([first, second])).rejects.toThrow('Duplicate Service-Plane signing key id: same');
    await expect(issuerFor([])).rejects.toThrow('Service-Plane signing keys cannot be empty');
    await expect(issuerFor([{ kid: '  ', secret: first.secret }])).rejects.toThrow('Service-Plane signing key id cannot be empty');
    expect(() => createCapabilitySigningAuthorityFromSigningKeys({ keys: [first, second] })).toThrow(
      'Duplicate Service-Plane signing key id: same',
    );
  });
});
