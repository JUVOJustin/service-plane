import { newHttpBatchRpcSession } from 'capnweb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import {
  abilityMethod,
  abilitySession,
  defineAbility,
  defineCapabilities,
  httpBatchRpc,
  RpcTarget,
  requireScopes,
  ServicePlaneService,
} from '../service/index.js';
import {
  type CapabilityJwks,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_MCP_PATH,
} from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

// One plane, two independently deployed services. `beta` is redeployed mid-test with a renamed
// scope while the plane still grants the old name — the drift window described in
// docs/cloudflare.md#staleness-after-a-service-deploy. Everything `alpha` offers must keep working.
const PLANE_ISSUER = 'https://plane.internal';
const PLANE_ORIGIN = 'https://plane.internal';
const CALLER_ID = 'workflow-runner';

describe('one plane, two services, one upgraded', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a healthy service issuable while another service renames a granted scope', async () => {
    const plane = await deployPlane();

    // Before the upgrade both services work end to end.
    await expect(plane.callDirect('alpha')).resolves.toMatchObject({ caller: CALLER_ID, service: 'alpha' });
    await expect(plane.callDirect('beta')).resolves.toMatchObject({ caller: CALLER_ID, service: 'beta' });

    // `beta` deploys: `beta.run` becomes `beta.execute`. The plane's grant still says `beta.run`.
    plane.upgradeBeta('beta.execute');

    const alphaToken = await plane.requestToken({ scopes: ['alpha.run'], targetServiceId: 'alpha' });
    expect(alphaToken.status).toBe(200);
    await expect(alphaToken.json()).resolves.toMatchObject({ token: expect.any(String) });
    await expect(plane.callDirect('alpha')).resolves.toMatchObject({ caller: CALLER_ID, service: 'alpha' });

    // The affected target still fails, loudly and specifically — not as a silent "no grant" 403.
    const betaToken = await plane.requestToken({ scopes: ['beta.run'], targetServiceId: 'beta' });
    expect(betaToken.status).toBe(500);
    await expect(betaToken.json()).resolves.toEqual({ error: 'Unknown Service-Plane capability scope: beta.run' });
  });

  it('keeps broker and MCP working for a healthy service while another service is undiscoverable', async () => {
    const plane = await deployPlane();

    // `beta` is mid-rollout and answers nothing, so the discovered catalog has no entry for it.
    plane.setBetaAvailable(false);

    await expect(plane.callBrokered('alpha')).resolves.toMatchObject({ caller: 'control-plane', service: 'alpha' });

    const tools = await plane.mcp({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} });
    expect(((await tools.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual([
      'alpha_run',
    ]);

    const called = await plane.mcp({
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { job: 'nightly' }, name: 'alpha_run' },
    });
    await expect(called.json()).resolves.toMatchObject({
      result: { structuredContent: { caller: 'control-plane', job: 'nightly', service: 'alpha' } },
    });

    const alphaToken = await plane.requestToken({ scopes: ['alpha.run'], targetServiceId: 'alpha' });
    expect(alphaToken.status).toBe(200);

    const betaToken = await plane.requestToken({ scopes: ['beta.run'], targetServiceId: 'beta' });
    expect(betaToken.status).toBe(500);
    await expect(betaToken.json()).resolves.toEqual({ error: 'Unknown Service-Plane capability target: beta' });
  });

  it('brokers and projects the upgraded service again once its grant catches up', async () => {
    const plane = await deployPlane();
    plane.upgradeBeta('beta.execute');

    const stale = await plane.mcp({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { job: 'nightly' }, name: 'beta_run' },
    });
    await expect(stale.json()).resolves.toMatchObject({
      error: { data: { status: 500 }, message: 'Unknown Service-Plane capability scope: beta.run' },
    });

    // The plane's grant is updated to the new scope name; no other service was touched.
    plane.regrantBeta('beta.execute');

    await expect(plane.callBrokered('beta')).resolves.toMatchObject({ caller: 'control-plane', service: 'beta' });
    await expect(plane.callBrokered('alpha')).resolves.toMatchObject({ caller: 'control-plane', service: 'alpha' });
  });
});

class JobsApi extends RpcTarget {
  constructor(
    private readonly scopeId: string,
    private readonly serviceId: string,
  ) {
    super();
  }

  async run(input: { job: string }) {
    const caller = requireScopes(this, this.scopeId);
    return { caller: caller.serviceId, job: input.job, service: this.serviceId };
  }
}

type BrokerPipeline = {
  ability(serviceId: string, abilityId: string): { connect(scopes: string[]): { run(input: { job: string }): Promise<unknown> } };
};

type DeployedPlane = {
  callBrokered(serviceId: string): Promise<unknown>;
  callDirect(serviceId: string): Promise<unknown>;
  mcp(body: unknown): Promise<Response>;
  regrantBeta(scopeId: string): void;
  requestToken(input: { scopes: string[]; targetServiceId: string }): Promise<Response>;
  setBetaAvailable(available: boolean): void;
  upgradeBeta(scopeId: string): void;
};

async function deployPlane(): Promise<DeployedPlane> {
  const signingSecret = await generateCapabilitySigningSecret();
  let plane: ServicePlaneControlPlane | undefined;
  const jwks = async () => {
    if (!plane) throw new Error('Control plane is not initialized');
    const response = await plane.fetch(new Request(`${PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    return response.json() as Promise<CapabilityJwks>;
  };

  const alpha = createService({ jwks, scopeId: 'alpha.run', serviceId: 'alpha', version: '1.0.0' });
  let beta = createService({ jwks, scopeId: 'beta.run', serviceId: 'beta', version: '1.0.0' });
  let betaAvailable = true;
  let betaGrantedScope = 'beta.run';

  plane = new ServicePlaneControlPlane({
    // Caller authentication has its own coverage; this test is about what one service's catalog
    // does to every other service's issuance.
    authenticateCaller: () => CALLER_ID,
    broker: { caller: () => ({ id: 'gateway', kind: 'user' }) },
    issuer: PLANE_ISSUER,
    log: false,
    mcp: { caller: () => ({ id: 'gateway', kind: 'user' }) },
    services: () => [
      cloudflareServiceBinding({
        binding: { fetch: async (request) => alpha.fetch(request) },
        grants: [
          { caller: CALLER_ID, scopes: ['alpha.run'] },
          { caller: 'control-plane', scopes: ['alpha.run'] },
        ],
        id: 'alpha',
        origin: 'https://alpha.internal',
      }),
      cloudflareServiceBinding({
        binding: {
          fetch: async (request) => (betaAvailable ? beta.fetch(request) : new Response('Service Unavailable', { status: 503 })),
        },
        grants: [
          { caller: CALLER_ID, scopes: [betaGrantedScope] },
          { caller: 'control-plane', scopes: [betaGrantedScope] },
        ],
        id: 'beta',
        origin: 'https://beta.internal',
      }),
    ],
    signingSecret: () => signingSecret,
  });
  const deployed = plane;

  // Route the in-memory hosts through global fetch so the capnweb HTTP-batch clients — the caller's
  // own leg to the broker, and a direct ability session — reach them over the real wire shape.
  const origins: Record<string, { fetch(request: Request): Promise<Response> }> = {
    'alpha.internal': { fetch: async (request) => alpha.fetch(request) },
    'beta.internal': { fetch: async (request) => (betaAvailable ? beta.fetch(request) : new Response(null, { status: 503 })) },
    'plane.internal': { fetch: async (request) => deployed.fetch(request) },
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const host = origins[new URL(request.url).hostname];
    if (!host) throw new Error(`Unknown host: ${request.url}`);
    return host.fetch(request);
  });

  const requestToken = async (input: { scopes: string[]; targetServiceId: string }) =>
    deployed.fetch(
      new Request(`${PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

  return {
    async callBrokered(serviceId) {
      // One HTTP-batch round trip, so the whole chain stays pipelined in a single expression.
      const root = newHttpBatchRpcSession<Record<string, never>>(`${PLANE_ORIGIN}/rpc/broker`) as unknown as BrokerPipeline;
      const scope = serviceId === 'beta' ? betaGrantedScope : `${serviceId}.run`;
      return root.ability(serviceId, `${serviceId}.jobs`).connect([scope]).run({ job: 'nightly' });
    },

    async callDirect(serviceId) {
      const scope = serviceId === 'beta' ? betaGrantedScope : `${serviceId}.run`;
      const session = await abilitySession<{ run(input: { job: string }): Promise<unknown> }>({
        abilityId: `${serviceId}.jobs`,
        callerServiceId: CALLER_ID,
        requestToken: async (input) => {
          const response = await requestToken(input);
          const body = (await response.json()) as { error?: string; expiresAt: string; token: string };
          if (!response.ok) throw new Error(body.error ?? `Token request failed: ${response.status}`);
          return { expiresAt: new Date(body.expiresAt), token: body.token };
        },
        scopes: [scope],
        targetServiceId: serviceId,
        transport: httpBatchRpc(`https://${serviceId}.internal/rpc/${serviceId}.jobs`),
      });
      return session.run({ job: 'nightly' });
    },

    async mcp(body) {
      return deployed.fetch(
        new Request(`${PLANE_ORIGIN}${SERVICE_PLANE_MCP_PATH}`, {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
    },

    regrantBeta(scopeId) {
      betaGrantedScope = scopeId;
    },

    requestToken,

    setBetaAvailable(available) {
      betaAvailable = available;
    },

    upgradeBeta(scopeId) {
      beta = createService({ jwks, scopeId, serviceId: 'beta', version: '2.0.0' });
    },
  };
}

function createService(options: {
  jwks: () => Promise<CapabilityJwks>;
  scopeId: string;
  serviceId: string;
  version: string;
}): ServicePlaneService {
  const capabilities = defineCapabilities({ scopes: [{ id: options.scopeId }], serviceId: options.serviceId });
  return new ServicePlaneService({
    abilities: [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: `${options.serviceId}.jobs`,
        methods: {
          run: abilityMethod({
            input: z.object({ job: z.string() }),
            mcp: { name: `${options.serviceId}_run` },
            output: z.object({ caller: z.string(), job: z.string(), service: z.string() }),
            scopes: [options.scopeId],
          }),
        },
        scopes: [options.scopeId],
        handler: () => new JobsApi(options.scopeId, options.serviceId) as JobsApi & Record<string, unknown>,
      }),
    ],
    auth: {
      issuer: PLANE_ISSUER,
      jwks: options.jwks,
    },
    capabilities,
    id: options.serviceId,
    title: options.serviceId,
    version: options.version,
  });
}
