import { RPCLink } from '@orpc/client/fetch';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapabilities } from '../service/capabilities.js';
import { createAbilityClient, createBrokeredAbilityClient } from '../service/client.js';
import { defineAbility } from '../service/discovery.js';
import { createAbilityBuilder } from '../service/orpc.js';
import { ServicePlaneService } from '../service/service.js';
import { memoryWebSocketPair } from '../test-support/index.js';
import type { CapabilityJwks } from '../shared/types.js';
import { SERVICE_PLANE_CAPABILITY_JWKS_PATH } from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret } from './signing-keys.js';

describe('oRPC control-plane broker', () => {
  it('keeps the control plane as the only public endpoint for typed unary and streaming calls', async () => {
    const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
    const ability = createAbilityBuilder();
    const tasks = defineAbility({
      access: 'plane',
      exposure: 'published',
      id: 'tasks.items',
      methods: {
        get: ability
          .procedure({ mcp: { name: 'tasks_get' }, scopes: ['tasks.read'] })
          .input(z.object({ id: z.string() }))
          .output(z.object({ caller: z.string(), id: z.string() }))
          .handler(({ context, input }) => ({ caller: context.identity.serviceId, id: input.id })),
        watch: ability
          .stream(z.object({ sequence: z.number() }), {
            mcp: { name: 'tasks_watch' },
            scopes: ['tasks.read'],
          })
          .input(z.object({ after: z.number() }))
          .handler(async function* ({ input }) {
            yield { sequence: input.after + 1 };
            yield { sequence: input.after + 2 };
          }),
      },
      rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
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
      ingress: { brokerServiceIds: ['control-plane'] },
      logger: false,
      title: 'Tasks',
      version: '1.0.0',
    });
    const signingSecret = await generateCapabilitySigningSecret();
    const [planeClientSocket, planeServerSocket] = memoryWebSocketPair();
    const upgradeWebSocket = (async (_context: unknown, events: { onMessage?: (event: unknown, socket: unknown) => void }) => {
      planeServerSocket.addEventListener('message', (event) => {
        void events.onMessage?.(event as never, planeServerSocket as never);
      });
      return new Response(null, { status: 200 });
    }) as unknown as UpgradeWebSocket;
    plane = new ServicePlaneControlPlane({
      broker: { caller: () => ({ id: 'headless-front', kind: 'service' }), upgradeWebSocket },
      controlPlaneServiceId: 'control-plane',
      log: false,
      mcp: { caller: () => ({ id: 'headless-front', kind: 'service' }) },
      openapi: false,
      services: () => [
        cloudflareServiceBinding({
          abilityRpc: {
            invokeAbility: (input) => service.invokeAbility(input),
          },
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

    const malformedBrokerLink = new RPCLink({
      fetch: async (url, init) => (plane as ServicePlaneControlPlane).fetch(new Request(url, init)),
      origin: 'https://plane.internal',
      url: '/rpc/broker',
    });
    await expect(malformedBrokerLink.call(['call'], {}, { context: {} })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(client.get({ id: 'task-1' })).resolves.toEqual({ caller: 'headless-front', id: 'task-1' });
    const directToken = await plane.issueCapabilityTokenForCaller(
      'headless-front',
      { scopes: ['tasks.read'], targetServiceId: 'tasks' },
      {},
    );
    const directClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      requestToken: async () => directToken,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: { fetch: async (request) => service.fetch(request) },
        origin: 'https://tasks.internal',
        type: 'fetch',
      },
    });
    await expect(directClient.get({ id: 'bypass' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stream = await client.watch({ after: 8 });
    const values = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([{ sequence: 9 }, { sequence: 10 }]);

    await plane.fetch(
      new Request('https://plane.internal/rpc/broker/ws', {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      }),
    );
    const webSocketClient = createBrokeredAbilityClient({
      ability: tasks,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        createWebSocket: () => planeClientSocket as unknown as WebSocket,
        type: 'websocket',
        url: 'wss://plane.internal/rpc/broker/ws',
      },
    });
    await expect(webSocketClient.get({ id: 'task-ws' })).resolves.toEqual({ caller: 'headless-front', id: 'task-ws' });
    const webSocketStream = await webSocketClient.watch({ after: 20 });
    const webSocketValues = [];
    for await (const value of webSocketStream) webSocketValues.push(value);
    expect(webSocketValues).toEqual([{ sequence: 21 }, { sequence: 22 }]);

    const mcp = await plane.fetch(
      new Request('https://plane.internal/rpc/mcp', {
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { id: 'task-mcp' }, name: 'tasks_get' },
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(mcp.status).toBe(200);
    await expect(mcp.json()).resolves.toMatchObject({
      id: 1,
      result: {
        structuredContent: { caller: 'headless-front', id: 'task-mcp' },
      },
    });

    const streamingMcp = await plane.fetch(
      new Request('https://plane.internal/rpc/mcp', {
        body: JSON.stringify({
          id: 2,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { after: 30 }, name: 'tasks_watch' },
        }),
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(streamingMcp.status).toBe(200);
    expect(streamingMcp.headers.get('content-type')).toContain('text/event-stream');
    const events = await streamingMcp.text();
    expect(events).toContain('"items":[{"sequence":31},{"sequence":32}]');
  });
});
