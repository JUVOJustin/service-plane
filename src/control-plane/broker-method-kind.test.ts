import { RPCLink } from '@orpc/client/fetch';
import { call, os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { describe, expect, it, vi } from 'vitest';
import { createRpcClientPlugins, createRpcHandlerPlugins } from '../service/orpc-features.js';
import type { DiscoveredServiceAbility, ServiceEndpoint, ServiceRegistry } from '../shared/types.js';
import { controlPlaneBrokerRouter, createControlPlaneRpcBroker } from './broker.js';

function fixture() {
  const invoked = vi.fn();
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: async () => ({ done: true as const, value: undefined }),
    return: vi.fn(async () => ({ done: true as const, value: undefined })),
  };
  const handler = new RPCHandler(
    {
      watch: os.handler(() => {
        invoked('watch');
        return source;
      }),
    },
    { plugins: createRpcHandlerPlugins({}, false) },
  );
  const fetch = vi.fn(async (request: Request) => {
    const result = await handler.handle(request, { prefix: '/rpc/v1/tasks.items' });
    return result.matched ? result.response : new Response(null, { status: 404 });
  });
  const invokeAbility = vi.fn(async () => {
    invoked('get');
    return { ok: true };
  });
  const service: ServiceEndpoint = { abilityRpc: { invokeAbility }, fetch, id: 'tasks', origin: 'https://tasks.internal' };
  const ability: DiscoveredServiceAbility = {
    access: 'plane',
    exposure: 'private',
    id: 'tasks.items',
    methods: {
      get: { inputSchema: {}, outputSchema: {}, scopes: ['tasks.read'] },
      watch: { inputSchema: {}, outputSchema: {}, scopes: ['tasks.read'], stream: true },
    },
    rpc: { path: '/rpc/v1/tasks.items', protocol: 'service-plane-rpc/1', transports: ['fetch', 'service-binding'] },
    scopes: ['tasks.read'],
    service,
    serviceId: service.id,
    serviceTitle: 'Tasks',
    serviceVersion: '1.0.0',
  };
  const registry: ServiceRegistry = {
    abilities: async () => [ability],
    ability: async () => ability,
    discover: async () => ({ abilities: [ability], discoveredAt: new Date(0).toISOString(), services: [] }),
    endpoint: () => service,
  };
  const issue = vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60_000), token: 'token' }));
  const authorizeInvocation = vi.fn(() => true);
  const broker = createControlPlaneRpcBroker({
    authorizeInvocation,
    controlPlaneServiceId: 'plane',
    issuer: { issueBrokeredCapabilityToken: issue, issueCapabilityToken: issue, jwks: async () => ({ keys: [] }) },
    registry,
  });
  return { authorizeInvocation, broker, fetch, invokeAbility, invoked, issue, source };
}

function input(method: string) {
  return { abilityId: 'tasks.items', input: {}, method, scopes: ['tasks.read'], targetServiceId: 'tasks' };
}

describe('broker method kind boundary', () => {
  it.each([false, true])('enforces both endpoint kinds through Fetch (batch=%s)', async (batch) => {
    const f = fixture();
    const handler = new RPCHandler(controlPlaneBrokerRouter, { plugins: createRpcHandlerPlugins({ batch }, false) });
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const result = await handler.handle(new Request(url, init), {
        context: { resolveBroker: async () => ({ broker: f.broker }) },
        prefix: '/broker',
      });
      return result.matched ? result.response : new Response(null, { status: 404 });
    });
    const link = new RPCLink({ fetch, origin: 'https://plane.internal', plugins: createRpcClientPlugins({ batch }), url: '/broker' });
    await Promise.all([
      expect(link.call(['call'], input('watch'), { context: {} })).rejects.toMatchObject({ code: 'METHOD_NOT_SUPPORTED' }),
      expect(link.call(['stream'], input('get'), { context: {} })).rejects.toMatchObject({ code: 'METHOD_NOT_SUPPORTED' }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(batch ? 1 : 2);
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.invokeAbility).not.toHaveBeenCalled();
  });

  it.each([
    ['call', 'watch', 'stream'],
    ['stream', 'get', 'call'],
  ] as const)('rejects %s/%s before authorization, issuance or dispatch', async (endpoint, method, attackerKind) => {
    const f = fixture();
    await expect(
      call(
        controlPlaneBrokerRouter[endpoint],
        { ...input(method), expectedKind: attackerKind },
        {
          context: { resolveBroker: async () => ({ broker: f.broker }) },
        },
      ),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_SUPPORTED' });
    expect(f.authorizeInvocation).not.toHaveBeenCalled();
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.invokeAbility).not.toHaveBeenCalled();
    expect(f.invoked).not.toHaveBeenCalled();
  });

  it('preserves native unary calls, Fetch streams and direct in-process stream dispatch', async () => {
    const f = fixture();
    const context = { resolveBroker: async () => ({ broker: f.broker }) };
    await expect(call(controlPlaneBrokerRouter.call, input('get'), { context })).resolves.toEqual({ ok: true });
    const stream = await call(controlPlaneBrokerRouter.stream, input('watch'), { context });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    const direct = (await f.broker.callAbility(input('watch'))) as AsyncIterator<unknown>;
    await expect(direct.next()).resolves.toMatchObject({ done: true });
    expect(f.issue).toHaveBeenCalledTimes(3);
    expect(f.invokeAbility).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['iterator-object', 'iterable', 'plain-iterator'] as const)(
    'closes an unexpected %s returned by a divergent backend',
    async (kind) => {
      const iterator = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next: vi.fn(async () => ({ done: false as const, value: 'unused' })),
        return: vi.fn(async () => ({ done: true as const, value: undefined })),
      };
      const output =
        kind === 'iterator-object'
          ? iterator
          : { [Symbol.asyncIterator]: () => (kind === 'plain-iterator' ? { next: iterator.next, return: iterator.return } : iterator) };
      await expect(
        call(controlPlaneBrokerRouter.call, input('get'), {
          context: { resolveBroker: async () => ({ broker: { callAbility: async () => output } }) },
        }),
      ).rejects.toMatchObject({ code: 'METHOD_NOT_SUPPORTED' });
      expect(iterator.return).toHaveBeenCalledOnce();
      expect(iterator.next).not.toHaveBeenCalled();
    },
  );
});
