import { describe, expect, it } from 'vitest';
import { RpcSession } from 'capnweb';
import {
  bindCapabilityIdentity,
  defineCapabilities,
  defineService,
  RpcTarget,
  requireScopes,
  verifyAuthenticationToken,
} from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { createControlPlaneRpcBroker } from './broker.js';
import { memoryRpcTransportPair } from '../testing/index.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('control-plane RPC broker', () => {
  it('mints a token and brokers a stub for the requested visibility', async () => {
    const keys = await testKeys();
    const exampleCaps = defineCapabilities({
      scopes: [{ id: 'example.events.ingest' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [exampleCaps],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['example.events.ingest'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });

    class Scoped extends RpcTarget {
      async ingest(payload: string) {
        const me = requireScopes(this, 'example.events.ingest');
        return { caller: me.serviceId, payload };
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

    const service = defineService({
      capabilities: exampleCaps,
      exports: [
        { factory: () => new Public(), id: 'public', scopes: ['example.events.ingest'], visibility: 'public' },
      ],
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    // Stand up the example service on an in-memory transport pair.
    const { left: clientSide, right: serviceSide } = memoryRpcTransportPair();
    new RpcSession(serviceSide, service.exports[0]!.factory({}));

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        {
          endpoint: { id: 'example' },
          transport: { kind: 'custom', openTransport: () => clientSide },
        },
      ],
    });

    const root = broker.rootCapability();
    const brokered = root.public('example') as unknown as { connect(scopes: string[]): Promise<{ ingest(payload: string): Promise<{ caller: string; payload: string }> }> };
    const stub = await brokered.connect(['example.events.ingest']);
    await expect(stub.ingest('hello')).resolves.toEqual({ caller: 'control-plane', payload: 'hello' });
  });

  it('rejects auth/internal capabilities without an authenticated caller', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [defineCapabilities({ scopes: [{ id: 'x.scope' }], serviceId: 'x' })],
      grants: defineServiceGrants({ grants: [{ caller: 'a', scopes: ['x.scope'], target: 'x' }] }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [{ endpoint: { id: 'x', origin: 'https://x.internal' } }],
    });
    const root = broker.rootCapability();
    expect(() => root.auth('x')).toThrow(/requires an authenticated caller/);
    expect(() => root.internal('x')).toThrow(/only exposes `internal` capabilities to service callers/);
  });

  it('rejects internal access from non-service callers', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [defineCapabilities({ scopes: [{ id: 'x.scope' }], serviceId: 'x' })],
      grants: defineServiceGrants({ grants: [{ caller: 'a', scopes: ['x.scope'], target: 'x' }] }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateKey: keys.privateKey,
      publicJwk: keys.publicJwk,
    });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [{ endpoint: { id: 'x', origin: 'https://x.internal' } }],
    });
    const root = broker.rootCapability({ id: 'user-1', kind: 'user' });
    expect(() => root.internal('x')).toThrow(/`internal` capabilities to service callers/);
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
