import { call, type StandardHeaders, type StandardLazyRequest } from '@orpc/server';
import { RPCHandler as FetchRpcHandler } from '@orpc/server/fetch';
import type { StandardHandlerPlugin } from '@orpc/server/standard';
import { type WebSocketLike, RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import { Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import { extractServicePlaneToken, servicePlaneAuthorization } from '../shared/capability-tokens.js';
import {
  type ConnInfo,
  normalizeConnInfo,
  parseConnInfo,
  SERVICE_PLANE_CONN_INFO_HEADER,
  SERVICE_PLANE_CONN_INFO_QUERY_PARAM,
  serializeConnInfo,
} from '../shared/conn-info.js';
import {
  DEFAULT_ABILITY_TIMEOUT_MS,
  remainingTimeoutMs,
  resolveTimeoutMs,
  SERVICE_PLANE_TIMEOUT_HEADER,
  type ServicePlaneTimeoutPolicy,
  serializeTimeoutMs,
  timeoutMsFromRequest,
  validateTimeoutPolicy,
} from '../shared/deadline.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import {
  idempotencyKeyFromRequest,
  normalizeForwardedToken,
  normalizeIdempotencyKey,
  SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER,
} from '../shared/idempotency.js';
import { defaultServicePlaneLogSink } from '../shared/logging.js';
import {
  type CapabilityIdentity,
  type CapabilityJwksResolver,
  type CapabilityVerifierOptions,
  type FetchLike,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_PROOF_HEADER,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  SERVICE_PLANE_REQUEST_ID_QUERY_PARAM,
} from '../shared/types.js';
import { jwksFromServiceBinding, verifyAuthenticationToken } from './capabilities.js';
import type { NativeAbilityCall } from './client.js';
import {
  type DefineServiceInput,
  type DefineServiceOptions,
  defineAbilityService,
  type NormalizedServiceAbility,
  type ServiceDefinition,
  serviceDiscoveryDocument,
} from './discovery.js';
import {
  recordServicePlaneLogEvent,
  type ServicePlaneHandlerFailureLogEvent,
  type ServicePlaneLoggerOptions,
  type ServicePlaneLogVariables,
  servicePlaneLogger,
} from './logger.js';
import { type AbilityProcedureContext, createAbilityProcedureRuntimeContext } from './orpc.js';

export type ServicePlaneServiceAuthOptions<TEnv extends Env> = {
  controlPlaneBinding?: (bindings: TEnv['Bindings'], context: Context<TEnv>) => FetchLike;
  expectedAudience?: string;
  issuer?: string;
  jwks?: CapabilityJwksResolver | ((context: Context<TEnv>) => CapabilityJwksResolver | Promise<CapabilityJwksResolver>);
  now?: Date | (() => Date);
};

export type ServicePlaneServiceIngressOptions<TEnv extends Env> = {
  brokerServiceIds?: string[] | ((bindings: TEnv['Bindings'], context: Context<TEnv>) => Promise<string[]> | string[]);
};

type ServicePlaneServiceEnv<TEnv extends Env> = TEnv & {
  Variables: RequestIdVariables & ServicePlaneLogVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;

export type ServicePlaneServiceOptions<TEnv extends Env = Env> = DefineServiceInput<TEnv> &
  DefineServiceOptions & {
    app?: Hono<TEnv>;
    auth: ServicePlaneServiceAuthOptions<TEnv>;
    discoveryPath?: string;
    httpCache?: ServicePlaneHttpCacheOption;
    ingress?: false | ServicePlaneServiceIngressOptions<TEnv>;
    logger?: false | ServicePlaneLoggerOptions;
    middleware?: MiddlewareHandler<TEnv>[];
    requestId?: ServicePlaneRequestIdOptions;
    rpc?: {
      /** oRPC handler plugins such as batching, compression, tracing, or hibernation. */
      plugins?: StandardHandlerPlugin<Record<PropertyKey, unknown>>[];
      /** Accept WebSockets outside Hono and forward their events through the manual methods. */
      manualWebSocket?: boolean;
      /** Runtime-specific Hono WebSocket upgrade adapter. */
      upgradeWebSocket?: UpgradeWebSocket;
    };
    /**
     * Bounds how long work runs here, so a service is not left unbounded by callers that send no
     * deadline of their own.
     *
     * `methodMs` is a per-call ceiling on every unary method, defaulting to
     * `DEFAULT_ABILITY_TIMEOUT_MS` (10s, matching Armeria's server request timeout). Override one
     * slow method with `timeoutMs` on the method rather than raising this for everything, and use
     * `false` to opt the whole service out. Streaming methods are never bounded this way.
     *
     * `maxMs` clamps a budget a caller forwarded. `defaultMs` supplies one when a caller sent none.
     * Fetch, WebSocket, and native binding paths resolve it independently for every logical call.
     */
    timeout?: ServicePlaneTimeoutPolicy & {
      methodMs?: false | number;
    };
  };

/**
 * ServicePlaneService provides the Hono shell while oRPC owns procedure execution and transport.
 */
export class ServicePlaneService<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneServiceEnv<TEnv>>;
  readonly definition: ServiceDefinition<TEnv>;
  readonly discoveryPath: string;

  // RPC transports get no manufactured default; misconfigured policy values fail here, not at
  // the first request they silently loosen.
  private readonly timeoutPolicy: ServicePlaneTimeoutPolicy | undefined;
  private readonly logHandlerFailure: ((event: ServicePlaneHandlerFailureLogEvent, context: Context<TEnv>) => void) | undefined;
  private readonly webSocketHandlers = new Map<string, WebSocketRpcHandler<Record<PropertyKey, unknown>>>();

  constructor(private readonly options: ServicePlaneServiceOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneServiceEnv<TEnv>>()) as Hono<ServicePlaneServiceEnv<TEnv>>;
    this.timeoutPolicy = validateTimeoutPolicy(options.timeout);
    // The replacement is all the caller sees, so the original throw goes to the app's log sink; the
    // package never owns the logger, mirroring every other surface.
    const write = options.logger === false ? undefined : (options.logger?.log ?? defaultServicePlaneLogSink);
    this.logHandlerFailure = write
      ? (event, context) => {
          recordServicePlaneLogEvent(context as unknown as Context, event);
          write(event, context as unknown as Context);
        }
      : undefined;
    this.definition = defineAbilityService(options, {
      ...(options.timeout?.methodMs === undefined ? {} : { defaultMethodTimeoutMs: options.timeout.methodMs }),
      requireAbilityScopes: options.requireAbilityScopes ?? true,
    });
    this.discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;

    // A declared WebSocket path needs either Hono's upgrade adapter or a Durable Object forwarding
    // hibernation events manually. Refuse a discovery document that advertises neither.
    if (!options.rpc?.upgradeWebSocket && !options.rpc?.manualWebSocket) {
      const broken = this.definition.abilities.find((ability) => ability.rpc.transports.includes('websocket'));
      if (broken) {
        throw new CapabilityAuthError(
          `Service-Plane ability declares the websocket transport but rpc.upgradeWebSocket is not configured: ${broken.id}`,
          500,
        );
      }
    }

    // Request-id assignment is not optional: correlation with the control plane depends on it,
    // and the middleware is free when the id is already present. Use `requestId` to customize.
    this.app.use(
      '*',
      requestId({
        // Adopt the id the broker sent; WebSocket upgrades carry it as a query parameter.
        generator: (context) => brokeredRequestId(context) ?? crypto.randomUUID(),
        headerName: SERVICE_PLANE_REQUEST_ID_HEADER,
        ...options.requestId,
      }),
    );

    for (const middleware of options.middleware ?? []) {
      this.app.use('*', middleware as MiddlewareHandler<ServicePlaneServiceEnv<TEnv>>);
    }

    if (options.logger !== false) {
      this.app.use('*', servicePlaneLogger(this.definition as unknown as ServiceDefinition, options.logger));
    }

    this.mountDiscovery();
    for (const ability of this.definition.abilities) {
      this.mountAbility(ability);
    }
  }

  fetch: Hono<ServicePlaneServiceEnv<TEnv>>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);

  /** Calls a unary procedure through a Cloudflare native service binding without HTTP serialization. */
  async invokeAbility(input: NativeAbilityCall, bindings?: TEnv['Bindings']): Promise<unknown> {
    const ability = this.definition.abilities.find((candidate) => candidate.id === input.abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane ability not found: ${input.abilityId}`, 404);
    if (!ability.rpc.transports.includes('cloudflare-service-binding')) {
      throw new CapabilityAuthError(`Service-Plane native binding RPC is not enabled for ability: ${input.abilityId}`, 405);
    }
    const method = ability.methods[input.method];
    if (!method?.procedure) {
      throw new CapabilityAuthError(`Service-Plane oRPC ability method not found: ${input.abilityId}/${input.method}`, 404);
    }
    if (method.stream) {
      throw new CapabilityAuthError(
        `Service-Plane streaming procedures use the service binding's Fetch transport: ${input.abilityId}/${input.method}`,
        405,
      );
    }
    const headers = new Headers({ authorization: servicePlaneAuthorization(input.token) });
    const connInfo = serializeConnInfo(input.connInfo);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const timeout = serializeTimeoutMs(input.timeoutMs);
    if (connInfo) headers.set(SERVICE_PLANE_CONN_INFO_HEADER, connInfo);
    if (idempotencyKey) headers.set(SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER, idempotencyKey);
    if (input.proof) headers.set(SERVICE_PLANE_PROOF_HEADER, input.proof);
    if (timeout) headers.set(SERVICE_PLANE_TIMEOUT_HEADER, timeout);
    const context = nativeBindingContext<TEnv>(ability.rpc.path, bindings, input.requestId, headers);
    return call(method.procedure, input.input, {
      context: this.createOrpcRuntime(ability, context, this.timeoutPolicy),
      path: [input.method],
    });
  }

  /**
   * Handles one message from a manually accepted WebSocket. A Durable Object can call this from
   * `webSocketMessage`, allowing the socket to hibernate between events.
   */
  async webSocketMessage(
    abilityId: string,
    webSocket: WebSocketLike,
    message: string | ArrayBuffer,
    bindings?: TEnv['Bindings'],
  ): Promise<void> {
    const ability = this.orpcWebSocketAbility(abilityId);
    const base = nativeBindingContext<TEnv>(ability.rpc.path, bindings, undefined);
    await this.orpcWebSocketHandler(ability).message(webSocket, message, {
      context: (request) => {
        const callContext = rpcMessageContext(base, request);
        return this.createOrpcRuntime(ability, callContext, this.timeoutPolicy, request.signal, webSocket);
      },
      prefix: ability.rpc.path as `/${string}`,
    });
  }

  /** Releases oRPC peer state after a manually accepted WebSocket closes. */
  async webSocketClose(abilityId: string, webSocket: WebSocketLike): Promise<void> {
    const ability = this.orpcWebSocketAbility(abilityId);
    await this.orpcWebSocketHandler(ability).close(webSocket);
  }

  private mountDiscovery(): void {
    const cacheHeaders = servicePlaneHttpCacheHeaders(this.options.httpCache, [
      'service-plane',
      'service-plane:discovery',
      `service-plane:service:${this.definition.id}`,
    ]);
    this.app.use(this.discoveryPath, etag());
    this.app.get(this.discoveryPath, (context) => {
      applyHttpCacheHeaders(cacheHeaders, (name, value) => context.header(name, value));
      return context.json({
        ...serviceDiscoveryDocument(this.definition),
        ...(this.options.ingress ? { ingress: { required: true as const } } : {}),
      });
    });
  }

  private mountAbility(ability: NormalizedServiceAbility<TEnv>): void {
    this.mountOrpcAbility(ability);
  }

  private mountOrpcAbility(ability: NormalizedServiceAbility<TEnv>): void {
    const router = Object.fromEntries(Object.entries(ability.methods).map(([name, method]) => [name, method.procedure]));
    const handlerOptions = this.options.rpc?.plugins ? { plugins: this.options.rpc.plugins } : {};
    const fetchHandler = new FetchRpcHandler(router, handlerOptions);
    const websocketHandler = this.orpcWebSocketHandler(ability);

    const handleFetch = async (context: Context<ServicePlaneServiceEnv<TEnv>>) => {
      if (!ability.rpc.transports.includes('fetch') && !ability.rpc.transports.includes('cloudflare-service-binding')) {
        return new Response('Fetch RPC is not enabled for this ability', { status: 405 });
      }
      const handled = await fetchHandler.handle(context.req.raw, {
        context: this.createOrpcRuntime(ability, context as unknown as Context<TEnv>, this.timeoutPolicy),
        prefix: ability.rpc.path as `/${string}`,
      });
      return handled.matched ? handled.response : new Response('oRPC procedure not found', { status: 404 });
    };

    // Fetch oRPC addresses a procedure below the ability prefix (`/rpc/ability/method`).
    this.app.all(`${ability.rpc.path}/*`, async (context, next) => {
      // The bare path is the WebSocket upgrade endpoint; Hono wildcards also match that prefix.
      if (context.req.path === ability.rpc.path) return next();
      return handleFetch(context);
    });
    this.app.all(ability.rpc.path, async (context) => {
      const upgrade = context.req.header('upgrade')?.toLowerCase() === 'websocket';
      if (!upgrade) return handleFetch(context);
      if (!ability.rpc.transports.includes('websocket')) {
        return new Response('WebSocket RPC is not enabled for this ability', { status: 405 });
      }
      const upgradeWebSocket = this.options.rpc?.upgradeWebSocket;
      if (!upgradeWebSocket) {
        return new Response('Service-Plane WebSocket is configured for manual event handling', { status: 426 });
      }

      return upgradeWebSocket(context, {
        onClose: (_event, socket) => {
          void websocketHandler.close(socket);
        },
        onMessage: async (event, socket) => {
          const data =
            event.data instanceof Blob
              ? await event.data.arrayBuffer()
              : typeof event.data === 'string' || event.data instanceof ArrayBuffer
                ? event.data
                : new Uint8Array(event.data).slice();
          await websocketHandler.message(socket, data, {
            context: (request: StandardLazyRequest) => {
              const callContext = rpcMessageContext(context as unknown as Context<TEnv>, request);
              return this.createOrpcRuntime(ability, callContext, this.timeoutPolicy, request.signal, socket);
            },
            prefix: ability.rpc.path as `/${string}`,
          });
        },
      });
    });
  }

  private orpcWebSocketAbility(abilityId: string): NormalizedServiceAbility<TEnv> {
    const ability = this.definition.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane oRPC ability not found: ${abilityId}`, 404);
    if (!ability.rpc.transports.includes('websocket')) {
      throw new CapabilityAuthError(`Service-Plane WebSocket transport is not enabled for ability: ${abilityId}`, 405);
    }
    return ability;
  }

  private orpcWebSocketHandler(ability: NormalizedServiceAbility<TEnv>): WebSocketRpcHandler<Record<PropertyKey, unknown>> {
    let handler = this.webSocketHandlers.get(ability.id);
    if (!handler) {
      const router = Object.fromEntries(Object.entries(ability.methods).map(([name, method]) => [name, method.procedure]));
      const options = this.options.rpc?.plugins ? { plugins: this.options.rpc.plugins } : {};
      handler = new WebSocketRpcHandler(router, options);
      this.webSocketHandlers.set(ability.id, handler);
    }
    return handler;
  }

  private createOrpcRuntime(
    ability: NormalizedServiceAbility<TEnv>,
    context: Context<TEnv>,
    timeoutPolicy: ServicePlaneTimeoutPolicy | undefined,
    transportSignal?: AbortSignal,
    webSocket?: WebSocketLike,
  ) {
    const timeoutMs = resolveTimeoutMs(timeoutMsFromRequest(context.req), timeoutPolicy);
    const startedAt = Date.now();
    const deadlineAt = timeoutMs === undefined ? undefined : startedAt + timeoutMs;
    const onHandlerFailure = this.logHandlerFailure;

    return createAbilityProcedureRuntimeContext<TEnv>({
      authorize: async ({ path, procedure, signal }) => {
        const methodName = path.at(-1);
        const method = methodName ? ability.methods[methodName] : undefined;
        if (!method || method.procedure !== procedure) {
          throw new CapabilityAuthError(`Service-Plane ability method not found: ${ability.id}/${methodName ?? ''}`, 404);
        }
        const token = extractServicePlaneToken(context.req.raw);
        const proof = context.req.header(SERVICE_PLANE_PROOF_HEADER);
        const identity = await verifyAuthenticationToken(token, {
          ...(await serviceVerifier(this.options.auth, this.definition.id, context)),
          abilityId: ability.id,
          ...(proof ? { proof } : {}),
        });
        await verifyServiceIngress(this.options.auth, this.options.ingress, identity, context);
        verifyAbilityAccess(ability, identity);
        requireAbilityMethodScopes(identity, method.scopes);

        const connInfo = this.options.ingress && identity.brokerServiceId ? normalizeConnInfo(forwardedConnInfo(context)) : undefined;
        const remaining = timeoutMs === undefined ? undefined : () => remainingTimeoutMs(timeoutMs, Date.now() - startedAt) as number;
        const idempotencyKey = idempotencyKeyFromRequest(context.req);
        const procedureContext: AbilityProcedureContext<TEnv> = {
          abilityId: ability.id,
          ...(connInfo ? { connInfo } : {}),
          context,
          env: context.env,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          identity,
          request: context.req.raw,
          ...(remaining ? { remainingTimeoutMs: remaining } : {}),
          ...(webSocket ? { webSocket } : {}),
        };
        defineLazyProcedureSignal(procedureContext, deadlineAt, signal ?? transportSignal);
        return procedureContext;
      },
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      defaultMethodTimeoutMs: this.options.timeout?.methodMs ?? DEFAULT_ABILITY_TIMEOUT_MS,
      ...(onHandlerFailure
        ? {
            onHandlerFailure: (cause: unknown, methodName: string) => {
              const requestId = requestIdFromContext(context as unknown as Context);
              onHandlerFailure(
                {
                  abilityId: ability.id,
                  error: cause instanceof Error ? { message: cause.message, name: cause.name } : { message: String(cause), name: 'Error' },
                  event: 'service_plane.ability.handler_failed',
                  level: 'error',
                  method: methodName,
                  ...(requestId ? { requestId } : {}),
                  serviceId: this.definition.id,
                },
                context,
              );
            },
          }
        : {}),
    });
  }
}

function verifyAbilityAccess(ability: Pick<NormalizedServiceAbility, 'access' | 'id'>, identity: CapabilityIdentity): void {
  if (ability.access === 'service' && identity.callerAccess !== 'service') {
    throw new CapabilityAuthError(`Service-Plane ability is callable by services only: ${ability.id}`, 403);
  }
}

function requireAbilityMethodScopes(identity: CapabilityIdentity, scopes: string[]): void {
  for (const scope of scopes) {
    if (!identity.scopes.includes(scope)) {
      throw new CapabilityAuthError(`Missing Service-Plane capability scope: ${scope}`, 403);
    }
  }
}

function defineLazyProcedureSignal<TEnv extends Env>(
  context: AbilityProcedureContext<TEnv>,
  deadlineAt: number | undefined,
  transportSignal: AbortSignal | undefined,
): void {
  if (deadlineAt === undefined && !transportSignal) return;
  let combined: AbortSignal | undefined;
  Object.defineProperty(context, 'signal', {
    configurable: true,
    enumerable: true,
    get: () => {
      if (combined) return combined;
      const signals = transportSignal ? [transportSignal] : [];
      if (deadlineAt !== undefined) signals.push(AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())));
      combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      return combined;
    },
  });
}

function rpcMessageContext<TEnv extends Env>(base: Context<TEnv>, message: StandardLazyRequest): Context<TEnv> {
  const headers = new Headers(base.req.raw.headers);
  applyStandardHeaders(headers, message.headers);
  const request = new Request(base.req.url, {
    headers,
    method: message.method,
    ...(message.signal ? { signal: message.signal } : {}),
  });
  const context = new Context<TEnv>(request, {
    env: base.env,
    path: base.req.path,
  });
  const requestId = validRequestId(headers.get(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined) ?? requestIdFromContext(base);
  if (requestId) context.set('requestId' as never, requestId as never);
  return context;
}

function applyStandardHeaders(target: Headers, source: StandardHeaders): void {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    target.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) target.append(name, item);
  }
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

async function serviceVerifier<TEnv extends Env>(
  auth: ServicePlaneServiceAuthOptions<TEnv>,
  serviceId: string,
  context: Context<TEnv>,
): Promise<CapabilityVerifierOptions> {
  const jwks = await resolveServiceJwks(context, auth);
  return {
    expectedAudience: auth.expectedAudience ?? serviceId,
    issuer: auth.issuer ?? 'control-plane',
    jwks,
    ...(auth.now ? { now: typeof auth.now === 'function' ? auth.now() : auth.now } : {}),
  };
}

async function verifyServiceIngress<TEnv extends Env>(
  auth: ServicePlaneServiceAuthOptions<TEnv>,
  ingress: false | ServicePlaneServiceIngressOptions<TEnv> | undefined,
  identity: CapabilityIdentity,
  context: Context<TEnv>,
): Promise<void> {
  if (!ingress) return;
  const allowed = await resolveIngressBrokerServiceIds(context, auth, ingress);
  if (identity.brokerServiceId && allowed.includes(identity.brokerServiceId)) return;
  throw new CapabilityAuthError('Service-Plane brokered capability token is required', 403);
}

// WebSocket upgrades cannot carry custom headers portably, so both forwarded values also have a
// query-parameter form. Parsing re-validates the payload; nothing here is trusted yet.
function forwardedConnInfo(context: Context): ConnInfo | undefined {
  return parseConnInfo(context.req.header(SERVICE_PLANE_CONN_INFO_HEADER) ?? context.req.query(SERVICE_PLANE_CONN_INFO_QUERY_PARAM));
}

// Mirrors hono/request-id's header validation so a query-supplied id cannot smuggle
// arbitrary characters into logs.
function brokeredRequestId(context: Context): string | undefined {
  return validRequestId(context.req.query(SERVICE_PLANE_REQUEST_ID_QUERY_PARAM));
}

function validRequestId(value: string | undefined): string | undefined {
  // Same rule as every other forwarded token-shaped value, from one shared implementation.
  return normalizeForwardedToken(value);
}

// Native-binding calls skip Hono routing, but handlers still receive an actual Hono Context.
// This keeps request helpers and response construction available without pretending that the
// normal middleware chain ran for a Workers RPC invocation.
function nativeBindingContext<TEnv extends Env>(
  abilityPath: string,
  bindings: TEnv['Bindings'] | undefined,
  requestId: string | undefined,
  forwardedHeaders?: Headers,
): Context<TEnv> {
  const normalizedRequestId = validRequestId(requestId);
  const headers = new Headers(forwardedHeaders);
  if (normalizedRequestId) headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, normalizedRequestId);
  const request = new Request(new URL(abilityPath, 'https://service-plane-native.internal'), {
    headers,
    method: 'POST',
  });
  const context = new Context<ServicePlaneServiceEnv<TEnv>>(request, {
    env: bindings ?? ({} as TEnv['Bindings']),
    path: abilityPath,
  });
  if (normalizedRequestId) context.set('requestId', normalizedRequestId);
  return context as unknown as Context<TEnv>;
}

async function resolveServiceJwks<TEnv extends Env>(
  context: Context<TEnv>,
  auth: ServicePlaneServiceAuthOptions<TEnv>,
): Promise<CapabilityJwksResolver> {
  if (auth.jwks) return typeof auth.jwks === 'function' ? auth.jwks(context) : auth.jwks;
  if (auth.controlPlaneBinding) return jwksFromServiceBinding(auth.controlPlaneBinding(context.env, context));
  throw new CapabilityAuthError('Service-Plane service auth requires jwks or controlPlaneBinding', 500);
}

async function resolveIngressBrokerServiceIds<TEnv extends Env>(
  context: Context<TEnv>,
  auth: ServicePlaneServiceAuthOptions<TEnv>,
  ingress: ServicePlaneServiceIngressOptions<TEnv>,
): Promise<string[]> {
  const configured = ingress.brokerServiceIds;
  const brokerServiceIds = configured
    ? typeof configured === 'function'
      ? await configured(context.env, context)
      : configured
    : [auth.issuer ?? 'control-plane'];
  const normalized = [...new Set(brokerServiceIds.map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new CapabilityAuthError('Service-Plane ingress requires at least one broker service id', 500);
  return normalized;
}
