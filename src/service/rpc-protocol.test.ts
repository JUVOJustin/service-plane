import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ServicePlaneControlPlane } from '../control-plane/control-plane.js';
import { servicePlaneErrorInfo } from '../shared/errors.js';
import { SERVICE_PLANE_RPC_PROTOCOL, SERVICE_PLANE_RPC_PROTOCOL_HEADER } from '../shared/rpc-protocol.js';
import { memoryWebSocketPair } from '../test-support/index.js';
import { AbilityHibernationStream, createAbilityBuilder } from './ability.js';
import { createAbilityClient, createBrokeredAbilityClient } from './client.js';
import { defineAbility, defineAbilityService, serviceDiscoveryDocument } from './discovery.js';
import { ServicePlaneService } from './service.js';

const builder = createAbilityBuilder();
const mutation = defineAbility({
  id: 'mutation',
  methods: { run: builder.method({ input: z.object({}), output: z.string(), handler: () => 'ok' }) },
  rpc: { transports: ['fetch', 'service-binding', 'websocket'] },
});

/** Keeps protocol refusals independent of capability validation and application work. */
function serviceFixture(app?: Hono) {
  const authorize = vi.fn(() => ({ keys: [] }));
  const service = new ServicePlaneService({
    ...(app ? { app } : {}),
    abilities: [mutation],
    auth: { jwks: authorize },
    id: 'service',
    ingress: false,
    logger: false,
    requireAbilityScopes: false,
    rpc: { manualWebSocket: true },
    title: 'Service',
    version: '7.3.2',
  });
  return { authorize, service };
}

describe('RPC wire revision boundaries', () => {
  it('preserves configured CORS exposure while making protocol responses readable to browsers', async () => {
    const app = new Hono();
    app.use('*', cors({ origin: 'https://app.example.com', exposeHeaders: ['X-Request-Id'] }));
    const { service } = serviceFixture(app);
    const response = await service.fetch(
      new Request('https://service.internal/rpc/v1/mutation/run', {
        method: 'POST',
        headers: { origin: 'https://app.example.com' },
      }),
    );
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(response.headers.get('access-control-expose-headers')).toBe(`X-Request-Id, ${SERVICE_PLANE_RPC_PROTOCOL_HEADER}`);
  });
  it('advertises a wire revision independent of application version and versions default routes', () => {
    const { service } = serviceFixture();
    expect(serviceDiscoveryDocument(service.definition)).toMatchObject({
      version: '7.3.2',
      abilities: [{ rpc: { path: '/rpc/v1/mutation', protocol: SERVICE_PLANE_RPC_PROTOCOL } }],
    });
  });

  it.each([undefined, 'service-plane-rpc/0', 'service-plane-rpc/2'])(
    'rejects Fetch revision %s before body parsing or authorization',
    async (protocol) => {
      const { authorize, service } = serviceFixture();
      const response = await service.fetch(
        new Request('https://service.internal/rpc/v1/mutation/run', {
          method: 'POST',
          body: '{invalid JSON',
          headers: protocol ? { [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: protocol } : {},
        }),
      );
      expect(response.status).toBe(426);
      expect(response.headers.get(SERVICE_PLANE_RPC_PROTOCOL_HEADER)).toBe(SERVICE_PLANE_RPC_PROTOCOL);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'incompatible_protocol', retryable: false } });
      expect(authorize).not.toHaveBeenCalled();
    },
  );

  it('refuses a native envelope with an unknown revision before looking up or authorizing a method', async () => {
    const { authorize, service } = serviceFixture();
    await expect(
      service.invokeAbility({ abilityId: mutation.id, input: {}, method: 'run', protocol: 'legacy', token: 'invalid' }),
    ).rejects.toMatchObject({ code: 'incompatible_protocol', status: 426, retryable: false });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('refuses an incompatible broker before product middleware or discovery runs', async () => {
    const middleware = vi.fn();
    const services = vi.fn(() => []);
    const plane = new ServicePlaneControlPlane({
      broker: {},
      invocationMiddleware: middleware,
      log: false,
      services,
      signingKeys: () => [],
    });
    const response = await plane.fetch(new Request('https://plane.internal/rpc/v1/broker/call', { method: 'POST' }));
    expect(response.status).toBe(426);
    expect(middleware).not.toHaveBeenCalled();
    expect(services).not.toHaveBeenCalled();
  });

  it('rejects an unmarked success response and cancels its body without decoding it', async () => {
    const cancelled = vi.fn();
    let receivedPath = '';
    const client = createAbilityClient({
      ability: mutation,
      targetServiceId: 'service',
      tokenProvider: { token: async () => 'token' },
      transport: {
        type: 'fetch',
        fetch: async (url, init) => {
          receivedPath = new URL(new Request(url, init).url).pathname;
          expect(new Headers(init?.headers).get(SERVICE_PLANE_RPC_PROTOCOL_HEADER)).toBe(SERVICE_PLANE_RPC_PROTOCOL);
          return new Response(new ReadableStream({ cancel: cancelled, pull: () => new Promise(() => undefined) }));
        },
      },
    });
    await expect(client.run({})).rejects.toMatchObject({ code: 'incompatible_protocol', status: 426 });
    expect(receivedPath).toBe('/rpc/v1/mutation/run');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('uses a versioned broker route and prevents user headers from replacing the revision', async () => {
    let receivedPath = '';
    const client = createBrokeredAbilityClient({
      ability: mutation,
      targetServiceId: 'service',
      transport: {
        headers: { [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: 'legacy' },
        fetch: async (url, init) => {
          receivedPath = new URL(new Request(url, init).url).pathname;
          expect(new Headers(init?.headers).get(SERVICE_PLANE_RPC_PROTOCOL_HEADER)).toBe(SERVICE_PLANE_RPC_PROTOCOL);
          return Response.json({ json: 'ok' }, { headers: { [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL } });
        },
      },
    });
    await expect(client.run({})).resolves.toBe('ok');
    expect(receivedPath).toBe('/rpc/v1/broker/call');
  });

  it('does not reach a legacy mutation mounted at the old default path', async () => {
    let legacyMutations = 0;
    const client = createAbilityClient({
      ability: mutation,
      targetServiceId: 'service',
      tokenProvider: { token: async () => 'token' },
      transport: {
        type: 'fetch',
        fetch: async (url, init) => {
          if (new URL(new Request(url, init).url).pathname === '/rpc/mutation/run') legacyMutations += 1;
          return new Response('Not found', { status: 404 });
        },
      },
    });
    await expect(client.run({})).rejects.toMatchObject({ status: 404 });
    expect(legacyMutations).toBe(0);
  });

  it('checks logical messages even on manually accepted Durable Object sockets', async () => {
    const { authorize, service } = serviceFixture();
    const [clientSocket, serviceSocket] = memoryWebSocketPair();
    serviceSocket.addEventListener('message', (event) => {
      void service.webSocketMessage(mutation.id, serviceSocket, (event as MessageEvent<string | ArrayBuffer>).data);
    });
    const link = new WebSocketRpcLink({ connect: () => clientSocket, url: '/rpc/v1/mutation' });
    const error = await link.call(['run'], {}, { context: {} }).catch((error: unknown) => error);
    expect(servicePlaneErrorInfo(error)).toMatchObject({ code: 'incompatible_protocol', status: 426 });
    expect(authorize).not.toHaveBeenCalled();
    await service.webSocketClose(mutation.id, serviceSocket);
    clientSocket.close();
  });

  it('does not publish a hibernating subscription as an MCP tool the broker cannot execute', () => {
    const contract = defineAbility({
      id: 'sleeping',
      exposure: 'published',
      rpc: { transports: ['websocket'] },
      methods: {
        subscribe: builder.hibernationStream({
          input: z.object({}),
          output: z.string(),
          mcp: { name: 'sleeping' },
          handler: () => new AbilityHibernationStream<string>(() => undefined),
        }),
      },
    });
    expect(() =>
      defineAbilityService({ abilities: [contract], id: 'service', title: 'Service', version: '1' }, { requireAbilityScopes: false }),
    ).toThrow('hibernation method cannot project an MCP tool');
  });
});
