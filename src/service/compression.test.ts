import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { ServicePlaneControlPlane } from '../control-plane/control-plane.js';
import { testKeys } from '../test-support/index.js';
import { createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient, createBrokeredAbilityClient } from './client.js';
import { defineAbility, serviceDiscoveryDocument } from './discovery.js';
import { ServicePlaneService } from './service.js';

const value = 'compressible payload '.repeat(256);

/** Captures actual wire headers while exercising the public client and endpoint options. */
async function compressionFixture(target: 'service' | 'plane', batch: boolean) {
  const keys = await testKeys();
  const secret = keys.privateJwk.d;
  if (!secret) throw new Error('compression test requires a signing key');
  const capabilities = defineCapabilities({ scopes: [{ id: 'echo.read' }], serviceId: 'echo' });
  const method = createAbilityBuilder();
  const ability = defineAbility({
    id: 'echo.messages',
    methods: {
      echo: method.method({
        handler: ({ input }) => input,
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
        scopes: ['echo.read'],
      }),
      stream: method.stream({
        handler: async function* () {
          yield { value };
        },
        input: z.object({}),
        output: z.object({ value: z.string() }),
        scopes: ['echo.read'],
      }),
    },
    rpc: { transports: ['fetch'] },
    scopes: ['echo.read'],
  });
  const wire = { batch: true, compression: { request: true, response: { encodings: ['gzip'] as const, threshold: 0 } } };
  const service = new ServicePlaneService({
    abilities: [ability],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
    capabilities,
    id: 'echo',
    ingress: false,
    logger: false,
    rpc: wire,
    title: 'Echo',
    version: '1.0.0',
  });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'frontend', scopes: ['echo.read'], target: 'echo' }] }),
    issuer: 'control-plane',
    privateJwks: [keys.privateJwk],
  });
  const issued = await issuer.issueCapabilityToken({
    callerAccess: 'service',
    callerServiceId: 'frontend',
    scopes: ['echo.read'],
    targetServiceId: 'echo',
  });
  const plane = new ServicePlaneControlPlane({
    broker: wire,
    controlPlaneServiceId: 'control-plane',
    invocationMiddleware: async (context, next) => {
      context.set('servicePlaneCaller', { id: 'frontend', kind: 'service' });
      await next();
    },
    log: false,
    openapi: false,
    services: () => [
      {
        discovery: () => serviceDiscoveryDocument(service.definition),
        fetch: async (request: Request) => service.fetch(request),
        grants: [{ caller: 'frontend', scopes: ['echo.read'] }],
        id: 'echo',
        origin: 'https://echo.internal',
      },
    ],
    signingKeys: () => [{ kid: keys.privateJwk.kid ?? 'compression-key', secret }],
  });
  const requests: Headers[] = [];
  const responses: Headers[] = [];
  const transport = {
    batch,
    compression: { request: { encoding: 'gzip' as const, threshold: 0 }, response: { encodings: ['gzip'] as const } },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(new Headers(request.headers));
      const response = await (target === 'service' ? service : plane).fetch(request);
      responses.push(new Headers(response.headers));
      return response;
    },
    origin: 'https://compression.internal',
  };
  const client =
    target === 'service'
      ? createAbilityClient({
          ability,
          targetServiceId: 'echo',
          tokenProvider: { token: async () => issued.token },
          transport: { ...transport, type: 'fetch' },
        })
      : createBrokeredAbilityClient({ ability, targetServiceId: 'echo', transport });
  return { client, requests, responses };
}

describe.each(['service', 'plane'] as const)('%s Fetch compression', (target) => {
  it('compresses and decodes non-batched unary responses', async () => {
    const { client, requests, responses } = await compressionFixture(target, false);

    await expect(client.echo({ value })).resolves.toEqual({ value });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.get('content-encoding')).toBe('gzip');
    expect(responses[0]?.get('content-encoding')).toBe('gzip');
    expect(responses[0]?.get('vary')?.toLowerCase()).toContain('accept-encoding');
  });

  it('compresses the batch request but leaves framed batch responses uncompressed', async () => {
    const { client, requests, responses } = await compressionFixture(target, true);

    await expect(Promise.all([client.echo({ value }), client.echo({ value })])).resolves.toEqual([{ value }, { value }]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.get('content-encoding')).toBe('gzip');
    expect(responses).toHaveLength(1);
    expect(responses[0]?.get('content-type')).toContain('application/vnd.orpc.batch');
    expect(responses[0]?.get('content-encoding')).toBeNull();
  });

  it('keeps event streams uncompressed', async () => {
    const { client, responses } = await compressionFixture(target, false);
    const values = [];
    for await (const item of await client.stream({})) values.push(item);

    expect(values).toEqual([{ value }]);
    expect(responses[0]?.get('content-encoding')).toBeNull();
  });
});
