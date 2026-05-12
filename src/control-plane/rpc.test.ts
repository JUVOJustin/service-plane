import { describe, expect, it } from 'vitest';
import { defineCapabilities } from '../service/capabilities.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { issueCapabilityTokenForCaller } from './rpc.js';

describe('control-plane RPC token helpers', () => {
  it('issues tokens for a deployment-bound caller and rejects caller mismatches', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const privateJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    const issuer = createCapabilityIssuer({
      capabilities: [
        defineCapabilities({
          scopes: [{ id: 'fizzy.users.lookup' }],
          serviceId: 'fizzy',
        }),
      ],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateJwk,
    });

    await expect(
      issueCapabilityTokenForCaller(issuer, 'moco', {
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
    ).resolves.toMatchObject({ token: expect.any(String), tokenType: 'ServicePlane' });

    await expect(
      issueCapabilityTokenForCaller(issuer, 'moco', {
        callerServiceId: 'other',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Caller service mismatch');
  });
});
