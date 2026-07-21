import { generateServicePlaneJwkSigningKey, publicJwkFromPrivateJwk } from '../shared/jwk-auth.js';

export type GenerateServiceCallerSigningJwkOptions = {
  keyId?: string;
};

// Gives external services an asymmetric identity for token requests without storing a shared secret in the control plane.
export async function generateServiceCallerSigningJwk(options: GenerateServiceCallerSigningJwkOptions = {}): Promise<JsonWebKey> {
  return generateServicePlaneJwkSigningKey(options);
}

export function publicJwkFromServiceCallerSigningJwk(
  privateJwk: JsonWebKey,
  keyId = serviceCallerKeyId(privateJwk),
): JsonWebKey & { kid?: string } {
  return publicJwkFromPrivateJwk(privateJwk, keyId);
}

function serviceCallerKeyId(privateJwk: JsonWebKey): string {
  const keyId = (privateJwk as JsonWebKey & { kid?: string }).kid;
  return keyId ?? 'default';
}
