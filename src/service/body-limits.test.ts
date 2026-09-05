import type { StandardLazyRequest } from '@orpc/server';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import type { UpgradeWebSocket } from 'hono/ws';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

type TestSocket = {
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer): void;
};

type UpgradeEvents = {
  onClose?: (event: CloseEvent, socket: TestSocket) => unknown;
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

function webSocketService(rpc: NonNullable<ConstructorParameters<typeof ServicePlaneService>[0]['rpc']>) {
  const ability = createAbilityBuilder();
  return new ServicePlaneService({
    ingress: false,
    abilities: [
      defineAbility({
        id: 'limits.echo',
        methods: {
          echo: ability.method({
            handler: ({ input }) => input,
            input: z.object({ value: z.string() }),
            output: z.object({ value: z.string() }),
            scopes: ['limits.read'],
          }),
        },
        rpc: { transports: ['websocket'] },
        scopes: ['limits.read'],
      }),
    ],
    auth: { jwks: { keys: [] } },
    capabilities: defineCapabilities({ scopes: [{ id: 'limits.read' }], serviceId: 'limits' }),
    id: 'limits',
    logger: false,
    rpc,
    title: 'Limits',
    version: '1.0.0',
  });
}

describe('service WebSocket body limits', () => {
  it('throws a stable 413 before decoding an oversized manually forwarded message', async () => {
    const service = webSocketService({ manualWebSocket: true, maxRequestBodyBytes: 3 });

    await expect(service.webSocketMessage('limits.echo', { send: () => undefined }, 'éé')).rejects.toMatchObject({
      message: 'Service-Plane WebSocket message exceeds rpc.maxRequestBodyBytes',
      status: 413,
    });
  });

  it('closes an automatically managed socket with code 1009 before decoding an oversized Blob', async () => {
    let events: UpgradeEvents | undefined;
    const upgradeWebSocket = (async (_context: unknown, configured: UpgradeEvents) => {
      events = configured;
      return new Response(null, { status: 200 });
    }) as unknown as UpgradeWebSocket;
    const service = webSocketService({ maxRequestBodyBytes: 3, upgradeWebSocket });
    await service.fetch(
      new Request('https://service.internal/rpc/v1/limits.echo', {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      }),
    );
    const close = vi.fn();

    await events?.onMessage?.(new MessageEvent('message', { data: new Blob(['1234']) }), {
      close,
      send: () => undefined,
    });

    expect(close).toHaveBeenCalledWith(1009, 'Message too large');
  });

  it('normalizes mounted Blob frames in arrival order and accounts from callback entry', async () => {
    let events: UpgradeEvents | undefined;
    const upgradeWebSocket = (async (_context: unknown, configured: UpgradeEvents) => {
      events = configured;
      return new Response(null, { status: 200 });
    }) as unknown as UpgradeWebSocket;
    const service = webSocketService({ upgradeWebSocket });
    await service.fetch(
      new Request('https://service.internal/rpc/v1/limits.echo', {
        headers: { connection: 'upgrade', upgrade: 'websocket' },
      }),
    );
    expect(events?.onMessage).toBeTypeOf('function');

    const delivered: string[] = [];
    const receivedAt: number[] = [];
    const internals = service as unknown as {
      createRpcRuntime(...args: unknown[]): unknown;
    };
    internals.createRpcRuntime = (...args) => {
      receivedAt.push(args.at(-1) as number);
      return {};
    };
    let releaseFirstDelivery: (() => void) | undefined;
    const firstDelivery = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    let markSecondDelivered: (() => void) | undefined;
    const secondDelivered = new Promise<void>((resolve) => {
      markSecondDelivered = resolve;
    });
    const message = vi.spyOn(WebSocketRpcHandler.prototype, 'message').mockImplementation(async (...args) => {
      const value = new TextDecoder().decode(args[1] as ArrayBuffer);
      delivered.push(value);
      await (args[2] as { context(request: StandardLazyRequest): unknown }).context(lazyRequest);
      if (value === 'first') await firstDelivery;
      if (value === 'second') markSecondDelivered?.();
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
      await secondDelivered;

      expect(delivered).toEqual(['first', 'second']);
      expect(receivedAt).toEqual([100, 200]);
      releaseFirstDelivery?.();
      await Promise.all([firstCall, secondCall]);
    } finally {
      releaseFirstDelivery?.();
      clock.mockRestore();
      message.mockRestore();
    }
  });

  it('delivers a manual frame before close without serializing the RPC execution', async () => {
    const service = webSocketService({ manualWebSocket: true });
    const sequence: string[] = [];
    let releaseMessage: (() => void) | undefined;
    const pendingMessage = new Promise<void>((resolve) => {
      releaseMessage = resolve;
    });
    const message = vi.spyOn(WebSocketRpcHandler.prototype, 'message').mockImplementation(async () => {
      sequence.push('message');
      await pendingMessage;
      return { matched: true };
    });
    let markClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const close = vi.spyOn(WebSocketRpcHandler.prototype, 'close').mockImplementation(async () => {
      sequence.push('close');
      markClosed?.();
    });
    const socket: TestSocket = { close: vi.fn(), send: vi.fn() };

    try {
      const messageCall = service.webSocketMessage('limits.echo', socket, 'message');
      let messageCompleted = false;
      const observedMessage = messageCall.then(() => {
        messageCompleted = true;
      });
      const closeCall = service.webSocketClose('limits.echo', socket);
      await closed;
      expect(sequence).toEqual(['message', 'close']);
      expect(messageCompleted).toBe(false);
      releaseMessage?.();
      await Promise.all([observedMessage, closeCall]);
      expect(sequence).toEqual(['message', 'close']);
    } finally {
      close.mockRestore();
      message.mockRestore();
    }
  });
});
