import { describe, expect, it, vi } from 'vitest';
import { SERVICE_PLANE_TIMEOUT_HEADER } from '../shared/deadline.js';
import { SERVICE_PLANE_CAPABILITY_TOKEN_PATH } from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';

describe('public control-plane route deadlines', () => {
  it.each(['broker', 'mcp', 'rest', 'token'] as const)(
    'cancels locked %s body readers at the default preparation deadline',
    async (surface) => {
      vi.useFakeTimers();
      let cancelled = false;
      let resolved: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        resolved = resolve;
      });
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
        pull() {
          resolved?.();
        },
      });
      const authenticateCaller = vi.fn(() => 'caller');
      const services = vi.fn(() => []);
      const plane = new ServicePlaneControlPlane({
        authenticateCaller,
        broker: {},
        invocationMiddleware: async (context, next) => {
          await context.req.raw.text();
          context.set('servicePlaneCaller', { id: 'user-1', kind: 'user' });
          await next();
        },
        log: false,
        mcp: {},
        openapi: false,
        services,
        signingKeys: () => [],
      });
      const path =
        surface === 'broker'
          ? '/rpc/v1/broker/call'
          : surface === 'mcp'
            ? '/mcp'
            : surface === 'token'
              ? SERVICE_PLANE_CAPABILITY_TOKEN_PATH
              : '/not-published';
      try {
        const pending = plane.fetch(
          new Request(`https://plane.internal${path}`, {
            body,
            duplex: 'half',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-service-plane-rpc-protocol': 'service-plane-rpc/1' },
          } as RequestInit),
        );
        await started;
        await vi.advanceTimersByTimeAsync(10_000);
        const response = await pending;

        expect(response.status).toBe(surface === 'mcp' ? 200 : 504);
        expect(await response.text()).toContain('deadline');
        await vi.waitFor(() => expect(cancelled).toBe(true));
        expect(services).not.toHaveBeenCalled();
        expect(authenticateCaller).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('cancels the MCP protocol parser at a shorter caller deadline', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
    });
    const services = vi.fn(() => []);
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-1', kind: 'user' });
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      rest: false,
      services,
      signingKeys: () => [],
    });
    const response = await plane.fetch(
      new Request('https://plane.internal/mcp', {
        body,
        duplex: 'half',
        method: 'POST',
        headers: { 'content-type': 'application/json', [SERVICE_PLANE_TIMEOUT_HEADER]: '20' },
      } as RequestInit),
    );

    expect(await response.text()).toContain('deadline');
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(services).not.toHaveBeenCalled();
  });

  it('bounds invocation middleware without starting late broker, MCP, or REST work', async () => {
    let serviceResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      broker: {},
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-1', kind: 'user' });
        await new Promise((resolve) => setTimeout(resolve, 40));
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      services: () => {
        serviceResolutions += 1;
        return [];
      },
      signingKeys: () => [],
    });
    const deadlineHeaders = { [SERVICE_PLANE_TIMEOUT_HEADER]: '10', 'x-service-plane-rpc-protocol': 'service-plane-rpc/1' };

    const [broker, mcp, rest] = await Promise.all([
      plane.fetch(new Request('https://plane.internal/rpc/v1/broker/call', { headers: deadlineHeaders, method: 'POST' })),
      plane.fetch(
        new Request('https://plane.internal/mcp', {
          body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
          headers: { ...deadlineHeaders, 'content-type': 'application/json' },
          method: 'POST',
        }),
      ),
      plane.fetch(new Request('https://plane.internal/not-published', { headers: deadlineHeaders })),
    ]);

    expect([broker.status, mcp.status, rest.status]).toEqual([504, 200, 504]);
    expect(serviceResolutions).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(serviceResolutions).toBe(0);
  });

  it('bounds REST and MCP while service-backed route discovery never resolves', async () => {
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-1', kind: 'user' });
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      services: () => new Promise<never>(() => undefined),
      signingKeys: () => [],
    });

    const rest = await plane.fetch(
      new Request('https://plane.internal/public/items', {
        headers: { [SERVICE_PLANE_TIMEOUT_HEADER]: '20' },
      }),
    );
    expect(rest.status).toBe(504);
    await expect(rest.json()).resolves.toMatchObject({ error: { code: 'timeout', retryable: true } });

    const mcp = await plane.fetch(
      new Request('https://plane.internal/mcp', {
        body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
        headers: {
          'content-type': 'application/json',
          [SERVICE_PLANE_TIMEOUT_HEADER]: '20',
        },
        method: 'POST',
      }),
    );
    expect(mcp.status).toBe(200);
    await expect(mcp.json()).resolves.toMatchObject({
      error: { code: -32603, message: expect.stringContaining('deadline') },
      id: 1,
      jsonrpc: '2.0',
    });
  });

  it('releases a timed-out shared discovery fill so the next request can recover', async () => {
    let available = false;
    let discoveryCalls = 0;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-1', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      services: () => [
        {
          fetch: async () => {
            discoveryCalls += 1;
            if (!available) return new Promise<Response>(() => undefined);
            return Response.json({ abilities: [], id: 'catalog', title: 'Catalog', version: '1.0.0' });
          },
          id: 'catalog',
          origin: 'https://catalog.internal',
        },
      ],
      signingKeys: () => [],
    });

    const first = await plane.fetch(
      new Request('https://plane.internal/not-published', {
        headers: { [SERVICE_PLANE_TIMEOUT_HEADER]: '20' },
      }),
    );
    expect(first.status).toBe(504);

    available = true;
    const recovered = await plane.fetch(
      new Request('https://plane.internal/not-published', {
        headers: { [SERVICE_PLANE_TIMEOUT_HEADER]: '500' },
      }),
    );

    expect({ discoveryCalls, status: recovered.status }).toEqual({ discoveryCalls: 2, status: 404 });
  });

  it('keeps a shared discovery fill owned by its first caller when shorter waiters time out', async () => {
    let discoveryCalls = 0;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-1', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      services: () => [
        {
          fetch: () => {
            discoveryCalls += 1;
            return new Promise<Response>(() => undefined);
          },
          id: 'catalog',
          origin: 'https://catalog.internal',
        },
      ],
      signingKeys: () => [],
    });

    const longCall = plane.fetch(
      new Request('https://plane.internal/not-published', {
        headers: { [SERVICE_PLANE_TIMEOUT_HEADER]: '120' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discoveryCalls).toBe(1);

    const shortStatuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await plane.fetch(
        new Request('https://plane.internal/not-published', {
          headers: { [SERVICE_PLANE_TIMEOUT_HEADER]: '15' },
        }),
      );
      shortStatuses.push(response.status);
    }

    expect(shortStatuses).toEqual([504, 504, 504]);
    expect(discoveryCalls).toBe(1);
    expect((await longCall).status).toBe(504);
  });
});
