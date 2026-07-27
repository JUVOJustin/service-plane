import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createControlPlaneRpcBroker } from '../control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { cloudflareServiceBinding } from '../control-plane/endpoints.js';
import { SERVICE_DISCOVERY_PATH, SERVICE_PLANE_REQUEST_ID_HEADER } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import {
  abilitySession,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  defineCapabilities,
  RpcTarget,
  requireScopes,
} from './capabilities.js';
import { type AbilityRpc, abilityMethod, defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('ServicePlaneService', () => {
  it('mounts discovery and serves a schema-backed ability over HTTP-batch', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'worker-a', scopes: ['example.sync.run'], target: 'example' }],
      }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    });

    let handlerContext:
      | {
          contentType: string | null;
          marker: unknown;
          method: string;
          path: string;
          requestIdHeader: string | undefined;
          requestIdVariable: unknown;
        }
      | undefined;
    const syncAbility = defineAbility({
      id: 'example.sync',
      methods: {
        runSync: abilityMethod({
          input: z.object({ since: z.string().optional() }),
          output: z.object({ caller: z.string(), ok: z.literal(true), since: z.string().nullable() }),
          scopes: ['example.sync.run'],
        }),
      },
      rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
      scopes: ['example.sync.run'],
      handler: ({ context }) => {
        const response = context.json({ ok: true });
        handlerContext = {
          contentType: response.headers.get('content-type'),
          marker: (context.env as { marker?: unknown } | undefined)?.marker,
          method: context.req.method,
          path: context.req.path,
          requestIdHeader: context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER),
          requestIdVariable: (context.get as (key: string) => unknown)('requestId'),
        };
        return new ExampleApi() as ExampleApi & Record<string, unknown>;
      },
    });

    const service = new ServicePlaneService({
      abilities: [syncAbility],
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

    const discovery = await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      abilities: [{ id: 'example.sync', rpc: { path: '/rpc/example.sync' }, scopes: ['example.sync.run'] }],
      id: 'example',
    });

    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
    });
    const binding = { fetch: async (request: Request) => service.fetch(request) };

    const api = await abilitySession<AbilityRpc<typeof syncAbility>>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(binding, undefined, 'https://example.internal'),
    });

    await expect(api.runSync({ since: '2026-05-09T00:00:00.000Z' })).resolves.toEqual({
      caller: 'worker-a',
      ok: true,
      since: '2026-05-09T00:00:00.000Z',
    });
    await expect(api.runSync({ since: 123 } as never)).rejects.toThrow('Invalid input');

    const nativeApi = await abilitySession<AbilityRpc<typeof syncAbility>>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      requestId: 'native-request-1',
      requestToken: async () => issued,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc({
        connectAbility: (input) => service.connectAbility(input, { marker: 'native-binding' } as never),
      }),
    });

    await expect(nativeApi.runSync({ since: '2026-05-10T00:00:00.000Z' })).resolves.toMatchObject({
      caller: 'worker-a',
      since: '2026-05-10T00:00:00.000Z',
    });
    expect(handlerContext).toEqual({
      contentType: 'application/json',
      marker: 'native-binding',
      method: 'POST',
      path: '/rpc/example.sync',
      requestIdHeader: 'native-request-1',
      requestIdVariable: 'native-request-1',
    });
  });

  it('rejects native binding RPC for abilities that do not declare it', async () => {
    const service = new ServicePlaneService({
      abilities: [
        defineAbility({
          id: 'example.http-only',
          methods: {
            run: abilityMethod({ input: z.object({}), output: z.object({ ok: z.boolean() }), scopes: ['example.sync.run'] }),
          },
          scopes: ['example.sync.run'],
          handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
        }),
      ],
      auth: { issuer: 'control-plane', jwks: { keys: [] } },
      capabilities: defineCapabilities({ scopes: [{ id: 'example.sync.run' }], serviceId: 'example' }),
      id: 'example',
      logger: false,
      title: 'Example',
      version: '0.1.0',
    });

    await expect(service.connectAbility({ abilityId: 'example.http-only', token: 'not-read' })).rejects.toMatchObject({ status: 405 });
  });

  it('blocks direct ability RPC when service-plane ingress protection is enabled', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'worker-a', scopes: ['example.sync.run'], target: 'example' }],
      }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    });
    let handlerCreations = 0;

    const syncAbility = defineAbility({
      id: 'example.sync',
      methods: {
        runSync: abilityMethod({
          input: z.object({ since: z.string().optional() }),
          output: z.object({ caller: z.string(), ok: z.literal(true), since: z.string().nullable() }),
          scopes: ['example.sync.run'],
        }),
      },
      rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
      scopes: ['example.sync.run'],
      handler: () => {
        handlerCreations += 1;
        return new ExampleApi() as ExampleApi & Record<string, unknown>;
      },
    });

    const service = new ServicePlaneService({
      abilities: [syncAbility],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'example',
      ingress: {},
      title: 'Example',
      version: '0.1.0',
    });
    const issued = await issuer.issueCapabilityToken({
      callerServiceId: 'worker-a',
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
    });
    const directBinding = { fetch: async (request: Request) => service.fetch(request) };
    const directApi = await abilitySession<AbilityRpc<typeof syncAbility>>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: cloudflareServiceBindingRpc(directBinding, undefined, 'https://example.internal'),
    });

    await expect(directApi.runSync({ since: '2026-05-09T00:00:00.000Z' })).rejects.toThrow('brokered capability token is required');
    expect(handlerCreations).toBe(0);

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        cloudflareServiceBinding({
          binding: directBinding,
          id: 'example',
          origin: 'https://example.internal',
        }),
      ],
    });
    type Brokered = {
      connect(scopes: string[]): Promise<AbilityRpc<typeof syncAbility>>;
    };
    const root = broker.rootCapability({ id: 'worker-a', kind: 'service' }) as unknown as {
      ability(serviceId: string, abilityId: string): Promise<Brokered>;
    };
    const brokered = await root.ability('example', 'example.sync');
    const brokeredApi = await brokered.connect(['example.sync.run']);

    await expect(brokeredApi.runSync({ since: '2026-05-10T00:00:00.000Z' })).resolves.toEqual({
      caller: 'worker-a',
      ok: true,
      since: '2026-05-10T00:00:00.000Z',
    });

    const nativeApi = await abilitySession<AbilityRpc<typeof syncAbility>>({
      abilityId: 'example.sync',
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['example.sync.run'],
      targetServiceId: 'example',
      transport: cloudflareNativeRpc(service),
    });

    await expect(nativeApi.runSync({ since: '2026-05-11T00:00:00.000Z' })).rejects.toThrow('brokered capability token is required');
  });

  it('emits Cache-Control and Cache-Tag headers on discovery when httpCache is enabled', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'example.sync.run' }],
      serviceId: 'example',
    });
    const syncAbility = defineAbility({
      id: 'example.sync',
      methods: {
        runSync: abilityMethod({
          input: z.object({}),
          output: z.object({ ok: z.literal(true) }),
          scopes: ['example.sync.run'],
        }),
      },
      scopes: ['example.sync.run'],
      handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
    });
    const serviceOptions = {
      abilities: [syncAbility],
      auth: { jwks: { keys: [keys.publicJwk] } },
      capabilities,
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    };

    const uncached = new ServicePlaneService(serviceOptions);
    const plainDiscovery = await uncached.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
    expect(plainDiscovery.headers.get('cache-control')).toBeNull();
    expect(plainDiscovery.headers.get('etag')).toBeTruthy();

    const cached = new ServicePlaneService({ ...serviceOptions, httpCache: { maxAgeSeconds: 60, tags: ['custom'] } });
    const discovery = await cached.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(discovery.headers.get('cache-tag')).toBe('service-plane,service-plane:discovery,service-plane:service:example,custom');

    const defaults = new ServicePlaneService({ ...serviceOptions, httpCache: true });
    const defaultDiscovery = await defaults.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
    expect(defaultDiscovery.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=300');
  });
});

class ExampleApi extends RpcTarget {
  async runSync(input: { since?: string }) {
    const caller = requireScopes(this, 'example.sync.run');
    return { caller: caller.serviceId, ok: true, since: input.since ?? null };
  }
}
