import { RpcTarget, newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse, RpcSession } from 'capnweb';
import type { RpcSessionOptions, RpcTransport } from 'capnweb';
import { CapabilityAuthError } from '../shared/errors.js';
import { verifyCapabilityToken } from '../shared/capability-tokens.js';
import {
  type CapabilityCatalog,
  type CapabilityIdentity,
  type CapabilityVerifierOptions,
  type ServiceCapabilityDescriptor,
  type ServiceCapabilityVisibility,
  type ServiceDiscoveryDocument,
  type ServiceRpcTransport,
  SERVICE_DISCOVERY_PATH,
} from '../shared/types.js';
import { normalizeScope, normalizeScopes, normalizeValue } from './capabilities.js';

// ---------------------------------------------------------------------------
// Identity & scope binding
//
// Cap'n Web has no per-call middleware: a method is just a method on an
// `RpcTarget`. We attach the verified `CapabilityIdentity` to every scoped
// target instance via a WeakMap keyed by the target object. `requireScopes`
// reads it back on each invocation. This avoids global state, keeps targets
// passable by reference across services, and lets the same `RpcTarget` class
// be reused across multiple sessions safely.
// ---------------------------------------------------------------------------

const identityByTarget = new WeakMap<object, CapabilityIdentity>();

/**
 * Bind a verified capability identity to a scoped capability target.
 *
 * Call this in your authentication handshake (typically `authenticate(token)`)
 * right after `verifyCapabilityToken(...)` succeeds and before returning the
 * scoped target to the caller. Once bound, every method on the target can
 * call `requireScopes(this, ...)` and `capabilityIdentity(this)`.
 */
export function bindCapabilityIdentity<T extends object>(target: T, identity: CapabilityIdentity): T {
  identityByTarget.set(target, identity);
  return target;
}

/**
 * Read the verified capability identity associated with an `RpcTarget`
 * instance. Returns `undefined` for un-bound roots (e.g. the public root that
 * exposes only the `authenticate(...)` handshake).
 */
export function capabilityIdentity(target: object): CapabilityIdentity | undefined {
  return identityByTarget.get(target);
}

/**
 * Assert that the verified identity bound to `target` carries every scope in
 * `scopes`. Throws `CapabilityAuthError(403)` otherwise. Returns the identity
 * so callers can use the result inline:
 *
 *     class Sync extends RpcTarget {
 *       async run() {
 *         const me = requireScopes(this, 'example.sync.run');
 *         return { caller: me.serviceId };
 *       }
 *     }
 */
export function requireScopes(target: object, ...scopes: string[]): CapabilityIdentity {
  const required = normalizeScopes(scopes);
  const identity = identityByTarget.get(target);
  if (!identity) {
    throw new CapabilityAuthError('Service-Plane capability identity is not bound to this RPC target', 401);
  }
  for (const scope of required) {
    if (!identity.scopes.includes(scope)) {
      throw new CapabilityAuthError(`Missing Service-Plane capability scope: ${scope}`, 403);
    }
  }
  return identity;
}

// Track which scopes a method statically requires so `defineService(..., {
// requireRouteScopes: true })` can fail fast on un-annotated public methods.
const declaredMethodScopes = new WeakMap<object, Map<string, string[]>>();

/**
 * Class-method decorator alternative for `requireScopes(this, ...)`. Use the
 * functional form inside method bodies for the default DX; the decorator is
 * provided for codebases that already lean on legacy decorators.
 */
export function scope(...scopes: string[]) {
  const required = normalizeScopes(scopes);
  return function decorate<This extends object, Args extends unknown[], R>(
    method: (this: This, ...args: Args) => R,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>,
  ): (this: This, ...args: Args) => R {
    if (typeof context.name !== 'string') return method;
    const methodName = context.name;
    context.addInitializer(function trackScopes(this: This) {
      const proto = Object.getPrototypeOf(this) as object;
      let map = declaredMethodScopes.get(proto);
      if (!map) {
        map = new Map();
        declaredMethodScopes.set(proto, map);
      }
      map.set(methodName, required);
    });
    return function gated(this: This, ...args: Args): R {
      requireScopes(this, ...required);
      return method.apply(this, args);
    };
  };
}

export function declaredScopes(target: object, methodName: string): string[] | undefined {
  const proto = Object.getPrototypeOf(target) as object | null;
  if (!proto) return undefined;
  return declaredMethodScopes.get(proto)?.get(methodName);
}

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

export type CapabilityFactory = (env: {
  identity?: CapabilityIdentity;
  verifier?: CapabilityVerifierOptions;
}) => RpcTarget;

export type ServiceCapabilityDefinition = {
  /** Unique label for this exported capability within the service. */
  id: string;
  /**
   * Factory that builds the root `RpcTarget` for a freshly opened RPC session.
   * For the `public` capability this is typically a class with a single
   * `authenticate(token)` method; for `internal` capabilities the factory
   * may pre-bind a service-to-service identity via `bindCapabilityIdentity`.
   */
  factory: CapabilityFactory;
  /** Static scopes required by methods on this capability. Surfaces in
   * discovery so tooling and the broker know what tokens to mint. */
  scopes?: string[];
  visibility: ServiceCapabilityVisibility;
};

export type DefineServiceInput = {
  capabilities?: CapabilityCatalog;
  exports: ServiceCapabilityDefinition[];
  id: string;
  rpcTransports?: ServiceRpcTransport[];
  title: string;
  version: string;
};

export type DefineServiceOptions = {
  /**
   * When true, every exported capability whose `visibility !== 'internal'`
   * must declare at least one scope. This catches accidentally-public,
   * unauthenticated capabilities at startup instead of in production.
   */
  requireRouteScopes?: boolean;
};

export type ServiceDefinition = {
  capabilities?: CapabilityCatalog;
  exports: NormalizedCapability[];
  id: string;
  rpcTransports: ServiceRpcTransport[];
  title: string;
  version: string;
};

export type NormalizedCapability = ServiceCapabilityDefinition & { scopes: string[] };

export function defineService(input: DefineServiceInput, options: DefineServiceOptions = {}): ServiceDefinition {
  const id = normalizeValue(input.id, 'service id');
  const title = normalizeValue(input.title, 'service title');
  const version = normalizeValue(input.version, 'service version');
  if (input.exports.length === 0) {
    throw new CapabilityAuthError('Service-Plane service must export at least one capability', 500);
  }

  const knownScopes = new Set(input.capabilities?.scopes.map((scope) => normalizeScope(scope.id)) ?? []);
  const seenIds = new Set<string>();
  const exports = input.exports.map((capability): NormalizedCapability => {
    const capId = normalizeValue(capability.id, 'capability id');
    if (seenIds.has(capId)) {
      throw new CapabilityAuthError(`Duplicate Service-Plane exported capability: ${capId}`, 500);
    }
    seenIds.add(capId);
    const scopes = capability.scopes ? normalizeScopes(capability.scopes) : [];
    if (options.requireRouteScopes && capability.visibility !== 'internal' && scopes.length === 0) {
      throw new CapabilityAuthError(
        `Service-Plane exported capability is missing required scope annotations: ${capId}`,
        500,
      );
    }
    if (scopes.length > 0 && !input.capabilities) {
      throw new CapabilityAuthError(
        `Service-Plane exported capability requires scopes but service has no capability catalog: ${capId}`,
        500,
      );
    }
    for (const scope of scopes) {
      if (!knownScopes.has(scope)) {
        throw new CapabilityAuthError(`Service-Plane exported capability requires unknown scope: ${scope}`, 500);
      }
    }
    return { ...capability, id: capId, scopes };
  });

  const rpcTransports = (input.rpcTransports && input.rpcTransports.length > 0
    ? input.rpcTransports
    : ['http-batch']) as ServiceRpcTransport[];

  return {
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    exports,
    id,
    rpcTransports,
    title,
    version,
  };
}

export function serviceDiscoveryDocument(service: ServiceDefinition): ServiceDiscoveryDocument {
  const exports: ServiceCapabilityDescriptor[] = service.exports.map((capability) => ({
    scopes: capability.scopes,
    visibility: capability.visibility,
  }));
  return {
    ...(service.capabilities ? { capabilities: service.capabilities } : {}),
    exports,
    id: service.id,
    rpcTransports: service.rpcTransports,
    title: service.title,
    version: service.version,
  };
}

// ---------------------------------------------------------------------------
// Server adapters
// ---------------------------------------------------------------------------

export type ServeCapabilityRpcOptions = {
  /** Discovery path. Defaults to `/.well-known/service-plane/services.json`. */
  discoveryPath?: string;
  /** RPC endpoint path. Defaults to `/rpc/<capabilityId>`. Override to mount
   * a single capability under a custom path (e.g. `/`). */
  rpcPath?: (capabilityId: string) => string;
  /** Token verifier configuration. Required for any capability whose factory
   * verifies a bootstrap token via `authenticate(...)`. */
  verifier?: CapabilityVerifierOptions;
  /** Cap'n Web session options forwarded to `newHttpBatchRpcResponse` /
   * `newWorkersWebSocketRpcResponse`. */
  rpcSessionOptions?: RpcSessionOptions;
};

export type CapabilityRpcHandler = (request: Request) => Promise<Response>;

/**
 * Build a single fetch-style handler that serves a service's discovery
 * document and all of its exported RPC capabilities. The handler is framework
 * agnostic — pass `request` from any runtime that exposes `Request` /
 * `Response` (Cloudflare Workers, Hono, Bun, plain Node via Web Fetch).
 *
 * Routing:
 *   GET  <discoveryPath>           → JSON discovery document
 *   POST <rpcPath(capabilityId)>   → HTTP-batch RPC for the capability
 *   GET  <rpcPath(capabilityId)>   → WebSocket upgrade (when `Upgrade: websocket`)
 */
export function serveCapabilityRpc(service: ServiceDefinition, options: ServeCapabilityRpcOptions = {}): CapabilityRpcHandler {
  const discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;
  const rpcPath = options.rpcPath ?? ((id) => `/rpc/${id}`);
  const document = serviceDiscoveryDocument(service);
  const exportsByPath = new Map(service.exports.map((capability) => [rpcPath(capability.id), capability] as const));

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === discoveryPath && request.method === 'GET') {
      return Response.json(document);
    }
    const capability = exportsByPath.get(url.pathname);
    if (!capability) {
      return new Response('Not Found', { status: 404 });
    }
    const target = await invokeFactory(capability, options);
    if (target instanceof Response) return target;
    if (request.method === 'POST') {
      return service.rpcTransports.includes('http-batch')
        ? newHttpBatchRpcResponse(request, target, options.rpcSessionOptions)
        : new Response('HTTP-batch RPC is not enabled for this service', { status: 405 });
    }
    if (request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return service.rpcTransports.includes('websocket')
        ? newWorkersWebSocketRpcResponse(request, target, options.rpcSessionOptions)
        : new Response('WebSocket RPC is not enabled for this service', { status: 405 });
    }
    return new Response('Method Not Allowed', { status: 405 });
  };
}

async function invokeFactory(
  capability: NormalizedCapability,
  options: ServeCapabilityRpcOptions,
): Promise<RpcTarget | Response> {
  try {
    return capability.factory({
      ...(options.verifier ? { verifier: options.verifier } : {}),
    });
  } catch (error) {
    if (error instanceof CapabilityAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reusable building blocks for service authors
// ---------------------------------------------------------------------------

/**
 * Common helper for authentication handshake methods. Verifies the supplied
 * Service-Plane capability token against the provided verifier and returns
 * the bound identity. Service code typically calls this at the top of
 * `authenticate(token)` and uses the result with `bindCapabilityIdentity`:
 *
 *     class Public extends RpcTarget {
 *       constructor(private readonly verifier: CapabilityVerifierOptions) { super(); }
 *       async authenticate(token: string) {
 *         const identity = await verifyAuthenticationToken(token, this.verifier);
 *         return bindCapabilityIdentity(new Scoped(), identity);
 *       }
 *     }
 */
export async function verifyAuthenticationToken(
  token: string,
  verifier: CapabilityVerifierOptions,
): Promise<CapabilityIdentity> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new CapabilityAuthError('Service-Plane capability token is required', 401);
  }
  return verifyCapabilityToken(token, verifier);
}

// Re-export the underlying RpcSession + transport types for adapters that
// want to wire up custom transports (e.g. tests, postMessage).
export { RpcSession, RpcTarget };
export type { RpcSessionOptions, RpcTransport };
