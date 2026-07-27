import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, RpcTarget, requireScopes } from '../service/index.js';
import {
  DEMO_SIGNING_KEY_ID,
  type DemoApp,
  type DemoServiceSpec,
  demoApp,
  demoEnvironments,
  demoSigningKey,
} from '../test-support/index.js';
import { memoryRegistryCache } from '../testing/memory-cache.js';

// The horizontal-scaling contract (#21): two independent control-plane replicas serving one
// deployment. Every replica here is its own `ServicePlaneControlPlane` with its own issuer object,
// registry, and OpenAPI cache — nothing but configuration is shared, which is what an autoscaled
// Cloudflare plane or a load-balanced on-prem pair actually have in common.
type EchoApiShape = { echo(input: { value: string }): Promise<{ caller: string; value: string }> };

describe.each(demoEnvironments())('control-plane replicas over $name', (env) => {
  let app: DemoApp | undefined;

  afterEach(() => {
    app?.close();
    app = undefined;
  });

  const start = async (replicas: DemoAppReplicas = 2) => {
    app = await demoApp({ env, replicas, services: [echoService()] });
    return app;
  };

  it('verifies a token issued by one replica against JWKS served by the other', async () => {
    const plane = await start();

    const issued = await tokenFrom(plane, 0);
    // Replica 1 never saw the issuance, and its JWKS is derived independently from configuration.
    const jwks = await plane.replica(1).jwks();

    const { verifyCapabilityToken } = await import('../shared/capability-tokens.js');
    await expect(
      verifyCapabilityToken(issued, {
        expectedAudience: 'demo',
        issuer: 'https://plane.internal',
        jwks,
        requiredScopes: ['demo.echo'],
      }),
    ).resolves.toMatchObject({ serviceId: 'workflow-runner' });
  });

  it('publishes byte-identical JWKS from every replica on the same configuration', async () => {
    const plane = await start();

    const [first, second] = await Promise.all([plane.replica(0).jwks(), plane.replica(1).jwks()]);
    expect(first).toEqual(second);
    expect(first.keys.map((key) => key.kid)).toEqual([DEMO_SIGNING_KEY_ID]);
  });

  it('brokers identically whichever replica the load balancer picks', async () => {
    const plane = await start();

    // Alternating mid-flight is the normal case behind a round-robin balancer, not an edge case.
    for (const replica of [0, 1, 0, 1]) {
      plane.route(replica);
      await expect(brokered(plane)).resolves.toMatchObject({ caller: 'control-plane', value: 'ping' });
    }

    // And a denial is a denial on both: authorization comes from the shared grant configuration,
    // never from whatever the local replica happens to have cached.
    for (const replica of [0, 1]) {
      plane.route(replica);
      const denied = await plane.token({ scopes: ['demo.admin'], targetServiceId: 'demo' });
      expect(denied.status).toBe(403);
    }
  });

  it('keeps a stale local registry cache from outliving the ability it cached', async () => {
    // Replica 0 caches discovery; replica 1 never does. Once the service drops the ability the two
    // genuinely disagree about the catalog — replica 0 still holds a snapshot that says the ability
    // is there. The service is the only authority on what it currently exposes, so the stale
    // snapshot must not be enough to reach a withdrawn ability.
    app = await demoApp({ env, replicas: [{ registryCache: memoryRegistryCache() }, {}], services: [echoService()] });
    const plane = app;

    plane.route(0);
    await expect(brokered(plane)).resolves.toMatchObject({ value: 'ping' });

    // Withdrawn: the service redeploys with `demo.echo` replaced, while replica 0's cache still
    // lists it. A service must keep at least one ability, so the swap is the withdrawal.
    plane.redeploy('demo', { abilities: replacementAbilities, version: '2.0.0' });

    for (const replica of [0, 1]) {
      plane.route(replica);
      await expect(brokered(plane)).rejects.toThrow();
    }
  });

  it('keeps divergent local caches from widening what a replica will authorize', async () => {
    app = await demoApp({ env, replicas: [{ registryCache: memoryRegistryCache() }, {}], services: [echoService()] });
    const plane = app;

    plane.route(0);
    await expect(brokered(plane)).resolves.toMatchObject({ value: 'ping' });

    // Authorization is decided from the plane's grants, not from whatever snapshot the local
    // replica happens to be holding, so both replicas refuse an ungranted scope identically.
    plane.setGrants('demo', [{ caller: 'control-plane', scopes: ['demo.echo'] }]);
    for (const replica of [0, 1]) {
      plane.route(replica);
      const denied = await plane.token({ scopes: ['demo.admin'], targetServiceId: 'demo' });
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({ error: 'Service-Plane capability grant denied' });
    }
  });

  it('refuses a replica whose issuer disagrees with the fleet', async () => {
    app = await demoApp({
      env,
      replicas: [{}, { issuer: 'https://impostor.internal' }],
      services: [echoService()],
    });
    const plane = app;

    plane.route(0);
    await expect(brokered(plane)).resolves.toMatchObject({ value: 'ping' });

    // Services pin the issuer they trust, so the divergent replica fails closed rather than
    // silently minting tokens the rest of the fleet would not honour.
    plane.route(1);
    await expect(brokered(plane)).rejects.toThrow(/Invalid Service-Plane capability issuer/u);
  });

  it('refuses a replica signing with a key the fleet does not publish', async () => {
    const rogue = await demoSigningKey('rogue-key');
    // `cacheJwks` pins what the service believes: it holds the fleet's JWKS, as a real service does
    // between refreshes. That separation matters — a replica that also serves the JWKS a service
    // reads is trusted by definition, so the misconfiguration only bites when the two disagree.
    app = await demoApp({ cacheJwks: true, env, replicas: [{}, { signingKeys: [rogue] }], services: [echoService()] });
    const plane = app;

    plane.route(0);
    await expect(brokered(plane)).resolves.toMatchObject({ value: 'ping' });

    // The divergent replica joins the fleet. Its key id was never published to this service, so its
    // tokens are refused outright rather than being accepted on a signature the service cannot check.
    plane.route(1);
    await expect(brokered(plane)).rejects.toThrow(/Unknown Service-Plane capability key id/u);

    plane.route(0);
    await expect(brokered(plane)).resolves.toMatchObject({ value: 'ping' });
  });

  it('fails a session pinned to a replica that disappears, without failing the fleet', async () => {
    const plane = await start();

    // A brokered call is bound to the replica that serves it. HTTP-batch carries no cross-request
    // session state, which is precisely why the fleet is safe to load-balance — and why losing a
    // replica costs the in-flight call rather than the caller's ability to keep working.
    await expect(brokeredOn(plane, 0)).resolves.toMatchObject({ value: 'ping' });

    plane.setReplicaAvailable(0, false);
    await expect(brokeredOn(plane, 0)).rejects.toThrow();

    // The balancer routes around it and the surviving replica serves the same deployment.
    await expect(brokeredOn(plane, 1)).resolves.toMatchObject({ value: 'ping' });
    plane.route('round-robin');
    await expect(brokered(plane)).resolves.toMatchObject({ value: 'ping' });
  });

  // Replay protection is stateless by design: PR #23 removed the replay cache in favour of
  // sender-constrained tokens, so there is deliberately no shared store for replicas to agree on.
  // The property that replaces it is that a captured token is refused by *any* replica's chain
  // without the caller's proof — which needs no coordination between replicas at all.
  it('needs no shared replay state to refuse a token replayed at another replica', async () => {
    const plane = await start();

    const captured = await tokenFrom(plane, 0);
    // Presented verbatim to the other replica's view of the world, by a caller that cannot produce
    // the confirmation the token would carry if it were sender-constrained.
    plane.route(1);
    const session = await plane.sessionWith<EchoApiShape>({
      abilityId: 'demo.echo',
      scopes: ['demo.echo'],
      serviceId: 'demo',
      token: captured,
    });

    // Bearer tokens remain usable by design; what matters is that the decision is identical on both
    // replicas and reached without either consulting shared state.
    await expect(session.echo({ value: 'ping' })).resolves.toMatchObject({ caller: 'workflow-runner' });
    const tampered = tamperSignature(captured);
    await expect(
      plane
        .sessionWith<EchoApiShape>({ abilityId: 'demo.echo', scopes: ['demo.echo'], serviceId: 'demo', token: tampered })
        .then((s) => s.echo({ value: 'ping' })),
    ).rejects.toThrow(/Invalid Service-Plane capability signature/u);
  });
});

type DemoAppReplicas = NonNullable<Parameters<typeof demoApp>[0]['replicas']>;

async function tokenFrom(app: DemoApp, replica: number): Promise<string> {
  const response = await app.replica(replica).token({ scopes: ['demo.echo'], targetServiceId: 'demo' });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

// Corrupts the signature so verification must fail. Rewriting the *tail* is not enough: a 64-byte
// ES256 signature is 86 base64url characters (516 bits carrying 512), so the final character owns
// only two significant bits and the decoder discards the rest — a rewritten tail decoded back to
// the identical signature roughly 1 run in 230, which is what made this test flaky. The first
// character owns six full bits of the first byte, so changing it always changes the signature.
function tamperSignature(token: string): string {
  const lastDot = token.lastIndexOf('.');
  const signature = token.slice(lastDot + 1);
  return `${token.slice(0, lastDot + 1)}${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
}

function brokered(app: DemoApp) {
  return app.brokerRoot<EchoApiShape>().ability('demo', 'demo.echo').connect(['demo.echo']).echo({ value: 'ping' });
}

// Bypasses the balancer so the call is pinned to one named replica.
function brokeredOn(app: DemoApp, replica: number) {
  return app.replica(replica).brokerRoot<EchoApiShape>().ability('demo', 'demo.echo').connect(['demo.echo']).echo({ value: 'ping' });
}

// The catalog after `demo.echo` is withdrawn: same service, same scope, different ability id.
const replacementAbilities: DemoServiceSpec['abilities'] = ({ transports }) => [
  defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'demo.successor',
    methods: {
      echo: abilityMethod({
        input: z.object({ value: z.string() }),
        output: z.object({ caller: z.string(), value: z.string() }),
        scopes: ['demo.echo'],
      }),
    },
    rpc: { transports },
    scopes: ['demo.echo'],
    handler: () => new EchoApi() as EchoApi & Record<string, unknown>,
  }),
];

class EchoApi extends RpcTarget {
  async echo(input: { value: string }) {
    const caller = requireScopes(this, 'demo.echo');
    return { caller: caller.serviceId, value: input.value };
  }
}

function echoService(): DemoServiceSpec {
  return {
    abilities: ({ transports }) => [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: 'demo.echo',
        methods: {
          echo: abilityMethod({
            input: z.object({ value: z.string() }),
            mcp: { name: 'demo_echo' },
            output: z.object({ caller: z.string(), value: z.string() }),
            scopes: ['demo.echo'],
          }),
        },
        rpc: { transports },
        scopes: ['demo.echo'],
        handler: () => new EchoApi() as EchoApi & Record<string, unknown>,
      }),
    ],
    id: 'demo',
    scopes: ['demo.echo'],
  };
}
