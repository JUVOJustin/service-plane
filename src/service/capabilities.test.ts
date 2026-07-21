import { RpcSession } from 'capnweb';
import { describe, expect, it } from 'vitest';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { memoryCapabilityTokenCache, memoryRpcTransportPair } from '../testing/index.js';
import {
  bindCapabilityIdentity,
  capabilityIdentity,
  capabilityRpcSession,
  capabilityTokenCacheKey,
  cloudflareServiceBindingRpc,
  controlPlaneRpcTokenRequester,
  createCapabilityTokenProvider,
  defineCapabilities,
  RpcTarget,
  requireScopes,
  verifyAuthenticationToken,
} from './capabilities.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('Cap’n Web service capabilities', () => {
  it('authenticates a Cap’n Web session and binds identity to scoped targets', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.users.lookup' }, { id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['example.users.lookup', 'example.sync.run'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });

    class ScopedExample extends RpcTarget {
      async lookupUser(email: string) {
        const caller = requireScopes(this, 'example.users.lookup');
        return { caller: caller.serviceId, email };
      }

      async whoami() {
        return capabilityIdentity(this)?.serviceId;
      }
    }

    class PublicRoot extends RpcTarget {
      async authenticate(token: string) {
        const identity = await verifyAuthenticationToken(token, {
          expectedAudience: 'example',
          issuer: 'control-plane',
          jwks: { keys: [keys.publicJwk] },
          now: VERIFIED_AT,
        });
        return bindCapabilityIdentity(new ScopedExample(), identity);
      }
    }

    const { left, right } = memoryRpcTransportPair();
    new RpcSession(right, new PublicRoot());
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });

    interface ExampleApi {
      lookupUser(email: string): Promise<{ caller: string; email: string }>;
      whoami(): Promise<string | undefined>;
    }

    const stub = await capabilityRpcSession<ExampleApi>({
      callerServiceId: 'moco',
      requestToken: async () => issued,
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
      transport: { kind: 'custom', transport: left },
    });

    await expect(stub.lookupUser('a@example.com')).resolves.toEqual({ caller: 'moco', email: 'a@example.com' });
    await expect(stub.whoami()).resolves.toBe('moco');
  });

  it('rejects methods when the bound identity lacks a required scope', async () => {
    const target = bindCapabilityIdentity(new RpcTarget(), {
      audience: 'example',
      expiresAt: new Date('2026-05-09T12:05:00.000Z'),
      issuer: 'control-plane',
      scopes: ['example.read'],
      serviceId: 'moco',
      tokenId: 'token-1',
    });

    expect(() => requireScopes(target, 'example.write')).toThrow('Missing Service-Plane capability scope: example.write');
  });

  it('caches capability tokens and shares cache entries across providers', async () => {
    let now = new Date('2026-05-09T12:00:00.000Z');
    const cache = memoryCapabilityTokenCache(() => now.getTime());
    let issuedCount = 0;
    const requestToken = async () => {
      issuedCount += 1;
      return { expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: `token-${issuedCount}` };
    };

    const first = createCapabilityTokenProvider({
      cache,
      callerServiceId: 'moco',
      now: () => now,
      requestToken,
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });
    const second = createCapabilityTokenProvider({
      cache,
      callerServiceId: 'moco',
      now: () => now,
      requestToken,
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });

    await expect(first.token()).resolves.toBe('token-1');
    await expect(second.token()).resolves.toBe('token-1');
    expect(issuedCount).toBe(1);

    now = new Date('2026-05-09T12:04:55.000Z');
    await expect(second.token()).resolves.toBe('token-2');
    expect(issuedCount).toBe(2);
  });

  it('builds stable token cache keys regardless of scope order', () => {
    expect(capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['b', 'a'], targetServiceId: 'example' })).toBe(
      capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a', 'b'], targetServiceId: 'example' }),
    );
  });

  it('requests capability tokens from a private RPC binding', async () => {
    const requester = controlPlaneRpcTokenRequester({
      binding: {
        async issueCapabilityTokenForCaller(callerServiceId, input) {
          expect(callerServiceId).toBe('worker-a');
          expect(input).toEqual({ scopes: ['example.sync.run'], targetServiceId: 'example' });
          return { expiresAt: '2026-05-12T10:17:00.000Z', token: 'rpc-token-1' };
        },
      },
      callerServiceId: 'worker-a',
    });

    await expect(
      requester({
        callerServiceId: 'ignored',
        scopes: ['example.sync.run'],
        targetServiceId: 'example',
      }),
    ).resolves.toEqual({
      expiresAt: new Date('2026-05-12T10:17:00.000Z'),
      token: 'rpc-token-1',
    });
  });

  it('asks the token provider for each stateless RPC call', async () => {
    let tokenCount = 0;
    const api = await capabilityRpcSession<{ ping(): Promise<string> }>({
      abilityId: 'example.sync',
      authenticate: (_root, token) =>
        ({
          ping: async () => token,
        }) as never,
      callerServiceId: 'worker-a',
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      tokenProvider: {
        async token() {
          tokenCount += 1;
          return `token-${tokenCount}`;
        },
      },
      transport: cloudflareServiceBindingRpc({
        fetch: async () => {
          throw new Error('authenticate stub should not use the transport root');
        },
      }),
    });

    await expect(api.ping()).resolves.toBe('token-1');
    await expect(api.ping()).resolves.toBe('token-2');
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
