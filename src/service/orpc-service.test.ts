import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { BatchLinkPlugin } from '@orpc/client/plugins';
import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { HibernationAsyncIteratorClass, HibernationHandlerPlugin } from '@orpc/hibernation';
import { BatchHandlerPlugin } from '@orpc/server/plugins';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createControlPlaneRpcBroker } from '../control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { servicePlaneAuthorization } from '../shared/capability-tokens.js';
import { memoryWebSocketPair, testKeys } from '../test-support/index.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient } from './client.js';
import { type AbilityRpc, defineAbility } from './discovery.js';
import { createAbilityBuilder, encodeAbilityHibernationEvent } from './orpc.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');

describe('ServicePlaneService oRPC runtime', () => {
  it('serves unary and streaming procedures over Fetch with capability checks before validation', async () => {
    const keys = await testKeys();
    const capabilities = defineCapabilities({
      scopes: [{ id: 'tasks.read' }],
      serviceId: 'tasks',
    });
    const issuer = createCapabilityIssuer({
      capabilities: [capabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'headless-front', scopes: ['tasks.read'], target: 'tasks' }],
      }),
      issuer: 'control-plane',
      now: () => ISSUED_AT,
      privateJwks: [keys.privateJwk],
    });
    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'headless-front',
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
    });
    const ability = createAbilityBuilder();
    const eventSchema = z.object({ sequence: z.number() });
    let hibernationIteratorId: string | undefined;
    const tasks = defineAbility({
      id: 'tasks.items',
      methods: {
        get: ability
          .procedure({ scopes: ['tasks.read'] })
          .input(z.object({ id: z.string() }))
          .output(z.object({ caller: z.string(), id: z.string() }))
          .handler(({ context, input }) => ({ caller: context.identity.serviceId, id: input.id })),
        inspect: ability
          .procedure({ scopes: ['tasks.read'] })
          .input(z.object({}))
          .output(
            z.object({
              hasSignal: z.boolean(),
              hasTimeout: z.boolean(),
              idempotencyKey: z.string(),
              requestId: z.string(),
            }),
          )
          .handler(({ context }) => ({
            hasSignal: context.signal !== undefined,
            hasTimeout: context.remainingTimeoutMs !== undefined && context.remainingTimeoutMs() > 0,
            idempotencyKey: context.idempotencyKey ?? '',
            requestId: context.request.headers.get('x-request-id') ?? '',
          })),
        watch: ability
          .stream(z.object({ sequence: z.number() }), { scopes: ['tasks.read'] })
          .input(z.object({ after: z.number() }))
          .handler(async function* ({ input }) {
            yield { sequence: input.after + 1 };
            yield { sequence: input.after + 2 };
          }),
        watchHibernating: ability
          .hibernationStream(eventSchema, { scopes: ['tasks.read'] })
          .input(z.object({}))
          .handler(
            ({ context }) =>
              new HibernationAsyncIteratorClass<{ sequence: number }>((id) => {
                hibernationIteratorId = id;
                context.webSocket?.serializeAttachment?.({ id });
              }),
          ),
      },
      rpc: { transports: ['fetch', 'cloudflare-service-binding', 'websocket'] },
      scopes: ['tasks.read'],
    });
    const service = new ServicePlaneService({
      abilities: [tasks],
      auth: {
        issuer: 'control-plane',
        jwks: { keys: [keys.publicJwk] },
        now: () => VERIFIED_AT,
      },
      capabilities,
      id: 'tasks',
      logger: false,
      rpc: { manualWebSocket: true, plugins: [new HibernationHandlerPlugin(), new BatchHandlerPlugin()] },
      title: 'Tasks',
      version: '1.0.0',
    });
    const createClient = (authorization?: string) => {
      const link = new RPCLink({
        fetch: async (url, init) => service.fetch(new Request(url, init)),
        ...(authorization ? { headers: { authorization } } : {}),
        origin: 'https://tasks.internal',
        url: '/rpc/tasks.items',
      });
      return createORPCClient<AbilityRpc<typeof tasks>>(link);
    };

    const denied = createClient();
    const deniedError = await denied.get({ id: 42 } as never).catch((error: unknown) => error);
    expect(deniedError).toBeInstanceOf(ORPCError);
    expect(deniedError).toMatchObject({ code: 'UNAUTHORIZED' });

    const client = createClient(servicePlaneAuthorization(issued.token));
    await expect(client.get({ id: 'task-1' })).resolves.toEqual({ caller: 'headless-front', id: 'task-1' });
    const stream = await client.watch({ after: 2 });
    const values = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([{ sequence: 3 }, { sequence: 4 }]);

    const binding = {
      fetch: async (request: Request) => service.fetch(request),
      invokeAbility: (input: Parameters<ServicePlaneService['invokeAbility']>[0]) => service.invokeAbility(input),
    };
    const nativeClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: { binding, origin: 'https://tasks.internal', type: 'service-binding' },
    });
    await expect(nativeClient.get({ id: 'task-native' })).resolves.toEqual({
      caller: 'headless-front',
      id: 'task-native',
    });
    const metadataClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      idempotencyKey: 'attempt-1',
      requestId: 'request-1',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      timeoutMs: 1_000,
      transport: { binding, origin: 'https://tasks.internal', type: 'service-binding' },
    });
    await expect(metadataClient.inspect({})).resolves.toEqual({
      hasSignal: true,
      hasTimeout: true,
      idempotencyKey: 'attempt-1',
      requestId: 'request-1',
    });
    const bindingStream = await nativeClient.watch({ after: 4 });
    const bindingValues = [];
    for await (const value of bindingStream) bindingValues.push(value);
    expect(bindingValues).toEqual([{ sequence: 5 }, { sequence: 6 }]);

    const [clientSocket, serviceSocket] = memoryWebSocketPair();
    serviceSocket.addEventListener('message', (event) => {
      const message = (event as MessageEvent<string | ArrayBuffer>).data;
      void service.webSocketMessage('tasks.items', serviceSocket, message);
    });
    const webSocketClient = createORPCClient<AbilityRpc<typeof tasks>>(
      new WebSocketRpcLink({
        connect: () => clientSocket,
        headers: { authorization: servicePlaneAuthorization(issued.token) },
        url: '/rpc/tasks.items',
      }),
    );
    await expect(webSocketClient.get({ id: 'task-ws' })).resolves.toEqual({ caller: 'headless-front', id: 'task-ws' });
    const webSocketStream = await webSocketClient.watch({ after: 10 });
    const webSocketValues = [];
    for await (const value of webSocketStream) webSocketValues.push(value);
    expect(webSocketValues).toEqual([{ sequence: 11 }, { sequence: 12 }]);

    const hibernatingStream = await webSocketClient.watchHibernating({});
    expect(hibernationIteratorId).toBeTypeOf('string');
    const iteratorId = hibernationIteratorId as string;
    serviceSocket.send(await encodeAbilityHibernationEvent(eventSchema, iteratorId, { sequence: 30 }));
    await expect(hibernatingStream.next()).resolves.toEqual({ done: false, value: { sequence: 30 } });
    serviceSocket.send(await encodeAbilityHibernationEvent(eventSchema, iteratorId, undefined, { event: 'close' }));
    await expect(hibernatingStream.next()).resolves.toMatchObject({ done: true });
    await service.webSocketClose('tasks.items', serviceSocket);

    let batchFetches = 0;
    const batchClient = createAbilityClient({
      ability: tasks,
      callerServiceId: 'headless-front',
      requestToken: async () => issued,
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
      transport: {
        fetch: {
          async fetch(request) {
            batchFetches += 1;
            return service.fetch(request);
          },
        },
        origin: 'https://tasks.internal',
        plugins: [
          new BatchLinkPlugin({
            groups: [{ condition: true, context: {} }],
          }),
        ],
        type: 'fetch',
      },
    });
    await expect(Promise.all([batchClient.get({ id: 'batch-1' }), batchClient.get({ id: 'batch-2' })])).resolves.toEqual([
      { caller: 'headless-front', id: 'batch-1' },
      { caller: 'headless-front', id: 'batch-2' },
    ]);
    expect(batchFetches).toBe(1);

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [
        {
          abilityRpc: {
            invokeAbility: (input) => service.invokeAbility(input),
          },
          fetch: async (request) => service.fetch(request),
          id: 'tasks',
          origin: 'https://tasks.internal',
        },
      ],
    });
    await expect(
      broker.callAbility({
        abilityId: 'tasks.items',
        caller: { id: 'headless-front', kind: 'service' },
        input: { id: 'brokered-1' },
        method: 'get',
        scopes: ['tasks.read'],
        targetServiceId: 'tasks',
      }),
    ).resolves.toEqual({ caller: 'headless-front', id: 'brokered-1' });
    const brokeredStream = (await broker.callAbility({
      abilityId: 'tasks.items',
      caller: { id: 'headless-front', kind: 'service' },
      input: { after: 6 },
      method: 'watch',
      scopes: ['tasks.read'],
      targetServiceId: 'tasks',
    })) as AsyncIterable<{ sequence: number }>;
    const brokeredValues = [];
    for await (const value of brokeredStream) brokeredValues.push(value);
    expect(brokeredValues).toEqual([{ sequence: 7 }, { sequence: 8 }]);
  });
});
