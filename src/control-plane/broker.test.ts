import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  abilityMethod,
  defineAbility,
  defineCapabilities,
  RpcTarget,
  requireScopes,
  type ServicePlaneLogEvent,
  ServicePlaneService,
} from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import type { ServicePlaneBrokerLogEvent } from '../shared/logging.js';
import { brokerCallerSubject, createControlPlaneRpcBroker } from './broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { cloudflareServiceBinding } from './endpoints.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('control-plane RPC broker', () => {
  it('mints a token and brokers a published plane-access ability stub', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.events.ingest' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['example.events.ingest'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });

    const ingestAbility = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'example.events',
      methods: {
        ingest: abilityMethod({
          input: z.object({ payload: z.string() }),
          output: z.object({ caller: z.string(), payload: z.string() }),
          scopes: ['example.events.ingest'],
        }),
      },
      scopes: ['example.events.ingest'],
      handler: () => new PublicApi() as PublicApi & Record<string, unknown>,
    });

    const service = new ServicePlaneService({
      abilities: [ingestAbility],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
    });

    type Brokered = {
      connect(scopes: string[]): Promise<{ ingest(input: { payload: string }): Promise<{ caller: string; payload: string }> }>;
    };
    const root = broker.rootCapability() as unknown as { ability(serviceId: string, abilityId: string): Promise<Brokered> };
    const brokered = await root.ability('example', 'example.events');
    const api = await brokered.connect(['example.events.ingest']);

    await expect(api.ingest({ payload: 'hello' })).resolves.toEqual({ caller: 'control-plane', payload: 'hello' });
  });

  it('propagates the plane request id to the service and emits broker log events', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.events.ingest' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['example.events.ingest'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });

    const ingestAbility = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'example.events',
      methods: {
        ingest: abilityMethod({
          input: z.object({ payload: z.string() }),
          output: z.object({ caller: z.string(), payload: z.string() }),
          scopes: ['example.events.ingest'],
        }),
      },
      scopes: ['example.events.ingest'],
      handler: () => new PublicApi() as PublicApi & Record<string, unknown>,
    });

    const serviceEvents: ServicePlaneLogEvent[] = [];
    const service = new ServicePlaneService({
      abilities: [ingestAbility],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'example',
      logger: { log: (event) => serviceEvents.push(event) },
      title: 'Example',
      version: '0.1.0',
    });

    const seenRequests: Request[] = [];
    const brokerEvents: ServicePlaneBrokerLogEvent[] = [];
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      log: (event) => brokerEvents.push(event),
      requestId: 'req-abc-123',
      services: [
        cloudflareServiceBinding({
          binding: {
            fetch: (request) => {
              seenRequests.push(request);
              return service.fetch(request);
            },
          },
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
    });

    type Brokered = {
      connect(scopes: string[]): Promise<{ ingest(input: { payload: string }): Promise<{ caller: string; payload: string }> }>;
    };
    const root = broker.rootCapability({ id: 'gateway', kind: 'user' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<Brokered>;
    };
    const brokered = await root.ability('example', 'example.events');
    const api = await brokered.connect(['example.events.ingest']);
    await expect(api.ingest({ payload: 'hello' })).resolves.toEqual({ caller: 'control-plane', payload: 'hello' });

    const rpcRequest = seenRequests.find((request) => new URL(request.url).pathname === '/rpc/example.events');
    expect(rpcRequest?.headers.get('X-Request-Id')).toBe('req-abc-123');
    expect(serviceEvents).toContainEqual(expect.objectContaining({ event: 'service_plane.request.completed', requestId: 'req-abc-123' }));
    expect(brokerEvents).toContainEqual(
      expect.objectContaining({
        abilityId: 'example.events',
        callerId: 'gateway',
        event: 'service_plane.broker.connect.completed',
        requestId: 'req-abc-123',
        serviceId: 'example',
      }),
    );

    await expect(brokered.connect(['example.events.unknown'])).rejects.toThrow('does not declare scope');
    expect(brokerEvents).toContainEqual(
      expect.objectContaining({ event: 'service_plane.broker.connect.failed', requestId: 'req-abc-123', status: 403 }),
    );
  });

  it('carries user callers to the service as RFC 8693 delegated subjects', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.events.ingest' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['example.events.ingest'], target: 'example' }],
      }),
      issuer: 'control-plane',
      keyId: 'test-key',
      now: () => ISSUED_AT,
      privateJwk: keys.privateJwk,
    });

    const ingestAbility = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'example.events',
      methods: {
        ingest: abilityMethod({
          input: z.object({ payload: z.string() }),
          output: z.object({ caller: z.string(), subjectId: z.string().optional(), subjectOrgId: z.string().optional() }),
          scopes: ['example.events.ingest'],
        }),
      },
      scopes: ['example.events.ingest'],
      handler: () => new SubjectEchoApi() as SubjectEchoApi & Record<string, unknown>,
    });

    const service = new ServicePlaneService({
      abilities: [ingestAbility],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });

    const brokerEvents: ServicePlaneBrokerLogEvent[] = [];
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      log: (event) => brokerEvents.push(event),
      services: [
        cloudflareServiceBinding({
          binding: { fetch: (request) => service.fetch(request) },
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
    });

    type Brokered = {
      connect(scopes: string[]): Promise<{
        ingest(input: { payload: string }): Promise<{ caller: string; subjectId?: string; subjectOrgId?: string }>;
      }>;
    };
    const root = broker.rootCapability({ id: 'user-7', kind: 'user', orgId: 'org-42' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<Brokered>;
    };
    const brokered = await root.ability('example', 'example.events');
    const api = await brokered.connect(['example.events.ingest']);

    await expect(api.ingest({ payload: 'hello' })).resolves.toEqual({
      caller: 'control-plane',
      subjectId: 'user-7',
      subjectOrgId: 'org-42',
    });
    expect(brokerEvents).toContainEqual(
      expect.objectContaining({
        callerId: 'user-7',
        callerKind: 'user',
        callerOrgId: 'org-42',
        event: 'service_plane.broker.connect.completed',
      }),
    );
  });

  it('normalizes user caller subjects at the boundary', () => {
    expect(brokerCallerSubject({ id: 'user-7', kind: 'user', orgId: '  ' })).toEqual({ id: 'user-7' });
    expect(brokerCallerSubject({ id: ' user-7 ', kind: 'user', orgId: ' org-42 ' })).toEqual({ id: 'user-7', orgId: 'org-42' });
    expect(brokerCallerSubject({ id: 'worker-a', kind: 'service' })).toBeUndefined();
    expect(() => brokerCallerSubject({ id: '   ', kind: 'user' })).toThrow('Invalid Service-Plane capability subject');
  });

  it('rejects service-access abilities without a service caller', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [defineCapabilities({ scopes: [{ id: 'example.sync.run' }], serviceId: 'example' })],
      grants: defineServiceGrants({ grants: [{ caller: 'worker-a', scopes: ['example.sync.run'], target: 'example' }] }),
      issuer: 'control-plane',
      keyId: 'test-key',
      privateJwk: keys.privateJwk,
    });
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        cloudflareServiceBinding({
          binding: { fetch: async () => Response.json(privateDiscovery) },
          id: 'example',
        }),
      ],
    });

    await expect(
      (broker.rootCapability() as unknown as { ability(serviceId: string, abilityId: string): Promise<unknown> }).ability(
        'example',
        'example.sync',
      ),
    ).rejects.toThrow('requires service access');
    await expect(
      (
        broker.rootCapability({ id: 'user-1', kind: 'user' }) as unknown as {
          ability(serviceId: string, abilityId: string): Promise<unknown>;
        }
      ).ability('example', 'example.sync'),
    ).rejects.toThrow('requires service access');
  });
});

class PublicApi extends RpcTarget {
  async ingest(input: { payload: string }) {
    const caller = requireScopes(this, 'example.events.ingest');
    return { caller: caller.serviceId, payload: input.payload };
  }
}

class SubjectEchoApi extends RpcTarget {
  async ingest(_input: { payload: string }) {
    const caller = requireScopes(this, 'example.events.ingest');
    return {
      caller: caller.serviceId,
      ...(caller.subject ? { subjectId: caller.subject.id } : {}),
      ...(caller.subject?.orgId ? { subjectOrgId: caller.subject.orgId } : {}),
    };
  }
}

const privateDiscovery = {
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

async function testKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    privateJwk,
    publicJwk: publicJwkFromPrivateJwk(privateJwk, 'test-key'),
  };
}
