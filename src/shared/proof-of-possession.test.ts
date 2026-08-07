import { describe, expect, it } from 'vitest';
import { publicJwkFromPrivateJwk } from './capability-tokens.js';
import { servicePlaneJwkThumbprint } from './jwk-auth.js';
import { signCapabilityProof, verifyCapabilityProof } from './proof-of-possession.js';

const TOKEN = 'header.payload.signature';

describe('JWK thumbprints', () => {
  it('hashes only the RFC 7638 required members, so published extras cannot change it', async () => {
    const keys = await callerKeys();
    const { crv, kty, x, y } = keys.publicJwk as { crv: string; kty: string; x: string; y: string };
    const bare = { crv, kty, x, y };

    // A caller publishing kid/use/alg/key_ops must thumbprint identically to the bare key, otherwise a
    // service and the plane could compute different values for the same key.
    await expect(servicePlaneJwkThumbprint(keys.publicJwk)).resolves.toBe(await servicePlaneJwkThumbprint(bare));
    expect(await servicePlaneJwkThumbprint(keys.publicJwk)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('differs between keys and refuses key types this package cannot sign with', async () => {
    const first = await callerKeys();
    const second = await callerKeys();

    expect(await servicePlaneJwkThumbprint(first.publicJwk)).not.toBe(await servicePlaneJwkThumbprint(second.publicJwk));
    await expect(servicePlaneJwkThumbprint({ kty: 'oct', k: 'secret' } as JsonWebKey)).rejects.toThrow(
      'Service-Plane JWK thumbprint requires an EC public key',
    );
  });
});

describe('capability proof of possession', () => {
  it('verifies a proof bound to the token, service, and ability', async () => {
    const keys = await callerKeys();
    const proof = await signCapabilityProof({
      abilityId: 'example.sync',
      privateJwk: keys.privateJwk,
      targetServiceId: 'example',
      token: TOKEN,
    });

    await expect(
      verifyCapabilityProof(proof, {
        abilityId: 'example.sync',
        confirmation: { jkt: keys.thumbprint },
        targetServiceId: 'example',
        token: TOKEN,
      }),
    ).resolves.toBeUndefined();
  });

  it('signs with a workerd-shaped JWK whose absent members exist with undefined values', async () => {
    // workerd's exportKey('jwk') materializes every JsonWebKey member — `alg: undefined` included —
    // where Node omits the absent ones. Reproduced here on Node so a regression fails everywhere,
    // not only in the workerd suite.
    const keys = await callerKeys();
    // The double cast is the point: TS's JsonWebKey cannot express "property present, value
    // undefined", but that is exactly the runtime shape workerd hands back.
    const workerdShaped = { ...keys.privateJwk, alg: undefined, e: undefined, k: undefined, n: undefined, use: undefined };
    const proof = await signCapabilityProof({
      abilityId: 'example.sync',
      privateJwk: workerdShaped as unknown as JsonWebKey,
      targetServiceId: 'example',
      token: TOKEN,
    });

    await expect(
      verifyCapabilityProof(proof, {
        abilityId: 'example.sync',
        confirmation: { jkt: keys.thumbprint },
        targetServiceId: 'example',
        token: TOKEN,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a different ability', { abilityId: 'example.other' }, /ability mismatch/u],
    ['a different service', { targetServiceId: 'other' }, /audience mismatch/u],
    ['a different token', { token: 'other.token.value' }, /bound to a different token/u],
  ])('rejects a proof checked against %s', async (_label, override, expected) => {
    const keys = await callerKeys();
    const proof = await signCapabilityProof({
      abilityId: 'example.sync',
      privateJwk: keys.privateJwk,
      targetServiceId: 'example',
      token: TOKEN,
    });

    await expect(
      verifyCapabilityProof(proof, {
        abilityId: 'example.sync',
        confirmation: { jkt: keys.thumbprint },
        targetServiceId: 'example',
        token: TOKEN,
        ...override,
      }),
    ).rejects.toThrow(expected);
  });

  it('rejects a proof whose key is not the bound key', async () => {
    const keys = await callerKeys();
    const attacker = await callerKeys();
    const proof = await signCapabilityProof({
      abilityId: 'example.sync',
      privateJwk: attacker.privateJwk,
      targetServiceId: 'example',
      token: TOKEN,
    });

    await expect(
      verifyCapabilityProof(proof, {
        abilityId: 'example.sync',
        confirmation: { jkt: keys.thumbprint },
        targetServiceId: 'example',
        token: TOKEN,
      }),
    ).rejects.toThrow('Service-Plane proof of possession key does not match the token confirmation');
  });

  it('rejects a proof that swaps in another key without re-signing', async () => {
    const keys = await callerKeys();
    const attacker = await callerKeys();
    const proof = await signCapabilityProof({
      abilityId: 'example.sync',
      privateJwk: attacker.privateJwk,
      targetServiceId: 'example',
      token: TOKEN,
    });

    // Substituting the victim's public key makes the thumbprint match, so the signature check is the
    // only thing standing between an attacker and a forged proof.
    const [header, payload, signature] = proof.split('.');
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload ?? '')));
    const swapped = `${header}.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, cnk: keys.publicJwk })))}.${signature}`;

    await expect(
      verifyCapabilityProof(swapped, {
        abilityId: 'example.sync',
        confirmation: { jkt: keys.thumbprint },
        targetServiceId: 'example',
        token: TOKEN,
      }),
    ).rejects.toThrow('Invalid Service-Plane proof of possession signature');
  });

  it('rejects an expired proof and one issued in the future beyond the skew allowance', async () => {
    const keys = await callerKeys();
    const now = new Date('2026-05-09T12:00:00.000Z');
    const proof = await signCapabilityProof({
      abilityId: 'example.sync',
      now,
      privateJwk: keys.privateJwk,
      targetServiceId: 'example',
      token: TOKEN,
      ttlSeconds: 60,
    });
    const check = (at: Date) =>
      verifyCapabilityProof(proof, {
        abilityId: 'example.sync',
        confirmation: { jkt: keys.thumbprint },
        now: at,
        targetServiceId: 'example',
        token: TOKEN,
      });

    // Within TTL plus the 60s skew allowance.
    await expect(check(new Date(now.getTime() + 90_000))).resolves.toBeUndefined();
    await expect(check(new Date(now.getTime() + 121_000))).rejects.toThrow('Expired Service-Plane proof of possession');
    await expect(check(new Date(now.getTime() - 61_000))).rejects.toThrow('Service-Plane proof of possession issued-at is in the future');
  });

  it('rejects malformed proofs without attempting verification', async () => {
    const keys = await callerKeys();
    const options = {
      abilityId: 'example.sync',
      confirmation: { jkt: keys.thumbprint },
      targetServiceId: 'example',
      token: TOKEN,
    };

    await expect(verifyCapabilityProof('', options)).rejects.toThrow('Invalid Service-Plane proof of possession');
    await expect(verifyCapabilityProof('not-a-jws', options)).rejects.toThrow('Invalid Service-Plane proof of possession');
    await expect(verifyCapabilityProof('a'.repeat(8193), options)).rejects.toThrow('Invalid Service-Plane proof of possession');
  });

  it('refuses to sign with a key that is not an EC private key', async () => {
    await expect(
      signCapabilityProof({
        abilityId: 'example.sync',
        privateJwk: { k: 'secret', kty: 'oct' } as JsonWebKey,
        targetServiceId: 'example',
        token: TOKEN,
      }),
    ).rejects.toThrow('Service-Plane proof of possession requires an EC private key');
  });
});

async function callerKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = publicJwkFromPrivateJwk(privateJwk, 'caller-key');
  return { privateJwk, publicJwk, thumbprint: await servicePlaneJwkThumbprint(publicJwk) };
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
