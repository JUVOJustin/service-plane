import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AbilityTransport } from '../shared/types.js';
import type { ServiceAbilityWebSocket } from './ability.js';
import { createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient } from './client.js';
import { defineAbility } from './discovery.js';
import { createRpcClientPlugins, createRpcHandlerPlugins } from './orpc-features.js';
import { ServicePlaneService } from './service.js';
import type { ServicePlaneServerWireOptions } from './wire-options.js';

const features = defineCapabilities({ scopes: [{ id: 'features.read' }], serviceId: 'features' });

function featureAbility(transports: AbilityTransport[]) {
  const ability = createAbilityBuilder();
  return defineAbility({
    id: 'features.echo',
    methods: {
      echo: ability.method({
        handler: ({ input }) => input,
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
        scopes: ['features.read'],
      }),
    },
    rpc: { transports },
    scopes: ['features.read'],
  });
}

function featureService(transports: AbilityTransport[], rpc: ServicePlaneServerWireOptions = {}): ServicePlaneService {
  return new ServicePlaneService({
    ingress: false,
    abilities: [featureAbility(transports)],
    auth: { issuer: 'control-plane', jwks: { keys: [] } },
    capabilities: features,
    id: 'features',
    logger: false,
    rpc: {
      ...rpc,
      ...(transports.includes('websocket') ? { manualWebSocket: true } : {}),
    },
    title: 'Features',
    version: '1.0.0',
  });
}

function webSocketHandlerCount(service: ServicePlaneService): number {
  return (service as unknown as { webSocketHandlers: ReadonlyMap<string, unknown> }).webSocketHandlers.size;
}

function configuredPlugin(plugins: { name: string }[], name: string): object {
  const plugin = plugins.find((candidate) => candidate.name === name);
  expect(plugin).toBeDefined();
  return plugin as object;
}

describe('private RPC feature configuration', () => {
  it('constructs WebSocket handlers only when a WebSocket event first needs one', async () => {
    const fetchOnly = featureService(['fetch']);
    const webSocketService = featureService(['websocket']);
    expect(webSocketHandlerCount(fetchOnly)).toBe(0);
    expect(webSocketHandlerCount(webSocketService)).toBe(0);

    const socket: ServiceAbilityWebSocket = { send: () => undefined };
    await webSocketService.webSocketClose('features.echo', socket);
    expect(webSocketHandlerCount(webSocketService)).toBe(1);

    await webSocketService.webSocketClose('features.echo', socket);
    expect(webSocketHandlerCount(webSocketService)).toBe(1);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])('rejects invalid client and server compression threshold %s', (threshold) => {
    expect(() => createRpcClientPlugins({ compression: { request: { threshold } } })).toThrow(
      'Service-Plane compression threshold must be a non-negative safe integer',
    );
    expect(() => createRpcHandlerPlugins({ compression: { response: { threshold } } }, false)).toThrow(
      'Service-Plane compression threshold must be a non-negative safe integer',
    );
  });

  it('rejects unsupported or empty compression encoding configurations at construction', () => {
    expect(() =>
      createAbilityClient({
        ability: featureAbility(['fetch']),
        targetServiceId: 'features',
        tokenProvider: { token: async () => 'unused' },
        transport: {
          compression: { request: { encoding: 'br' as never } },
          type: 'fetch',
        },
      }),
    ).toThrow('Service-Plane compression encoding must be one of: gzip, deflate, deflate-raw');
    expect(() => createRpcClientPlugins({ compression: { response: { encodings: [] } } })).toThrow(
      'Service-Plane compression encodings must be a non-empty array',
    );
    expect(() =>
      featureService(['fetch'], {
        compression: { response: { encodings: ['gzip', 'br'] as never } },
      }),
    ).toThrow('Service-Plane compression encoding must be one of: gzip, deflate, deflate-raw');
  });

  it('accepts zero thresholds and deduplicates encoding preferences in order', () => {
    const clientPlugins = createRpcClientPlugins({
      compression: {
        request: { encoding: 'deflate', threshold: 0 },
        response: { encodings: ['gzip', 'gzip', 'deflate'] },
      },
    });
    const clientRequest = configuredPlugin(clientPlugins, '~request-compression');
    const clientResponse = configuredPlugin(clientPlugins, '~response-compression');
    expect(Reflect.get(clientRequest, 'encoding')).toBe('deflate');
    expect(Reflect.get(clientRequest, 'threshold')).toBe(0);
    expect(Reflect.get(clientResponse, 'encodings')).toEqual(['gzip', 'deflate']);

    const serverPlugins = createRpcHandlerPlugins(
      {
        compression: {
          response: { encodings: ['deflate', 'gzip', 'deflate'], threshold: 0 },
        },
      },
      false,
    );
    const serverResponse = configuredPlugin(serverPlugins, '~response-compression');
    expect(Reflect.get(serverResponse, 'encodings')).toEqual(['deflate', 'gzip']);
    expect(Reflect.get(serverResponse, 'threshold')).toBe(0);
  });

  it('applies the request limit after decompression', async () => {
    const ability = featureAbility(['fetch']);
    const service = new ServicePlaneService({
      ingress: false,
      abilities: [ability],
      auth: { issuer: 'control-plane', jwks: { keys: [] } },
      capabilities: features,
      id: 'features',
      logger: false,
      rpc: { compression: { request: true }, maxRequestBodyBytes: 128 },
      title: 'Features',
      version: '1.0.0',
    });
    const client = createAbilityClient({
      ability,
      targetServiceId: 'features',
      tokenProvider: { token: async () => 'unused' },
      transport: {
        compression: { request: { encoding: 'gzip', threshold: 0 } },
        fetch: async (url, init) => service.fetch(new Request(url, init)),
        origin: 'https://features.internal',
        type: 'fetch',
      },
    });

    await expect(client.echo({ value: 'x'.repeat(2_000) })).rejects.toMatchObject({ status: 413 });
  });
});
