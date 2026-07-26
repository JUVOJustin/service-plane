import { RpcSession } from 'capnweb';
import { describe, expect, it } from 'vitest';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { testKeys } from '../test-support/index.js';
import { memoryCapabilityTokenCache, memoryRpcTransportPair } from '../testing/index.js';
import {
  bindCapabilityIdentity,
  capabilityIdentity,
  capabilityRpcSession,
  capabilityTokenCacheKey,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  controlPlaneHmacTokenRequester,
  controlPlaneRpcTokenRequester,
  createCapabilityTokenProvider,
  defineCapabilities,
  disposeAbilitySession,
  RpcTarget,
  requireScopes,
  verifyAuthenticationToken,
  websocketRpc,
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

  it('deduplicates concurrent token requests and retries after a failed request', async () => {
    let attempts = 0;
    const provider = createCapabilityTokenProvider({
      callerServiceId: 'moco',
      requestToken: async () => {
        attempts += 1;
        await Promise.resolve();
        if (attempts === 1) throw new Error('temporary issuer failure');
        return { expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: 'token-2' };
      },
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });

    await expect(Promise.all([provider.token(), provider.token()])).rejects.toThrow('temporary issuer failure');
    expect(attempts).toBe(1);
    await expect(Promise.all([provider.token(), provider.token()])).resolves.toEqual(['token-2', 'token-2']);
    expect(attempts).toBe(2);
  });

  it('rejects invalid token refresh skew at setup', () => {
    expect(() =>
      createCapabilityTokenProvider({
        callerServiceId: 'moco',
        refreshSkewSeconds: Number.NaN,
        requestToken: async () => ({ expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: 'token' }),
        scopes: ['example.users.lookup'],
        targetServiceId: 'example',
      }),
    ).toThrow('refresh skew must be a non-negative integer');
  });

  it('builds stable token cache keys regardless of scope order', () => {
    expect(capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['b', 'a'], targetServiceId: 'example' })).toBe(
      capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a', 'b'], targetServiceId: 'example' }),
    );
  });

  it('never shares cached tokens across delegated subjects', async () => {
    expect(
      capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a'], subject: { id: 'user-7' }, targetServiceId: 'example' }),
    ).not.toBe(capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a'], targetServiceId: 'example' }));
    expect(
      capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a'], subject: { id: 'user-7' }, targetServiceId: 'example' }),
    ).not.toBe(capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a'], subject: { id: 'user-8' }, targetServiceId: 'example' }));

    const cache = memoryCapabilityTokenCache(() => new Date('2026-05-09T12:00:00.000Z').getTime());
    let issuedCount = 0;
    const providerFor = (subjectId: string) =>
      createCapabilityTokenProvider({
        cache,
        callerServiceId: 'control-plane',
        now: () => new Date('2026-05-09T12:00:00.000Z'),
        requestToken: async (input) => {
          issuedCount += 1;
          expect(input.subject).toEqual({ id: subjectId, orgId: 'org-42' });
          return { expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: `token-${subjectId}` };
        },
        scopes: ['example.users.lookup'],
        subject: { id: subjectId, orgId: 'org-42' },
        targetServiceId: 'example',
      });

    await expect(providerFor('user-7').token()).resolves.toBe('token-user-7');
    await expect(providerFor('user-8').token()).resolves.toBe('token-user-8');
    expect(issuedCount).toBe(2);
  });

  it('partitions caller-supplied cache keys by delegated subject', async () => {
    const cache = memoryCapabilityTokenCache(() => new Date('2026-05-09T12:00:00.000Z').getTime());
    let issuedCount = 0;
    const providerFor = (subjectId: string) =>
      createCapabilityTokenProvider({
        cache,
        cacheKey: 'shared-key',
        callerServiceId: 'control-plane',
        now: () => new Date('2026-05-09T12:00:00.000Z'),
        requestToken: async () => {
          issuedCount += 1;
          return { expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: `token-${subjectId}-${issuedCount}` };
        },
        scopes: ['example.users.lookup'],
        subject: { id: subjectId },
        targetServiceId: 'example',
      });

    await expect(providerFor('user-7').token()).resolves.toBe('token-user-7-1');
    await expect(providerFor('user-8').token()).resolves.toBe('token-user-8-2');
    await expect(providerFor('user-7').token()).resolves.toBe('token-user-7-1');
    expect(issuedCount).toBe(2);
  });

  it('rejects delegated subjects on shipped token requesters before anything is sent', async () => {
    const input = {
      callerServiceId: 'moco',
      scopes: ['example.users.lookup'],
      subject: { id: 'user-7' },
      targetServiceId: 'example',
    };
    const rpcRequester = controlPlaneRpcTokenRequester({
      binding: {
        async issueCapabilityToken() {
          throw new Error('raw binding must not be reached');
        },
      },
    });
    const hmacRequester = controlPlaneHmacTokenRequester({
      clientId: 'moco',
      clientSecret: 'secret',
      controlPlaneUrl: 'https://plane.example.com',
      fetch: async () => {
        throw new Error('token endpoint must not be reached');
      },
    });

    await expect(rpcRequester(input)).rejects.toThrow('Service-Plane token requesters cannot assert a delegated subject');
    await expect(hmacRequester(input)).rejects.toThrow('Service-Plane token requesters cannot assert a delegated subject');
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
    await expect((api as unknown as { missing(): Promise<unknown> }).missing()).rejects.toThrow('ability method is not available: missing');
  });

  it('creates a WebSocket after adding the request id and restores an absent runtime global', async () => {
    const globalObject = globalThis as typeof globalThis & { WebSocket?: typeof WebSocket };
    const descriptor = Object.getOwnPropertyDescriptor(globalObject, 'WebSocket');
    const socket = new FakeWebSocket();
    let createdUrl: string | undefined;
    let createdSockets = 0;
    let tokenAttempts = 0;
    Reflect.deleteProperty(globalObject, 'WebSocket');

    try {
      const api = await capabilityRpcSession<{ ping(): Promise<string> }>({
        abilityId: 'example.sync',
        authenticate: () => ({ ping: async () => 'pong' }),
        callerServiceId: 'worker-a',
        requestId: 'request-42',
        scopes: ['example.sync.run'],
        targetServiceId: 'example',
        tokenProvider: {
          async token() {
            tokenAttempts += 1;
            await Promise.resolve();
            if (tokenAttempts === 1) throw new Error('temporary token failure');
            return 'capability-token';
          },
        },
        transport: websocketRpc('ws://example.internal/rpc/example.sync?existing=1', {
          createWebSocket(url) {
            createdSockets += 1;
            createdUrl = url;
            return socket as unknown as WebSocket;
          },
        }),
      });

      await expect(api.ping()).rejects.toThrow('temporary token failure');
      await expect(Promise.all([api.ping(), api.ping()])).resolves.toEqual(['pong', 'pong']);
      await expect(api.ping()).resolves.toBe('pong');
      expect(tokenAttempts).toBe(2);
      expect(createdSockets).toBe(1);
      expect(createdUrl).toBe('ws://example.internal/rpc/example.sync?existing=1&request_id=request-42');
      expect(socket.binaryType).toBe('arraybuffer');
      expect(Object.hasOwn(globalObject, 'WebSocket')).toBe(false);
      await disposeAbilitySession(api);
    } finally {
      if (descriptor) Object.defineProperty(globalObject, 'WebSocket', descriptor);
      else Reflect.deleteProperty(globalObject, 'WebSocket');
    }
  });

  it('opens a native binding once for concurrent and later calls', async () => {
    let connections = 0;
    let calls = 0;
    let disposals = 0;
    let tokenRequests = 0;
    const target = {
      [Symbol.dispose]() {
        disposals += 1;
      },
      async ping() {
        calls += 1;
        return 'pong';
      },
    };
    const api = await capabilityRpcSession<{ ping(): Promise<string> }>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      tokenProvider: {
        async token() {
          tokenRequests += 1;
          await Promise.resolve();
          return 'capability-token';
        },
      },
      transport: cloudflareNativeRpc({
        async connectAbility() {
          connections += 1;
          await Promise.resolve();
          return target;
        },
      }),
    });

    await expect(Promise.all([api.ping(), api.ping()])).resolves.toEqual(['pong', 'pong']);
    await expect(api.ping()).resolves.toBe('pong');
    expect({ calls, connections, tokenRequests }).toEqual({ calls: 3, connections: 1, tokenRequests: 1 });
    await disposeAbilitySession(api);
    expect(disposals).toBe(1);
  });

  it('invokes methods directly on a native binding RPC stub', async () => {
    class NativeAbility extends RpcTarget {
      async ping() {
        return 'pong';
      }
    }
    class NativeBinding extends RpcTarget {
      connectAbility() {
        return new NativeAbility();
      }
    }
    const { left, right } = memoryRpcTransportPair();
    new RpcSession(right, new NativeBinding());
    const binding = new RpcSession<{ connectAbility(input: { abilityId: string; token: string }): Promise<object> }>(left).getRemoteMain();
    const api = await capabilityRpcSession<{ ping(): Promise<string> }>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      tokenProvider: { token: async () => 'capability-token' },
      transport: cloudflareNativeRpc(binding),
    });

    await expect(api.ping()).resolves.toBe('pong');
    await disposeAbilitySession(api);
  });
});

class FakeWebSocket extends EventTarget {
  binaryType: BinaryType = 'blob';
  readonly readyState = 0;

  close(): void {}

  send(): void {}
}
