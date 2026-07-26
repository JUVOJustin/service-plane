import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, RpcTarget, requireScopes } from '../service/index.js';
import { DEMO_CALLER_ID, type DemoApp, type DemoServiceSpec, demoApp, demoEnvironments } from '../test-support/index.js';

// The same two-service plane, deployed through every transport the package supports. Single-service
// fixtures pinned to one transport are how a plane-wide coupling bug (#24) stayed invisible; this
// sweeps both dimensions so a regression has nowhere to hide.
type EchoApiShape = { echo(input: { value: string }): Promise<{ caller: string; service: string; value: string }> };

describe.each(demoEnvironments())('two-service plane over $name', (env) => {
  let app: DemoApp | undefined;

  afterEach(() => {
    app?.close();
    app = undefined;
  });

  const start = async () => {
    app = await demoApp({ env, services: [echoService('inventory'), echoService('billing')] });
    return app;
  };

  it('issues, brokers, and projects each service independently', async () => {
    const plane = await start();

    for (const serviceId of ['inventory', 'billing']) {
      const token = await plane.token({ scopes: [`${serviceId}.echo`], targetServiceId: serviceId });
      expect(token.status).toBe(200);

      await expect(brokered(plane, serviceId)).resolves.toMatchObject({ caller: 'control-plane', service: serviceId });
      await expect(direct(plane, serviceId)).resolves.toMatchObject({ caller: DEMO_CALLER_ID, service: serviceId });
    }

    const tools = await plane.mcp({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} });
    const listed = ((await tools.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    expect(listed.sort()).toEqual(['billing_echo', 'inventory_echo']);
  });

  it('scopes a grant to its own target', async () => {
    const plane = await start();

    // `inventory`'s grant says nothing about `billing`'s scope, and vice versa.
    const crossed = await plane.token({ scopes: ['billing.echo'], targetServiceId: 'inventory' });
    expect(crossed.status).toBe(403);
    await expect(crossed.json()).resolves.toEqual({ error: 'Service-Plane capability grant denied' });
  });

  it('confines an outage to the service that is down', async () => {
    const plane = await start();
    plane.setAvailable('billing', false);

    await expect(brokered(plane, 'inventory')).resolves.toMatchObject({ service: 'inventory' });
    expect((await plane.token({ scopes: ['inventory.echo'], targetServiceId: 'inventory' })).status).toBe(200);

    const down = await plane.token({ scopes: ['billing.echo'], targetServiceId: 'billing' });
    expect(down.status).toBe(500);
    await expect(down.json()).resolves.toEqual({ error: 'Unknown Service-Plane capability target: billing' });
  });

  it('picks up a new ability the moment a service redeploys', async () => {
    const plane = await start();

    const before = await plane.mcp({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} });
    const beforeNames = ((await before.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(beforeNames).not.toContain('inventory_audit');

    plane.redeploy('inventory', { abilities: echoService('inventory', { withAudit: true }).abilities, version: '2.0.0' });

    const after = await plane.mcp({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} });
    const afterNames = ((await after.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(afterNames).toContain('inventory_audit');
    // The redeploy is invisible to the other service.
    expect(afterNames).toContain('billing_echo');
  });
});

function brokered(app: DemoApp, serviceId: string) {
  return app
    .brokerRoot<EchoApiShape>()
    .ability(serviceId, `${serviceId}.echo`)
    .connect([`${serviceId}.echo`])
    .echo({ value: 'ping' });
}

function direct(app: DemoApp, serviceId: string) {
  return app
    .session<EchoApiShape>(serviceId, `${serviceId}.echo`, [`${serviceId}.echo`])
    .then((session) => session.echo({ value: 'ping' }));
}

class EchoApi extends RpcTarget {
  constructor(private readonly serviceId: string) {
    super();
  }

  async echo(input: { value: string }) {
    const caller = requireScopes(this, `${this.serviceId}.echo`);
    return { caller: caller.serviceId, service: this.serviceId, value: input.value };
  }

  async audit(_input: Record<string, never>) {
    requireScopes(this, `${this.serviceId}.echo`);
    return { entries: 0 };
  }
}

function echoService(serviceId: string, options: { withAudit?: boolean } = {}): DemoServiceSpec {
  const scope = `${serviceId}.echo`;
  return {
    abilities: ({ transports }) => [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: `${serviceId}.echo`,
        methods: {
          echo: abilityMethod({
            input: z.object({ value: z.string() }),
            mcp: { name: `${serviceId}_echo` },
            output: z.object({ caller: z.string(), service: z.string(), value: z.string() }),
            scopes: [scope],
          }),
          ...(options.withAudit
            ? {
                audit: abilityMethod({
                  input: z.object({}),
                  mcp: { name: `${serviceId}_audit` },
                  output: z.object({ entries: z.number() }),
                  scopes: [scope],
                }),
              }
            : {}),
        },
        rpc: { transports },
        scopes: [scope],
        handler: () => new EchoApi(serviceId) as EchoApi & Record<string, unknown>,
      }),
    ],
    id: serviceId,
    scopes: [scope],
  };
}
