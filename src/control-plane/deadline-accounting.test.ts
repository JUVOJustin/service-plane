import { newHttpBatchRpcSession } from 'capnweb';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { type AbilityRpc, abilityMethod, defineAbility } from '../service/discovery.js';
import { defineCapabilities, RpcTarget, ServicePlaneService } from '../service/index.js';
import { SERVICE_PLANE_TIMEOUT_HEADER } from '../shared/deadline.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

const PLANE_ORIGIN = 'https://plane.internal';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const capabilities = defineCapabilities({ scopes: [{ id: 'example.work.run' }], serviceId: 'example' });

const workAbility = defineAbility({
  id: 'example.work',
  methods: {
    runFast: abilityMethod({
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      scopes: ['example.work.run'],
    }),
  },
  rpc: { transports: ['http-batch'] },
  scopes: ['example.work.run'],
  handler: () => {
    class WorkApi extends RpcTarget {
      async runFast() {
        return { ok: true as const };
      }
    }
    return new WorkApi() as WorkApi & Record<string, unknown>;
  },
});

// How long the plane is made to spend before it opens the service leg. Chosen far above timer
// jitter so the assertion is about accounting, not scheduling noise.
const PLANE_WORK_MS = 120;
const CALLER_BUDGET_MS = 5_000;

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

async function planeForwardingTimeout(): Promise<string | null> {
  const secret = await generateCapabilitySigningSecret();
  let plane: ServicePlaneControlPlane | undefined;
  const service = new ServicePlaneService({
    abilities: [workAbility],
    // Verifies against the plane's own JWKS, so the whole chain runs on real time rather than a
    // pinned clock — this test is about elapsed time.
    auth: {
      controlPlaneBinding: () => ({ fetch: async (request: Request) => (plane as ServicePlaneControlPlane).fetch(request) }),
      issuer: PLANE_ORIGIN,
    },
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
  });

  let forwarded: string | null = null;
  const endpoint = cloudflareServiceBinding({
    binding: {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/rpc/example.work') forwarded = request.headers.get(SERVICE_PLANE_TIMEOUT_HEADER);
        return service.fetch(request);
      },
    },
    grants: [{ caller: 'gateway', scopes: ['example.work.run'] }],
    id: 'example',
  });

  plane = new ServicePlaneControlPlane({
    broker: { caller: () => ({ id: 'gateway', kind: 'service' }) },
    discoveryCache: false,
    issuer: PLANE_ORIGIN,
    log: false,
    // Stands in for the discovery fan-out on a cold cache: real plane work, before the broker
    // exists, that the caller is already waiting through.
    services: async () => {
      await sleep(PLANE_WORK_MS);
      return [endpoint];
    },
    signingKeys: () => [{ kid: 'k1', secret }],
  });

  const originalFetch = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    // capnweb sends the batch as fetch(templateRequest, { method, body }); the init carries the
    // body, so it must not be dropped when the first argument is already a Request.
    return (plane as ServicePlaneControlPlane).fetch(new Request(input as RequestInfo, init));
  }) as typeof fetch;

  const root = newHttpBatchRpcSession<Record<string, never>>(
    new Request(`${PLANE_ORIGIN}/rpc/broker`, {
      headers: { [SERVICE_PLANE_TIMEOUT_HEADER]: String(CALLER_BUDGET_MS) },
      method: 'POST',
    }),
  ) as unknown as {
    ability(serviceId: string, abilityId: string): { connect(scopes: string[]): AbilityRpc<typeof workAbility> };
  };

  await root.ability('example', 'example.work').connect(['example.work.run']).runFast({});
  return forwarded;
}

describe('control-plane deadline accounting', () => {
  it('charges the caller for the plane work that happens before the broker exists', async () => {
    const forwarded = await planeForwardingTimeout();

    expect(forwarded).not.toBeNull();
    const remaining = Number(forwarded);
    // The plane spent PLANE_WORK_MS resolving its catalog. That time is the caller's, so the budget
    // reaching the service must be visibly smaller — not the untouched number the caller sent.
    expect(remaining).toBeLessThanOrEqual(CALLER_BUDGET_MS - PLANE_WORK_MS / 2);
    expect(remaining).toBeGreaterThan(0);
  });
});
