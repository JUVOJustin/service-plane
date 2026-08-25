import { createORPCClient } from '@orpc/client';
import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { HibernationAsyncIteratorClass } from '@orpc/hibernation';
import { call, ORPCError, type RouterClient } from '@orpc/server';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityAuthError, servicePlaneErrorInfo } from '../shared/errors.js';
import type { CapabilityIdentity } from '../shared/types.js';
import { defineAbility, defineAbilityService, serviceDiscoveryDocument } from './discovery.js';
import {
  type AbilityProcedureContext,
  abilityProcedureDefinition,
  abilityProcedureInputSchema,
  abilityProcedureOutputSchema,
  abilityProcedureStreams,
  createAbilityBuilder,
  createAbilityProcedureRuntimeContext,
  encodeAbilityHibernationEvent,
} from './orpc.js';

const identity: CapabilityIdentity = {
  audience: 'tasks',
  callerAccess: 'service',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  issuer: 'plane',
  scopes: ['tasks.read'],
  serviceId: 'test',
  tokenId: 'cap_test',
};

const context = {
  abilityId: 'example.tasks',
  context: {} as AbilityProcedureContext['context'],
  env: {},
  identity,
  request: new Request('https://tasks.internal/rpc/example.tasks/get'),
} satisfies AbilityProcedureContext;

const runtimeContext = createAbilityProcedureRuntimeContext({ authorize: () => context });

describe('oRPC ability procedures', () => {
  it('keeps execution, schemas, scopes, and projections on one unary procedure', async () => {
    const ability = createAbilityBuilder();
    const input = z.object({ id: z.string() });
    const output = z.object({ id: z.string(), title: z.string() });
    const procedure = ability
      .procedure({
        mcp: { name: 'tasks_get' },
        rest: { method: 'get', path: '/tasks/{id}' },
        scopes: ['tasks.read'],
      })
      .input(input)
      .output(output)
      .handler(({ input: value }) => ({ ...value, title: 'Task' }));

    expect(abilityProcedureDefinition(procedure)).toEqual({
      mcp: { name: 'tasks_get' },
      rest: { method: 'get', path: '/tasks/{id}' },
      scopes: ['tasks.read'],
    });
    expect(abilityProcedureInputSchema(procedure)).toBe(input);
    expect(abilityProcedureOutputSchema(procedure)).toBe(output);
    expect(abilityProcedureStreams(procedure)).toBe(false);
    await expect(call(procedure, { id: 'task-1' }, { context: runtimeContext })).resolves.toEqual({ id: 'task-1', title: 'Task' });
  });

  it('uses the yielded item schema for discovery and validates streamed items', async () => {
    const ability = createAbilityBuilder();
    const item = z.object({ sequence: z.number() });
    const procedure = ability
      .stream(item, { scopes: ['tasks.read'] })
      .input(z.object({ after: z.number() }))
      .handler(async function* ({ input }) {
        yield { sequence: input.after + 1 };
        yield { sequence: input.after + 2 };
      });

    expect(abilityProcedureDefinition(procedure)).toEqual({ scopes: ['tasks.read'], stream: true });
    expect(abilityProcedureOutputSchema(procedure)).toBe(item);
    expect(abilityProcedureStreams(procedure)).toBe(true);

    const stream = await call(procedure, { after: 2 }, { context: runtimeContext });
    const values = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([{ sequence: 3 }, { sequence: 4 }]);
  });

  it('derives discovery from procedure schemas and metadata', () => {
    const ability = createAbilityBuilder();
    const definition = defineAbility({
      id: 'example.tasks',
      methods: {
        get: ability
          .procedure({ mcp: { name: 'tasks_get' }, scopes: ['tasks.read'] })
          .input(z.object({ id: z.string() }))
          .output(z.object({ title: z.string() }))
          .handler(() => ({ title: 'Task' })),
      },
      scopes: ['tasks.read'],
    });
    const service = defineAbilityService({
      abilities: [definition],
      capabilities: { scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' },
      id: 'tasks',
      title: 'Tasks',
      version: '1.0.0',
    });

    expect(serviceDiscoveryDocument(service).abilities[0]?.methods.get).toMatchObject({
      inputSchema: { properties: { id: { type: 'string' } }, type: 'object' },
      mcp: { name: 'tasks_get' },
      outputSchema: { properties: { title: { type: 'string' } }, type: 'object' },
      scopes: ['tasks.read'],
    });
  });

  it('authorizes before input validation and preserves the Service Plane error taxonomy', async () => {
    const ability = createAbilityBuilder();
    const procedure = ability
      .procedure({ scopes: ['tasks.read'] })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true) }))
      .handler(() => ({ ok: true as const }));
    const denied = createAbilityProcedureRuntimeContext({
      authorize() {
        throw new CapabilityAuthError('token required', 401);
      },
    });

    const error = await call(procedure, { id: 42 } as never, { context: denied }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: 'UNAUTHORIZED',
      data: { servicePlane: { code: 'capability_auth', message: 'token required', status: 401 } },
    });
    expect(servicePlaneErrorInfo(error)).toMatchObject({ code: 'capability_auth', status: 401 });

    const invalid = await call(procedure, { id: 42 } as never, { context: runtimeContext }).catch((cause: unknown) => cause);
    expect(servicePlaneErrorInfo(invalid)).toMatchObject({
      code: 'ability_validation',
      issues: [{ message: expect.any(String), path: ['id'] }],
      status: 422,
    });
  });

  it('keeps typed oRPC handler errors and hides arbitrary handler failures', async () => {
    const ability = createAbilityBuilder();
    const failures: unknown[] = [];
    const typed = ability
      .procedure()
      .errors({ QUOTA_EXHAUSTED: { message: 'No quota remains' } })
      .handler(({ errors }) => {
        throw errors.QUOTA_EXHAUSTED();
      });
    const leaky = ability.procedure().handler(() => {
      throw new Error('postgres://secret@internal/tasks');
    });
    const runtime = createAbilityProcedureRuntimeContext({
      authorize: () => context,
      onHandlerFailure: (cause) => failures.push(cause),
    });

    await expect(call(typed, undefined, { context: runtime })).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
      message: 'No quota remains',
    });
    await expect(call(leaky, undefined, { context: runtime })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Service-Plane ability handler failed: unknown',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: 'postgres://secret@internal/tasks' });
  });

  it('enforces procedure ceilings without requiring a caller deadline', async () => {
    const ability = createAbilityBuilder();
    const procedure = ability
      .procedure({ timeoutMs: 5 })
      .input(z.void())
      .output(z.literal('done'))
      .handler(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'done' as const;
      });

    const error = await call(procedure, undefined, { context: runtimeContext }).catch((cause: unknown) => cause);
    expect(servicePlaneErrorInfo(error)).toMatchObject({ code: 'timeout', status: 504 });
  });

  it('preserves hibernation iterators instead of wrapping them in an in-memory deadline iterator', async () => {
    const ability = createAbilityBuilder();
    const output = z.string();
    const procedure = ability
      .hibernationStream(output)
      .input(z.void())
      .handler(() => new HibernationAsyncIteratorClass<string>(() => undefined));
    const runtime = createAbilityProcedureRuntimeContext({
      authorize: () => context,
      deadlineAt: Date.now() + 1_000,
    });

    expect(abilityProcedureStreams(procedure)).toBe(true);
    expect(abilityProcedureOutputSchema(procedure)).toBe(output);
    await expect(call(procedure, undefined, { context: runtime })).resolves.toBeInstanceOf(HibernationAsyncIteratorClass);
    await expect(encodeAbilityHibernationEvent(output, 'stream-1', 'ready')).resolves.toBeTypeOf('string');
    await expect(encodeAbilityHibernationEvent(output, 'stream-1', 42 as never)).rejects.toMatchObject({
      code: 'ability_validation',
      status: 500,
    });
  });

  it('serves the same unary and streaming router over WebSocket', async () => {
    const ability = createAbilityBuilder();
    const router = {
      get: ability
        .procedure()
        .input(z.object({ id: z.string() }))
        .output(z.object({ id: z.string() }))
        .handler(({ input }) => input),
      watch: ability
        .stream(z.number())
        .input(z.object({ after: z.number() }))
        .handler(async function* ({ input }) {
          yield input.after + 1;
          yield input.after + 2;
        }),
    };
    const [clientSocket, serverSocket] = memoryWebSocketPair();
    const handler = new WebSocketRpcHandler(router);
    handler.upgrade(serverSocket as never, { context: () => runtimeContext });
    const link = new WebSocketRpcLink({ connect: () => clientSocket, url: '/' });
    const client = createORPCClient<RouterClient<typeof router>>(link);

    await expect(client.get({ id: 'task-ws' })).resolves.toEqual({ id: 'task-ws' });
    const stream = await client.watch({ after: 10 });
    const values = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([11, 12]);
  });
});

class MemoryWebSocket extends EventTarget {
  peer?: MemoryWebSocket;
  readyState = 1 as const;

  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void {
    queueMicrotask(() => this.peer?.dispatchEvent(new MessageEvent('message', { data })));
  }
}

function memoryWebSocketPair(): [MemoryWebSocket, MemoryWebSocket] {
  const left = new MemoryWebSocket();
  const right = new MemoryWebSocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}
