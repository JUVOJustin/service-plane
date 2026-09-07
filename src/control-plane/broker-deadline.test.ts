import { describe, expect, it } from 'vitest';
import type { DiscoveredServiceAbility, ServiceEndpoint, ServiceRegistry } from '../shared/types.js';
import { createControlPlaneRpcBroker } from './broker.js';
import type { CapabilityIssuer } from './capabilities.js';

const endpoint: ServiceEndpoint = {
  fetch: async () => new Response(null, { status: 404 }),
  id: 'tasks',
  origin: 'https://tasks.internal',
};

function discoveredAbility(service: ServiceEndpoint = endpoint): DiscoveredServiceAbility {
  return {
    access: 'plane',
    exposure: 'private',
    id: 'tasks.items',
    methods: {
      get: {
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scopes: ['tasks.read'],
      },
    },
    rpc: { path: '/rpc/v1/tasks.items', protocol: 'service-plane-rpc/1', transports: service.abilityRpc ? ['service-binding'] : ['fetch'] },
    scopes: ['tasks.read'],
    service,
    serviceId: 'tasks',
    serviceTitle: 'Tasks',
    serviceVersion: '1.0.0',
  };
}

function registryWithAbility(resolveAbility: ServiceRegistry['ability']): ServiceRegistry {
  return {
    abilities: async () => [],
    ability: resolveAbility,
    discover: async () => ({ abilities: [], discoveredAt: new Date(0).toISOString(), services: [] }),
    endpoint: () => undefined,
  };
}

function issuer(
  issue: CapabilityIssuer['issueCapabilityToken'] = async () => ({ expiresAt: new Date(Date.now() + 60_000), token: 'token' }),
) {
  return {
    issueBrokeredCapabilityToken: issue,
    issueCapabilityToken: issue,
    jwks: async () => ({ keys: [] }),
  } satisfies CapabilityIssuer;
}

function callInput() {
  return {
    abilityId: 'tasks.items',
    input: {},
    method: 'get',
    scopes: ['tasks.read'],
    targetServiceId: 'tasks',
  };
}

describe('control-plane broker deadlines', () => {
  it.each([undefined, 'service-plane-rpc/0', 'service-plane-rpc/2'])(
    'rejects discovered wire revision %s before issuing capabilities',
    async (protocol) => {
      let issued = 0;
      let invoked = 0;
      const ability = discoveredAbility({
        ...endpoint,
        abilityRpc: {
          invokeAbility: () => {
            invoked += 1;
          },
        },
      });
      const incompatible = {
        ...ability,
        rpc: { path: ability.rpc.path, transports: ability.rpc.transports, ...(protocol ? { protocol } : {}) },
      };
      const broker = createControlPlaneRpcBroker({
        controlPlaneServiceId: 'control-plane',
        issuer: issuer(async () => {
          issued += 1;
          return { expiresAt: new Date(), token: 'token' };
        }),
        registry: registryWithAbility(async () => incompatible),
      });
      await expect(broker.callAbility(callInput())).rejects.toMatchObject({ code: 'incompatible_protocol', status: 426, retryable: false });
      expect(issued).toBe(0);
      expect(invoked).toBe(0);
    },
  );
  it.each(['constructor', 'hasOwnProperty', 'toString', '__proto__'])(
    'rejects inherited method name %s before capability issuance or service dispatch',
    async (method) => {
      let issued = 0;
      let invoked = 0;
      const service: ServiceEndpoint = {
        ...endpoint,
        abilityRpc: {
          invokeAbility: async () => {
            invoked += 1;
            return undefined;
          },
        },
      };
      const ability = discoveredAbility(service);
      const broker = createControlPlaneRpcBroker({
        controlPlaneServiceId: 'control-plane',
        issuer: issuer(async () => {
          issued += 1;
          return { expiresAt: new Date(Date.now() + 60_000), token: 'token' };
        }),
        registry: registryWithAbility(async () => ability),
      });

      await expect(broker.callAbility({ ...callInput(), method })).rejects.toMatchObject({
        code: 'capability_auth',
        status: 404,
      });
      expect(issued).toBe(0);
      expect(invoked).toBe(0);
    },
  );

  it('times out while service discovery never resolves', async () => {
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer: issuer(),
      registry: registryWithAbility(() => new Promise<never>(() => undefined)),
      timeoutMs: 20,
    });

    await expect(broker.callAbility(callInput())).rejects.toMatchObject({ code: 'timeout', status: 504 });
  });

  it('aborts a Fetch transport that outlives the remaining broker budget', async () => {
    let transportSignal: AbortSignal | undefined;
    const service: ServiceEndpoint = {
      ...endpoint,
      fetch: (request) => {
        transportSignal = request.signal;
        return new Promise<Response>(() => undefined);
      },
    };
    const ability = discoveredAbility(service);
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer: issuer(),
      registry: registryWithAbility(async () => ability),
      timeoutMs: 20,
    });

    await expect(broker.callAbility(callInput())).rejects.toMatchObject({ code: 'timeout', status: 504 });
    expect(transportSignal?.aborted).toBe(true);
    expect(transportSignal?.reason).toMatchObject({ code: 'timeout', status: 504 });
  });
});
