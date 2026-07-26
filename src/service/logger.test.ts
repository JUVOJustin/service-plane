import type { MiddlewareHandler } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { SERVICE_DISCOVERY_PATH } from '../shared/types.js';
import { testKeys } from '../test-support/index.js';
import { defineCapabilities, RpcTarget } from './capabilities.js';
import { abilityMethod, defineAbility } from './discovery.js';
import type { ServicePlaneLogEvent } from './logger.js';
import { servicePlaneLogEvents } from './logger.js';
import { ServicePlaneService } from './service.js';

describe('service plane logging', () => {
  it('adopts an incoming request id, logs it, and echoes it on the response', async () => {
    const events: ServicePlaneLogEvent[] = [];
    const service = await testService({ log: (event) => events.push(event) });

    const response = await service.fetch(
      new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`, { headers: { 'X-Request-Id': 'req-42' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe('req-42');
    expect(events).toContainEqual(expect.objectContaining({ event: 'service_plane.discovery.served', requestId: 'req-42' }));
  });

  it('falls back to the request id query parameter used by WebSocket transports', async () => {
    const events: ServicePlaneLogEvent[] = [];
    const service = await testService({ log: (event) => events.push(event) });

    const response = await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}?request_id=req-ws-7`));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe('req-ws-7');
    expect(events).toContainEqual(expect.objectContaining({ requestId: 'req-ws-7' }));
  });

  it('generates a request id when none is provided', async () => {
    const events: ServicePlaneLogEvent[] = [];
    const service = await testService({ log: (event) => events.push(event) });

    const response = await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(events[0]?.requestId).toBe(response.headers.get('X-Request-Id'));
  });

  it('exposes emitted events to app middleware on the Hono context', async () => {
    let observed: ServicePlaneLogEvent[] = [];
    const service = await testService(undefined, [
      async (context, next) => {
        await next();
        observed = servicePlaneLogEvents(context);
      },
    ]);

    await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`, { headers: { 'X-Request-Id': 'req-mw' } }));
    expect(observed).toContainEqual(expect.objectContaining({ event: 'service_plane.discovery.served', requestId: 'req-mw' }));
  });

  it('can disable the built-in logger while request ids stay on', async () => {
    const keys = await testKeys();
    const service = new ServicePlaneService({
      abilities: [testAbility()],
      auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
      capabilities: testCapabilities(),
      id: 'example',
      logger: false,
      title: 'Example',
      version: '0.1.0',
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await service.fetch(new Request(`https://example.internal${SERVICE_DISCOVERY_PATH}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Request-Id')).toBeTruthy();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });
});

class ExampleApi extends RpcTarget {
  async runSync() {
    return { ok: true as const };
  }
}

function testCapabilities() {
  return defineCapabilities({ scopes: [{ id: 'example.sync.run' }], serviceId: 'example' });
}

function testAbility() {
  return defineAbility({
    id: 'example.sync',
    methods: {
      runSync: abilityMethod({
        input: z.object({}),
        output: z.object({ ok: z.literal(true) }),
        scopes: ['example.sync.run'],
      }),
    },
    scopes: ['example.sync.run'],
    handler: () => new ExampleApi() as ExampleApi & Record<string, unknown>,
  });
}

async function testService(logger?: { log: (event: ServicePlaneLogEvent) => void }, middleware?: MiddlewareHandler[]) {
  const keys = await testKeys();
  return new ServicePlaneService({
    abilities: [testAbility()],
    auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
    capabilities: testCapabilities(),
    id: 'example',
    ...(logger ? { logger } : {}),
    ...(middleware ? { middleware } : {}),
    title: 'Example',
    version: '0.1.0',
  });
}
