import { createORPCClient } from '@orpc/client';
import { RPCLink as WebSocketRpcLink } from '@orpc/client/websocket';
import { HibernationAsyncIteratorClass } from '@orpc/hibernation';
import { call, ORPCError, type RouterClient } from '@orpc/server';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AbilityHandlerError, CapabilityAuthError, servicePlaneErrorInfo } from '../shared/errors.js';
import type { CapabilityIdentity } from '../shared/types.js';
import { memoryWebSocketPair } from '../test-support/index.js';
import { AbilityHibernationStream, type AbilityMethodContext, createAbilityBuilder } from './ability.js';
import { defineAbility, defineAbilityService, serviceDiscoveryDocument } from './discovery.js';
import { encodeAbilityHibernationEvent } from './hibernation.js';
import { compileAbilityMethod, createAbilityRpcRuntimeContext } from './orpc.js';

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
  context: {} as AbilityMethodContext['context'],
  env: {},
  identity,
  request: new Request('https://tasks.internal/rpc/example.tasks/get'),
} satisfies AbilityMethodContext;

const runtimeContext = createAbilityRpcRuntimeContext({ authorize: () => context });

describe('private RPC ability runtime', () => {
  it('exposes Service Plane method builders without an engine procedure builder', () => {
    const builder = createAbilityBuilder();

    expect(builder).toHaveProperty('method');
    expect(builder).not.toHaveProperty('procedure');
  });

  it('keeps execution, schemas, scopes, and projections on one portable method', async () => {
    const ability = createAbilityBuilder();
    const input = z.object({ id: z.string() });
    const output = z.object({ id: z.string(), title: z.string() });
    const method = ability
      .method({
        mcp: { name: 'tasks_get' },
        rest: { method: 'get', path: '/tasks/{id}' },
        scopes: ['tasks.read'],
      })
      .input(input)
      .output(output)
      .handler(({ input: value }) => ({ ...value, title: 'Task' }));

    expect(method.metadata).toEqual({
      mcp: { name: 'tasks_get' },
      rest: { method: 'get', path: '/tasks/{id}' },
      scopes: ['tasks.read'],
    });
    expect(method.input).toBe(input);
    expect(method.output).toBe(output);
    expect(method.kind).toBe('unary');
    const procedure = compileAbilityMethod(method);
    await expect(call(procedure, { id: 'task-1' }, { context: runtimeContext })).resolves.toEqual({ id: 'task-1', title: 'Task' });
  });

  it('uses the yielded item schema for discovery and validates streamed items', async () => {
    const ability = createAbilityBuilder();
    const item = z.object({ sequence: z.number() });
    const method = ability
      .stream(item, { scopes: ['tasks.read'] })
      .input(z.object({ after: z.number() }))
      .handler(async function* ({ input }) {
        yield { sequence: input.after + 1 };
        yield { sequence: input.after + 2 };
      });

    expect(method.metadata).toEqual({ scopes: ['tasks.read'] });
    expect(method.output).toBe(item);
    expect(method.kind).toBe('stream');

    const procedure = compileAbilityMethod(method);
    const stream = await call(procedure, { after: 2 }, { context: runtimeContext });
    const values = [];
    for await (const value of stream as AsyncIterable<unknown>) values.push(value);
    expect(values).toEqual([{ sequence: 3 }, { sequence: 4 }]);
  });

  it('derives discovery from procedure schemas and metadata', () => {
    const ability = createAbilityBuilder();
    const definition = defineAbility({
      id: 'example.tasks',
      methods: {
        get: ability
          .method({ mcp: { name: 'tasks_get' }, scopes: ['tasks.read'] })
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
    const method = ability
      .method({ scopes: ['tasks.read'] })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true) }))
      .handler(() => ({ ok: true as const }));
    const procedure = compileAbilityMethod(method);
    const denied = createAbilityRpcRuntimeContext({
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

  it('keeps explicit handler errors and hides arbitrary handler failures', async () => {
    const ability = createAbilityBuilder();
    const failures: unknown[] = [];
    const visible = ability
      .method()
      .input(z.void())
      .output(z.void())
      .handler(() => {
        throw new AbilityHandlerError('No quota remains', { reason: 'quota_exhausted', status: 429 });
      });
    const leaky = ability
      .method()
      .input(z.void())
      .output(z.void())
      .handler(() => {
        throw new Error('postgres://secret@internal/tasks');
      });
    const runtime = createAbilityRpcRuntimeContext({
      authorize: () => context,
      onHandlerFailure: (cause) => failures.push(cause),
    });

    const visibleError = await call(compileAbilityMethod(visible), undefined, { context: runtime }).catch((error: unknown) => error);
    expect(servicePlaneErrorInfo(visibleError)).toMatchObject({ code: 'handler', reason: 'quota_exhausted', status: 429 });
    await expect(call(compileAbilityMethod(leaky), undefined, { context: runtime })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Service-Plane ability handler failed: unknown',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: 'postgres://secret@internal/tasks' });
  });

  it('enforces procedure ceilings without requiring a caller deadline', async () => {
    const ability = createAbilityBuilder();
    const method = ability
      .method({ timeoutMs: 5 })
      .input(z.void())
      .output(z.literal('done'))
      .handler(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return 'done' as const;
      });

    const error = await call(compileAbilityMethod(method), undefined, { context: runtimeContext }).catch((cause: unknown) => cause);
    expect(servicePlaneErrorInfo(error)).toMatchObject({ code: 'timeout', status: 504 });
  });

  it('preserves hibernation iterators instead of wrapping them in an in-memory deadline iterator', async () => {
    const ability = createAbilityBuilder();
    const output = z.string();
    const method = ability
      .hibernationStream(output)
      .input(z.void())
      .handler(() => new AbilityHibernationStream<string>(() => undefined));
    const runtime = createAbilityRpcRuntimeContext({
      authorize: () => context,
      deadlineAt: Date.now() + 1_000,
    });

    expect(method.kind).toBe('hibernation');
    expect(method.output).toBe(output);
    await expect(call(compileAbilityMethod(method), undefined, { context: runtime })).resolves.toBeInstanceOf(
      HibernationAsyncIteratorClass,
    );
    await expect(encodeAbilityHibernationEvent(output, 'stream-1', 'ready')).resolves.toBeTypeOf('string');
    await expect(encodeAbilityHibernationEvent(output, 'stream-1', 42 as never)).rejects.toMatchObject({
      code: 'ability_validation',
      status: 500,
    });
  });

  it('serves the same unary and streaming router over WebSocket', async () => {
    const ability = createAbilityBuilder();
    const methods = {
      get: ability
        .method()
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
    const router = {
      get: compileAbilityMethod(methods.get),
      watch: compileAbilityMethod(methods.watch),
    };
    const [clientSocket, serverSocket] = memoryWebSocketPair();
    const handler = new WebSocketRpcHandler(router);
    handler.upgrade(serverSocket as never, { context: () => runtimeContext });
    const link = new WebSocketRpcLink({ connect: () => clientSocket, url: '/' });
    const client = createORPCClient<RouterClient<typeof router>>(link);

    await expect(client.get({ id: 'task-ws' })).resolves.toEqual({ id: 'task-ws' });
    const stream = await client.watch({ after: 10 });
    const values = [];
    for await (const value of stream as AsyncIterable<unknown>) values.push(value);
    expect(values).toEqual([11, 12]);
  });
});
