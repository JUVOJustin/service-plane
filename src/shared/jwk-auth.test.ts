import { describe, expect, it } from 'vitest';
import { extractServicePlaneJwkAssertion, servicePlaneJwkRequestParts } from './jwk-auth.js';

describe('Service-Plane JWK auth helpers', () => {
  it('parses the authorization scheme case-insensitively and rejects extra credentials', () => {
    expect(
      extractServicePlaneJwkAssertion(
        new Request('https://control-plane.internal', { headers: { authorization: 'serviceplane-jwk assertion' } }),
      ),
    ).toBe('assertion');

    expect(() =>
      extractServicePlaneJwkAssertion(
        new Request('https://control-plane.internal', { headers: { authorization: 'ServicePlane-JWK assertion extra' } }),
      ),
    ).toThrow('Invalid Service-Plane JWK authorization scheme');
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
    await expect(servicePlaneJwkRequestParts(request, 'moco-client', 'test-key', undefined, 5)).rejects.toThrow(
      'Service-Plane JWK request body is too large',
    );
  });
});

function nodeRequestDuplexOption(): RequestInit {
  return { duplex: 'half' } as RequestInit;
}
