import type { StandardLazyRequest } from '@orpc/server';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import { SERVICE_PLANE_RPC_PROTOCOL, SERVICE_PLANE_RPC_PROTOCOL_HEADER } from '../shared/rpc-protocol.js';
import { ServicePlaneControlPlane } from './control-plane.js';

type TestSocket = {
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer): void;
};

type UpgradeEvents = {
  onMessage?: (event: MessageEvent, socket: TestSocket) => unknown;
};

const lazyRequest = {
  headers: {},
  method: 'POST',
  resolveBody: async () => undefined,
  url: '/rpc/v1/test',
} satisfies StandardLazyRequest;

function deferredBlobFrame(value: string): { blob: Blob; resolve(): void } {
  const bytes = new TextEncoder().encode(value).buffer;
  let resolveBytes: ((bytes: ArrayBuffer) => void) | undefined;
  const loaded = new Promise<ArrayBuffer>((resolve) => {
    resolveBytes = resolve;
  });
  const blob = new Blob([bytes]);
  Object.defineProperty(blob, 'arrayBuffer', { value: () => loaded });
  return {
    blob,
    resolve: () => resolveBytes?.(bytes),
  };
}

describe('control-plane RPC body limits', () => {
  it.each(['mcp', 'broker', 'rest'] as const)(
    'bounds the physical %s body before body-reading authentication can buffer it',
    async (surface) => {
      let pulls = 0;
      let cancelled = false;
      let serviceResolutions = 0;
      let authenticatedBytes: number | undefined;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(controller) {
          pulls += 1;
          if (pulls > 512) controller.close();
          else controller.enqueue(new Uint8Array(65_536));
        },
      });
      const plane = new ServicePlaneControlPlane({
        broker: surface === 'broker' ? { maxRequestBodyBytes: 1024 } : false,
        invocationMiddleware: async (context, next) => {
          authenticatedBytes = (await context.req.raw.arrayBuffer()).byteLength;
          context.set('servicePlaneCaller', { id: 'signed-client', kind: 'service' });
          await next();
        },
        log: false,
        mcp: surface === 'mcp' ? { maxBodyBytes: 1024 } : false,
        openapi: false,
        rest: surface === 'rest' ? { maxBodyBytes: 1024 } : false,
        services: () => {
          serviceResolutions += 1;
          return [];
        },
        signingKeys: () => [],
      });
      const path = surface === 'mcp' ? '/mcp' : surface === 'broker' ? '/rpc/v1/broker/call' : '/unknown';
      const response = await plane.fetch(
        new Request(`https://plane.internal${path}`, {
          body,
          duplex: 'half',
          headers: { 'content-type': 'application/json', [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL },
          method: 'POST',
        } as RequestInit),
      );

      expect(response.status).toBe(413);
      expect(authenticatedBytes).toBeUndefined();
      expect(serviceResolutions).toBe(0);
      expect(pulls).toBeLessThan(5);
      await vi.waitFor(() => expect(cancelled).toBe(true));
    },
  );

  it('rejects an oversized MCP body before service discovery or issuer work', async () => {
    let middlewareCalls = 0;
    let serviceResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: async (context, next) => {
        middlewareCalls += 1;
        context.set('servicePlaneCaller', { id: 'browser', kind: 'user' });
        await next();
      },
      log: false,
      mcp: { maxBodyBytes: 3 },
      openapi: false,
      rest: false,
      services: () => {
        serviceResolutions += 1;
        return [];
      },
      signingKeys: () => [],
    });

    const response = await plane.fetch(
      new Request('https://plane.internal/mcp', {
        body: '1234',
        headers: { 'content-type': 'application/json', [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(413);
    expect(middlewareCalls).toBe(1);
    expect(serviceResolutions).toBe(0);
  });

  it('rejects an oversized Fetch broker body before service discovery or issuer work', async () => {
    let serviceResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      broker: { maxRequestBodyBytes: 3 },
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'browser', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      rest: false,
      services: () => {
        serviceResolutions += 1;
        return [];
      },
      signingKeys: () => [],
    });

    const response = await plane.fetch(
      new Request('https://plane.internal/rpc/v1/broker/call', {
        body: '1234',
        headers: { 'content-type': 'application/json', [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(413);
    expect(serviceResolutions).toBe(0);
  });

  it('cancels both Fetch broker body branches when invocation middleware refuses the request', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"unread":true}'));
      },
    });
    const plane = new ServicePlaneControlPlane({
      broker: {},
      invocationMiddleware: (context) => Promise.resolve(context.json({ error: 'Unauthorized' }, 401)),
      log: false,
      openapi: false,
      rest: false,
      services: () => [],
      signingKeys: () => [],
    });

    const response = await plane.fetch(
      new Request('https://plane.internal/rpc/v1/broker/call', {
        body,
        headers: { 'content-type': 'application/json', [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL },
        method: 'POST',
        duplex: 'half',
      } as RequestInit),
    );

    expect(response.status).toBe(401);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('closes an oversized broker message with code 1009 before RPC decoding', async () => {
    let events: UpgradeEvents | undefined;
    const upgradeWebSocket = (async (_context: unknown, configured: UpgradeEvents) => {
      events = configured;
      return new Response(null, { status: 200 });
    }) as unknown as UpgradeWebSocket;
    const plane = new ServicePlaneControlPlane({
      broker: { maxRequestBodyBytes: 3, upgradeWebSocket },
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'browser', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      rest: false,
      services: () => [],
      signingKeys: () => [],
    });
    await plane.fetch(
      new Request('https://plane.internal/rpc/v1/broker/ws', {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      }),
    );
    const close = vi.fn();

    await events?.onMessage?.(new MessageEvent('message', { data: Uint8Array.from([1, 2, 3, 4]) }), {
      close,
      send: () => undefined,
    });

    expect(close).toHaveBeenCalledWith(1009, 'Message too large');
  });

  it('normalizes broker Blob frames in arrival order and accounts from callback entry', async () => {
    let events: UpgradeEvents | undefined;
    const upgradeWebSocket = (async (_context: unknown, configured: UpgradeEvents) => {
      events = configured;
      return new Response(null, { status: 200 });
    }) as unknown as UpgradeWebSocket;
    const plane = new ServicePlaneControlPlane({
      broker: { upgradeWebSocket },
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'browser', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      rest: false,
      services: () => [],
      signingKeys: () => [],
    });
    await plane.fetch(
      new Request('https://plane.internal/rpc/v1/broker/ws', {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      }),
    );
    expect(events?.onMessage).toBeTypeOf('function');

    const delivered: string[] = [];
    const receivedAt: number[] = [];
    // Each frame opens its own request scope; its entry timestamp is what the scope receives.
    const internals = plane as unknown as {
      requestScope(context: unknown, surface: string, facts: { receivedAt: number }): unknown;
    };
    internals.requestScope = (_context, _surface, facts) => {
      receivedAt.push(facts.receivedAt);
      return { broker: async () => ({}) };
    };

    const message = vi.spyOn(WebSocketRpcHandler.prototype, 'message').mockImplementation(async (...args) => {
      delivered.push(new TextDecoder().decode(args[1] as ArrayBuffer));
      const runtime = await (args[2] as { context(request: StandardLazyRequest): Promise<unknown> }).context(lazyRequest);
      await (runtime as { resolveBroker(): Promise<unknown> }).resolveBroker();
      return { matched: true };
    });
    let now = 100;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = deferredBlobFrame('first');
    const second = deferredBlobFrame('second');
    const socket: TestSocket = { close: vi.fn(), send: vi.fn() };
    const onMessage = events?.onMessage as NonNullable<UpgradeEvents['onMessage']>;

    try {
      const firstCall = Promise.resolve(onMessage(new MessageEvent('message', { data: first.blob }), socket));
      now = 200;
      const secondCall = Promise.resolve(onMessage(new MessageEvent('message', { data: second.blob }), socket));
      now = 900;
      second.resolve();
      await Promise.resolve();
      expect(delivered).toEqual([]);
      first.resolve();
      await Promise.all([firstCall, secondCall]);

      expect(delivered).toEqual(['first', 'second']);
      expect(receivedAt).toEqual([100, 200]);
    } finally {
      clock.mockRestore();
      message.mockRestore();
    }
  });
});
