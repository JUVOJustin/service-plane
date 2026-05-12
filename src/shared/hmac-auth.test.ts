import { describe, expect, it } from 'vitest';
import { servicePlaneHmacRequestParts } from './hmac-auth.js';

describe('Service-Plane HMAC auth helpers', () => {
  it('rejects request bodies larger than the configured hash limit', async () => {
    await expect(
      servicePlaneHmacRequestParts(
        new Request('https://control-plane.internal/.well-known/service-plane/capability-token', {
          body: 'abcdef',
          method: 'POST',
        }),
        'moco-client',
        '2026-05-12T10:15:00.000Z',
        undefined,
        5,
      ),
    ).rejects.toThrow('Service-Plane HMAC request body is too large');
  });
});
