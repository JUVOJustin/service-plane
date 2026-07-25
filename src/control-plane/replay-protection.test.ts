import { describe, expect, it } from 'vitest';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { signServicePlaneHmacRequest } from '../shared/hmac-auth.js';
import { signServicePlaneJwkRequest } from '../shared/jwk-auth.js';
import { SERVICE_PLANE_CAPABILITY_TOKEN_PATH, type ServiceDiscoveryDocument } from '../shared/types.js';
import {
  type HmacServiceClientAuthLogEvent,
  hmacServiceClientAuth,
  type JwkServiceClientAuthLogEvent,
  jwkServiceClientAuth,
  type ServicePlaneReplayCache,
} from './caller-auth.js';
import type { CallerAuthenticator } from './capabilities.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

// Every replica in these tests is a separate ServicePlaneControlPlane with its own authenticator and
// its own issuer state. Only what a deployment would actually share — the signing secret and, where
// the test says so, the replay store — is shared.
const CLIENT_SECRET = 'a'.repeat(43);
const NOW = new Date('2026-05-09T12:00:00.000Z');
const TOKEN_URL = `https://plane.internal${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`;

// Stands in for the shared atomic store a deployment would reach (Redis SET NX EX, a Durable
// Object): one JS task does the check and the write, so a single instance handed to several planes
// reserves each key exactly once. Only valid as a stand-in because every replica here is in-process.
function sharedReplayStore(now: () => number = () => Date.now()): ServicePlaneReplayCache {
  const expiresAt = new Map<string, number>();
  return {
    async reserve(key, ttlSeconds) {
      const existing = expiresAt.get(key);
      if (existing !== undefined && existing > now()) return false;
      expiresAt.set(key, now() + ttlSeconds * 1000);
      return true;
    },
  };
}

const discovery: ServiceDiscoveryDocument = {
  abilities: [
    {
      access: 'service',
      exposure: 'private',
      id: 'example.sync',
      methods: {
        runSync: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          scopes: ['example.sync.run'],
        },
      },
      rpc: { path: '/rpc/example.sync', transports: ['http-batch'] },
      scopes: ['example.sync.run'],
    },
  ],
  capabilities: { scopes: [{ id: 'example.sync.run' }], serviceId: 'example' },
  id: 'example',
  title: 'Example',
  version: '0.1.0',
};

describe('caller-auth replay protection across control-plane replicas', () => {
  it('rejects a captured HMAC request replayed against another replica through a shared atomic cache', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const replayCache = sharedReplayStore(() => NOW.getTime());
    const events: HmacServiceClientAuthLogEvent[] = [];
    const replicaA = hmacPlane(signingSecret, replayCache, events);
    const replicaB = hmacPlane(signingSecret, replayCache, events);

    const captured = await captureHmacRequest();
    const first = await replicaA.fetch(replay(captured));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ token: expect.any(String) });

    // Same bytes, different replica: the shared reservation already exists, so this copy loses.
    const replayed = await replicaB.fetch(replay(captured));
    expect(replayed.status).toBe(401);
    expect(events.map((event) => event.reason)).toEqual(['replayed_signature']);
  });

  it('rejects a captured JWK assertion replayed against another replica through a shared atomic cache', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const privateJwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    const publicJwk = publicJwkFromPrivateJwk(privateJwk, 'worker-a-key');
    const replayCache = sharedReplayStore(() => NOW.getTime());
    const events: JwkServiceClientAuthLogEvent[] = [];
    const jwkPlane = () =>
      controlPlane(
        signingSecret,
        jwkServiceClientAuth({
          clients: [{ clientId: 'worker-a', jwks: { keys: [publicJwk] } }],
          log: (event) => events.push(event),
          now: () => NOW,
          replayCache,
        }),
      );
    const replicaA = jwkPlane();
    const replicaB = jwkPlane();

    const captured = await captureJwkRequest(privateJwk);
    expect((await replicaA.fetch(replay(captured))).status).toBe(200);

    const replayed = await replicaB.fetch(replay(captured));
    expect(replayed.status).toBe(401);
    expect(events.map((event) => event.reason)).toEqual(['replayed_assertion']);
  });

  it('accepts the same request on both replicas when the store is not actually shared', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const events: HmacServiceClientAuthLogEvent[] = [];
    // Why the contract demands one authoritative store: give each replica its own and only the
    // replica that saw the first copy rejects the second, with nothing reporting the gap. Process
    // and isolate memory is exactly this, which is why it is not offered as a supported store.
    const replicaA = hmacPlane(
      signingSecret,
      sharedReplayStore(() => NOW.getTime()),
      events,
    );
    const replicaB = hmacPlane(
      signingSecret,
      sharedReplayStore(() => NOW.getTime()),
      events,
    );

    const captured = await captureHmacRequest();
    expect((await replicaA.fetch(replay(captured))).status).toBe(200);
    expect((await replicaB.fetch(replay(captured))).status).toBe(200);
    expect(events).toEqual([]);

    // The same replica still rejects its own second copy.
    expect((await replicaA.fetch(replay(captured))).status).toBe(401);
    expect(events.map((event) => event.reason)).toEqual(['replayed_signature']);
  });

  it('accepts exactly one of two concurrent copies racing two replicas', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const events: HmacServiceClientAuthLogEvent[] = [];
    const inner = sharedReplayStore(() => NOW.getTime());
    // Holds every reservation until both replicas have asked, so the two calls genuinely overlap
    // instead of completing one after the other. A read-then-write store would let both through
    // here; an atomic reserve() cannot, which is why it is the only accepted shape.
    let arrived = 0;
    let bothArrived: () => void = () => {
      throw new Error('barrier not initialized');
    };
    const barrier = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const replayCache: ServicePlaneReplayCache = {
      async reserve(key, ttlSeconds) {
        arrived += 1;
        if (arrived >= 2) bothArrived();
        await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 100))]);
        return inner.reserve(key, ttlSeconds);
      },
    };
    const replicaA = hmacPlane(signingSecret, replayCache, events);
    const replicaB = hmacPlane(signingSecret, replayCache, events);

    const captured = await captureHmacRequest();
    const statuses = (await Promise.all([replicaA.fetch(replay(captured)), replicaB.fetch(replay(captured))]))
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([200, 401]);
    expect(events.map((event) => event.reason)).toEqual(['replayed_signature']);
  });

  it('holds an HMAC reservation until a future-dated request stops being acceptable', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const events: HmacServiceClientAuthLogEvent[] = [];
    let clock = NOW.getTime();
    const replayCache = sharedReplayStore(() => clock);
    const plane = controlPlane(
      signingSecret,
      hmacServiceClientAuth({
        clients: [{ clientId: 'worker-a', secret: CLIENT_SECRET }],
        log: (event) => events.push(event),
        now: () => new Date(clock),
        replayCache,
      }),
    );
    // The skew check is symmetric, so a timestamp this far ahead is accepted and stays acceptable
    // until 60s *after* it — later than the moment the reservation was taken.
    const captured = await captureHmacRequest(new Date(NOW.getTime() + 60_000));

    expect((await plane.fetch(replay(captured))).status).toBe(200);

    // Sizing the reservation from arrival rather than from the signed timestamp would have let it
    // lapse here, handing the identical bytes a second token.
    clock += 61_000;
    expect((await plane.fetch(replay(captured))).status).toBe(401);
    expect(events.map((event) => event.reason)).toEqual(['replayed_signature']);

    // Once the request itself is stale it is refused on freshness, so the reservation is free to go.
    clock += 60_000;
    expect((await plane.fetch(replay(captured))).status).toBe(401);
    expect(events.map((event) => event.reason)).toEqual(['replayed_signature', 'timestamp_skew']);
  });

  it('refuses the request with 503 when a configured replay store errors', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const events: HmacServiceClientAuthLogEvent[] = [];
    const brokenStore: ServicePlaneReplayCache = {
      reserve() {
        throw new Error('redis connection refused');
      },
    };
    const plane = hmacPlane(signingSecret, brokenStore, events);

    // Configuring a store is opting into the guarantee, so an unreachable store refuses rather than
    // serve unprotected. Not a 401: the signature verified and no challenge would help the caller.
    const refused = await plane.fetch(replay(await captureHmacRequest()));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('www-authenticate')).toBeNull();
    await expect(refused.json()).resolves.toEqual({ error: 'Service-Plane replay verification unavailable' });
    expect(events).toMatchObject([
      { reason: 'replay_cache_unavailable', message: 'Service-Plane replay cache is unavailable: redis connection refused' },
    ]);
  });

  it('issues tokens without a replay store, bounded by the skew window alone', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const events: HmacServiceClientAuthLogEvent[] = [];
    const plane = controlPlane(
      signingSecret,
      hmacServiceClientAuth({
        clients: [{ clientId: 'worker-a', secret: CLIENT_SECRET }],
        log: (event) => events.push(event),
        now: () => NOW,
      }),
    );

    // The default: no store, no reservation, and a captured request stays usable until its timestamp
    // falls outside the skew window. Documented baseline, and it scales horizontally as-is.
    const captured = await captureHmacRequest();
    expect((await plane.fetch(replay(captured))).status).toBe(200);
    expect((await plane.fetch(replay(captured))).status).toBe(200);
    expect(events).toEqual([]);

    const stale = await captureHmacRequest(new Date(NOW.getTime() - 61_000));
    const rejected = await plane.fetch(replay(stale));
    expect(rejected.status).toBe(401);
    expect(events.map((event) => event.reason)).toEqual(['timestamp_skew']);
  });

  it('leaves the private service-binding token path outside replay reservation', async () => {
    const signingSecret = await generateCapabilitySigningSecret();
    const events: HmacServiceClientAuthLogEvent[] = [];
    const replayCache = sharedReplayStore(() => NOW.getTime());
    const plane = hmacPlane(signingSecret, replayCache, events);
    const issue = () => plane.issueCapabilityTokenForCaller('worker-a', { scopes: ['example.sync.run'], targetServiceId: 'example' }, {});

    // Caller identity comes from the binding entrypoint, not from a replayable HTTP assertion, so
    // repeated native calls are ordinary requests rather than replays.
    await expect(issue()).resolves.toMatchObject({ token: expect.any(String) });
    await expect(issue()).resolves.toMatchObject({ token: expect.any(String) });
    expect(events).toEqual([]);
  });

  it('lets a reservation lapse only after its TTL', async () => {
    let now = NOW.getTime();
    const cache = sharedReplayStore(() => now);

    await expect(cache.reserve('service-plane:hmac:worker-a:req-1', 60)).resolves.toBe(true);
    await expect(cache.reserve('service-plane:hmac:worker-a:req-1', 60)).resolves.toBe(false);

    now += 60_000;
    await expect(cache.reserve('service-plane:hmac:worker-a:req-1', 60)).resolves.toBe(true);
  });
});

function hmacPlane(
  signingSecret: string,
  replayCache: ServicePlaneReplayCache,
  events: HmacServiceClientAuthLogEvent[],
): ServicePlaneControlPlane {
  return controlPlane(
    signingSecret,
    hmacServiceClientAuth({
      clients: [{ clientId: 'worker-a', secret: CLIENT_SECRET }],
      log: (event) => events.push(event),
      now: () => NOW,
      replayCache,
    }),
  );
}

function controlPlane(signingSecret: string, authenticateCaller: CallerAuthenticator): ServicePlaneControlPlane {
  return new ServicePlaneControlPlane({
    authenticateCaller,
    services: () => [
      cloudflareServiceBinding({
        binding: { fetch: async () => Response.json(discovery) },
        grants: [{ caller: 'worker-a', scopes: ['example.sync.run'] }],
        id: 'example',
      }),
    ],
    signingSecret: () => signingSecret,
  });
}

type CapturedRequest = {
  body: string;
  headers: [string, string][];
};

// A Request body streams once, so an attacker's replay is modeled by re-sending the captured bytes.
function replay(captured: CapturedRequest): Request {
  return new Request(TOKEN_URL, { body: captured.body, headers: captured.headers, method: 'POST' });
}

async function captureHmacRequest(now = NOW): Promise<CapturedRequest> {
  const body = JSON.stringify({ scopes: ['example.sync.run'], targetServiceId: 'example' });
  const signed = await signServicePlaneHmacRequest(
    new Request(TOKEN_URL, { body, headers: { 'content-type': 'application/json' }, method: 'POST' }),
    { clientId: 'worker-a', now, secret: CLIENT_SECRET },
  );
  return { body, headers: [...signed.headers] };
}

async function captureJwkRequest(privateJwk: JsonWebKey): Promise<CapturedRequest> {
  const body = JSON.stringify({ scopes: ['example.sync.run'], targetServiceId: 'example' });
  const signed = await signServicePlaneJwkRequest(
    new Request(TOKEN_URL, { body, headers: { 'content-type': 'application/json' }, method: 'POST' }),
    { clientId: 'worker-a', keyId: 'worker-a-key', now: NOW, privateJwk },
  );
  return { body, headers: [...signed.headers] };
}
