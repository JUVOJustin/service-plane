import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  abilityMethod,
  abilitySession,
  cloudflareServiceBindingRpc,
  defineAbility,
  defineCapabilities,
  RpcTarget,
  requireScopes,
  ServicePlaneService,
} from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import { type ConnInfo, SERVICE_PLANE_CONN_INFO_HEADER } from '../shared/conn-info.js';
import { createControlPlaneRpcBroker } from './broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { cloudflareServiceBinding } from './endpoints.js';

const ISSUED_AT = new Date('2026-07-24T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-07-24T12:00:01.000Z');
const CLIENT: ConnInfo = { remote: { address: '203.0.113.7', addressType: 'IPv4', port: 44_321, transport: 'tcp' } } as ConnInfo;

class AuditApi extends RpcTarget {
  constructor(private readonly connInfo: ConnInfo | undefined) {
    super();
  }

  async whoCalled(_input: Record<string, never>) {
    requireScopes(this, 'audit.read');
    return { address: this.connInfo?.remote.address ?? null, port: this.connInfo?.remote.port ?? null };
  }
}

async function createFixture(options: { ingress?: boolean; nativeRpc?: boolean } = {}) {
  const keys = await testKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'audit.read' }], serviceId: 'audit' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'control-plane', scopes: ['audit.read'], target: 'audit' }] }),
    issuer: 'control-plane',
    keyId: 'test-key',
    now: () => ISSUED_AT,
    privateJwk: keys.privateJwk,
  });

  const service = new ServicePlaneService({
    abilities: [
      defineAbility({
        access: 'plane',
        exposure: 'published',
        id: 'audit.calls',
        methods: {
          whoCalled: abilityMethod({
            input: z.object({}),
            output: z.object({ address: z.string().nullable(), port: z.number().nullable() }),
            scopes: ['audit.read'],
          }),
        },
        rpc: { transports: options.nativeRpc ? ['http-batch', 'cloudflare-binding-rpc'] : ['http-batch'] },
        scopes: ['audit.read'],
        // The handler factory is the only place connection info is offered to service code.
        handler: ({ connInfo }) => new AuditApi(connInfo) as AuditApi & Record<string, unknown>,
      }),
    ],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'audit',
    ...(options.ingress === false ? {} : { ingress: { brokerServiceIds: ['control-plane'] } }),
    title: 'Audit',
    version: '0.1.0',
  });

  const endpoint = cloudflareServiceBinding({
    ...(options.nativeRpc
      ? { abilityRpc: { connectAbility: (input: Parameters<typeof service.connectAbility>[0]) => service.connectAbility(input) } }
      : {}),
    binding: { fetch: async (request: Request) => service.fetch(request) },
    id: 'audit',
    origin: 'https://audit.internal',
  });

  return { endpoint, issuer, keys, service };
}

type Brokered = {
  connect(scopes: string[]): Promise<{ whoCalled(input: Record<string, never>): Promise<{ address: string | null; port: number | null }> }>;
};

async function brokeredCall(fixture: Awaited<ReturnType<typeof createFixture>>, connInfo: ConnInfo | undefined) {
  const broker = createControlPlaneRpcBroker({
    ...(connInfo ? { connInfo } : {}),
    controlPlaneServiceId: 'control-plane',
    issuer: fixture.issuer,
    services: [fixture.endpoint],
  });
  const root = broker.rootCapability({ id: 'user-1', kind: 'user' }) as unknown as {
    ability(serviceId: string, abilityId: string): Promise<Brokered>;
  };
  const api = await (await root.ability('audit', 'audit.calls')).connect(['audit.read']);
  return api.whoCalled({});
}

describe('forwarded connection info', () => {
  it('reaches an ingress-protected handler over HTTP-batch', async () => {
    const fixture = await createFixture();
    await expect(brokeredCall(fixture, CLIENT)).resolves.toEqual({ address: '203.0.113.7', port: 44_321 });
  });

  it('reaches an ingress-protected handler over native binding RPC', async () => {
    const fixture = await createFixture({ nativeRpc: true });
    await expect(brokeredCall(fixture, CLIENT)).resolves.toEqual({ address: '203.0.113.7', port: 44_321 });
  });

  it('stays absent when the plane forwards nothing', async () => {
    const fixture = await createFixture();
    await expect(brokeredCall(fixture, undefined)).resolves.toEqual({ address: null, port: null });
  });

  it('is withheld from handlers when the service does not require ingress', async () => {
    // Without ingress the service has no proof its peer is the broker, so a forwarded value is
    // indistinguishable from one a direct caller invented.
    const fixture = await createFixture({ ingress: false });
    await expect(brokeredCall(fixture, CLIENT)).resolves.toEqual({ address: null, port: null });
  });

  it('ignores a header a direct caller sets for itself', async () => {
    const fixture = await createFixture({ ingress: false });
    const spoofing = {
      fetch: async (request: Request) => {
        const forged = new Request(request);
        forged.headers.set(SERVICE_PLANE_CONN_INFO_HEADER, '{"address":"198.51.100.9","addressType":"IPv4"}');
        return fixture.service.fetch(forged);
      },
    };
    const api = await abilitySession<{ whoCalled(input: Record<string, never>): Promise<{ address: string | null }> }>({
      abilityId: 'audit.calls',
      callerServiceId: 'control-plane',
      requestToken: (input) => fixture.issuer.issueCapabilityToken(input),
      scopes: ['audit.read'],
      targetServiceId: 'audit',
      transport: cloudflareServiceBindingRpc(spoofing, '/rpc/audit.calls', 'https://audit.internal'),
    });

    await expect(api.whoCalled({})).resolves.toEqual({ address: null, port: null });
  });
});

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { privateJwk, publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key') };
}
