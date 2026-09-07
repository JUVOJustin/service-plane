import { os } from '@orpc/server';
import { RPCHandlerCodec, StandardHandler } from '@orpc/server/standard';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ServicePlaneControlPlane } from '../control-plane/control-plane.js';
import { SERVICE_PLANE_RPC_PROTOCOL, SERVICE_PLANE_RPC_PROTOCOL_HEADER } from '../shared/rpc-protocol.js';
import { createAbilityBuilder } from './ability.js';
import { defineAbility } from './discovery.js';
import { createRpcHandlerPlugins } from './orpc-features.js';
import { ServicePlaneService } from './service.js';

type TestSocket = { send(data: string | ArrayBuffer): void; close(): void };
type UpgradeEvents = {
  onClose?: (event: CloseEvent, socket: TestSocket) => unknown;
  onMessage?: (event: MessageEvent, socket: TestSocket) => unknown;
};

const protocolHeaders = { [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: SERVICE_PLANE_RPC_PROTOCOL };
const compression = { request: true };

// Preserve the native constructor's required `new` invocation while counting real allocations.
function spyOnDecoders() {
  const NativeDecompressionStream = globalThis.DecompressionStream;
  // biome-ignore lint/complexity/useArrowFunction: Constructor spies must remain constructible.
  return vi.spyOn(globalThis, 'DecompressionStream').mockImplementation(function (format) {
    return new NativeDecompressionStream(format);
  });
}

// Exposes application and authorization work separately from private wire decoding.
function serviceFixture(rpc: NonNullable<ConstructorParameters<typeof ServicePlaneService>[0]['rpc']>) {
  const handler = vi.fn(({ input }: { input: { value: string } }) => input);
  const authorize = vi.fn(() => ({ keys: [] }));
  const service = new ServicePlaneService({
    abilities: [
      defineAbility({
        id: 'echo',
        methods: {
          echo: createAbilityBuilder().method({ input: z.object({ value: z.string() }), output: z.object({ value: z.string() }), handler }),
        },
        rpc: { transports: ['fetch', 'websocket'] },
      }),
    ],
    auth: { jwks: authorize },
    id: 'echo',
    ingress: false,
    logger: false,
    requireAbilityScopes: false,
    rpc: { manualWebSocket: true, ...rpc },
    title: 'Echo',
    version: '1.0.0',
  });
  return { authorize, handler, service };
}

// The broker upgrade authenticates a caller before accepting logical request frames.
function planeFixture(broker: Exclude<ConstructorParameters<typeof ServicePlaneControlPlane>[0]['broker'], false | undefined>) {
  const services = vi.fn(() => []);
  const signingKeys = vi.fn(() => []);
  const authenticate = vi.fn();
  const plane = new ServicePlaneControlPlane({
    broker,
    invocationMiddleware: async (context, next) => {
      authenticate();
      context.set('servicePlaneCaller', { id: 'browser', kind: 'user' });
      await next();
    },
    log: false,
    openapi: false,
    rest: false,
    services,
    signingKeys,
  });
  return { authenticate, plane, services, signingKeys };
}

// A tiny envelope requests an octet stream without supplying any compressed body bytes.
function pendingFrame(url: string, encoding: string | string[], protocol = SERVICE_PLANE_RPC_PROTOCOL): string {
  return JSON.stringify({
    id: 'depth',
    kind: 'request',
    json: {
      url,
      headers: { 'content-type': 'application/json', 'content-encoding': encoding, [SERVICE_PLANE_RPC_PROTOCOL_HEADER]: protocol },
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('request compression depth', () => {
  it.each(['service', 'plane'] as const)('rejects repeated Fetch encodings before allocating decoders at the %s', async (target) => {
    const service = serviceFixture({ compression, maxRequestBodyBytes: false });
    const plane = planeFixture({ compression, maxRequestBodyBytes: false });
    const decoders = spyOnDecoders();
    const response = await (target === 'service' ? service.service : plane.plane).fetch(
      new Request(`https://endpoint.internal/rpc/v1/${target === 'service' ? 'echo/echo' : 'broker/call'}`, {
        method: 'POST',
        headers: { ...protocolHeaders, 'content-type': 'application/json', 'content-encoding': 'gzip, gzip, gzip' },
        body: '{}',
      }),
    );

    expect(decoders).not.toHaveBeenCalled();
    expect(response.status).toBe(415);
    expect(response.headers.get(SERVICE_PLANE_RPC_PROTOCOL_HEADER)).toBe(SERVICE_PLANE_RPC_PROTOCOL);
    expect(await response.json()).toMatchObject({ json: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    expect(service.authorize).not.toHaveBeenCalled();
    expect(service.handler).not.toHaveBeenCalled();
    expect(plane.services).not.toHaveBeenCalled();
    expect(plane.signingKeys).not.toHaveBeenCalled();
  });

  describe.each(['manual service', 'automatic service', 'authenticated broker'] as const)('%s WebSocket', (target) => {
    it.each([undefined, false] as const)(
      'rejects repeated encodings with a pending body and byte limit %s',
      async (maxRequestBodyBytes) => {
        let events: UpgradeEvents | undefined;
        const upgradeWebSocket = (async (_context: unknown, configured: UpgradeEvents) => {
          events = configured;
          return new Response(null, { status: 200 });
        }) as unknown as UpgradeWebSocket;
        const wire = { compression, ...(maxRequestBodyBytes === false ? { maxRequestBodyBytes } : {}) };
        const service = serviceFixture({ ...wire, upgradeWebSocket });
        const plane = planeFixture({ ...wire, upgradeWebSocket });
        const broker = target === 'authenticated broker';
        if (target !== 'manual service') {
          const upgraded = await (broker ? plane.plane : service.service).fetch(
            new Request(`https://endpoint.internal/rpc/v1/${broker ? 'broker/ws' : 'echo'}`, {
              headers: { upgrade: 'websocket', connection: 'upgrade' },
            }),
          );
          expect(upgraded.status).toBe(200);
          expect(events?.onMessage).toBeTypeOf('function');
        }
        if (broker) expect(plane.authenticate).toHaveBeenCalledOnce();

        const send = vi.fn();
        const socket: TestSocket = { send, close: vi.fn() };
        const frame = pendingFrame(`/rpc/v1/${broker ? 'broker/call' : 'echo/echo'}`, [' GZip ', '\tdeflate, gzip ']);
        const decoders = spyOnDecoders();
        const delivery = Promise.resolve(
          target === 'manual service'
            ? service.service.webSocketMessage('echo', socket, frame)
            : events?.onMessage?.(new MessageEvent('message', { data: frame }), socket),
        );
        try {
          // The vulnerable decoder allocates three streams here while waiting indefinitely for bytes.
          await vi.waitFor(() => expect(decoders.mock.calls.length > 0 || send.mock.calls.length > 0).toBe(true));
          expect(decoders).not.toHaveBeenCalled();
          await delivery;
          const response = send.mock.calls.map(([data]) => JSON.parse(data as string)).find((message) => message.kind === 'response');
          expect(response).toMatchObject({
            json: { status: 415, headers: protocolHeaders, body: { json: { code: 'UNSUPPORTED_MEDIA_TYPE' } } },
          });
          expect(service.authorize).not.toHaveBeenCalled();
          expect(service.handler).not.toHaveBeenCalled();
          expect(plane.services).not.toHaveBeenCalled();
          expect(plane.signingKeys).not.toHaveBeenCalled();
        } finally {
          if (target === 'manual service') await service.service.webSocketClose('echo', socket);
          else await events?.onClose?.(new Event('close') as CloseEvent, socket);
          await delivery;
        }
      },
    );
  });

  it.each([
    ['gzip, gzip'],
    [['gzip', 'gzip']],
    [['gzip, deflate', 'gzip']],
    [''],
    [[]],
    ['gzip,'],
    [',gzip'],
    ['gzip,,deflate'],
    ['br'],
    ['identity'],
    ['gzip; q=1'],
    ['gzip\n'],
  ])('explicitly rejects unsupported or malformed standard encoding header %j', async (encoding) => {
    const handler = vi.fn(() => 'ok');
    const rpc = new StandardHandler(new RPCHandlerCodec({ echo: os.handler(handler) }), {
      plugins: createRpcHandlerPlugins({ compression, batch: true, maxRequestBodyBytes: false }, false),
    });
    const resolveBody = vi.fn(async () => ({ json: {} }));
    const decoders = spyOnDecoders();
    const result = await rpc.handle(
      { method: 'POST', url: '/echo', headers: { ...protocolHeaders, 'content-encoding': encoding }, resolveBody },
      { context: {} },
    );

    expect(result.response?.status).toBe(415);
    expect(resolveBody).not.toHaveBeenCalled();
    expect(decoders).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['gzip', 'deflate', 'deflate-raw'] as const)(
    'preserves single %s decoding with casing, OWS and array headers',
    async (encoding) => {
      const handler = vi.fn(({ input }) => input);
      const rpc = new StandardHandler(new RPCHandlerCodec({ echo: os.input(z.object({ value: z.string() })).handler(handler) }), {
        plugins: createRpcHandlerPlugins({ compression }, false),
      });
      const value = { value: 'compressible '.repeat(32) };
      const compressed = new Blob([JSON.stringify({ json: value })]).stream().pipeThrough(new CompressionStream(encoding));
      const resolveBody = vi.fn(async () => compressed);
      const decoders = spyOnDecoders();
      const result = await rpc.handle(
        {
          method: 'POST',
          url: '/echo',
          headers: { ...protocolHeaders, 'content-type': 'application/json', 'content-encoding': [` \t${encoding.toUpperCase()}\t `] },
          resolveBody,
        },
        { context: {} },
      );

      expect(result.response?.status).toBe(200);
      expect(result.response?.body).toEqual({ json: value });
      expect(decoders).toHaveBeenCalledExactlyOnceWith(encoding);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it('keeps the protocol refusal ahead of the compression guard and body decoding', async () => {
    const rpc = new StandardHandler(new RPCHandlerCodec({ echo: os.handler(() => 'ok') }), {
      plugins: createRpcHandlerPlugins({ compression, batch: true }, false),
    });
    const resolveBody = vi.fn(async () => ({ json: {} }));
    const result = await rpc.handle(
      { method: 'POST', url: '/echo', headers: { 'content-encoding': 'gzip, gzip' }, resolveBody },
      { context: {} },
    );
    expect(result.response?.status).toBe(426);
    expect(resolveBody).not.toHaveBeenCalled();
  });
});
