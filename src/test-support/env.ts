import type { UpgradeWebSocket } from 'hono/ws';
import { cloudflareServiceBinding } from '../control-plane/endpoints.js';
import type { AbilityTransport, ServiceAbilityNativeRpcBinding, ServiceEndpoint, ServiceEndpointGrant } from '../shared/types.js';

export type DemoEnvironmentName = 'http-batch' | 'native-rpc' | 'websocket';

// Structural, not `ServicePlaneService`, so a caller can interpose availability or request
// tampering between the plane and the real service.
export type DemoServiceHost = ServiceAbilityNativeRpcBinding & {
  fetch(request: Request): Promise<Response>;
};

export type DemoEndpointInput = {
  grants: ServiceEndpointGrant[];
  id: string;
  origin: string;
  service: DemoServiceHost;
};

// A deployment shape a service can be reached through. Specs stay environment-agnostic: they take
// `transports` for their ability declarations, and the environment wires the matching endpoint. That
// is what lets one scenario run as a matrix instead of being pinned to whichever transport its
// author happened to pick.
export type DemoEnvironment = {
  endpoint(input: DemoEndpointInput): ServiceEndpoint;
  name: DemoEnvironmentName;
  transports: AbilityTransport[];
  // Services advertising the websocket transport refuse to construct without an upgrade helper.
  upgradeWebSocket?: UpgradeWebSocket;
};

// Plain Worker-to-Worker fetch. The baseline every service supports.
export function httpBatchEnv(): DemoEnvironment {
  return {
    endpoint: (input) =>
      cloudflareServiceBinding({
        binding: { fetch: async (request) => input.service.fetch(request) },
        grants: input.grants,
        id: input.id,
        origin: input.origin,
      }),
    name: 'http-batch',
    transports: ['http-batch'],
  };
}

// Native Workers RPC: session-shaped without holding a socket, so streams flow without an upgrade.
// The hooks exist because "did the plane actually take this path, and did it clean up?" is the
// question these tests are usually asking.
export function nativeRpcEnv(options: { onConnect?: () => void; onDispose?: () => void } = {}): DemoEnvironment {
  return {
    endpoint: (input) =>
      cloudflareServiceBinding({
        abilityRpc: {
          async connectAbility(connect) {
            options.onConnect?.();
            const target = await input.service.connectAbility(connect);
            // Replaces the real disposer, matching what a counting test wants to observe.
            if (options.onDispose) Object.defineProperty(target, Symbol.dispose, { value: options.onDispose });
            return target;
          },
        },
        binding: { fetch: async (request) => input.service.fetch(request) },
        grants: input.grants,
        id: input.id,
        origin: input.origin,
      }),
    name: 'native-rpc',
    transports: ['http-batch', 'cloudflare-binding-rpc'],
  };
}

// Advertises websocket in discovery so transport *selection* is exercised. Nothing dials it by
// default: an in-memory service has no socket to accept, and the tests using this assert the plane
// stays on HTTP-batch. Pass `createWebSocket` to observe or serve a dial.
export function websocketEnv(options: { createWebSocket?: (url: string) => WebSocket } = {}): DemoEnvironment {
  const createWebSocket =
    options.createWebSocket ??
    ((_url: string): WebSocket => {
      throw new Error('unexpected WebSocket connection to the service');
    });
  return {
    endpoint: (input) =>
      cloudflareServiceBinding({
        binding: { fetch: async (request) => input.service.fetch(request) },
        createWebSocket,
        grants: input.grants,
        id: input.id,
        origin: input.origin,
      }),
    name: 'websocket',
    transports: ['http-batch', 'websocket'],
    upgradeWebSocket: (() => () => {
      throw new Error('unexpected WebSocket upgrade on the service');
    }) as unknown as UpgradeWebSocket,
  };
}

// The matrix a cross-transport scenario should sweep.
export function demoEnvironments(): DemoEnvironment[] {
  return [httpBatchEnv(), nativeRpcEnv(), websocketEnv()];
}
