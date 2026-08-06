import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createControlPlaneRpcBroker } from '../control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { cloudflareServiceBinding } from '../control-plane/endpoints.js';
import { SERVICE_PLANE_TIMEOUT_HEADER, SERVICE_PLANE_TIMEOUT_QUERY_PARAM } from '../shared/deadline.js';
import { testKeys } from '../test-support/index.js';
import { abilitySession, cloudflareNativeRpc, cloudflareServiceBindingRpc, defineCapabilities, RpcTarget } from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const capabilities = defineCapabilities({
  scopes: [{ id: 'example.work.run' }],
  serviceId: 'example',
});

type HandlerObservation = { hasSignal: boolean };

// One ability with a fast method and a method that deliberately outlives any budget a test sets,
// so service-side enforcement can be observed without racing the caller's own timer.
function buildService(observe?: (observation: HandlerObservation) => void) {
  const workAbility = defineAbility({
    id: 'example.work',
    methods: {
      runFast: abilityMethod({
        input: z.object({}),
        output: z.object({ ok: z.literal(true) }),
        scopes: ['example.work.run'],
      }),
      runSlow: abilityMethod({
        input: z.object({}),
        output: z.object({ ok: z.literal(true) }),
        scopes: ['example.work.run'],
      }),
    },
    rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
    scopes: ['example.work.run'],
    handler: ({ signal }) => {
      observe?.({ hasSignal: Boolean(signal) });
      class WorkApi extends RpcTarget {
        async runFast() {
          return { ok: true as const };
        }
        // Ignores `signal` on purpose: the wrapper must still refuse to resolve past the deadline.
        async runSlow() {
          await sleep(200);
          return { ok: true as const };
        }
      }
      return new WorkApi() as WorkApi & Record<string, unknown>;
    },
  });

  const service = new ServicePlaneService({
    abilities: [workAbility],
    auth: { issuer: 'control-plane', jwks: { keys: [] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });
  return { service, workAbility };
}

async function issuerWithKeys() {
  const keys = await testKeys();
  return {
    keys,
    issuer: createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.work.run'], target: 'example' }] }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    }),
  };
}

describe('deadline propagation', () => {
  it('hands the handler a signal only when the caller sent a budget', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const observations: HandlerObservation[] = [];
    const { workAbility } = buildService((observation) => observations.push(observation));
    const authed = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });
    const binding = { fetch: async (request: Request) => authed.fetch(request) };

    const withoutDeadline = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(binding, undefined, 'https://example.internal'),
    });
    await expect(withoutDeadline.runFast({})).resolves.toEqual({ ok: true });

    const withDeadline = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      timeoutMs: 5_000,
      transport: cloudflareServiceBindingRpc(binding, undefined, 'https://example.internal'),
    });
    await expect(withDeadline.runFast({})).resolves.toEqual({ ok: true });

    expect(observations).toEqual([{ hasSignal: false }, { hasSignal: true }]);
  });

  it('forwards the budget as a header on HTTP transports', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const { workAbility } = buildService();
    const service = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    let forwarded: string | null = null;
    const binding = {
      fetch: async (request: Request) => {
        forwarded = request.headers.get(SERVICE_PLANE_TIMEOUT_HEADER);
        return service.fetch(request);
      },
    };
    const api = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      timeoutMs: 4_200,
      transport: cloudflareServiceBindingRpc(binding, undefined, 'https://example.internal'),
    });

    await expect(api.runFast({})).resolves.toEqual({ ok: true });
    expect(forwarded).toBe('4200');
  });

  it('refuses to resolve a handler that outlives the deadline, even when it ignores the signal', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const { workAbility } = buildService();
    const service = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    // Straight through the native binding so the caller-side timer is out of the picture and the
    // rejection can only have come from the service's own enforcement.
    const target = (await service.connectAbility({
      abilityId: 'example.work',
      timeoutMs: 20,
      token: issued.token,
    })) as unknown as { runSlow(input: unknown): Promise<unknown> };

    await expect(target.runSlow({})).rejects.toThrow(/deadline/iu);
  });

  it('bounds the calling side even when the service is slow', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const { workAbility } = buildService();
    const service = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    const api = await abilitySession<AbilityRpc<typeof workAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      timeoutMs: 25,
      transport: cloudflareNativeRpc({
        connectAbility: (input) => service.connectAbility(input),
      }),
    });

    await expect(api.runSlow({})).rejects.toThrow(/deadline/iu);
  });
});

describe('broker deadline accounting', () => {
  it('forwards what is left after the plane spent part of the budget', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const { workAbility } = buildService();
    const service = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    let forwarded: string | null = null;
    const endpoint = cloudflareServiceBinding({
      binding: {
        fetch: async (request: Request) => {
          // Only the ability call carries a budget; the registry's discovery fetch is plane-side
          // work that happens before the service leg exists.
          if (new URL(request.url).pathname === '/rpc/example.work') forwarded = request.headers.get(SERVICE_PLANE_TIMEOUT_HEADER);
          return service.fetch(request);
        },
      },
      id: 'example',
    });

    // The plane took 400ms of the caller's 1000ms before it reached the service.
    const clock = [0, 400];
    let reading = 0;
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      now: () => clock[Math.min(reading++, clock.length - 1)] as number,
      services: [endpoint],
      timeoutMs: 1_000,
    });

    const root = broker.rootCapability({ id: 'worker-a', kind: 'service' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<{ connect(scopes: string[]): Promise<AbilityRpc<typeof workAbility>> }>;
    };
    const ability = await root.ability('example', 'example.work');
    const api = await ability.connect(['example.work.run']);
    await expect(api.runFast({})).resolves.toEqual({ ok: true });

    expect(forwarded).toBe('600');
  });

  it('fails before opening a session once the budget is gone', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const { workAbility } = buildService();
    const service = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    let reached = false;
    const endpoint = cloudflareServiceBinding({
      binding: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === '/rpc/example.work') reached = true;
          return service.fetch(request);
        },
      },
      id: 'example',
    });

    const clock = [0, 5_000];
    let reading = 0;
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      now: () => clock[Math.min(reading++, clock.length - 1)] as number,
      services: [endpoint],
      timeoutMs: 1_000,
    });

    const root = broker.rootCapability({ id: 'worker-a', kind: 'service' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<{ connect(scopes: string[]): Promise<unknown> }>;
    };
    const ability = await root.ability('example', 'example.work');
    await expect(ability.connect(['example.work.run'])).rejects.toThrow(/exhausted the caller's deadline/u);
    expect(reached).toBe(false);
  });
});

describe('websocket deadline forwarding', () => {
  it('carries the budget as a query parameter where headers cannot travel', async () => {
    const { issuer, keys } = await issuerWithKeys();
    const { workAbility } = buildService();
    const service = new ServicePlaneService({
      abilities: [workAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    let socketUrl: string | undefined;
    await expect(
      abilitySession<AbilityRpc<typeof workAbility>>({
        abilityId: 'example.work',
        callerServiceId: 'worker-a',
        requestToken: async () => issued,
        scopes: ['example.work.run'],
        targetServiceId: 'example',
        timeoutMs: 1_500,
        transport: {
          createWebSocket: (url) => {
            socketUrl = url;
            throw new Error('stop before connecting');
          },
          kind: 'websocket',
          url: 'wss://example.internal/rpc/example.work',
        },
      }).then((api) => api.runFast({})),
    ).rejects.toThrow();

    expect(new URL(socketUrl as string).searchParams.get(SERVICE_PLANE_TIMEOUT_QUERY_PARAM)).toBe('1500');
    expect(service.discoveryPath).toBeTruthy();
  });
});

describe('deadline across a service chain', () => {
  it('shrinks the budget at each hop when a handler passes the remainder on', async () => {
    const { issuer, keys } = await issuerWithKeys();

    // The downstream service. Records the budget it was handed.
    let downstreamBudget: number | undefined;
    const { workAbility: leafAbility } = buildService();
    const leaf = new ServicePlaneService({
      abilities: [leafAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.work.run'],
      targetServiceId: 'example',
    });

    // The middle service: its handler calls the leaf, forwarding what is left of its own budget.
    const middleAbility = defineAbility({
      id: 'example.work',
      methods: {
        runFast: abilityMethod({
          input: z.object({}),
          output: z.object({ ok: z.literal(true) }),
          scopes: ['example.work.run'],
        }),
      },
      rpc: { transports: ['cloudflare-binding-rpc'] },
      scopes: ['example.work.run'],
      handler: ({ remainingTimeoutMs }) => {
        class MiddleApi extends RpcTarget {
          async runFast() {
            await sleep(60);
            const onward = remainingTimeoutMs?.();
            downstreamBudget = onward;
            const downstream = await abilitySession<AbilityRpc<typeof leafAbility>>({
              abilityId: 'example.work',
              callerServiceId: 'worker-a',
              requestToken: async () => issued,
              scopes: ['example.work.run'],
              targetServiceId: 'example',
              ...(onward === undefined ? {} : { timeoutMs: onward }),
              transport: cloudflareNativeRpc({ connectAbility: (input) => leaf.connectAbility(input) }),
            });
            return downstream.runFast({});
          }
        }
        return new MiddleApi() as MiddleApi & Record<string, unknown>;
      },
    });

    const middle = new ServicePlaneService({
      abilities: [middleAbility],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    const api = await abilitySession<AbilityRpc<typeof middleAbility>>({
      abilityId: 'example.work',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.work.run'],
      targetServiceId: 'example',
      timeoutMs: 2_000,
      transport: cloudflareNativeRpc({ connectAbility: (input) => middle.connectAbility(input) }),
    });

    await expect(api.runFast({})).resolves.toEqual({ ok: true });

    // The middle service burned ~60ms of the caller's 2000ms before calling on, so the leaf must
    // start from visibly less than the original budget rather than a fresh one.
    expect(downstreamBudget).toBeDefined();
    expect(downstreamBudget as number).toBeLessThanOrEqual(2_000 - 30);
    expect(downstreamBudget as number).toBeGreaterThan(0);
  });
});
