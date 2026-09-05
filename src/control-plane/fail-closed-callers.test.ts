import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAbilityBuilder } from '../service/ability.js';
import { defineCapabilities } from '../service/capabilities.js';
import { createBrokeredAbilityClient } from '../service/client.js';
import { defineAbility } from '../service/discovery.js';
import { ServicePlaneService } from '../service/service.js';
import type { CapabilityJwks, ServiceDiscoveryDocument } from '../shared/types.js';
import {
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_MCP_PATH,
} from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

const BROKER_PATH = 'https://plane.internal/rpc/v1/broker/call';
const MCP_PATH = `https://plane.internal${SERVICE_PLANE_MCP_PATH}`;

const discovery: ServiceDiscoveryDocument = {
  abilities: [
    {
      access: 'plane',
      exposure: 'published',
      id: 'tasks.items',
      methods: {
        get: {
          inputSchema: { type: 'object' },
          mcp: { name: 'tasks_get' },
          outputSchema: { type: 'object' },
          scopes: ['tasks.read'],
        },
      },
      rpc: { path: '/rpc/v1/tasks.items', transports: ['fetch'] },
      scopes: ['tasks.read'],
    },
  ],
  capabilities: { scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' },
  id: 'tasks',
  title: 'Tasks',
  version: '1.0.0',
};

function stubEndpoint() {
  return cloudflareServiceBinding({
    binding: {
      fetch: async (request) => (new URL(request.url).pathname === SERVICE_DISCOVERY_PATH ? Response.json(discovery) : Response.json({})),
    },
    grants: [{ caller: 'headless-front', scopes: ['tasks.read'] }],
    id: 'tasks',
  });
}

describe('fail-closed caller resolution', () => {
  it('fails closed with 500 on broker and MCP endpoints when invocation middleware does not provide a caller', async () => {
    // Misconfiguration is logged straight to console.error so it surfaces even without a log sink.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let serviceCalls = 0;
      let signingKeyCalls = 0;
      const plane = new ServicePlaneControlPlane({
        broker: {},
        log: false,
        mcp: {},
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

      const broker = await plane.fetch(
        new Request(BROKER_PATH, { headers: { 'x-service-plane-rpc-protocol': 'service-plane-rpc/1' }, method: 'POST' }),
      );
      expect(broker.status).toBe(500);
      await expect(broker.json()).resolves.toEqual({ error: 'Service-Plane Hono invocation context is missing servicePlaneCaller' });
      expect(serviceCalls).toBe(0);

      const mcp = await plane.fetch(
        new Request(MCP_PATH, {
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
      );
      expect(mcp.status).toBe(500);
      await expect(mcp.json()).resolves.toEqual({ error: 'Service-Plane Hono invocation context is missing servicePlaneCaller' });

      // Authentication now completes before discovery for both public RPC surfaces.
      expect(serviceCalls).toBe(0);
      expect(signingKeyCalls).toBe(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('passes a generic 403 from invocation middleware through unchanged', async () => {
    let serviceCalls = 0;
    const plane = new ServicePlaneControlPlane({
      broker: {},
      invocationMiddleware: async (context) => context.json({ error: 'Forbidden' }, 403),
      log: false,
      mcp: {},
      openapi: false,
      services: () => {
        serviceCalls += 1;
        return [stubEndpoint()];
      },
      signingKeys: async () => [{ kid: 'test-key', secret: await generateCapabilitySigningSecret() }],
    });

    const broker = await plane.fetch(
      new Request(BROKER_PATH, { headers: { 'x-service-plane-rpc-protocol': 'service-plane-rpc/1' }, method: 'POST' }),
    );
    const mcp = await plane.fetch(
      new Request(MCP_PATH, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    for (const response of [broker, mcp]) {
      expect(response.status).toBe(403);
      // A generic refusal: no invented auth scheme leaks how the plane authenticates callers.
      expect(response.headers.get('www-authenticate')).toBeNull();
      await expect(response.json()).resolves.toEqual({ error: 'Forbidden' });
    }
    expect(serviceCalls).toBe(0);
  });

  it('passes an invocation-middleware authentication challenge through unchanged', async () => {
    let serviceCalls = 0;
    let signingKeyCalls = 0;
    const plane = new ServicePlaneControlPlane({
      broker: {},
      invocationMiddleware: async (context) =>
        context.json({ error: 'Unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="service-plane"' }),
      log: false,
      mcp: {},
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

    const broker = await plane.fetch(
      new Request(BROKER_PATH, { headers: { 'x-service-plane-rpc-protocol': 'service-plane-rpc/1' }, method: 'POST' }),
    );
    const mcp = await plane.fetch(
      new Request(MCP_PATH, {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'ping' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    for (const response of [broker, mcp]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="service-plane"');
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    }
    // Refused callers never trigger discovery or signing-material derivation.
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

  it('brokers the same call once invocation middleware provides a caller', async () => {
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'tasks.items',
      methods: {
        get: ability.method({
          scopes: ['tasks.read'],
          input: z.object({ id: z.string() }),
          output: z.object({ caller: z.string(), id: z.string() }),
          handler: ({ context, input }) => ({ caller: context.identity.serviceId, id: input.id }),
        }),
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
    let authenticatedBody: string | undefined;
    plane = new ServicePlaneControlPlane({
      broker: {},
      controlPlaneServiceId: 'control-plane',
      invocationMiddleware: async (context, next) => {
        authenticatedBody = await context.req.raw.text();
        context.set('servicePlaneCaller', { id: 'headless-front', kind: 'service' });
        await next();
      },
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
    expect(authenticatedBody).toContain('task-1');
  });
});
