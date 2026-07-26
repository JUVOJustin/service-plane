import { RpcTarget } from 'capnweb';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilitySession } from '../service/capabilities.js';
import {
  abilityMethod,
  controlPlaneJwkTokenRequester,
  defineAbility,
  defineCapabilities,
  jwkCapabilityProofSigner,
  requireScopes,
  ServicePlaneService,
} from '../service/index.js';
import { decodeCapabilityTokenPayload, publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { servicePlaneJwkThumbprint } from '../shared/jwk-auth.js';
import { signCapabilityProof } from '../shared/proof-of-possession.js';
import { type CapabilityJwks, SERVICE_PLANE_CAPABILITY_JWKS_PATH } from '../shared/types.js';
import { jwkServiceClientAuth } from './caller-auth.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-secret.js';

// A token bound to the caller's key (RFC 7800 `cnf`) is useless to anyone who only holds the bytes.
// These tests exercise the direct caller -> service path, which is where a capability token leaves the
// plane and would otherwise be a plain bearer credential.
const CALLER = 'worker-a';
const KEY_ID = 'worker-a-key';

const capabilities = defineCapabilities({
  scopes: [{ id: 'example.sync.run' }],
  serviceId: 'example',
});

class SyncApi extends RpcTarget {
  async runSync(_input: Record<string, never>) {
    const identity = requireScopes(this, 'example.sync.run');
    return { boundTo: identity.confirmation?.jkt ?? null, caller: identity.serviceId };
  }
}

describe('sender-constrained capability tokens', () => {
  it('binds an issued token to the JWK that authenticated, and rejects it without a proof', async () => {
    const caller = await callerKeys();
    const { plane, requestToken, service } = await deployment(caller);

    const issued = await requestToken({ callerServiceId: CALLER, scopes: ['example.sync.run'], targetServiceId: 'example' });
    const claims = decodeCapabilityTokenPayload(issued.token) as unknown as { cnf?: { jkt: string } };
    expect(claims.cnf?.jkt).toBe(caller.thumbprint);

    // The bytes alone are now insufficient: this is exactly what an attacker who captured the token
    // response, the plane's logs, or the plane itself would be holding.
    const stolen = await session(service, { token: issued.token });
    await expect(stolen.runSync({})).rejects.toThrow(/requires a proof of possession/u);
    void plane;
  });

  it('accepts the same token when the caller proves it holds the bound key', async () => {
    const caller = await callerKeys();
    const { requestToken, service } = await deployment(caller);
    const issued = await requestToken({ callerServiceId: CALLER, scopes: ['example.sync.run'], targetServiceId: 'example' });

    const authorized = await session(service, {
      proveTokenPossession: jwkCapabilityProofSigner({ privateJwk: caller.privateJwk }),
      token: issued.token,
    });

    await expect(authorized.runSync({})).resolves.toEqual({ boundTo: caller.thumbprint, caller: CALLER });
  });

  it('rejects a proof signed by a different key', async () => {
    const caller = await callerKeys();
    const attacker = await callerKeys();
    const { requestToken, service } = await deployment(caller);
    const issued = await requestToken({ callerServiceId: CALLER, scopes: ['example.sync.run'], targetServiceId: 'example' });

    // Signed directly rather than through jwkCapabilityProofSigner: that helper refuses a mismatched
    // key client-side, and an attacker would simply not use it. The service must reject on its own.
    const forged = await session(service, {
      proveTokenPossession: ({ abilityId, targetServiceId, token }) =>
        signCapabilityProof({ abilityId, privateJwk: attacker.privateJwk, targetServiceId, token }),
      token: issued.token,
    });

    await expect(forged.runSync({})).rejects.toThrow(/does not match the token confirmation/u);
  });

  it('rejects a proof minted for a different token', async () => {
    const caller = await callerKeys();
    const { requestToken, service } = await deployment(caller);
    const first = await requestToken({ callerServiceId: CALLER, scopes: ['example.sync.run'], targetServiceId: 'example' });
    const second = await requestToken({ callerServiceId: CALLER, scopes: ['example.sync.run'], targetServiceId: 'example' });

    // Replaying a captured proof alongside a different token must not work, or the proof would be a
    // reusable ticket rather than a binding.
    const mismatched = await session(service, {
      proveTokenPossession: jwkCapabilityProofSigner({ privateJwk: caller.privateJwk }),
      proofToken: first.token,
      token: second.token,
    });

    await expect(mismatched.runSync({})).rejects.toThrow(/bound to a different token/u);
  });

  it('proves possession with no session wiring when the shipped requester is used', async () => {
    const caller = await callerKeys();
    const { requestToken, service } = await deployment(caller);

    // The whole point of binding on by default: the key is configured once, on the requester, and the
    // session picks the prover up from it. No `proveTokenPossession` anywhere in this call.
    const api = await abilitySession<SyncApi>({
      abilityId: 'example.sync',
      callerServiceId: CALLER,
      requestToken,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: {
        fetcher: { fetch: async (request: Request) => service.fetch(request) },
        kind: 'fetch',
        origin: 'https://example.internal',
        path: '/rpc/example.sync',
      },
    });

    await expect(api.runSync({})).resolves.toEqual({ boundTo: caller.thumbprint, caller: CALLER });
  });

  it('fails locally when the proof key no longer matches the token it accompanies', async () => {
    const caller = await callerKeys();
    const rotated = await callerKeys();
    const { requestToken } = await deployment(caller);
    const issued = await requestToken({ callerServiceId: CALLER, scopes: ['example.sync.run'], targetServiceId: 'example' });

    // A rotated key resolver outrunning a cached token would otherwise ship a proof that fails
    // remotely as an opaque 401.
    await expect(
      jwkCapabilityProofSigner({ privateJwk: rotated.privateJwk })({
        abilityId: 'example.sync',
        targetServiceId: 'example',
        token: issued.token,
      }),
    ).rejects.toThrow(/does not match the capability token it accompanies/u);
  });

  it('leaves HMAC callers unbound, since a shared secret has no key to confirm', async () => {
    const caller = await callerKeys();
    const { plane } = await deployment(caller);
    const nativeToken = await plane.issueCapabilityTokenForCaller(CALLER, { scopes: ['example.sync.run'], targetServiceId: 'example' }, {});

    // The private binding path pins identity by deployment config, so there is no caller key and the
    // token stays a plain (never-exposed) credential rather than gaining an unverifiable claim.
    const claims = decodeCapabilityTokenPayload(nativeToken.token) as unknown as { cnf?: unknown };
    expect(claims.cnf).toBeUndefined();
  });
});

async function callerKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = publicJwkFromPrivateJwk(privateJwk, KEY_ID);
  return { privateJwk, publicJwk, thumbprint: await servicePlaneJwkThumbprint(publicJwk) };
}

async function deployment(caller: Awaited<ReturnType<typeof callerKeys>>) {
  const signingSecret = await generateCapabilitySigningSecret();
  // Declared up front because the two shells reference each other lazily: the service fetches JWKS
  // from the plane, and the plane discovers the service.
  let plane: ServicePlaneControlPlane;

  const service: ServicePlaneService = new ServicePlaneService({
    abilities: [
      defineAbility({
        access: 'service',
        exposure: 'private',
        handler: () => new SyncApi() as unknown as RpcTarget & Record<string, unknown>,
        id: 'example.sync',
        methods: {
          runSync: abilityMethod({
            input: z.object({}),
            output: z.object({ boundTo: z.string().nullable(), caller: z.string() }),
            scopes: ['example.sync.run'],
          }),
        },
        rpc: { path: '/rpc/example.sync', transports: ['http-batch'] },
        scopes: ['example.sync.run'],
      }),
    ],
    auth: {
      jwks: async (): Promise<CapabilityJwks> =>
        (await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`))).json() as Promise<CapabilityJwks>,
    },
    capabilities,
    id: 'example',
    logger: false,
    title: 'Example',
    version: '0.1.0',
  });

  plane = new ServicePlaneControlPlane({
    authenticateCaller: jwkServiceClientAuth({
      clients: [{ clientId: CALLER, jwks: { keys: [caller.publicJwk] } }],
      log: () => undefined,
    }),
    log: false,
    services: () => [
      cloudflareServiceBinding({
        binding: { fetch: async (request: Request) => service.fetch(request) },
        grants: [{ caller: CALLER, scopes: ['example.sync.run'] }],
        id: 'example',
        origin: 'https://example.internal',
      }),
    ],
    signingSecret: () => signingSecret,
  });

  const requestToken = controlPlaneJwkTokenRequester({
    clientId: CALLER,
    controlPlaneUrl: 'https://plane.internal',
    fetch: async (request: RequestInfo | URL, init?: RequestInit) => plane.fetch(new Request(request, init)),
    keyId: KEY_ID,
    privateJwk: caller.privateJwk,
  });

  return { plane, requestToken, service };
}

// Opens a direct caller -> service session over HTTP-batch with a token the test already holds.
// `proofToken` signs the proof against a different token than the one presented, to model a proof
// captured from another exchange.
async function session(
  service: ServicePlaneService,
  input: { proofToken?: string; proveTokenPossession?: ReturnType<typeof jwkCapabilityProofSigner>; token: string },
) {
  return abilitySession<SyncApi>({
    abilityId: 'example.sync',
    callerServiceId: CALLER,
    ...(input.proveTokenPossession
      ? {
          proveTokenPossession: (proofInput) =>
            input.proveTokenPossession?.({ ...proofInput, token: input.proofToken ?? proofInput.token }) as Promise<string>,
        }
      : {}),
    scopes: ['example.sync.run'],
    targetServiceId: 'example',
    tokenProvider: { token: async () => input.token },
    transport: {
      kind: 'fetch',
      fetcher: { fetch: async (request: Request) => service.fetch(request) },
      origin: 'https://example.internal',
      path: '/rpc/example.sync',
    },
  });
}
