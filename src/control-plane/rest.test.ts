import { RpcTarget } from 'capnweb';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { abilityMethod, defineAbility, defineCapabilities, ServicePlaneService } from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/capability-tokens.js';
import type { ConnInfo } from '../shared/conn-info.js';
import {
  ServicePlaneControlPlane,
  type ServicePlaneControlPlaneInvocation,
  type ServicePlaneControlPlaneVariables,
} from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret, privateJwkFromCapabilitySigningSecret } from './signing-keys.js';

const PLANE_ORIGIN = 'https://plane.internal';
const SCOPE = 'connections.snapshots.write';

type TestEnv = {
  Variables: ServicePlaneControlPlaneVariables;
};

describe('control-plane REST facade', () => {
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
      rpc: false,
      issuer: PLANE_ORIGIN,
      mcp: false,
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

  it('falls through unmatched projections to application routes registered later', async () => {
    const plane = new ServicePlaneControlPlane({
      rpc: false,
      log: false,
      mcp: false,
      openapi: false,
      services: () => [],
      signingKeys: () => [],
    });
    plane.app.get('/ui', (context) => context.text('docs'));

    const response = await plane.fetch(new Request(`${PLANE_ORIGIN}/ui`));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('docs');
  });

  it('runs invocation middleware only for an exact match and exposes metadata plus the final response', async () => {
    const { endpoint, signingKey } = await restService([]);
    const before: ServicePlaneControlPlaneInvocation[] = [];
    const after: Array<{ invocation: ServicePlaneControlPlaneInvocation | undefined; status: number }> = [];
    const plane = new ServicePlaneControlPlane({
      rpc: false,
      invocationMiddleware: async (context, next) => {
        const invocation = context.get('servicePlaneInvocation');
        if (invocation) before.push(invocation);
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
        after.push({ invocation: context.get('servicePlaneInvocation'), status: context.res.status });
      },
      issuer: PLANE_ORIGIN,
      mcp: false,
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
    expect(before).toEqual([
      {
        abilityId: 'connections.snapshots',
        method: 'createSnapshot',
        path: '/connections/{connectionId}/snapshots',
        scopes: [SCOPE],
        serviceId: 'connections',
        surface: 'rest',
      },
    ]);
    expect(after).toEqual([{ invocation: before[0], status: 422 }]);
  });

  it('fails closed without middleware caller identity and returns Allow for a known path', async () => {
    const { endpoint, signingKey } = await restService([]);
    const plane = new ServicePlaneControlPlane({
      rpc: false,
      issuer: PLANE_ORIGIN,
      mcp: false,
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
      rpc: false,
      issuer: PLANE_ORIGIN,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      log: false,
      mcp: false,
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
      rpc: false,
      issuer: PLANE_ORIGIN,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'product-user', kind: 'user' });
        await next();
      },
      mcp: false,
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
      rpc: false,
      issuer: PLANE_ORIGIN,
      log: false,
      invocationMiddleware: async (context, next) => {
        middlewareCalls += 1;
        context.set('servicePlaneCaller', { id: 'product-user', kind: 'user' });
        await next();
      },
      mcp: false,
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
    expect(middlewareCalls).toBe(1);
  });

  it('bounds and validates JSON bodies before opening an ability session', async () => {
    const { endpoint, signingKey } = await restService([]);
    const plane = new ServicePlaneControlPlane({
      rpc: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      mcp: false,
      openapi: false,
      rest: { maxBodyBytes: 8 },
      services: () => [endpoint],
      signingKeys: () => [signingKey],
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
  });

  it('returns bodyless 205 responses exactly as declared', async () => {
    const { endpoint, signingKey } = await restService([], 205);
    const plane = new ServicePlaneControlPlane({
      rpc: false,
      invocationMiddleware: async (context, next) => {
        context.set('servicePlaneCaller', { id: 'user-7', kind: 'user' });
        await next();
      },
      issuer: PLANE_ORIGIN,
      mcp: false,
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
});

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
  const ability = defineAbility({
    access: 'plane',
    exposure: options.exposure ?? 'published',
    id: `${options.serviceId}.items`,
    methods: {
      get: abilityMethod({
        input: z.object({ id: z.string().optional(), slug: z.string().optional() }),
        output: z.object({ id: z.string(), serviceId: z.string() }),
        rest: { method: 'get', path: options.path, ...(options.status === undefined ? {} : { status: options.status }) },
        scopes: [scope],
      }),
    },
    scopes: [scope],
    handler: () => {
      class ItemsHandler extends RpcTarget {
        async get(input: { id?: string; slug?: string }) {
          return { id: input.id ?? input.slug ?? '', serviceId: options.serviceId };
        }
      }
      return new ItemsHandler() as ItemsHandler & Record<string, unknown>;
    },
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
  const ability = defineAbility({
    access: 'plane',
    exposure: 'published',
    id: 'connections.snapshots',
    methods: {
      createSnapshot: abilityMethod({
        input: z.object({ connectionId: z.string(), dryRun: z.string(), name: z.string(), tags: z.array(z.string()).optional() }),
        output: z.object({ connectionId: z.string(), name: z.string() }),
        rest: { method: 'post', path: '/connections/{connectionId}/snapshots', status },
        scopes: [SCOPE],
      }),
    },
    scopes: [SCOPE],
    handler: ({ connInfo, identity }) => {
      class SnapshotsHandler extends RpcTarget {
        async createSnapshot(input: { connectionId: string; dryRun: string; name: string; tags?: string[] }) {
          observed.push({ connInfo, input, subject: identity.subject });
          return { connectionId: input.connectionId, name: input.name };
        }
      }
      return new SnapshotsHandler() as SnapshotsHandler & Record<string, unknown>;
    },
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
