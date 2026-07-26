import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, RpcTarget, requireScopes } from '../service/index.js';
import { DEMO_CALLER_ID, type DemoApp, type DemoServiceSpec, demoApp } from '../test-support/index.js';

// One plane, two independently deployed services. `beta` is redeployed mid-test with a renamed
// scope while the plane still grants the old name — the drift window described in
// docs/cloudflare.md#staleness-after-a-service-deploy. Everything `alpha` offers must keep working.
type JobsApiShape = { run(input: { job: string }): Promise<{ caller: string; job: string; service: string }> };

describe('one plane, two services, one upgraded', () => {
  let app: DemoApp | undefined;

  afterEach(() => {
    app?.close();
    app = undefined;
  });

  it('keeps a healthy service issuable while another service renames a granted scope', async () => {
    app = await demoApp({ services: [jobsService('alpha', 'alpha.run'), jobsService('beta', 'beta.run')] });

    // Before the upgrade both services work end to end.
    await expect(runDirect(app, 'alpha', 'alpha.run')).resolves.toMatchObject({ caller: DEMO_CALLER_ID, service: 'alpha' });
    await expect(runDirect(app, 'beta', 'beta.run')).resolves.toMatchObject({ caller: DEMO_CALLER_ID, service: 'beta' });

    // `beta` deploys: `beta.run` becomes `beta.execute`. The plane's grant still says `beta.run`.
    app.redeploy('beta', { ...jobsService('beta', 'beta.execute'), version: '2.0.0' });

    const alphaToken = await app.token({ scopes: ['alpha.run'], targetServiceId: 'alpha' });
    expect(alphaToken.status).toBe(200);
    await expect(alphaToken.json()).resolves.toMatchObject({ token: expect.any(String) });
    await expect(runDirect(app, 'alpha', 'alpha.run')).resolves.toMatchObject({ caller: DEMO_CALLER_ID, service: 'alpha' });

    // The affected target still fails, loudly and specifically — not as a silent "no grant" 403.
    const betaToken = await app.token({ scopes: ['beta.run'], targetServiceId: 'beta' });
    expect(betaToken.status).toBe(500);
    await expect(betaToken.json()).resolves.toEqual({ error: 'Unknown Service-Plane capability scope: beta.run' });
  });

  it('keeps broker and MCP working for a healthy service while another service is undiscoverable', async () => {
    app = await demoApp({ services: [jobsService('alpha', 'alpha.run'), jobsService('beta', 'beta.run')] });

    // `beta` is mid-rollout and answers nothing, so the discovered catalog has no entry for it.
    app.setAvailable('beta', false);

    await expect(runBrokered(app, 'alpha', 'alpha.run')).resolves.toMatchObject({ caller: 'control-plane', service: 'alpha' });

    const tools = await app.mcp({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} });
    expect(((await tools.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)).toEqual([
      'alpha_run',
    ]);

    const called = await app.mcp({
      id: 2,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { job: 'nightly' }, name: 'alpha_run' },
    });
    await expect(called.json()).resolves.toMatchObject({
      result: { structuredContent: { caller: 'control-plane', job: 'nightly', service: 'alpha' } },
    });

    const alphaToken = await app.token({ scopes: ['alpha.run'], targetServiceId: 'alpha' });
    expect(alphaToken.status).toBe(200);

    const betaToken = await app.token({ scopes: ['beta.run'], targetServiceId: 'beta' });
    expect(betaToken.status).toBe(500);
    await expect(betaToken.json()).resolves.toEqual({ error: 'Unknown Service-Plane capability target: beta' });
  });

  it('brokers and projects the upgraded service again once its grant catches up', async () => {
    app = await demoApp({ services: [jobsService('alpha', 'alpha.run'), jobsService('beta', 'beta.run')] });
    app.redeploy('beta', { ...jobsService('beta', 'beta.execute'), version: '2.0.0' });

    const stale = await app.mcp({
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { job: 'nightly' }, name: 'beta_run' },
    });
    await expect(stale.json()).resolves.toMatchObject({
      error: { data: { status: 500 }, message: 'Unknown Service-Plane capability scope: beta.run' },
    });

    // The plane's grant is updated to the new scope name; no other service was touched.
    app.setGrants('beta', [
      { caller: DEMO_CALLER_ID, scopes: ['beta.execute'] },
      { caller: 'control-plane', scopes: ['beta.execute'] },
    ]);

    await expect(runBrokered(app, 'beta', 'beta.execute')).resolves.toMatchObject({ caller: 'control-plane', service: 'beta' });
    await expect(runBrokered(app, 'alpha', 'alpha.run')).resolves.toMatchObject({ caller: 'control-plane', service: 'alpha' });
  });
});

function runDirect(app: DemoApp, serviceId: string, scope: string) {
  return app.session<JobsApiShape>(serviceId, `${serviceId}.jobs`, [scope]).then((session) => session.run({ job: 'nightly' }));
}

function runBrokered(app: DemoApp, serviceId: string, scope: string) {
  return app.brokerRoot<JobsApiShape>().ability(serviceId, `${serviceId}.jobs`).connect([scope]).run({ job: 'nightly' });
}

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

function jobsService(serviceId: string, scopeId: string): DemoServiceSpec {
  return {
    abilities: ({ transports }) => [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: `${serviceId}.jobs`,
        methods: {
          run: abilityMethod({
            input: z.object({ job: z.string() }),
            mcp: { name: `${serviceId}_run` },
            output: z.object({ caller: z.string(), job: z.string(), service: z.string() }),
            scopes: [scopeId],
          }),
        },
        rpc: { transports },
        scopes: [scopeId],
        handler: () => new JobsApi(scopeId, serviceId) as JobsApi & Record<string, unknown>,
      }),
    ],
    id: serviceId,
    scopes: [scopeId],
  };
}
