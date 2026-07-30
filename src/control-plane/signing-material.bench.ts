import { bench, describe } from 'vitest';
import { createCapabilityIssuerFromPrivateJwk } from './capabilities.js';
import {
  createCapabilityIssuerFromSigningKeys,
  generateCapabilitySigningSecret,
  privateJwkFromCapabilitySigningSecret,
  validatedPrivateJwksFromSigningKeys,
} from './signing-keys.js';

// Guards the one decision the control plane's caching rests on: the signing material is memoized and
// the issuer is not. That is only correct while deriving the material stays far more expensive than
// assembling an issuer around it — so the ratio is measured here rather than asserted in a comment.
//
// If `assemble issuer from derived material` ever approaches `derive + validate signing material`,
// caching the issuer starts to pay and the comment in `issuerFor` needs revisiting. The catalog is
// what moves that number: BENCH_ISSUER_SERVICES sizes it (default 20, try 200).
//
// End-to-end request benchmarks deliberately live outside this file. The difference between caching
// the issuer and not is single-digit microseconds at realistic catalog sizes, which is well below
// the run-to-run noise of a full HTTP request through Hono — measuring it that way produced results
// that flipped direction between runs. The component ratio below is stable to ~±1%.

const SERVICES = Number(process.env.BENCH_ISSUER_SERVICES ?? 20);
const SCOPES_PER_SERVICE = 20;
const GRANTS_PER_SERVICE = 5;
const ISSUER_BENCH = { time: 2_000, warmupTime: 250 };

const secret = await generateCapabilitySigningSecret();
const keys = [{ kid: 'bench-key', secret }];
const privateJwks = await validatedPrivateJwksFromSigningKeys(keys);

const capabilities = Array.from({ length: SERVICES }, (_, service) => ({
  scopes: Array.from({ length: SCOPES_PER_SERVICE }, (_, index) => ({ id: `svc${service}.s${index}` })),
  serviceId: `svc${service}`,
}));
const grants = {
  grants: Array.from({ length: SERVICES }, (_, service) =>
    Array.from({ length: GRANTS_PER_SERVICE }, (_, index) => ({
      caller: `caller${index}`,
      scopes: [`svc${service}.s0`],
      target: `svc${service}`,
    })),
  ).flat(),
};

describe('issuer build: key material vs catalog', () => {
  // The expensive half, and the reason the memo exists: pure P-256 scalar multiplication.
  bench(
    'derive private JWK from signing secret',
    () => {
      privateJwkFromCapabilitySigningSecret(secret, 'bench-key');
    },
    ISSUER_BENCH,
  );

  // What the plane memoizes, once per key set: the derivation plus the sign/verify round-trip that
  // proves the pair before anything signs with it.
  bench(
    'derive + validate signing material (memoized per key set)',
    async () => {
      await validatedPrivateJwksFromSigningKeys(keys);
    },
    ISSUER_BENCH,
  );

  // What the plane actually pays per request. Scales with catalog size; this is the number that
  // decides whether not caching the issuer stays the right call.
  bench(
    `assemble issuer from derived material (${SERVICES} services)`,
    async () => {
      await createCapabilityIssuerFromPrivateJwk({
        capabilities,
        grants,
        issuer: 'bench',
        privateJwks,
        ttlSeconds: 120,
        validateKeyPair: false,
      });
    },
    ISSUER_BENCH,
  );

  // What a request would cost if the key work were folded back into the per-configuration build —
  // the shape this package had before the split.
  bench(
    'full build from signing keys (no signing-material memo)',
    async () => {
      await createCapabilityIssuerFromSigningKeys({ capabilities, grants, keys });
    },
    ISSUER_BENCH,
  );
});
