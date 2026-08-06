import { describe, expect, it } from 'vitest';
import { defineCapabilities } from '../service/capabilities.js';
import { decodeCapabilityTokenPayload } from '../shared/capability-tokens.js';
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
      privateJwks: [{ ...privateJwk, kid: 'test-key' }],
    });

    const issued = await issueCapabilityTokenForCaller(issuer, 'moco', {
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    expect(issued).toMatchObject({ token: expect.any(String), tokenType: 'ServicePlane' });
    // The deployment configuration established the caller as a service, and services enforce
    // `access: 'service'` against this claim — pin it so a refactor cannot drop the stamp silently.
    expect(decodeCapabilityTokenPayload(issued.token).spa).toBe('service');

    await expect(
      issueCapabilityTokenForCaller(issuer, 'moco', {
        callerServiceId: 'other',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Caller service mismatch');

    await expect(
      issueCapabilityTokenForCaller(issuer, 'moco', {
        scopes: ['fizzy.users.lookup'],
        subject: { id: 'user-7' },
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Service-Plane capability token subject cannot be asserted by callers');
  });
});
