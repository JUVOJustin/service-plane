import { describe, expect, it } from 'vitest';
import { createControlPlaneRpcBroker } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';

describe('broker logging reliability', () => {
  it('preserves the broker failure when the log sink throws', async () => {
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer: unusedIssuer(),
      log: () => {
        throw new Error('sink failed');
      },
      services: [],
    });

    await expect(
      broker.callAbility({
        abilityId: 'missing',
        input: {},
        method: 'read',
        scopes: ['catalog:read'],
        targetServiceId: 'catalog',
      }),
    ).rejects.toThrow('Service-Plane broker has no ability: catalog/missing');
  });
});

function unusedIssuer(): CapabilityIssuer {
  return {
    issueBrokeredCapabilityToken: async () => {
      throw new Error('not reached');
    },
    issueCapabilityToken: async () => {
      throw new Error('not reached');
    },
    jwks: async () => ({ keys: [] }),
  };
}
