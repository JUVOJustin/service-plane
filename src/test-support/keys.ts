import type { CapabilitySigningJwk } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';

export type TestKeys = {
  privateJwk: CapabilitySigningJwk;
  publicJwk: JsonWebKey;
};

// One ES256 pair for tests that sign with raw key material instead of a control-plane signing
// secret. `keyId` lands on both halves, so verifiers see the same `kid` the issuer signs with.
export async function testKeys(keyId = 'test-key'): Promise<TestKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk: { ...privateJwk, kid: keyId }, publicJwk: publicJwkFromPrivateJwk(privateJwk, keyId) };
}
