import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAbilityBuilder } from '../service/ability.js';
import { defineCapabilities } from '../service/capabilities.js';
import { createBrokeredAbilityClient } from '../service/client.js';
import { defineAbility } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import type { CapabilityJwks } from '../shared/types.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH, SERVICE_PLANE_CAPABILITY_TOKEN_PATH, SERVICE_PLANE_MCP_PATH } from '../shared/types.js';
import { type BrokerCallerResolver, ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

const BROKER_PATH = 'https://plane.internal/rpc/broker/call';
const MCP_PATH = `https://plane.internal${SERVICE_PLANE_MCP_PATH}`;

function stubEndpoint() {
  return cloudflareServiceBinding({
    binding: { fetch: async () => Response.json({}) },
    grants: [{ caller: 'headless-front', scopes: ['tasks.read'] }],
    id: 'tasks',
  });
}

describe('fail-closed caller resolution', () => {
  it('fails closed with 500 on broker and MCP endpoints when no caller resolver is configured', async () => {
    // Misconfiguration is logged straight to console.error so it surfaces even without a log sink.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let serviceCalls = 0;
      const plane = new ServicePlaneControlPlane({
        broker: {},
        log: false,
        mcp: {},
        openapi: false,
        services: () => {
          serviceCalls += 1;
          return [stubEndpoint()];
        },
        signingKeys: async () => [{ kid: 'test-key', secret: await generateCapabilitySigningSecret() }],
      });

      const broker = await plane.fetch(new Request(BROKER_PATH, { method: 'POST' }));
      expect(broker.status).toBe(500);
      await expect(broker.json()).resolves.toEqual({ error: 'Service-Plane broker caller authentication is not configured' });

      const mcp = await plane.fetch(new Request(MCP_PATH, { method: 'POST' }));
      expect(mcp.status).toBe(500);
      await expect(mcp.json()).resolves.toEqual({ error: 'Service-Plane broker caller authentication is not configured' });

      // Fail closed before any service work: a refused request must not trigger discovery.
      expect(serviceCalls).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('refuses with a generic 403 when the caller resolver returns undefined', async () => {
    let serviceCalls = 0;
    const refuse: BrokerCallerResolver = () => undefined;
    const plane = new ServicePlaneControlPlane({
      broker: { caller: refuse },
      log: false,
      mcp: { caller: refuse },
      openapi: false,
      services: () => {
        serviceCalls += 1;
        return [stubEndpoint()];
      },
      signingKeys: async () => [{ kid: 'test-key', secret: await generateCapabilitySigningSecret() }],
    });

    const broker = await plane.fetch(new Request(BROKER_PATH, { method: 'POST' }));
    const mcp = await plane.fetch(new Request(MCP_PATH, { method: 'POST' }));
    for (const response of [broker, mcp]) {
      expect(response.status).toBe(403);
      // A generic refusal: no invented auth scheme leaks how the plane authenticates callers.
      expect(response.headers.get('www-authenticate')).toBeNull();
      await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    }
    expect(serviceCalls).toBe(0);
  });

  it('passes a resolver-owned authentication challenge through unchanged', async () => {
    let serviceCalls = 0;
    let signingKeyCalls = 0;
    const reject: BrokerCallerResolver = (context) =>
      context.json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="service-plane"' });
    const plane = new ServicePlaneControlPlane({
      broker: { caller: reject },
      log: false,
      mcp: { caller: reject },
      openapi: false,
      services: () => {
        serviceCalls += 1;
        return [stubEndpoint()];
      },
      signingKeys: async () => {
        signingKeyCalls += 1;
        return [{ kid: 'test-key', secret: await generateCapabilitySigningSecret() }];
      },
    });

    const broker = await plane.fetch(new Request(BROKER_PATH, { method: 'POST' }));
    const mcp = await plane.fetch(new Request(MCP_PATH, { method: 'POST' }));
    for (const response of [broker, mcp]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="service-plane"');
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    }
    // Refused callers cost nothing: neither discovery nor signing material is touched.
    expect(serviceCalls).toBe(0);
    expect(signingKeyCalls).toBe(0);
  });

  it('fails closed with 500 on the token endpoint when caller authentication is not configured', async () => {
    const plane = new ServicePlaneControlPlane({
      log: false,
      openapi: false,
      services: () => [stubEndpoint()],
      signingKeys: async () => [{ kid: 'test-key', secret: await generateCapabilitySigningSecret() }],
    });

    const response = await plane.fetch(
      new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify({ scopes: ['tasks.read'], targetServiceId: 'tasks' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Service-Plane caller authentication is not configured' });
  });

  it('brokers the same call once a caller resolver is configured', async () => {
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'tasks.items',
      methods: {
        get: ability
          .method({ scopes: ['tasks.read'] })
          .input(z.object({ id: z.string() }))
          .output(z.object({ caller: z.string(), id: z.string() }))
          .handler(({ context, input }) => ({ caller: context.identity.serviceId, id: input.id })),
      },
      rpc: { transports: ['fetch'] },
      scopes: ['tasks.read'],
    });
    let plane: ServicePlaneControlPlane | undefined;
    const service = new ServicePlaneService({
      abilities: [tasks],
      auth: {
        issuer: 'control-plane',
        jwks: async () => {
          if (!plane) throw new Error('Control plane is not initialized');
          const response = await plane.fetch(new Request(`https://plane.internal${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
          return response.json() as Promise<CapabilityJwks>;
        },
      },
      capabilities,
      id: 'tasks',
      logger: false,
      title: 'Tasks',
      version: '1.0.0',
    });
    const signingSecret = await generateCapabilitySigningSecret();
    plane = new ServicePlaneControlPlane({
      broker: { caller: () => ({ id: 'headless-front', kind: 'service' }) },
      controlPlaneServiceId: 'control-plane',
      log: false,
      mcp: false,
      openapi: false,
      services: () => [
        cloudflareServiceBinding({
          binding: { fetch: async (request) => service.fetch(request) },
          grants: [{ caller: 'headless-front', scopes: ['tasks.read'] }],
          id: 'tasks',
          origin: 'https://tasks.internal',
        }),
      ],
      signingKeys: () => [{ kid: 'test-key', secret: signingSecret }],
    });
    const client = createBrokeredAbilityClient({
      ability: tasks,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: async (url, init) => (plane as ServicePlaneControlPlane).fetch(new Request(url, init)),
        origin: 'https://plane.internal',
      },
    });

    await expect(client.get({ id: 'task-1' })).resolves.toEqual({ caller: 'headless-front', id: 'task-1' });
  });
});
