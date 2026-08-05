import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServicePlaneLogSink } from '../shared/logging.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH, SERVICE_PLANE_CAPABILITY_TOKEN_PATH, type ServiceDiscoveryDocument } from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

// The plane memoizes exactly one thing: the derived signing material. Everything expensive about
// building an issuer lives there — a P-256 scalar multiplication per key plus the sign/verify
// round-trip that proves the pair — and none of it depends on the catalog or the grants. The issuer
// itself is rebuilt per request, which is what these tests pin: the derivation must be shared across
// every configuration and every route, and rebuilding must never serve stale authorization.

// Counts derivations of the signing material — the work the memo exists to avoid repeating.
const derivations = vi.hoisted(() => ({ count: 0 }));
vi.mock('./signing-keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./signing-keys.js')>();
  return {
    ...actual,
    validatedPrivateJwksFromSigningKeys: (...args: Parameters<typeof actual.validatedPrivateJwksFromSigningKeys>) => {
      derivations.count += 1;
      return actual.validatedPrivateJwksFromSigningKeys(...args);
    },
  };
});

beforeEach(() => {
  derivations.count = 0;
});

const discovery: ServiceDiscoveryDocument = {
  abilities: [
    {
      access: 'service',
      exposure: 'private',
      id: 'example.sync',
      methods: { runSync: { inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, scopes: ['example.sync.run'] } },
      rpc: { path: '/rpc/example.sync', transports: ['http-batch'] },
      scopes: ['example.sync.run'],
    },
  ],
  capabilities: { scopes: [{ id: 'example.sync.run' }], serviceId: 'example' },
  id: 'example',
  title: 'Example',
  version: '0.1.0',
};

function planeWith(options: { grantsFor?: () => string; log?: ServicePlaneLogSink; secret: string; secondSecret?: string }) {
  return new ServicePlaneControlPlane({
    authenticateCaller: () => 'worker-a',
    log: options.log ?? false,
    services: () => [
      cloudflareServiceBinding({
        binding: { fetch: async () => Response.json(discovery) },
        // The authenticated caller is always `worker-a`; a varying grant is added only when a test
        // asks for one, so the default fixture is a configuration a plane would really hold.
        grants: [
          { caller: 'worker-a', scopes: ['example.sync.run'] },
          ...(options.grantsFor ? [{ caller: options.grantsFor(), scopes: ['example.sync.run'] }] : []),
        ],
        id: 'example',
      }),
    ],
    signingKeys: () => [
      { kid: 'test-key', secret: options.secondSecret ?? options.secret },
      ...(options.secondSecret ? [{ kid: 'old-key', secret: options.secret }] : []),
    ],
  });
}

const tokenRequest = () =>
  new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
    body: JSON.stringify({ scopes: ['example.sync.run'], targetServiceId: 'example' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });

const jwksRequest = () => new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`);

describe('signing material memo', () => {
  it('derives once no matter how many configurations resolve', async () => {
    const secret = await generateCapabilitySigningSecret();
    let caller = 0;
    const plane = planeWith({
      grantsFor: () => {
        caller += 1;
        return `tenant-${caller}`;
      },
      secret,
    });

    // Every request resolves a different configuration, so every request rebuilds an issuer. The
    // derivation depends only on the key set, which never changed — folding it back into the
    // per-configuration build is what would make rebuilding unaffordable.
    for (let index = 0; index < 64; index += 1) {
      expect((await plane.fetch(tokenRequest())).status).toBe(200);
    }
    expect(derivations.count).toBe(1);
  });

  it('reuses one derivation across the JWKS route and token issuance', async () => {
    const plane = planeWith({ secret: await generateCapabilitySigningSecret() });

    expect((await plane.fetch(jwksRequest())).status).toBe(200);
    expect((await plane.fetch(tokenRequest())).status).toBe(200);

    // JWKS publishes the public half and issuance signs with the private half — same material, so
    // whichever route runs first must warm it for the other.
    expect(derivations.count).toBe(1);
  });

  it('shares one derivation across concurrent requests', async () => {
    const plane = planeWith({ secret: await generateCapabilitySigningSecret() });

    const responses = await Promise.all(Array.from({ length: 12 }, () => plane.fetch(tokenRequest())));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    // Memoized before it settles, so concurrent requests await one derivation rather than racing to
    // repeat the most expensive work on the issuance path.
    expect(derivations.count).toBe(1);
  });

  it('derives again when the signing key rotates under the same key id', async () => {
    const secret = await generateCapabilitySigningSecret();
    const rotated = await generateCapabilitySigningSecret();
    const plane = planeWith({ secret });
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(derivations.count).toBe(1);

    const rotatedPlane = planeWith({ secret, secondSecret: rotated });
    expect((await rotatedPlane.fetch(tokenRequest())).status).toBe(200);

    // Same kid, different material: comparing the key set rather than trusting the id is what stops
    // a rotation from signing with the retired key.
    expect(derivations.count).toBe(2);
  });

  it('does not memoize invalid key material as permanent', async () => {
    const secret = await generateCapabilitySigningSecret();
    let broken = true;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: async () => Response.json(discovery) },
          grants: [{ caller: 'worker-a', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret: broken ? 'not-a-valid-p256-scalar' : secret }],
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(500);

    // A rejected derivation must not stick: once the secret is fixed the next request has to retry
    // rather than keep serving the cached failure.
    broken = false;
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
  });

  it('refuses a scope after the grant behind it is withdrawn', async () => {
    const secret = await generateCapabilitySigningSecret();
    let granted = true;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: async () => Response.json(discovery) },
          grants: granted ? [{ caller: 'worker-a', scopes: ['example.sync.run'] }] : [],
          id: 'example',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret }],
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(200);

    // The memo covers key material only. Authorization is rebuilt from the current catalog on every
    // request, so a withdrawn grant takes effect immediately rather than at a cache boundary.
    granted = false;
    expect((await plane.fetch(tokenRequest())).status).toBe(403);
    expect(derivations.count).toBe(1);
  });

  it('re-derives when a rotation mutates the key set in place', async () => {
    const secret = await generateCapabilitySigningSecret();
    const rotated = await generateCapabilitySigningSecret();
    // A resolver that hands back the same array every time and rotates by writing into it. Storing
    // that array by reference would mean comparing the new secret against itself on the next
    // request — a hit — and the plane would keep signing with the retired key indefinitely.
    const keys = [{ kid: 'test-key', secret }];
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: async () => Response.json(discovery) },
          grants: [{ caller: 'worker-a', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingKeys: () => keys,
    });

    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(derivations.count).toBe(1);

    keys[0] = { kid: 'test-key', secret: rotated };
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(derivations.count).toBe(2);

    // And mutating the key object itself, which is the sharper version of the same mistake.
    (keys[0] as { secret: string }).secret = secret;
    expect((await plane.fetch(tokenRequest())).status).toBe(200);
    expect(derivations.count).toBe(3);
  });

  it('does not let a rotation mid-derivation poison the JWKS memo', async () => {
    const secret = await generateCapabilitySigningSecret();
    const rotated = await generateCapabilitySigningSecret();
    const keys = [{ kid: 'test-key', secret }];
    let scheduled = false;
    const plane = new ServicePlaneControlPlane({
      authenticateCaller: () => 'worker-a',
      log: false,
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: async () => Response.json(discovery) },
          grants: [{ caller: 'worker-a', scopes: ['example.sync.run'] }],
          id: 'example',
        }),
      ],
      signingKeys: () => {
        if (!scheduled) {
          scheduled = true;
          // A macrotask, deliberately: a microtask would fire on the `await` of this very resolver,
          // before the snapshot is taken, and prove nothing. This lands while the derivation it
          // feeds is still running — the window in which a snapshot taken *after* the await would
          // record the new key set alongside material derived from the old one.
          setTimeout(() => {
            keys[0] = { kid: 'test-key', secret: rotated };
          }, 0);
        }
        return keys;
      },
    });

    expect((await plane.fetch(jwksRequest())).status).toBe(200);
    expect(derivations.count).toBe(1);

    // The memo must describe the key set the authority was actually built from. If it recorded the
    // rotated one instead, this request would read as a hit and JWKS would keep publishing the
    // retired key while issuance had already moved on — every token minted after the move would
    // then fail verification against the published set.
    expect((await plane.fetch(jwksRequest())).status).toBe(200);
    expect(derivations.count).toBe(2);
  });
});
