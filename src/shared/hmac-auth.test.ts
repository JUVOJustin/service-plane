import { describe, expect, it } from 'vitest';
import { extractServicePlaneHmacSignature, servicePlaneHmacRequestParts } from './hmac-auth.js';

describe('Service-Plane HMAC auth helpers', () => {
  it('parses the authorization scheme case-insensitively and rejects extra credentials', () => {
    expect(
      extractServicePlaneHmacSignature(
        new Request('https://control-plane.internal', { headers: { authorization: 'serviceplane-hmac signature' } }),
      ),
    ).toBe('signature');

    expect(() =>
      extractServicePlaneHmacSignature(
        new Request('https://control-plane.internal', { headers: { authorization: 'ServicePlane-HMAC signature extra' } }),
      ),
    ).toThrow('Invalid Service-Plane HMAC authorization scheme');
  });

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

  it('rejects lengthless stream bodies larger than the configured hash limit', async () => {
    const request = new Request('https://control-plane.internal/.well-known/service-plane/capability-token', {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abcdef'));
          controller.close();
        },
      }),
      method: 'POST',
      ...nodeRequestDuplexOption(),
    });

    expect(request.headers.has('content-length')).toBe(false);
    await expect(servicePlaneHmacRequestParts(request, 'moco-client', '2026-05-12T10:15:00.000Z', undefined, 5)).rejects.toThrow(
      'Service-Plane HMAC request body is too large',
    );
  });
});

function nodeRequestDuplexOption(): RequestInit {
  return { duplex: 'half' } as RequestInit;
}
