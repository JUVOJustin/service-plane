import { describe, expect, it } from 'vitest';
import { mergeServiceOpenApi } from './openapi.js';
import type { ServiceRegistry } from './types.js';

describe('OpenAPI merging', () => {
  it('does not use unsafe discovery paths as object keys', async () => {
    const registry: ServiceRegistry = {
      async discover() {
        return {
          discoveredAt: '2026-05-12T10:15:00.000Z',
          routes: [
            {
              method: 'GET',
              path: '__proto__',
              service: { fetch: async () => new Response(), id: 'evil', origin: 'https://evil.internal' },
              serviceId: 'evil',
              serviceTitle: 'Evil',
              serviceVersion: '0.0.1',
              visibility: 'public',
            },
            {
              method: 'GET',
              path: '/safe',
              service: { fetch: async () => new Response(), id: 'safe', origin: 'https://safe.internal' },
              serviceId: 'safe',
              serviceTitle: 'Safe',
              serviceVersion: '0.0.1',
              visibility: 'public',
            },
          ],
          services: [],
        };
      },
      async match() {
        return undefined;
      },
    };

    const document = await mergeServiceOpenApi({
      baseDocument: { info: { title: 'API', version: '0.0.1' }, openapi: '3.1.0' },
      registry,
    });

    expect(Object.hasOwn(Object.prototype, 'get')).toBe(false);
    expect(document.paths).toHaveProperty('/safe');
    expect(document.paths).not.toHaveProperty('__proto__');
  });
});
