import { describe, expect, it, vi } from 'vitest';
import type { ServiceDiscoveryDocument } from '../shared/types.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import type { ControlPlaneMcpHandlerOptions, PreparedControlPlaneMcpRequest } from './mcp.js';
import { handleControlPlaneMcpRequest, handlePreparedControlPlaneMcpRequest, prepareControlPlaneMcpRequest } from './mcp.js';

function rpcRequest(body: BodyInit, init: RequestInit = {}): Request {
  return new Request('https://plane.internal/mcp', {
    body,
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    ...init,
  });
}

function unavailableRuntimeOptions(): ControlPlaneMcpHandlerOptions {
  return {
    controlPlaneServiceId: 'control-plane',
    get issuer(): ControlPlaneMcpHandlerOptions['issuer'] {
      throw new Error('issuer must not be resolved');
    },
    get registry(): ControlPlaneMcpHandlerOptions['registry'] {
      throw new Error('registry must not be resolved');
    },
  };
}

function expectPrepared(value: PreparedControlPlaneMcpRequest | Response): PreparedControlPlaneMcpRequest {
  if (value instanceof Response) throw new Error(`Expected a prepared request, received HTTP ${value.status}`);
  return value;
}

describe('control-plane MCP request preflight', () => {
  it('composes the public handler without touching runtime dependencies for invalid requests', async () => {
    const response = await handleControlPlaneMcpRequest(rpcRequest('{nope'), unavailableRuntimeOptions());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 }, id: null });
  });

  it('rejects an oversized chunked body and cancels its reader during preflight', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"ping"}'));
      },
    });
    const request = rpcRequest(body, { duplex: 'half' } as RequestInit);

    const result = await prepareControlPlaneMcpRequest(request, { maxBodyBytes: 8 });

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32600, data: { status: 413 } }, id: null });
    expect(cancelled).toBe(true);
  });

  it('dispatches a prepared request without reading its consumed body again', async () => {
    const request = rpcRequest(JSON.stringify({ id: 'ping-1', jsonrpc: '2.0', method: 'ping' }));
    const prepared = expectPrepared(await prepareControlPlaneMcpRequest(request));

    expect(request.bodyUsed).toBe(true);
    expect(prepared).toMatchObject({ acceptsEventStream: true, id: 'ping-1', method: 'ping' });

    const response = await handlePreparedControlPlaneMcpRequest(prepared, unavailableRuntimeOptions());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'ping-1', jsonrpc: '2.0', result: {} });
  });

  it('leaves the mounted request body available to body-bound authentication', async () => {
    const body = JSON.stringify({ id: 'signed-ping', jsonrpc: '2.0', method: 'ping' });
    let authenticatedBody: string | undefined;
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: async (context, next) => {
        authenticatedBody = await context.req.raw.text();
        if (authenticatedBody !== body) return context.json({ error: 'Invalid signature' }, 401);
        context.set('servicePlaneCaller', { id: 'signed-client', kind: 'service' });
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      rest: false,
      services: () => {
        throw new Error('ping must not resolve services');
      },
      signingKeys: () => {
        throw new Error('ping must not resolve signing keys');
      },
    });

    const response = await plane.fetch(rpcRequest(body));

    expect(authenticatedBody).toBe(body);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 'signed-ping', jsonrpc: '2.0', result: {} });
  });

  it('cancels the unused parsing clone when invocation middleware refuses the request', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":1,"jsonrpc":"2.0","method":"ping"}'));
      },
    });
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: (context) => Promise.resolve(context.json({ error: 'Unauthorized' }, 401)),
      log: false,
      mcp: {},
      openapi: false,
      rest: false,
      services: () => [],
      signingKeys: () => [],
    });

    const response = await plane.fetch(rpcRequest(body, { duplex: 'half' } as RequestInit));

    expect(response.status).toBe(401);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('runs invocation middleware before parsing a valid-size malformed body', async () => {
    let middlewareCalls = 0;
    let authenticatedBody: string | undefined;
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: async (context, next) => {
        middlewareCalls += 1;
        authenticatedBody = await context.req.raw.text();
        context.set('servicePlaneCaller', { id: 'signed-client', kind: 'service' });
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      rest: false,
      services: () => {
        throw new Error('malformed JSON must not resolve services');
      },
      signingKeys: () => {
        throw new Error('malformed JSON must not resolve signing keys');
      },
    });

    const response = await plane.fetch(rpcRequest('{nope'));

    expect(middlewareCalls).toBe(1);
    expect(authenticatedBody).toBe('{nope');
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700 }, id: null });
  });

  it('rejects a declared oversized body at the cheap boundary before invocation middleware', async () => {
    let middlewareCalls = 0;
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: async (context, next) => {
        middlewareCalls += 1;
        context.set('servicePlaneCaller', { id: 'client', kind: 'user' });
        await next();
      },
      log: false,
      mcp: { maxBodyBytes: 3 },
      openapi: false,
      rest: false,
      services: () => [],
      signingKeys: () => [],
    });

    const response = await plane.fetch(
      rpcRequest('1234', {
        headers: { 'content-length': '4', 'content-type': 'application/json' },
      }),
    );

    expect(response.status).toBe(413);
    expect(middlewareCalls).toBe(0);
  });

  it('resolves only the runtime dependencies required by the MCP method', async () => {
    const discovery: ServiceDiscoveryDocument = {
      abilities: [
        {
          access: 'plane',
          exposure: 'published',
          id: 'tasks',
          methods: {
            get: {
              inputSchema: { type: 'object' },
              mcp: { name: 'tasks_get' },
              outputSchema: { type: 'object' },
              scopes: ['tasks.read'],
            },
          },
          rpc: { path: '/rpc/tasks', transports: ['fetch'] },
          scopes: ['tasks.read'],
        },
      ],
      capabilities: { scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' },
      id: 'tasks',
      title: 'Tasks',
      version: '1.0.0',
    };
    let serviceResolutions = 0;
    let signingKeyResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'mcp-client', kind: 'user' });
        await next();
      },
      log: false,
      mcp: {},
      openapi: false,
      rest: false,
      services: () => {
        serviceResolutions += 1;
        return [
          cloudflareServiceBinding({
            binding: { fetch: async () => Response.json({}) },
            discovery,
            grants: [{ caller: 'mcp-client', scopes: ['tasks.read'] }],
            id: 'tasks',
          }),
        ];
      },
      signingKeys: () => {
        signingKeyResolutions += 1;
        return [];
      },
    });
    const call = (method: string) => plane.fetch(rpcRequest(JSON.stringify({ id: method, jsonrpc: '2.0', method, params: {} })));

    expect((await call('ping')).status).toBe(200);
    expect((await call('initialize')).status).toBe(200);
    expect((await call('unsupported/method')).status).toBe(200);
    expect(serviceResolutions).toBe(0);
    expect(signingKeyResolutions).toBe(0);

    const list = await call('tools/list');
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ result: { tools: [{ name: 'tasks_get' }] } });
    expect(serviceResolutions).toBe(1);
    expect(signingKeyResolutions).toBe(0);
  });
});
