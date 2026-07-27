import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, RpcTarget, requireScopes } from '../service/index.js';
import { decodeServicePlaneJwkToken } from '../shared/jwk-auth.js';
import {
  DEMO_SIGNING_KEY_ID,
  type DemoApp,
  type DemoServiceSpec,
  demoApp,
  demoEnvironments,
  demoSigningKey,
} from '../test-support/index.js';

// Zero-downtime signing-key rotation, walked one stage at a time (#16). Each stage is the state a
// real fleet is actually in for some window, so each gets its own assertion rather than being
// collapsed into "rotate, then call once".
//
// The sequence a rotation follows:
//   1. prepare  — publish the new key alongside the old; keep signing with the old.
//   2. mixed    — a rolling deploy has restarted some replicas but not others.
//   3. activate — every replica signs with the new key; the old stays published.
//   4. complete — drop the old key once the overlap window has passed.
type EchoApiShape = { echo(input: { value: string }): Promise<{ caller: string; value: string }> };

const OLD_KEY_ID = DEMO_SIGNING_KEY_ID;
const NEW_KEY_ID = 'demo-key-2';

describe.each(demoEnvironments())('signing-key rotation over $name', (env) => {
  let app: DemoApp | undefined;

  afterEach(() => {
    app?.close();
    app = undefined;
  });

  const start = async (options: { cacheJwks?: boolean; replicas?: number } = {}) => {
    app = await demoApp({
      env,
      services: [echoService()],
      ...(options.cacheJwks ? { cacheJwks: true } : {}),
      ...(options.replicas ? { replicas: options.replicas } : {}),
    });
    return app;
  };

  it('publishes both keys and keeps signing with the old one while preparing', async () => {
    const plane = await start();
    const next = await demoSigningKey(NEW_KEY_ID);
    const old = plane.replica(0).signingKeys();

    // Preparation appends: the new key becomes verifiable everywhere before anything signs with it.
    plane.replica(0).setSigningKeys([...old, next]);

    expect(await keyIds(plane)).toEqual([OLD_KEY_ID, NEW_KEY_ID]);
    expect(await signingKeyId(plane)).toBe(OLD_KEY_ID);
    await expect(call(plane)).resolves.toMatchObject({ value: 'ping' });
  });

  it('accepts tokens from both replicas midway through a rolling deploy', async () => {
    const plane = await start({ replicas: 2 });
    const next = await demoSigningKey(NEW_KEY_ID);
    const old = plane.replica(0).signingKeys();

    // Replica 0 has restarted onto the new configuration; replica 1 has not. Both are serving.
    plane.replica(0).setSigningKeys([next, ...old]);
    plane.replica(1).setSigningKeys([...old, next]);

    expect(await signingKeyIdOf(plane, 0)).toBe(NEW_KEY_ID);
    expect(await signingKeyIdOf(plane, 1)).toBe(OLD_KEY_ID);

    // Whichever replica signs, whichever replica's JWKS the service happens to read, the call works.
    for (const replica of [0, 1]) {
      plane.route(replica);
      await expect(call(plane)).resolves.toMatchObject({ caller: 'control-plane', value: 'ping' });
    }
  });

  it('signs only with the new key once every replica has activated it', async () => {
    const plane = await start({ replicas: 2 });
    const next = await demoSigningKey(NEW_KEY_ID);
    const old = plane.replica(0).signingKeys();

    for (const replica of plane.replicas) replica.setSigningKeys([next, ...old]);

    expect(await keyIds(plane)).toEqual([NEW_KEY_ID, OLD_KEY_ID]);
    for (const replica of [0, 1]) {
      plane.route(replica);
      expect(await signingKeyId(plane)).toBe(NEW_KEY_ID);
      await expect(call(plane)).resolves.toMatchObject({ value: 'ping' });
    }
  });

  it('invalidates tokens signed with the old key only after it is dropped', async () => {
    const plane = await start();
    const next = await demoSigningKey(NEW_KEY_ID);
    const old = plane.replica(0).signingKeys();

    // Minted while the old key was still active — the token this whole overlap exists to protect.
    const beforeRotation = await token(plane);

    plane.replica(0).setSigningKeys([next, ...old]);
    await expect(callWith(plane, beforeRotation)).resolves.toMatchObject({ value: 'ping' });

    // Completion. Past this point the old token is refused, which is the intended end state.
    plane.replica(0).setSigningKeys([next]);
    expect(await keyIds(plane)).toEqual([NEW_KEY_ID]);
    await expect(callWith(plane, beforeRotation)).rejects.toThrow(/Unknown Service-Plane capability key id/u);
  });

  it('survives a service whose cached JWKS predates the rotation', async () => {
    const plane = await start({ cacheJwks: true });
    const next = await demoSigningKey(NEW_KEY_ID);
    const old = plane.replica(0).signingKeys();

    // Warm the service's JWKS cache while only the old key exists.
    await expect(call(plane)).resolves.toMatchObject({ value: 'ping' });

    // Activating before the cached copy expires is the mistake the overlap window prevents: the
    // service is still holding a JWKS that has never seen the new key id.
    plane.replica(0).setSigningKeys([next, ...old]);
    await expect(call(plane)).rejects.toThrow(/Unknown Service-Plane capability key id/u);

    // Once the cache TTL lapses the service picks up both keys and recovers on its own.
    plane.refreshJwks();
    await expect(call(plane)).resolves.toMatchObject({ value: 'ping' });
  });

  it('rolls back by making the old key active again', async () => {
    const plane = await start();
    const next = await demoSigningKey(NEW_KEY_ID);
    const old = plane.replica(0).signingKeys();

    plane.replica(0).setSigningKeys([next, ...old]);
    const afterRotation = await token(plane);
    expect(await signingKeyId(plane)).toBe(NEW_KEY_ID);

    // Rollback is a reorder, not a redeploy: both keys stay published, so tokens minted during the
    // failed rotation keep working while the fleet returns to the old signing key.
    plane.replica(0).setSigningKeys([...old, next]);
    expect(await signingKeyId(plane)).toBe(OLD_KEY_ID);
    await expect(callWith(plane, afterRotation)).resolves.toMatchObject({ value: 'ping' });
    await expect(call(plane)).resolves.toMatchObject({ value: 'ping' });
  });

  it('refuses a key set a verifier could not tell apart', async () => {
    const plane = await start();
    const [old] = plane.replica(0).signingKeys();
    if (!old) throw new Error('expected a demo signing key');

    // Rotating the secret while keeping the key id is the dangerous shape: a verifier holding a
    // cached JWKS would pick the stale key for this id and report a signature failure instead.
    plane.replica(0).setSigningKeys([{ kid: OLD_KEY_ID, secret: (await demoSigningKey('x')).secret }, old]);

    const response = await plane.token({ scopes: ['demo.echo'], targetServiceId: 'demo' });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: `Duplicate Service-Plane signing key id: ${OLD_KEY_ID}` });
  });
});

async function keyIds(app: DemoApp): Promise<Array<string | undefined>> {
  return (await app.replica(0).jwks()).keys.map((key) => key.kid);
}

async function token(app: DemoApp): Promise<string> {
  const response = await app.token({ scopes: ['demo.echo'], targetServiceId: 'demo' });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

async function signingKeyId(app: DemoApp): Promise<string> {
  return (decodeServicePlaneJwkToken(await token(app), 'unreadable').header as { kid: string }).kid;
}

async function signingKeyIdOf(app: DemoApp, replica: number): Promise<string> {
  const response = await app.replica(replica).token({ scopes: ['demo.echo'], targetServiceId: 'demo' });
  const issued = ((await response.json()) as { token: string }).token;
  return (decodeServicePlaneJwkToken(issued, 'unreadable').header as { kid: string }).kid;
}

// Brokered, so the token the plane just minted is the one the service verifies on this call.
function call(app: DemoApp) {
  return app.brokerRoot<EchoApiShape>().ability('demo', 'demo.echo').connect(['demo.echo']).echo({ value: 'ping' });
}

// The direct caller leg driven by a token captured earlier — the only way to present a token minted
// before a rotation to the service's current view of the JWKS.
async function callWith(app: DemoApp, issued: string) {
  const session = await app.sessionWith<EchoApiShape>({
    abilityId: 'demo.echo',
    scopes: ['demo.echo'],
    serviceId: 'demo',
    token: issued,
  });
  return session.echo({ value: 'ping' });
}

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
