import { os } from '@orpc/server';
import { RPCHandler as FetchRpcHandler } from '@orpc/server/fetch';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SERVICE_PLANE_TIMEOUT_GRACE_MS } from '../shared/deadline.js';
import { memoryWebSocketPair } from '../test-support/index.js';
import { createAbilityBuilder } from './ability.js';
import { createAbilityClient, createBrokeredAbilityClient, disposeAbilityClient } from './client.js';
import { defineAbility } from './discovery.js';
import { createRpcHandlerPlugins } from './orpc-features.js';

const ability = createAbilityBuilder();
const lifecycleContract = defineAbility({
  id: 'client.lifecycle',
  methods: {
    ping: ability.method({
      input: z.object({ value: z.string() }),
      output: z.string(),
    }),
    watch: ability.stream({
      input: z.object({ value: z.string() }),
      output: z.string(),
    }),
  },
  rpc: { path: '/', transports: ['fetch', 'service-binding', 'websocket'] },
});

describe('ability client lifecycle', () => {
  it('closes a direct WebSocket once, releases its stream, and suppresses proactive reconnect', async () => {
    let streamClosed = 0;
    let pendingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      pendingStarted = resolve;
    });
    const handler = new WebSocketRpcHandler(
      {
        ping: os.input(z.object({ value: z.string() })).handler(({ input }) => {
          if (input.value !== 'pending') return input.value;
          pendingStarted?.();
          return new Promise<string>(() => undefined);
        }),
        watch: os.input(z.object({ value: z.string() })).handler(({ input }) => {
          let first = true;
          const stream: AsyncIterableIterator<string> = {
            [Symbol.asyncIterator]() {
              return stream;
            },
            next() {
              if (first) {
                first = false;
                return Promise.resolve({ done: false, value: input.value });
              }
              return new Promise(() => undefined);
            },
            return() {
              streamClosed += 1;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
          return stream;
        }),
      },
      { plugins: createRpcHandlerPlugins({}, false) },
    );
    let connections = 0;
    let closeCalls = 0;
    let physicalSocket: ReturnType<typeof memoryWebSocketPair>[0] | undefined;
    const client = createAbilityClient({
      ability: lifecycleContract,
      targetServiceId: 'lifecycle',
      tokenProvider: { token: async () => 'test-token' },
      transport: {
        createWebSocket: () => {
          connections += 1;
          const [clientSocket, serverSocket] = memoryWebSocketPair();
          physicalSocket = clientSocket;
          const close = clientSocket.close.bind(clientSocket);
          clientSocket.close = (code, reason) => {
            closeCalls += 1;
            close(code, reason);
          };
          handler.upgrade(serverSocket as unknown as WebSocket);
          return clientSocket;
        },
        reconnect: {
          enabled: true,
          onClose: { delay: 0, enabled: true },
        },
        type: 'websocket',
        url: 'wss://lifecycle.internal/rpc/v1/client.lifecycle',
      },
    });

    await expect(client.ping({ value: 'ready' })).resolves.toBe('ready');
    const stream = await client.watch({ value: 'event' });
    await expect(stream.next()).resolves.toEqual({ done: false, value: 'event' });
    const pending = client.ping({ value: 'pending' });
    await started;
    const pendingRejection = expect(pending).rejects.toMatchObject({ code: 'cancelled', retryable: false, status: 499 });

    disposeAbilityClient(client);
    disposeAbilityClient(client);

    await vi.waitFor(() => expect(physicalSocket?.readyState).toBe(3));
    await vi.waitFor(() => expect(streamClosed).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeCalls).toBe(1);
    expect(connections).toBe(1);
    await pendingRejection;
    await expect(client.ping({ value: 'late' })).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Service-Plane ability client is disposed',
      retryable: false,
      status: 499,
    });
  });

  it('disposes an unused broker WebSocket without opening it', async () => {
    let connections = 0;
    const client = createBrokeredAbilityClient({
      ability: lifecycleContract,
      targetServiceId: 'lifecycle',
      transport: {
        createWebSocket: () => {
          connections += 1;
          throw new Error('socket must remain lazy');
        },
        reconnect: { enabled: true, onClose: { enabled: true } },
        type: 'websocket',
        url: 'wss://plane.internal/rpc/v1/broker/ws',
      },
    });

    disposeAbilityClient(client);
    disposeAbilityClient(client);

    expect(connections).toBe(0);
    await expect(client.ping({ value: 'late' })).rejects.toMatchObject({ code: 'cancelled', status: 499 });
    expect(connections).toBe(0);
  });

  it('settles an in-flight reconnect loop without creating sockets after disposal', async () => {
    vi.useFakeTimers();
    try {
      let connections = 0;
      let firstAttempt: (() => void) | undefined;
      const attempted = new Promise<void>((resolve) => {
        firstAttempt = resolve;
      });
      const client = createBrokeredAbilityClient({
        ability: lifecycleContract,
        targetServiceId: 'lifecycle',
        transport: {
          createWebSocket: () => {
            connections += 1;
            firstAttempt?.();
            throw new Error('offline');
          },
          reconnect: { delay: () => 10, enabled: true, maxAttempt: 100 },
          type: 'websocket',
          url: 'wss://plane.internal/rpc/v1/broker/ws',
        },
      });
      const call = client.ping({ value: 'pending' });
      const rejection = expect(call).rejects.toMatchObject({ code: 'cancelled', retryable: false, status: 499 });
      await vi.advanceTimersByTimeAsync(10);
      await attempted;

      disposeAbilityClient(client);
      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(connections).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a streaming deadline when disposed between pulls', async () => {
    vi.useFakeTimers();
    try {
      let returnCalls = 0;
      const handler = new WebSocketRpcHandler(
        {
          ping: os.input(z.object({ value: z.string() })).handler(({ input }) => input.value),
          watch: os.input(z.object({ value: z.string() })).handler(({ input }) => {
            let first = true;
            const stream: AsyncIterableIterator<string> = {
              [Symbol.asyncIterator]() {
                return stream;
              },
              next() {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false, value: input.value });
                }
                return new Promise(() => undefined);
              },
              return() {
                returnCalls += 1;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
            return stream;
          }),
        },
        { plugins: createRpcHandlerPlugins({}, false) },
      );
      const client = createAbilityClient({
        ability: lifecycleContract,
        targetServiceId: 'lifecycle',
        timeoutMs: 600_000,
        tokenProvider: { token: async () => 'test-token' },
        transport: {
          createWebSocket: () => {
            const [clientSocket, serverSocket] = memoryWebSocketPair();
            handler.upgrade(serverSocket as unknown as WebSocket);
            return clientSocket;
          },
          type: 'websocket',
          url: 'wss://lifecycle.internal/rpc/v1/client.lifecycle',
        },
      });

      const streamCall = client.watch({ value: 'event' });
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamCall;
      await expect(stream.next()).resolves.toEqual({ done: false, value: 'event' });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      disposeAbilityClient(client);
      await vi.advanceTimersByTimeAsync(0);

      expect(returnCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases lifecycle tracking when a streaming deadline expires between pulls', async () => {
    vi.useFakeTimers();
    try {
      let returnCalls = 0;
      const handler = new WebSocketRpcHandler(
        {
          ping: os.input(z.object({ value: z.string() })).handler(({ input }) => input.value),
          watch: os.input(z.object({ value: z.string() })).handler(({ input }) => {
            let first = true;
            const stream: AsyncIterableIterator<string> = {
              [Symbol.asyncIterator]() {
                return stream;
              },
              next() {
                if (first) {
                  first = false;
                  return Promise.resolve({ done: false, value: input.value });
                }
                return new Promise(() => undefined);
              },
              return() {
                returnCalls += 1;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
            return stream;
          }),
        },
        { plugins: createRpcHandlerPlugins({}, false) },
      );
      const client = createAbilityClient({
        ability: lifecycleContract,
        targetServiceId: 'lifecycle',
        timeoutMs: 1,
        tokenProvider: { token: async () => 'test-token' },
        transport: {
          createWebSocket: () => {
            const [clientSocket, serverSocket] = memoryWebSocketPair();
            handler.upgrade(serverSocket as unknown as WebSocket);
            return clientSocket;
          },
          type: 'websocket',
          url: 'wss://lifecycle.internal/rpc/v1/client.lifecycle',
        },
      });

      const streamCall = client.watch({ value: 'event' });
      await vi.advanceTimersByTimeAsync(0);
      const stream = await streamCall;
      await expect(stream.next()).resolves.toEqual({ done: false, value: 'event' });

      await vi.advanceTimersByTimeAsync(1 + SERVICE_PLANE_TIMEOUT_GRACE_MS);

      expect(returnCalls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      await expect(stream.next()).rejects.toMatchObject({ code: 'timeout', status: 504 });
      disposeAbilityClient(client);
      expect(returnCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delegates stream return only once when disposal races asynchronous cleanup', async () => {
    let returnCalls = 0;
    let returnStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      returnStarted = resolve;
    });
    let finishReturn: (() => void) | undefined;
    const handler = new WebSocketRpcHandler(
      {
        ping: os.input(z.object({ value: z.string() })).handler(({ input }) => input.value),
        watch: os.input(z.object({ value: z.string() })).handler(({ input }) => {
          let first = true;
          const stream: AsyncIterableIterator<string> = {
            [Symbol.asyncIterator]() {
              return stream;
            },
            next() {
              if (first) {
                first = false;
                return Promise.resolve({ done: false, value: input.value });
              }
              return new Promise(() => undefined);
            },
            return() {
              returnCalls += 1;
              returnStarted?.();
              return new Promise((resolve) => {
                finishReturn = () => resolve({ done: true, value: undefined });
              });
            },
          };
          return stream;
        }),
      },
      { plugins: createRpcHandlerPlugins({}, false) },
    );
    const client = createAbilityClient({
      ability: lifecycleContract,
      targetServiceId: 'lifecycle',
      tokenProvider: { token: async () => 'test-token' },
      transport: {
        createWebSocket: () => {
          const [clientSocket, serverSocket] = memoryWebSocketPair();
          handler.upgrade(serverSocket as unknown as WebSocket);
          return clientSocket;
        },
        type: 'websocket',
        url: 'wss://lifecycle.internal/rpc/v1/client.lifecycle',
      },
    });
    const stream = await client.watch({ value: 'event' });
    await expect(stream.next()).resolves.toEqual({ done: false, value: 'event' });

    const returning = stream.return?.();
    if (!returning) throw new Error('stream return hook is required');
    const settled = returning.then(
      () => undefined,
      () => undefined,
    );
    await started;
    disposeAbilityClient(client);

    expect(returnCalls).toBe(1);
    finishReturn?.();
    await settled;
    expect(returnCalls).toBe(1);
  });

  it('is a no-op for Fetch and native clients because they own no persistent connection', async () => {
    const native = createAbilityClient({
      ability: lifecycleContract,
      targetServiceId: 'lifecycle',
      tokenProvider: { token: async () => 'test-token' },
      transport: {
        binding: {
          invokeAbility: (input) => (input.input as { value: string }).value,
        },
        type: 'service-binding',
      },
    });
    const brokerHandler = new FetchRpcHandler(
      {
        call: os.input(z.unknown()).handler(({ input }) => (input as { input: { value: string } }).input.value),
      },
      { plugins: createRpcHandlerPlugins({}, false) },
    );
    const broker = createBrokeredAbilityClient({
      ability: lifecycleContract,
      targetServiceId: 'lifecycle',
      transport: {
        fetch: async (url, init) => {
          const handled = await brokerHandler.handle(new Request(url, init), { prefix: '/rpc/v1/broker' });
          return handled.matched ? handled.response : new Response('Not found', { status: 404 });
        },
      },
    });

    disposeAbilityClient(native);
    disposeAbilityClient(native);
    disposeAbilityClient(broker);
    disposeAbilityClient(broker);

    await expect(native.ping({ value: 'native' })).resolves.toBe('native');
    await expect(broker.ping({ value: 'fetch' })).resolves.toBe('fetch');
  });
});
