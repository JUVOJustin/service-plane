import { describe, expect, it } from 'vitest';
import { RpcSession } from 'capnweb';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import {
  bindCapabilityIdentity,
  capabilityIdentity,
  defineCapabilities,
  defineService,
  requireScopes,
  RpcTarget,
  serveCapabilityRpc,
  verifyAuthenticationToken,
} from './index.js';
import { capabilityRpcSession, createCapabilityTokenProvider, capabilityTokenCacheKey } from './client.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { memoryRpcTransportPair, memoryCapabilityTokenCache } from '../testing/index.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('service-plane RPC', () => {
  it('runs a Cap\'n Web service with scope-gated methods over an in-memory transport', async () => {
    const keys = await testKeys();
    const exampleCapabilities = defineCapabilities({
      scopes: [
        { id: 'example.users.lookup', title: 'Lookup users' },
        { id: 'example.sync.run', title: 'Run sync' },
      ],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [exampleCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['example.users.lookup', 'example.sync.run'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });

    class ScopedExample extends RpcTarget {
      async lookupUser(email: string) {
        const me = requireScopes(this, 'example.users.lookup');
        return { caller: me.serviceId, email };
      }
      async runSync() {
        requireScopes(this, 'example.sync.run');
        return { ok: true };
      }
      async whoami() {
        return capabilityIdentity(this)?.serviceId;
      }
    }

    class PublicExample extends RpcTarget {
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

    const service = defineService({
      capabilities: exampleCapabilities,
      exports: [
        {
          factory: () => new PublicExample(),
          id: 'public',
          scopes: ['example.users.lookup', 'example.sync.run'],
          visibility: 'public',
        },
      ],
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    // Wire an in-memory transport pair directly to the service factory. This
    // mirrors what `serveCapabilityRpc` would do on Cloudflare Workers but
    // keeps the test transport-agnostic.
    const { left, right } = memoryRpcTransportPair();
    const root = service.exports[0]!.factory({});
    new RpcSession(right, root);

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['example.users.lookup', 'example.sync.run'],
      targetServiceId: 'example',
    });

    interface ExampleRoot {
      authenticate(token: string): {
        lookupUser(email: string): Promise<{ caller: string; email: string }>;
        runSync(): Promise<{ ok: true }>;
        whoami(): Promise<string | undefined>;
      };
    }

    const stub = await capabilityRpcSession<ExampleRoot['authenticate'] extends (token: string) => infer S ? S : never>({
      callerServiceId: 'moco',
      requestToken: async () => issued,
      scopes: ['example.users.lookup', 'example.sync.run'],
      targetServiceId: 'example',
      transport: { kind: 'custom', transport: left },
    });

    await expect(stub.lookupUser('a@example.com')).resolves.toEqual({ caller: 'moco', email: 'a@example.com' });
    await expect(stub.runSync()).resolves.toEqual({ ok: true });
    await expect(stub.whoami()).resolves.toBe('moco');
  });

  it('rejects calls that lack the required scope', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [
        { id: 'example.users.lookup' },
        { id: 'example.users.write' },
      ],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['example.users.lookup'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });

    class Scoped extends RpcTarget {
      async write() {
        requireScopes(this, 'example.users.write');
        return 'wrote';
      }
    }
    class Public extends RpcTarget {
      async authenticate(token: string) {
        const identity = await verifyAuthenticationToken(token, {
          expectedAudience: 'example',
          issuer: 'control-plane',
          jwks: { keys: [keys.publicJwk] },
          now: VERIFIED_AT,
        });
        return bindCapabilityIdentity(new Scoped(), identity);
      }
    }

    const { left, right } = memoryRpcTransportPair();
    new RpcSession(right, new Public());
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'moco',
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });

    interface Api { write(): Promise<string>; }
    const stub = await capabilityRpcSession<Api>({
      callerServiceId: 'moco',
      requestToken: async () => issued,
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
      transport: { kind: 'custom', transport: left },
    });

    await expect(stub.write()).rejects.toThrow(/Missing Service-Plane capability scope/);
  });

  it('caches capability tokens across calls', async () => {
    let issuedCount = 0;
    const provider = createCapabilityTokenProvider({
      callerServiceId: 'moco',
      now: () => ISSUED_AT,
      requestToken: async () => {
        issuedCount += 1;
        return { expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: `token-${issuedCount}` };
      },
      scopes: ['example.users.lookup'],
      targetServiceId: 'example',
    });

    expect(await provider.token()).toBe('token-1');
    expect(await provider.token()).toBe('token-1');
    expect(issuedCount).toBe(1);
  });

  it('shares cached tokens across providers via a CapabilityTokenCache', async () => {
    let now = new Date('2026-05-09T12:00:00.000Z');
    const cache = memoryCapabilityTokenCache(() => now.getTime());
    let issuedCount = 0;
    const requestToken = async () => {
      issuedCount += 1;
      return { expiresAt: new Date('2026-05-09T12:05:00.000Z'), token: `token-${issuedCount}` };
    };
    const a = createCapabilityTokenProvider({ cache, callerServiceId: 'moco', now: () => now, requestToken, scopes: ['example.users.lookup'], targetServiceId: 'example' });
    const b = createCapabilityTokenProvider({ cache, callerServiceId: 'moco', now: () => now, requestToken, scopes: ['example.users.lookup'], targetServiceId: 'example' });

    await expect(a.token()).resolves.toBe('token-1');
    await expect(b.token()).resolves.toBe('token-1');
    expect(issuedCount).toBe(1);

    now = new Date('2026-05-09T12:04:55.000Z');
    await expect(b.token()).resolves.toBe('token-2');
    expect(issuedCount).toBe(2);
  });

  it('builds stable token cache keys regardless of scope order', () => {
    expect(
      capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['b', 'a'], targetServiceId: 'example' }),
    ).toBe(
      capabilityTokenCacheKey({ callerServiceId: 'moco', scopes: ['a', 'b'], targetServiceId: 'example' }),
    );
  });

  it('serves the discovery document from the HTTP fetch handler', async () => {
    const exampleCapabilities = defineCapabilities({
      scopes: [{ id: 'example.users.lookup' }],
      serviceId: 'example',
    });
    const service = defineService({
      capabilities: exampleCapabilities,
      exports: [
        { factory: () => new RpcTarget(), id: 'public', scopes: ['example.users.lookup'], visibility: 'public' },
      ],
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    const handler = serveCapabilityRpc(service);
    const response = await handler(new Request('https://example.internal/.well-known/service-plane/services.json'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; exports: { visibility: string }[] };
    expect(body.id).toBe('example');
    expect(body.exports).toEqual([{ scopes: ['example.users.lookup'], visibility: 'public' }]);
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
