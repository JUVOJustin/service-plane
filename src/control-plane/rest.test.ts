import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { createAbilityBuilder, defineAbility, defineCapabilities, ServicePlaneService } from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import type { ConnInfo } from '../shared/conn-info.js';
import type { ServicePlaneLogSink } from '../shared/logging.js';
import { SERVICE_PLANE_RPC_PROTOCOL } from '../shared/rpc-protocol.js';
import { type DiscoveredServiceAbility, SERVICE_DISCOVERY_PATH } from '../shared/types.js';
import type { CapabilityIssuer } from './capabilities.js';
import {
  ServicePlaneControlPlane,
  type ServicePlaneControlPlaneInvocation,
  type ServicePlaneControlPlaneVariables,
} from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { handleControlPlaneRestRequest } from './rest.js';
import { generateCapabilitySigningSecret, privateJwkFromCapabilitySigningSecret } from './signing-keys.js';

const PLANE_ORIGIN = 'https://plane.internal';
const SCOPE = 'connections.snapshots.write';

type TestEnv = {
  Variables: ServicePlaneControlPlaneVariables;
};

describe('control-plane REST facade', () => {
  it('keeps REST invocation observers from changing dispatch or catalog scopes', async () => {
    const invokeAbility = vi.fn(async () => ({ ok: true }));
    const ability: DiscoveredServiceAbility = {
      access: 'plane',
      exposure: 'published',
      id: 'tasks',
      methods: {
        get: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          rest: { method: 'get', path: '/tasks' },
          scopes: ['tasks.read'],
        },
      },
      rpc: { path: '/rpc/v1/tasks', protocol: SERVICE_PLANE_RPC_PROTOCOL, transports: ['service-binding'] },
      scopes: ['tasks.read', 'tasks.admin'],
      service: {
        abilityRpc: { invokeAbility },
        fetch: async () => new Response(null, { status: 500 }),
        id: 'tasks-service',
        origin: 'https://tasks.internal',
      },
      serviceId: 'tasks-service',
      serviceTitle: 'Tasks',
      serviceVersion: '1.0.0',
    };
    const issueCapabilityToken = vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60_000), token: 'unused' }));
    const issuer: CapabilityIssuer = {
      issueBrokeredCapabilityToken: issueCapabilityToken,
      issueCapabilityToken,
      jwks: async () => ({ keys: [] }),
    };

    const response = await handleControlPlaneRestRequest(new Request(`${PLANE_ORIGIN}/tasks`), {
      onInvocation: (invocation) => {
        (invocation.scopes as string[]).push('tasks.admin');
      },
      registry: { discover: async () => ({ abilities: [ability], discoveredAt: new Date(0).toISOString(), services: [] }) },
      resolveInvocation: async () => ({ controlPlaneServiceId: 'control-plane', issuer }),
    });

    expect(response.status).toBe(200);
    expect(issueCapabilityToken).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['tasks.read'] }));
    expect(ability.methods.get?.scopes).toEqual(['tasks.read']);
    expect(invokeAbility).toHaveBeenCalledOnce();
  });

  it('rejects an invalid body limit when the plane is constructed', () => {
    expect(
      () =>
        new ServicePlaneControlPlane({
          broker: false,
          openapi: false,
          rest: { maxBodyBytes: 0 },
          services: () => [],
          signingKeys: () => [],
        }),
    ).toThrow('Service-Plane REST maxBodyBytes must be a positive safe integer');
  });

  it('can leave the REST catch-all unmounted without resolving the service catalog', async () => {
    const app = new Hono();
    app.get('/health', (context) => context.text('ok'));
    let serviceResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      app,
      broker: false,
      log: false,
      openapi: false,
      rest: false,
      services: () => {
        serviceResolutions += 1;
        return [];
      },
      signingKeys: () => [],
    });

    const health = await plane.fetch(new Request(`${PLANE_ORIGIN}/health`));
    const missing = await plane.fetch(new Request(`${PLANE_ORIGIN}/missing`));

    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    expect(missing.status).toBe(404);
    expect(serviceResolutions).toBe(0);
  });

  it('uses middleware identity and connection info, preserves query arrays, and applies path > body > query', async () => {
    const observed: Array<{ input: unknown; subject: unknown; connInfo: ConnInfo | undefined }> = [];
    const { endpoint, signingKey } = await restService(observed);
    let invocation: ServicePlaneControlPlaneInvocation | undefined;
    const app = new Hono<TestEnv>();
    app.use('*', async (context, next) => {
      context.set('servicePlaneCaller', { id: 'user-7', kind: 'user', orgId: 'org-42' });
      context.set('servicePlaneConnInfo', { remote: { address: '203.0.113.7', port: 443 } });
      await next();
      invocation = context.get('servicePlaneInvocation');
    });
    const plane = new ServicePlaneControlPlane<TestEnv>({
      app,
      broker: false,
      issuer: PLANE_ORIGIN,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-path/snapshots?connectionId=conn-query&dryRun=true&tags=nightly`, {
        body: JSON.stringify({ connectionId: 'conn-body', name: 'Nightly' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ connectionId: 'conn-path', name: 'Nightly' });
    expect(observed).toEqual([
      {
        connInfo: { remote: { address: '203.0.113.7', port: 443 } },
        input: { connectionId: 'conn-path', dryRun: 'true', name: 'Nightly', tags: ['nightly'] },
        subject: { id: 'user-7', orgId: 'org-42' },
      },
    ]);
    expect(invocation).toEqual({
      abilityId: 'connections.snapshots',
      method: 'createSnapshot',
      path: '/connections/{connectionId}/snapshots',
      scopes: [SCOPE],
      serviceId: 'connections',
      surface: 'rest',
    });

    const prefix = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-path/snapshots/extra`, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(prefix.status).toBe(404);
  });

  it('prefers application routes registered later over colliding REST projections', async () => {
    const observed: Array<{ input: unknown; subject: unknown; connInfo: ConnInfo | undefined }> = [];
    const { endpoint, signingKey } = await restService(observed);
    let invocationMiddlewareCalls = 0;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        invocationMiddlewareCalls += 1;
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      log: false,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });
    plane.app.get('/connections/:connectionId/snapshots', (context) => context.text('application route'));

    const applicationResponse = await plane.fetch(new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots`));

    expect(applicationResponse.status).toBe(200);
    expect(await applicationResponse.text()).toBe('application route');
    expect(invocationMiddlewareCalls).toBe(0);

    const restResponse = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots`, {
        body: JSON.stringify({ dryRun: 'false', name: 'Nightly' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(restResponse.status).toBe(202);
    expect(invocationMiddlewareCalls).toBe(1);
    expect(observed).toHaveLength(1);
  });

  it('reuses the matched discovery snapshot for token issuance', async () => {
    const { endpoint, signingKey } = await restService([]);
    let discoveryFetches = 0;
    const countedEndpoint = {
      ...endpoint,
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === SERVICE_DISCOVERY_PATH) discoveryFetches += 1;
        return endpoint.fetch(request);
      },
    };
    const plane = new ServicePlaneControlPlane({
      discoveryCache: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      log: false,
      openapi: false,
      broker: false,
      services: () => [countedEndpoint],
      signingKeys: () => [signingKey],
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots`, {
        body: JSON.stringify({ dryRun: 'false', name: 'Nightly' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(response.status).toBe(202);
    expect(discoveryFetches).toBe(1);
  });

  it('authenticates before route discovery and exposes matched metadata after the response', async () => {
    const { endpoint, signingKey } = await restService([]);
    const before: ServicePlaneControlPlaneInvocation[] = [];
    const after: Array<{ invocation: ServicePlaneControlPlaneInvocation | undefined; status: number }> = [];
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        const invocation = context.get('servicePlaneInvocation');
        if (invocation) before.push(invocation);
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
        after.push({ invocation: context.get('servicePlaneInvocation'), status: context.res.status });
      },
      issuer: PLANE_ORIGIN,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });

    const failed = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots?dryRun=true`, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    const unmatched = await plane.fetch(new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots/extra`, { method: 'POST' }));
    const emptySegment = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections//snapshots`, {
        body: JSON.stringify({ name: 'Nightly' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(failed.status).toBe(422);
    expect(unmatched.status).toBe(404);
    expect(emptySegment.status).toBe(404);
    expect(before).toEqual([]);
    expect(after).toEqual([
      {
        invocation: {
          abilityId: 'connections.snapshots',
          method: 'createSnapshot',
          path: '/connections/{connectionId}/snapshots',
          scopes: [SCOPE],
          serviceId: 'connections',
          surface: 'rest',
        },
        status: 422,
      },
      { invocation: undefined, status: 404 },
      { invocation: undefined, status: 404 },
    ]);
  });

  it('fails closed without middleware caller identity and returns Allow for a known path', async () => {
    const { endpoint, signingKey } = await restService([]);
    const plane = new ServicePlaneControlPlane({
      broker: false,
      issuer: PLANE_ORIGIN,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });
    const missingCaller = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots`, {
        body: '{}',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(missingCaller.status).toBe(500);

    const authenticated = new ServicePlaneControlPlane({
      broker: false,
      issuer: PLANE_ORIGIN,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      log: false,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });
    const wrongMethod = await authenticated.fetch(new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots`));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
  });

  it('routes published paths across multiple abilities and services', async () => {
    const secret = await generateCapabilitySigningSecret();
    const kid = 'shared-rest-key';
    const endpoints = await Promise.all([
      routedRestService({ kid, path: '/asana/tasks/{id}', secret, serviceId: 'asana', status: 201 }),
      routedRestService({ kid, path: '/slack/messages/{id}', secret, serviceId: 'slack' }),
    ]);
    const plane = new ServicePlaneControlPlane({
      broker: false,
      issuer: PLANE_ORIGIN,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'product-user', kind: 'user' });
        await next();
      },
      openapi: false,
      services: () => endpoints,
      signingKeys: () => [{ kid, secret }],
    });

    const asana = await plane.fetch(new Request(`${PLANE_ORIGIN}/asana/tasks/A-1`));
    expect(asana.status).toBe(201);
    await expect(asana.json()).resolves.toEqual({
      id: 'A-1',
      serviceId: 'asana',
    });
    const slack = await plane.fetch(new Request(`${PLANE_ORIGIN}/slack/messages/S-1`));
    expect(slack.status).toBe(200);
    await expect(slack.json()).resolves.toEqual({
      id: 'S-1',
      serviceId: 'slack',
    });
  });

  it('prefers static paths, rejects ambiguous templates, and hides private projections', async () => {
    const secret = await generateCapabilitySigningSecret();
    const kid = 'route-order-key';
    const endpoints = await Promise.all([
      routedRestService({ kid, path: '/items/{id}', secret, serviceId: 'template' }),
      routedRestService({ kid, path: '/items/special', secret, serviceId: 'static' }),
      routedRestService({ kid, path: '/ambiguous/{id}', secret, serviceId: 'ambiguous-id' }),
      routedRestService({ kid, path: '/ambiguous/{slug}', secret, serviceId: 'ambiguous-slug' }),
      routedRestService({ exposure: 'private', kid, path: '/private/{id}', secret, serviceId: 'private' }),
    ]);
    let middlewareCalls = 0;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      issuer: PLANE_ORIGIN,
      log: false,
      invocationMiddleware: async (context, next) => {
        middlewareCalls += 1;
        context.set('servicePlaneCaller', { id: 'product-user', kind: 'user' });
        await next();
      },
      openapi: false,
      services: () => endpoints,
      signingKeys: () => [{ kid, secret }],
    });

    const staticMatch = await plane.fetch(new Request(`${PLANE_ORIGIN}/items/special?id=query-value`));
    expect(staticMatch.status).toBe(200);
    await expect(staticMatch.json()).resolves.toEqual({ id: 'query-value', serviceId: 'static' });

    const ambiguous = await plane.fetch(new Request(`${PLANE_ORIGIN}/ambiguous/value`));
    expect(ambiguous.status).toBe(500);
    await expect(ambiguous.json()).resolves.toEqual({
      error: {
        code: 'capability_auth',
        message: 'Ambiguous Service-Plane REST route: GET /ambiguous/value',
        retryable: false,
      },
    });

    const hidden = await plane.fetch(new Request(`${PLANE_ORIGIN}/private/secret`));
    expect(hidden.status).toBe(404);
    expect(middlewareCalls).toBe(3);
  });

  it('bounds and validates JSON bodies before opening an ability session', async () => {
    const { endpoint, signingKey } = await restService([]);
    let signingKeyResolutions = 0;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      openapi: false,
      rest: { maxBodyBytes: 8 },
      services: () => [endpoint],
      signingKeys: () => {
        signingKeyResolutions += 1;
        return [signingKey];
      },
    });
    const request = (body: string, contentType: string) =>
      plane.fetch(
        new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots?dryRun=true`, {
          body,
          headers: { 'content-type': contentType },
          method: 'POST',
        }),
      );

    expect((await request('{broken', 'application/json')).status).toBe(400);
    expect((await request('{}', 'text/plain')).status).toBe(415);
    expect((await request('{"name":1}', 'application/json')).status).toBe(413);
    expect(signingKeyResolutions).toBe(0);
  });

  it('keeps the REST body available after body-bound invocation authentication', async () => {
    const observed: Array<{ input: unknown; subject: unknown; connInfo: ConnInfo | undefined }> = [];
    const { endpoint, signingKey } = await restService(observed);
    const body = JSON.stringify({ name: 'Signed request' });
    let authenticatedBody: string | undefined;
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        authenticatedBody = await context.req.raw.text();
        context.set('servicePlaneCaller', { id: 'signed-user', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      log: false,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots?dryRun=true`, {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

    expect(authenticatedBody).toBe(body);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ connectionId: 'conn-1', name: 'Signed request' });
    expect(observed).toHaveLength(1);
  });

  it('cancels both REST body branches when invocation middleware refuses the request', async () => {
    const { endpoint, signingKey } = await restService([]);
    let cancelled = false;
    let serviceResolutions = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"name":"Unread"}'));
      },
    });
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: (context) => Promise.resolve(context.json({ error: 'Unauthorized' }, 401)),
      issuer: PLANE_ORIGIN,
      log: false,
      openapi: false,
      services: () => {
        serviceResolutions += 1;
        return [endpoint];
      },
      signingKeys: () => [signingKey],
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots?dryRun=true`, {
        body,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        duplex: 'half',
      } as RequestInit),
    );

    expect(response.status).toBe(401);
    expect(serviceResolutions).toBe(0);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it('returns bodyless 205 responses exactly as declared', async () => {
    const { endpoint, signingKey } = await restService([], 205);
    const plane = new ServicePlaneControlPlane({
      broker: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      openapi: false,
      services: () => [endpoint],
      signingKeys: () => [signingKey],
    });

    const response = await plane.fetch(
      new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots?dryRun=true`, {
        body: JSON.stringify({ name: 'Nightly' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(205);
    expect(await response.text()).toBe('');
  });

  it('contains throwing REST log sinks for both completed and failed invocations', async () => {
    await expectRestLogSinkContained(() => {
      throw new Error('synchronous log failure');
    });
  });

  it('observes rejected async REST log sinks without rejecting either response', async () => {
    await expectRestLogSinkContained(() => Promise.reject(new Error('asynchronous log failure')));
  });
});

async function expectRestLogSinkContained(fail: () => unknown): Promise<void> {
  const observed: Array<{ input: unknown; subject: unknown; connInfo: ConnInfo | undefined }> = [];
  const { endpoint, signingKey } = await restService(observed);
  const loggedEvents: string[] = [];
  const log: ServicePlaneLogSink = (event) => {
    if (event.event !== 'service_plane.rest.completed' && event.event !== 'service_plane.rest.failed') return;
    loggedEvents.push(event.event);
    return fail();
  };
  const plane = new ServicePlaneControlPlane({
    broker: false,
    invocationMiddleware: async (context, next) => {
      context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
      await next();
    },
    issuer: PLANE_ORIGIN,
    log,
    openapi: false,
    services: () => [endpoint],
    signingKeys: () => [signingKey],
  });

  const completed = await plane.fetch(
    new Request(`${PLANE_ORIGIN}/connections/conn-1/snapshots?dryRun=true`, {
      body: JSON.stringify({ name: 'Persisted before logging' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );
  const failed = await plane.fetch(
    new Request(`${PLANE_ORIGIN}/connections/conn-2/snapshots?dryRun=true`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  );

  expect(completed.status).toBe(202);
  await expect(completed.json()).resolves.toEqual({ connectionId: 'conn-1', name: 'Persisted before logging' });
  expect(failed.status).toBe(422);
  expect(observed).toHaveLength(1);
  expect(loggedEvents).toEqual(['service_plane.rest.completed', 'service_plane.rest.failed']);
  await Promise.resolve();
}

async function routedRestService(options: {
  exposure?: 'private' | 'published';
  kid: string;
  path: string;
  secret: string;
  serviceId: string;
  status?: number;
}) {
  const scope = `${options.serviceId}.items.read`;
  const privateJwk = privateJwkFromCapabilitySigningSecret(options.secret, options.kid);
  const capabilities = defineCapabilities({ scopes: [{ id: scope }], serviceId: options.serviceId });
  const method = createAbilityBuilder();
  const ability = defineAbility({
    access: 'plane',
    exposure: options.exposure ?? 'published',
    id: `${options.serviceId}.items`,
    methods: {
      get: method.method({
        handler: ({ input }) => ({ id: input.id ?? input.slug ?? '', serviceId: options.serviceId }),
        input: z.object({ id: z.string().optional(), slug: z.string().optional() }),
        output: z.object({ id: z.string(), serviceId: z.string() }),
        rest: { method: 'get', path: options.path, ...(options.status === undefined ? {} : { status: options.status }) },
        scopes: [scope],
      }),
    },
    scopes: [scope],
  });
  const service = new ServicePlaneService({
    abilities: [ability],
    auth: { issuer: PLANE_ORIGIN, jwks: { keys: [publicJwkFromPrivateJwk(privateJwk, options.kid)] } },
    capabilities,
    id: options.serviceId,
    ingress: { brokerServiceIds: ['control-plane'] },
    logger: false,
    title: options.serviceId,
    version: '1.0.0',
  });
  return cloudflareServiceBinding({
    binding: { fetch: async (request) => service.fetch(request) },
    grants: [{ caller: 'control-plane', scopes: [scope] }],
    id: options.serviceId,
  });
}

async function restService(observed: Array<{ input: unknown; subject: unknown; connInfo: ConnInfo | undefined }>, status = 202) {
  const secret = await generateCapabilitySigningSecret();
  const kid = 'rest-key';
  const privateJwk = privateJwkFromCapabilitySigningSecret(secret, kid);
  const capabilities = defineCapabilities({ scopes: [{ id: SCOPE }], serviceId: 'connections' });
  const method = createAbilityBuilder();
  const ability = defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'connections.snapshots',
    methods: {
      createSnapshot: method.method({
        handler: ({ context, input }) => {
          observed.push({ connInfo: context.connInfo, input, subject: context.identity.subject });
          return { connectionId: input.connectionId, name: input.name };
        },
        input: z.object({ connectionId: z.string(), dryRun: z.string(), name: z.string(), tags: z.array(z.string()).optional() }),
        output: z.object({ connectionId: z.string(), name: z.string() }),
        rest: { method: 'post', path: '/connections/{connectionId}/snapshots', status },
        scopes: [SCOPE],
      }),
    },
    scopes: [SCOPE],
  });
  const service = new ServicePlaneService({
    abilities: [ability],
    auth: { issuer: PLANE_ORIGIN, jwks: { keys: [publicJwkFromPrivateJwk(privateJwk, kid)] } },
    capabilities,
    id: 'connections',
    ingress: { brokerServiceIds: ['control-plane'] },
    logger: false,
    title: 'Connections',
    version: '1.0.0',
  });
  return {
    endpoint: cloudflareServiceBinding({
      binding: { fetch: async (request) => service.fetch(request) },
      grants: [{ caller: 'control-plane', scopes: [SCOPE] }],
      id: 'connections',
    }),
    signingKey: { kid, secret },
  };
}
