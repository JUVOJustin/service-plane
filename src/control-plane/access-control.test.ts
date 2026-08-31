import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAbilityBuilder } from '../service/ability.js';
import { defineCapabilities } from '../service/capabilities.js';
import { createAbilityClient, createBrokeredAbilityClient } from '../service/client.js';
import { defineAbility } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import type { CapabilityJwks } from '../shared/types.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { type BrokerCaller, createControlPlaneRpcBroker } from './broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './capabilities.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');
const SINCE = '2026-05-09T00:00:00.000Z';

// One service-only ability shared by every test: published so MCP can project it, which is exactly
// the shape where `exposure` and `access` must stay independent decisions.
function defineSyncAbility(onHandlerRun?: () => void) {
  const ability = createAbilityBuilder();
  return defineAbility({
    access: 'service',
    exposure: 'published',
    id: 'internal.sync',
    methods: {
      run: ability
        .method({ mcp: { name: 'internal_sync_run' }, scopes: ['internal.sync.run'] })
        .input(z.object({ since: z.string() }))
        .output(z.object({ caller: z.string(), since: z.string() }))
        .handler(({ context, input }) => {
          onHandlerRun?.();
          return { caller: context.identity.serviceId, since: input.since };
        }),
    },
    rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
    scopes: ['internal.sync.run'],
  });
}

async function createDirectFixture() {
  const keys = await testKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'internal.sync.run' }], serviceId: 'internal' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({
      grants: [
        { caller: 'control-plane', scopes: ['internal.sync.run'], target: 'internal' },
        { caller: 'worker-a', scopes: ['internal.sync.run'], target: 'internal' },
      ],
    }),
    issuer: 'control-plane',
    now: () => ISSUED_AT,
    privateJwks: [keys.privateJwk],
  });
  let handlerRuns = 0;
  const sync = defineSyncAbility(() => {
    handlerRuns += 1;
  });
  const service = new ServicePlaneService({
    abilities: [sync],
    auth: {
      issuer: 'control-plane',
      jwks: { keys: [keys.publicJwk] },
      now: () => VERIFIED_AT,
    },
    capabilities,
    id: 'internal',
    logger: false,
    title: 'Internal',
    version: '1.0.0',
  });
  const broker = createControlPlaneRpcBroker({
    controlPlaneServiceId: 'control-plane',
    issuer,
    services: [
      {
        abilityRpc: {
          invokeAbility: (input) => service.invokeAbility(input),
        },
        fetch: async (request) => service.fetch(request),
        id: 'internal',
        origin: 'https://internal.example',
      },
    ],
  });
  const directClient = (issued: { expiresAt: Date; token: string }) =>
    createAbilityClient({
      ability: sync,
      callerServiceId: 'worker-a',
      requestToken: async () => issued,
      scopes: ['internal.sync.run'],
      targetServiceId: 'internal',
      transport: {
        fetch: { fetch: async (request) => service.fetch(request) },
        origin: 'https://internal.example',
        type: 'fetch',
      },
    });
  return { broker, directClient, handlerRuns: () => handlerRuns, issuer };
}

async function createPlaneFixture(caller: BrokerCaller) {
  const capabilities = defineCapabilities({ scopes: [{ id: 'internal.sync.run' }], serviceId: 'internal' });
  const sync = defineSyncAbility();
  let plane: ServicePlaneControlPlane | undefined;
  const service = new ServicePlaneService({
    abilities: [sync],
    auth: {
      issuer: 'control-plane',
      jwks: async () => {
        if (!plane) throw new Error('Control plane is not initialized');
        const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
        return response.json() as Promise<CapabilityJwks>;
      },
    },
    capabilities,
    id: 'internal',
    logger: false,
    title: 'Internal',
    version: '1.0.0',
  });
  const signingSecret = await generateCapabilitySigningSecret();
  plane = new ServicePlaneControlPlane({
    broker: { caller: () => caller },
    controlPlaneServiceId: 'control-plane',
    log: false,
    mcp: { caller: () => caller },
    openapi: false,
    services: () => [
      cloudflareServiceBinding({
        abilityRpc: {
          invokeAbility: (input) => service.invokeAbility(input),
        },
        binding: { fetch: async (request) => service.fetch(request) },
        grants: [
          { caller: 'control-plane', scopes: ['internal.sync.run'] },
          { caller: caller.id, scopes: ['internal.sync.run'] },
        ],
        id: 'internal',
        origin: 'https://internal.internal',
      }),
    ],
    signingKeys: () => [{ kid: 'test-key', secret: signingSecret }],
  });
  const resolvedPlane = plane;
  const brokeredClient = createBrokeredAbilityClient({
    ability: sync,
    scopes: ['internal.sync.run'],
    targetServiceId: 'internal',
    transport: {
      fetch: async (url, init) => resolvedPlane.fetch(new Request(url, init)),
      origin: 'https://plane.internal',
    },
  });
  const mcpToolCall = async (id: number) =>
    resolvedPlane.fetch(
      new Request('https://plane.internal/rpc/mcp', {
        body: JSON.stringify({
          id,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { since: SINCE }, name: 'internal_sync_run' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
  return { brokeredClient, mcpToolCall };
}

describe('access: service enforcement at the broker', () => {
  it('refuses a user caller for a service-access ability discovered from the catalog', async () => {
    const { broker, handlerRuns } = await createDirectFixture();
    await expect(
      broker.callAbility({
        abilityId: 'internal.sync',
        caller: { id: 'user-1', kind: 'user' },
        input: { since: SINCE },
        method: 'run',
        scopes: ['internal.sync.run'],
        targetServiceId: 'internal',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('requires service access'), status: 403 });
    expect(handlerRuns()).toBe(0);
  });

  it('refuses a plane-owned broker call with no caller at all', async () => {
    const { broker, handlerRuns } = await createDirectFixture();
    await expect(
      broker.callAbility({
        abilityId: 'internal.sync',
        input: { since: SINCE },
        method: 'run',
        scopes: ['internal.sync.run'],
        targetServiceId: 'internal',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('requires service access'), status: 403 });
    expect(handlerRuns()).toBe(0);
  });

  it('brokers the same ability for a service caller', async () => {
    const { broker, handlerRuns } = await createDirectFixture();
    await expect(
      broker.callAbility({
        abilityId: 'internal.sync',
        caller: { id: 'worker-a', kind: 'service' },
        input: { since: SINCE },
        method: 'run',
        scopes: ['internal.sync.run'],
        targetServiceId: 'internal',
      }),
    ).resolves.toEqual({ caller: 'worker-a', since: SINCE });
    expect(handlerRuns()).toBe(1);
  });
});

describe('access: service enforcement at the service', () => {
  // The service, not the plane's catalog, is the authority on its own `access`: a plane-class token
  // with the right issuer, audience, and scopes is still refused before the handler runs.
  it('refuses a direct call whose token carries plane caller access despite valid scopes', async () => {
    const { directClient, handlerRuns, issuer } = await createDirectFixture();
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'plane',
      callerServiceId: 'worker-a',
      scopes: ['internal.sync.run'],
      targetServiceId: 'internal',
    });
    const error = await directClient(issued)
      .run({ since: SINCE })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'capability_auth', status: 403 });
    expect((error as Error).message).toContain('callable by services only');
    expect(handlerRuns()).toBe(0);
  });

  it('serves the same ability for a token minted with service caller access', async () => {
    const { directClient, handlerRuns, issuer } = await createDirectFixture();
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'worker-a',
      scopes: ['internal.sync.run'],
      targetServiceId: 'internal',
    });
    await expect(directClient(issued).run({ since: SINCE })).resolves.toEqual({ caller: 'worker-a', since: SINCE });
    expect(handlerRuns()).toBe(1);
  });
});

describe('access: service enforcement at the control-plane mounts', () => {
  it('refuses a non-service caller on the mounted broker endpoint', async () => {
    const { brokeredClient } = await createPlaneFixture({ id: 'user-1', kind: 'user' });
    await expect(brokeredClient.run({ since: SINCE })).rejects.toMatchObject({ code: 'capability_auth', status: 403 });
  });

  it('refuses an MCP tool backed by a service-access ability for a non-service caller', async () => {
    const { mcpToolCall } = await createPlaneFixture({ id: 'user-1', kind: 'user' });
    const denied = await mcpToolCall(1);
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: -32603, data: { status: 403 } },
      id: 1,
    });
  });

  it('serves the mounted broker endpoint and the MCP tool for a service caller', async () => {
    const { brokeredClient, mcpToolCall } = await createPlaneFixture({ id: 'gateway-svc', kind: 'service' });
    await expect(brokeredClient.run({ since: SINCE })).resolves.toEqual({ caller: 'gateway-svc', since: SINCE });
    const allowed = await mcpToolCall(2);
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      id: 2,
      result: { structuredContent: { caller: 'gateway-svc', since: SINCE } },
    });
  });
});
