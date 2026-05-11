import { describe, expect, it } from 'vitest';
import { defineCapabilities } from './capabilities.js';
import { defineService, RpcTarget, serviceDiscoveryDocument } from './discovery.js';

describe('defineService', () => {
  const capabilities = defineCapabilities({
    scopes: [
      { id: 'example.events.ingest' },
      { id: 'example.sync.run' },
    ],
    serviceId: 'example',
  });

  class PublicRoot extends RpcTarget {}
  class InternalRoot extends RpcTarget {}

  it('builds a discovery document from explicit RPC capability exports', () => {
    const service = defineService({
      capabilities,
      exports: [
        { factory: () => new PublicRoot(), id: 'public', scopes: ['example.events.ingest'], visibility: 'public' },
        { factory: () => new InternalRoot(), id: 'internal', scopes: ['example.sync.run'], visibility: 'internal' },
      ],
      id: 'example',
      rpcTransports: ['http-batch', 'websocket'],
      title: 'Example',
      version: '0.1.0',
    });

    expect(serviceDiscoveryDocument(service)).toEqual({
      capabilities,
      exports: [
        { scopes: ['example.events.ingest'], visibility: 'public' },
        { scopes: ['example.sync.run'], visibility: 'internal' },
      ],
      id: 'example',
      rpcTransports: ['http-batch', 'websocket'],
      title: 'Example',
      version: '0.1.0',
    });
  });

  it('rejects scopes not declared in the catalog', () => {
    expect(() =>
      defineService({
        capabilities,
        exports: [{ factory: () => new PublicRoot(), id: 'public', scopes: ['example.unknown'], visibility: 'public' }],
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Service-Plane exported capability requires unknown scope: example.unknown');
  });

  it('rejects scoped capabilities when the service has no catalog', () => {
    expect(() =>
      defineService({
        exports: [{ factory: () => new PublicRoot(), id: 'public', scopes: ['example.events.ingest'], visibility: 'public' }],
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('requires scopes but service has no capability catalog');
  });

  it('can require every public/auth capability to declare scopes', () => {
    expect(() =>
      defineService(
        {
          capabilities,
          exports: [{ factory: () => new PublicRoot(), id: 'public', visibility: 'public' }],
          id: 'example',
          title: 'Example',
          version: '0.1.0',
        },
        { requireRouteScopes: true },
      ),
    ).toThrow('Service-Plane exported capability is missing required scope annotations: public');
  });

  it('rejects duplicate exported capability ids', () => {
    expect(() =>
      defineService({
        capabilities,
        exports: [
          { factory: () => new PublicRoot(), id: 'public', scopes: ['example.events.ingest'], visibility: 'public' },
          { factory: () => new PublicRoot(), id: 'public', scopes: ['example.events.ingest'], visibility: 'auth' },
        ],
        id: 'example',
        title: 'Example',
        version: '0.1.0',
      }),
    ).toThrow('Duplicate Service-Plane exported capability: public');
  });

  it('defaults rpcTransports to http-batch only', () => {
    const service = defineService({
      exports: [{ factory: () => new PublicRoot(), id: 'public', visibility: 'internal' }],
      id: 'example',
      title: 'Example',
      version: '0.1.0',
    });
    expect(service.rpcTransports).toEqual(['http-batch']);
  });
});
