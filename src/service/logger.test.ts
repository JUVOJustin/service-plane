import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { ServicePlaneClientError } from '../shared/errors.js';
import { testKeys } from '../test-support/index.js';
import { createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient } from './client.js';
import { defineAbility, defineAbilityService } from './discovery.js';
import { type ServicePlaneLogEvent, type ServicePlaneLoggerOptions, servicePlaneLogger } from './logger.js';
import { ServicePlaneService } from './service.js';

const ISSUED_AT = new Date('2099-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2099-05-09T12:00:01.000Z');

describe('service logger reliability', () => {
  it('does not let a failing log sink change a successful response', async () => {
    const builder = createAbilityBuilder();
    const ability = defineAbility({
      id: 'catalog.health',
      methods: {
        read: builder.method({ input: z.object({}), output: z.object({ ok: z.boolean() }), handler: () => ({ ok: true }) }),
      },
    });
    const service = defineAbilityService(
      { abilities: [ability], id: 'catalog', title: 'Catalog', version: '1.0.0' },
      { requireAbilityScopes: false },
    );
    const app = new Hono();
    app.use(
      '*',
      servicePlaneLogger(service, {
        log: () => {
          throw new Error('sink failed');
        },
      }),
    );
    app.get('/ok', (context) => context.text('ok'));

    const response = await app.request('/ok');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('keeps an opaque handler failure when its log sink throws synchronously', async () => {
    const events: ServicePlaneLogEvent[] = [];
    const { client } = await serveFailingAbility((event) => {
      events.push(event);
      throw new Error('synchronous sink failure');
    });

    const { result, unhandled } = await captureUnhandledRejections(() => client.fail({}));

    expectOpaqueHandlerFailure(result);
    expect(events.some((event) => event.event === 'service_plane.ability.handler_failed')).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('handles a rejected handler-failure log promise without an unhandled rejection', async () => {
    const events: ServicePlaneLogEvent[] = [];
    const { client } = await serveFailingAbility(async (event) => {
      events.push(event);
      throw new Error('asynchronous sink failure');
    });

    const { result, unhandled } = await captureUnhandledRejections(() => client.fail({}));

    expectOpaqueHandlerFailure(result);
    expect(events.some((event) => event.event === 'service_plane.ability.handler_failed')).toBe(true);
    expect(unhandled).toEqual([]);
  });
});

async function serveFailingAbility(log: NonNullable<ServicePlaneLoggerOptions['log']>) {
  const keys = await testKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'catalog.read' }], serviceId: 'catalog' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'headless-front', scopes: ['catalog.read'], target: 'catalog' }] }),
    issuer: 'control-plane',
    now: () => ISSUED_AT,
    privateJwks: [keys.privateJwk],
  });
  const issued = await issuer.issueCapabilityToken({
    callerAccess: 'service',
    callerServiceId: 'headless-front',
    scopes: ['catalog.read'],
    targetServiceId: 'catalog',
  });
  const builder = createAbilityBuilder();
  const ability = defineAbility({
    id: 'catalog.failure',
    methods: {
      fail: builder.method({
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        scopes: ['catalog.read'],
        handler: () => {
          throw new Error('postgres://secret@internal/catalog');
        },
      }),
    },
    rpc: { transports: ['fetch'] },
    scopes: ['catalog.read'],
  });
  const service = new ServicePlaneService({
    ingress: false,
    abilities: [ability],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
    capabilities,
    id: 'catalog',
    logger: { log },
    title: 'Catalog',
    version: '1.0.0',
  });
  const client = createAbilityClient({
    ability,
    callerServiceId: 'headless-front',
    requestToken: async () => issued,
    scopes: ['catalog.read'],
    targetServiceId: 'catalog',
    transport: {
      fetch: async (url, init) => service.fetch(new Request(url, init)),
      origin: 'https://catalog.internal',
      type: 'fetch',
    },
  });
  return { client };
}

function expectOpaqueHandlerFailure(result: unknown): void {
  expect(result).toBeInstanceOf(ServicePlaneClientError);
  expect(result).toMatchObject({
    code: 'internal',
    message: 'Service-Plane ability handler failed: fail',
    retryable: false,
    status: 500,
  });
  expect(JSON.stringify(result)).not.toContain('secret@internal');
}

async function captureUnhandledRejections(run: () => Promise<unknown>): Promise<{ result: unknown; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const result = await run().catch((error: unknown) => error);
    // Let Node/workerd perform their unhandled-rejection checkpoint before inspecting the capture.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', listener);
  }
}
