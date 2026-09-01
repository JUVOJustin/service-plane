import { describe, expect, it } from 'vitest';
import type { DiscoveredServiceAbility, IssuedCapabilityToken } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';
import { invokeControlPlaneMethod } from './invocation.js';

describe('shared REST and MCP invocation deadlines', () => {
  it('times out pending capability issuance and prevents a late result from starting transport', async () => {
    let transportCalls = 0;
    const ability: DiscoveredServiceAbility = {
      access: 'plane',
      exposure: 'published',
      id: 'tasks.items',
      methods: {
        get: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scopes: ['tasks.read'],
        },
      },
      rpc: { path: '/rpc/tasks.items', transports: ['service-binding'] },
      scopes: ['tasks.read'],
      service: {
        abilityRpc: {
          invokeAbility: () => {
            transportCalls += 1;
            return { ok: true };
          },
        },
        fetch: async () => new Response(null, { status: 404 }),
        id: 'tasks',
        origin: 'https://tasks.internal',
      },
      serviceId: 'tasks',
      serviceTitle: 'Tasks',
      serviceVersion: '1.0.0',
    };
    let resolveIssue: ((issued: IssuedCapabilityToken) => void) | undefined;
    const pendingIssue = () =>
      new Promise<Awaited<ReturnType<CapabilityIssuer['issueCapabilityToken']>>>((resolve) => {
        resolveIssue = resolve;
      });
    const issuer: CapabilityIssuer = {
      issueBrokeredCapabilityToken: pendingIssue,
      issueCapabilityToken: pendingIssue,
      jwks: async () => ({ keys: [] }),
    };

    await expect(
      invokeControlPlaneMethod(
        { ability, method: 'get', scopes: ['tasks.read'] },
        {},
        {
          controlPlaneServiceId: 'control-plane',
          issuer,
          receivedAt: Date.now(),
          timeoutMs: 20,
        },
      ),
    ).rejects.toMatchObject({ code: 'timeout', status: 504 });

    resolveIssue?.({ expiresAt: new Date(Date.now() + 60_000), token: 'late-token' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transportCalls).toBe(0);
  });
});
