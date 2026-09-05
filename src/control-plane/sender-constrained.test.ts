import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAbilityBuilder } from '../service/ability.js';
import {
  type CapabilityProofSigner,
  controlPlaneJwkTokenRequester,
  createCapabilityTokenProvider,
  defineCapabilities,
  jwkCapabilityProofSigner,
} from '../service/capabilities.js';
import { createAbilityClient } from '../service/client.js';
import { defineAbility } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import { decodeCapabilityTokenPayload, publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { ServicePlaneClientError } from '../shared/errors.js';
import { servicePlaneJwkThumbprint } from '../shared/jwk-auth.js';
import { signCapabilityProof } from '../shared/proof-of-possession.js';
import { type CapabilityTokenCacheEntry, SERVICE_PLANE_CAPABILITY_JWKS_PATH } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { jwkServiceClientAuth } from './caller-auth.js';
import { createCapabilityIssuer, defineServiceGrants, mountCapabilityEndpoints } from './capabilities.js';

// A token bound to the caller's key (RFC 7800 `cnf`) is useless to anyone who only holds the bytes.
// These tests exercise the direct caller -> service path end to end: JWK caller auth at the plane's
// token endpoint stamps the confirmation, and the service refuses the token without a matching proof.
const CALLER = 'worker-a';
const KEY_ID = 'worker-a-key';
const SERVICE_ID = 'example';
const SCOPE = 'example.sync.run';
const ISSUED_AT = new Date('2099-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2099-05-09T12:00:01.000Z');

const capabilities = defineCapabilities({ scopes: [{ id: SCOPE }], serviceId: SERVICE_ID });

describe('sender-constrained capability tokens', () => {
  it('binds an issued token to the JWK that authenticated, and rejects it without a proof', async () => {
    const caller = await callerKeys();
    const { ability, requestToken, service } = await deployment(caller);

    const issued = await requestToken({ callerServiceId: CALLER, scopes: [SCOPE], targetServiceId: SERVICE_ID });
    expect(decodeCapabilityTokenPayload(issued.token).cnf?.jkt).toBe(caller.thumbprint);

    // The bytes alone are now insufficient: this is exactly what an attacker who captured the token
    // response, the plane's logs, or the plane itself would be holding.
    const stolen = tokenClient(ability, service, { token: issued.token });
    const error = await stolen.run({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServicePlaneClientError);
    expect(error).toMatchObject({ code: 'capability_auth', message: expect.stringContaining('requires a proof of possession') });
  });

  it('accepts the token with no proof wiring when the shipped requester is used', async () => {
    const caller = await callerKeys();
    const { ability, requestToken, service } = await deployment(caller);

    // The whole point of binding on by default: the key is configured once, on the requester, and the
    // client picks the prover up from it. No `proveTokenPossession` anywhere in this call.
    const client = createAbilityClient({
      ability,
      callerServiceId: CALLER,
      requestToken,
      scopes: [SCOPE],
      targetServiceId: SERVICE_ID,
      transport: {
        fetch: { fetch: async (request) => service.fetch(request) },
        origin: 'https://example.internal',
        type: 'fetch',
      },
    });

    await expect(client.run({})).resolves.toEqual({ boundTo: caller.thumbprint, caller: CALLER });
  });

  it('rejects a proof signed by a different key', async () => {
    const caller = await callerKeys();
    const attacker = await callerKeys();
    const { ability, requestToken, service } = await deployment(caller);
    const issued = await requestToken({ callerServiceId: CALLER, scopes: [SCOPE], targetServiceId: SERVICE_ID });

    // Signed directly rather than through jwkCapabilityProofSigner: that helper refuses a mismatched
    // key client-side, and an attacker would simply not use it. The service must reject on its own.
    const forged = tokenClient(ability, service, {
      proveTokenPossession: ({ abilityId, targetServiceId, token }) =>
        signCapabilityProof({ abilityId, now: ISSUED_AT, privateJwk: attacker.privateJwk, targetServiceId, token }),
      token: issued.token,
    });

    await expect(forged.run({})).rejects.toMatchObject({
      code: 'capability_auth',
      message: expect.stringContaining('does not match the token confirmation'),
    });
  });

  it('rejects a proof minted for a different token', async () => {
    const caller = await callerKeys();
    const { ability, requestToken, service } = await deployment(caller);
    const first = await requestToken({ callerServiceId: CALLER, scopes: [SCOPE], targetServiceId: SERVICE_ID });
    const second = await requestToken({ callerServiceId: CALLER, scopes: [SCOPE], targetServiceId: SERVICE_ID });

    // Replaying a captured proof alongside a different token must not work, or the proof would be a
    // reusable ticket rather than a binding.
    const mismatched = tokenClient(ability, service, {
      proveTokenPossession: ({ abilityId, targetServiceId }) =>
        signCapabilityProof({ abilityId, now: ISSUED_AT, privateJwk: caller.privateJwk, targetServiceId, token: first.token }),
      token: second.token,
    });

    await expect(mismatched.run({})).rejects.toMatchObject({
      code: 'capability_auth',
      message: expect.stringContaining('bound to a different token'),
    });
  });

  it('fails locally when the proof key no longer matches the token it accompanies', async () => {
    const caller = await callerKeys();
    const rotated = await callerKeys();
    const { requestToken } = await deployment(caller);
    const issued = await requestToken({ callerServiceId: CALLER, scopes: [SCOPE], targetServiceId: SERVICE_ID });

    // A rotated key resolver outrunning a cached token would otherwise ship a proof that fails
    // remotely as an opaque 401.
    await expect(
      jwkCapabilityProofSigner({ now: () => ISSUED_AT, privateJwk: rotated.privateJwk })({
        abilityId: 'example.sync',
        targetServiceId: SERVICE_ID,
        token: issued.token,
      }),
    ).rejects.toThrow(/does not match the capability token it accompanies/u);
  });

  it('never reuses an unbound cached token for a proof-capable caller', async () => {
    const caller = await callerKeys();
    const { requestToken } = await deployment(caller);
    const entries = new Map<string, CapabilityTokenCacheEntry>();
    const cache = {
      get: async (key: string) => entries.get(key),
      set: async (key: string, value: CapabilityTokenCacheEntry) => {
        entries.set(key, value);
      },
    };
    const shared = {
      cache,
      callerServiceId: CALLER,
      now: () => ISSUED_AT,
      scopes: [SCOPE],
      targetServiceId: SERVICE_ID,
    };

    // An unbound token for the same caller, target, and scopes — what an HMAC provider, or a release
    // from before binding existed, would have written into a shared cache.
    const unbound = createCapabilityTokenProvider({
      ...shared,
      requestToken: async () => ({ expiresAt: new Date(ISSUED_AT.getTime() + 60_000), token: 'unbound.token.value' }),
    });
    await unbound.token();

    // The proof-capable provider must not read that entry: it carries no cnf, so the client would skip
    // the proof and hand the service a bearer token, silently losing the binding.
    const boundProvider = createCapabilityTokenProvider({ ...shared, requestToken });
    const token = await boundProvider.token();
    expect(token).not.toBe('unbound.token.value');
    expect(decodeCapabilityTokenPayload(token).cnf).toBeDefined();
  });

  it('leaves callers that authenticated without a key unbound', async () => {
    const caller = await callerKeys();
    const { issuer } = await deployment(caller);

    // No confirmation reaches the issuer when the caller proved no key — HMAC and native
    // service-binding callers — so the token stays a plain credential rather than gaining an
    // unverifiable claim.
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: CALLER,
      scopes: [SCOPE],
      targetServiceId: SERVICE_ID,
    });
    expect(decodeCapabilityTokenPayload(issued.token).cnf).toBeUndefined();
  });
});

async function callerKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicJwk = publicJwkFromPrivateJwk(privateJwk, KEY_ID);
  return { privateJwk, publicJwk, thumbprint: await servicePlaneJwkThumbprint(publicJwk) };
}

async function deployment(caller: Awaited<ReturnType<typeof callerKeys>>) {
  const keys = await testKeys();
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: CALLER, scopes: [SCOPE], target: SERVICE_ID }] }),
    issuer: 'control-plane',
    now: () => ISSUED_AT,
    privateJwks: [keys.privateJwk],
  });

  // The plane's STS/JWKS surface with JWK caller auth, which is what stamps `cnf` into issued tokens.
  const plane = new Hono();
  mountCapabilityEndpoints(plane, issuer, {
    authenticateCaller: jwkServiceClientAuth({
      clients: [{ clientId: CALLER, jwks: { keys: [caller.publicJwk] } }],
      log: () => undefined,
      now: () => ISSUED_AT,
    }),
    jwks: issuer,
  });

  const builder = createAbilityBuilder();
  const ability = defineAbility({
    access: 'service',
    exposure: 'private',
    id: 'example.sync',
    methods: {
      run: builder.method({
        scopes: [SCOPE],
        input: z.object({}),
        output: z.object({ boundTo: z.string().nullable(), caller: z.string() }),
        handler: ({ context }) => ({
          boundTo: context.identity.confirmation?.jkt ?? null,
          caller: context.identity.serviceId,
        }),
      }),
    },
    rpc: { transports: ['fetch'] },
    scopes: [SCOPE],
  });

  const service = new ServicePlaneService({
    ingress: false,
    abilities: [ability],
    auth: {
      issuer: 'control-plane',
      jwks: async () => {
        const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
        return response.json();
      },
      now: () => VERIFIED_AT,
    },
    capabilities,
    id: SERVICE_ID,
    logger: false,
    title: 'Example',
    version: '0.1.0',
  });

  const requestToken = controlPlaneJwkTokenRequester({
    clientId: CALLER,
    controlPlaneUrl: 'https://plane.internal',
    fetch: async (request: RequestInfo | URL, init?: RequestInit) => plane.fetch(new Request(request, init)),
    keyId: KEY_ID,
    now: () => ISSUED_AT,
    privateJwk: caller.privateJwk,
  });

  return { ability, issuer, requestToken, service };
}

type SenderConstrainedDeployment = Awaited<ReturnType<typeof deployment>>;

// A direct caller -> service client using a token the test already holds, so the proof can be
// omitted or forged independently of how the token was issued.
function tokenClient(
  ability: SenderConstrainedDeployment['ability'],
  service: SenderConstrainedDeployment['service'],
  input: { proveTokenPossession?: CapabilityProofSigner; token: string },
) {
  return createAbilityClient({
    ability,
    ...(input.proveTokenPossession ? { proveTokenPossession: input.proveTokenPossession } : {}),
    scopes: [SCOPE],
    targetServiceId: SERVICE_ID,
    tokenProvider: { token: async () => input.token },
    transport: {
      fetch: { fetch: async (request) => service.fetch(request) },
      origin: 'https://example.internal',
      type: 'fetch',
    },
  });
}
