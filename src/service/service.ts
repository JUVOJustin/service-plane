import { type AnyProcedure, call, type StandardHeaders, type StandardLazyRequest } from '@orpc/server';
import { RPCHandler as FetchRpcHandler } from '@orpc/server/fetch';
import { RPCHandler as WebSocketRpcHandler } from '@orpc/server/websocket';
import { Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import {
  closeOversizedWebSocket,
  readBoundedWebSocketMessage,
  resolveOptionalBodyByteLimit,
  ServicePlaneBodyTooLargeError,
} from '../shared/body-limit.js';
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
import { CapabilityAuthError, ServicePlaneTimeoutError, servicePlaneErrorInfo } from '../shared/errors.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import {
  idempotencyKeyFromRequest,
  normalizeForwardedToken,
  normalizeIdempotencyKey,
  SERVICE_PLANE_IDEMPOTENCY_KEY_HEADER,
} from '../shared/idempotency.js';
import { defaultServicePlaneLogSink, emitBestEffortServicePlaneLog } from '../shared/logging.js';
import {
  createFetchRequestPreparation,
  DEFAULT_RPC_REQUEST_PREPARATION_TIMEOUT_MS,
  preserveRuntimeRequestMetadata,
} from '../shared/request-preparation.js';
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
import { OrderedWebSocketTasks } from '../shared/web-socket-tasks.js';
import type { AbilityMethodContext, ServiceAbilityWebSocket } from './ability.js';
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
import { compileAbilityMethod, createAbilityRpcRuntimeContext } from './orpc.js';
import { createRpcHandlerPlugins } from './orpc-features.js';
import { DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES, type ServicePlaneServerWireOptions } from './wire-options.js';

const SERVICE_WEB_SOCKET_TOO_LARGE_MESSAGE = 'Service-Plane WebSocket message exceeds rpc.maxRequestBodyBytes';

type ServicePlaneServiceAuthCommonOptions = {
  /** Token audience accepted by this service. Defaults to the service id. */
  expectedAudience?: string;
  /** Capability-token issuer. Defaults to `control-plane`. */
  issuer?: string;
  /** Verification clock override for deterministic tests or controlled runtimes. */
  now?: Date | (() => Date);
};

/** Trust source and token-verification policy for one service. */
export type ServicePlaneServiceAuthOptions<TEnv extends Env> = ServicePlaneServiceAuthCommonOptions &
  (
    | {
        /** Fetch binding to the control plane's JWKS endpoint. */
        controlPlaneBinding: (bindings: TEnv['Bindings'], context: Context<TEnv>) => FetchLike;
        /** Optional explicit resolver; when present it takes precedence over the binding. */
        jwks?: CapabilityJwksResolver | ((context: Context<TEnv>) => CapabilityJwksResolver | Promise<CapabilityJwksResolver>);
      }
    | {
        /** Optional binding retained when an explicit resolver is supplied. */
        controlPlaneBinding?: (bindings: TEnv['Bindings'], context: Context<TEnv>) => FetchLike;
        /** Explicit JWKS value or resolver used to verify capability tokens. */
        jwks: CapabilityJwksResolver | ((context: Context<TEnv>) => CapabilityJwksResolver | Promise<CapabilityJwksResolver>);
      }
  );

export type ServicePlaneServiceIngressOptions<TEnv extends Env> = {
  brokerServiceIds?: string[] | ((bindings: TEnv['Bindings'], context: Context<TEnv>) => Promise<string[]> | string[]);
};

type ServicePlaneServiceEnv<TEnv extends Env> = TEnv & {
  Variables: RequestIdVariables & ServicePlaneLogVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;

type ServicePlaneBindingsArgument<TEnv extends Env> = undefined extends TEnv['Bindings']
  ? [bindings?: TEnv['Bindings']]
  : [bindings: TEnv['Bindings']];

export type ServicePlaneServiceOptions<TEnv extends Env = Env> = DefineServiceInput<TEnv> &
  Omit<DefineServiceOptions, 'defaultMethodTimeoutMs'> & {
    app?: Hono<TEnv>;
    auth: ServicePlaneServiceAuthOptions<TEnv>;
    discoveryPath?: string;
    httpCache?: ServicePlaneHttpCacheOption;
    ingress?: false | ServicePlaneServiceIngressOptions<TEnv>;
    logger?: false | ServicePlaneLoggerOptions;
    middleware?: MiddlewareHandler<TEnv>[];
    requestId?: ServicePlaneRequestIdOptions;
    rpc?: ServicePlaneServerWireOptions & {
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
     * `false` to opt the whole service out. Streaming execution is never bounded this way. Before
     * any method is known, the same service-wide value bounds Fetch body decoding; `false` removes
     * that preparation ceiling too when the caller supplied no deadline.
     *
     * `maxMs` clamps a budget a caller forwarded. `defaultMs` supplies one when a caller sent none.
     * Fetch, WebSocket, and native binding paths resolve it independently for every logical call.
     */
    timeout?: ServicePlaneTimeoutPolicy & {
      methodMs?: false | number;
    };
  };

/**
 * ServicePlaneService provides the Hono shell while a private runtime owns RPC execution and transport.
 */
export class ServicePlaneService<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneServiceEnv<TEnv>>;
  readonly definition: ServiceDefinition<TEnv>;
  readonly discoveryPath: string;

  // RPC transports get no manufactured default; misconfigured policy values fail here, not at
  // the first request they silently loosen.
  private readonly timeoutPolicy: ServicePlaneTimeoutPolicy | undefined;
  private readonly rpcMaxRequestBodyBytes: false | number;
  private readonly logHandlerFailure: ((event: ServicePlaneHandlerFailureLogEvent, context: Context<TEnv>) => void) | undefined;
  private readonly abilitiesById = new Map<string, NormalizedServiceAbility<TEnv>>();
  private readonly rpcRouters = new Map<string, Record<string, AnyProcedure>>();
  private readonly webSocketHandlers = new Map<string, WebSocketRpcHandler<Record<PropertyKey, unknown>>>();
  private readonly webSocketTasks = new OrderedWebSocketTasks();

  constructor(private readonly options: ServicePlaneServiceOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneServiceEnv<TEnv>>()) as Hono<ServicePlaneServiceEnv<TEnv>>;
    this.timeoutPolicy = validateTimeoutPolicy(options.timeout);
    this.rpcMaxRequestBodyBytes = resolveOptionalBodyByteLimit(
      options.rpc?.maxRequestBodyBytes,
      DEFAULT_SERVICE_PLANE_RPC_MAX_REQUEST_BODY_BYTES,
      'Service-Plane maxRequestBodyBytes must be a positive integer or false',
    );
    // The replacement is all the caller sees, so the original throw goes to the app's log sink; the
    // package never owns the logger, mirroring every other surface.
    const write = options.logger === false ? undefined : (options.logger?.log ?? defaultServicePlaneLogSink);
    this.logHandlerFailure = write
      ? (event, context) => {
          recordServicePlaneLogEvent(context as unknown as Context, event);
          emitBestEffortServicePlaneLog(write, event, context as unknown as Context);
        }
      : undefined;
    this.definition = defineAbilityService(options, {
      ...(options.timeout?.methodMs === undefined ? {} : { defaultMethodTimeoutMs: options.timeout.methodMs }),
      requireAbilityScopes: options.requireAbilityScopes ?? true,
    });
    for (const ability of this.definition.abilities) {
      this.abilitiesById.set(ability.id, ability);
      this.rpcRouters.set(ability.id, compileAbilityRouter(ability));
    }
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

  /**
   * Calls a unary method through a Cloudflare binding without the Service Plane HTTP/JSON codec.
   * The bindings argument is required when this service's typed environment requires bindings.
   */
  async invokeAbility(input: NativeAbilityCall, ...[bindings]: ServicePlaneBindingsArgument<TEnv>): Promise<unknown> {
    const ability = this.abilitiesById.get(input.abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane ability not found: ${input.abilityId}`, 404);
    if (!ability.rpc.transports.includes('service-binding')) {
      throw new CapabilityAuthError(`Service-Plane native binding RPC is not enabled for ability: ${input.abilityId}`, 405);
    }
    const method = Object.hasOwn(ability.methods, input.method) ? ability.methods[input.method] : undefined;
    if (!method) {
      throw new CapabilityAuthError(`Service-Plane ability method not found: ${input.abilityId}/${input.method}`, 404);
    }
    if (method.stream) {
      throw new CapabilityAuthError(
        `Service-Plane streaming methods use the service binding's Fetch transport: ${input.abilityId}/${input.method}`,
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
    const router = this.rpcRouter(ability);
    const procedure = Object.hasOwn(router, input.method) ? router[input.method] : undefined;
    if (!procedure) throw new CapabilityAuthError(`Service-Plane ability method not found: ${input.abilityId}/${input.method}`, 404);
    return call(procedure, input.input, {
      context: this.createRpcRuntime(ability, context, this.timeoutPolicy),
      path: [input.method],
    });
  }

  /**
   * Handles one message from a manually accepted WebSocket. A Durable Object can call this from
   * `webSocketMessage`, allowing the socket to hibernate between events. Call it at event entry;
   * messages for one socket reach the private peer in call order, and `webSocketClose` lets queued
   * frames reach that peer before releasing it. Messages exceeding `rpc.maxRequestBodyBytes`
   * reject with status 413 before the private protocol decoder runs. The bindings argument is
   * required when this service's typed environment requires bindings.
   */
  async webSocketMessage(
    abilityId: string,
    webSocket: ServiceAbilityWebSocket,
    message: string | ArrayBuffer,
    ...[bindings]: ServicePlaneBindingsArgument<TEnv>
  ): Promise<void> {
    const receivedAt = Date.now();
    const ability = this.orpcWebSocketAbility(abilityId);
    const base = nativeBindingContext<TEnv>(ability.rpc.path, bindings, undefined);
    const delivery = await this.webSocketTasks.run(webSocket, async () => {
      const boundedMessage = await readBoundedWebSocketMessage(message, this.rpcMaxRequestBodyBytes, SERVICE_WEB_SOCKET_TOO_LARGE_MESSAGE);
      return {
        completion: this.orpcWebSocketHandler(ability).message(webSocket, boundedMessage, {
          context: (request) => {
            const callContext = rpcMessageContext(base, request);
            return this.createRpcRuntime(ability, callContext, this.timeoutPolicy, request.signal, webSocket, receivedAt);
          },
          prefix: ability.rpc.path as `/${string}`,
        }),
      };
    });
    await delivery.completion;
  }

  /** Delivers queued frames, then releases private RPC peer state after a manual socket closes. */
  async webSocketClose(abilityId: string, webSocket: ServiceAbilityWebSocket): Promise<void> {
    const ability = this.orpcWebSocketAbility(abilityId);
    await this.webSocketTasks.run(webSocket, () => this.orpcWebSocketHandler(ability).close(webSocket));
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
    this.mountRpcAbility(ability);
  }

  private mountRpcAbility(ability: NormalizedServiceAbility<TEnv>): void {
    const router = this.rpcRouter(ability);
    const plugins = this.rpcHandlerPlugins(ability, false);
    const handlerOptions = plugins.length > 0 ? { plugins } : {};
    const fetchHandler = new FetchRpcHandler(router, handlerOptions);

    const handleFetch = async (context: Context<ServicePlaneServiceEnv<TEnv>>) => {
      if (!ability.rpc.transports.includes('fetch') && !ability.rpc.transports.includes('service-binding')) {
        return new Response('Fetch RPC is not enabled for this ability', { status: 405 });
      }
      const receivedAt = Date.now();
      const callerTimeoutMs = resolveTimeoutMs(timeoutMsFromRequest(context.req), this.timeoutPolicy);
      const configuredPreparationMs = this.options.timeout?.methodMs ?? DEFAULT_RPC_REQUEST_PREPARATION_TIMEOUT_MS;
      const preparationTimeoutMs = minimumDefinedTimeout(
        callerTimeoutMs,
        configuredPreparationMs === false ? undefined : configuredPreparationMs,
      );
      const preparation = createFetchRequestPreparation(context.req.raw, {
        ...(preparationTimeoutMs === undefined ? {} : { deadlineAt: receivedAt + preparationTimeoutMs }),
        deadlineError: () => new ServicePlaneTimeoutError(`Service-Plane request decoding exceeded its deadline: ${ability.id}`),
      });
      try {
        const handled = await preparation.run(
          () =>
            fetchHandler.handle(preparation.request, {
              context: this.createRpcRuntime(
                ability,
                context as unknown as Context<TEnv>,
                this.timeoutPolicy,
                preparation.signal,
                undefined,
                receivedAt,
                preparation.complete,
              ),
              prefix: ability.rpc.path as `/${string}`,
            }),
          (late) => {
            void late.response?.body?.cancel().catch(() => undefined);
          },
        );
        return handled.matched ? handled.response : new Response('Service-Plane method not found', { status: 404 });
      } catch (error) {
        const info = servicePlaneErrorInfo(error);
        if (info?.code !== 'timeout') throw error;
        return Response.json({ error: { code: info.code, message: info.message, retryable: info.retryable } }, { status: info.status });
      }
    };

    // Fetch RPC addresses a method below the ability prefix (`/rpc/ability/method`).
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

      const websocketHandler = this.orpcWebSocketHandler(ability);
      return upgradeWebSocket(context, {
        onClose: (_event, socket) => {
          void this.webSocketTasks.run(socket, () => websocketHandler.close(socket));
        },
        onMessage: (event, socket) => {
          const receivedAt = Date.now();
          const delivery = this.webSocketTasks.run(socket, async () => {
            let data: string | ArrayBuffer;
            try {
              data = await readBoundedWebSocketMessage(event.data, this.rpcMaxRequestBodyBytes, SERVICE_WEB_SOCKET_TOO_LARGE_MESSAGE);
            } catch (error) {
              if (!(error instanceof ServicePlaneBodyTooLargeError)) throw error;
              closeOversizedWebSocket(socket);
              return;
            }
            return {
              completion: websocketHandler.message(socket, data, {
                context: (request: StandardLazyRequest) => {
                  const callContext = rpcMessageContext(context as unknown as Context<TEnv>, request);
                  return this.createRpcRuntime(ability, callContext, this.timeoutPolicy, request.signal, socket, receivedAt);
                },
                prefix: ability.rpc.path as `/${string}`,
              }),
            };
          });
          // The queue covers only normalization and synchronous protocol delivery. The RPC itself
          // remains concurrent with later calls on the same socket, matching oRPC's own upgrader.
          return delivery.then((result) => result?.completion);
        },
      });
    });
  }

  private orpcWebSocketAbility(abilityId: string): NormalizedServiceAbility<TEnv> {
    const ability = this.abilitiesById.get(abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane ability not found: ${abilityId}`, 404);
    if (!ability.rpc.transports.includes('websocket')) {
      throw new CapabilityAuthError(`Service-Plane WebSocket transport is not enabled for ability: ${abilityId}`, 405);
    }
    return ability;
  }

  private orpcWebSocketHandler(ability: NormalizedServiceAbility<TEnv>): WebSocketRpcHandler<Record<PropertyKey, unknown>> {
    let handler = this.webSocketHandlers.get(ability.id);
    if (!handler) {
      const router = this.rpcRouter(ability);
      const plugins = this.rpcHandlerPlugins(ability, true);
      const options = plugins.length > 0 ? { plugins } : {};
      handler = new WebSocketRpcHandler(router, options);
      this.webSocketHandlers.set(ability.id, handler);
    }
    return handler;
  }

  private rpcRouter(ability: NormalizedServiceAbility<TEnv>): Record<string, AnyProcedure> {
    const router = this.rpcRouters.get(ability.id);
    if (!router) throw new CapabilityAuthError(`Service-Plane ability runtime is not compiled: ${ability.id}`, 500);
    return router;
  }

  private rpcHandlerPlugins(ability: NormalizedServiceAbility<TEnv>, supportsHibernation: boolean) {
    const hibernation = supportsHibernation && Object.values(ability.methods).some((method) => method.method.kind === 'hibernation');
    return createRpcHandlerPlugins(this.options.rpc ?? {}, hibernation);
  }

  private createRpcRuntime(
    ability: NormalizedServiceAbility<TEnv>,
    context: Context<TEnv>,
    timeoutPolicy: ServicePlaneTimeoutPolicy | undefined,
    transportSignal?: AbortSignal,
    webSocket?: ServiceAbilityWebSocket,
    receivedAt = Date.now(),
    onProcedureEntry?: () => void,
  ) {
    // Batch decoding, frame normalization, and authorization are part of the caller's budget, not
    // free work before its timer begins. WebSocket callbacks therefore pass their entry timestamp.
    const onHandlerFailure = this.logHandlerFailure;
    const resolveCallTimeoutMs = (headers?: Headers) =>
      resolveTimeoutMs(
        timeoutMsFromRequest(
          headers
            ? {
                header: (name) => headers.get(name) ?? undefined,
                query: (name) => context.req.query(name),
              }
            : context.req,
        ),
        timeoutPolicy,
      );
    const resolveCallDeadlineAt = (headers?: Headers) => {
      const timeoutMs = resolveCallTimeoutMs(headers);
      return timeoutMs === undefined ? undefined : receivedAt + timeoutMs;
    };

    return createAbilityRpcRuntimeContext<TEnv>({
      authorize: async ({ headers, path, procedure, signal }) => {
        onProcedureEntry?.();
        const logicalSignal = signal ?? transportSignal;
        logicalSignal?.throwIfAborted();
        const callContext =
          headers || (logicalSignal && logicalSignal !== context.req.raw.signal)
            ? rpcRequestContext(context, headers ?? context.req.raw.headers, logicalSignal)
            : context;
        const timeoutMs = resolveCallTimeoutMs(headers);
        const deadlineAt = timeoutMs === undefined ? undefined : receivedAt + timeoutMs;
        const methodName = path.at(-1);
        const method = methodName && Object.hasOwn(ability.methods, methodName) ? ability.methods[methodName] : undefined;
        const router = this.rpcRouter(ability);
        const expectedProcedure = methodName && Object.hasOwn(router, methodName) ? router[methodName] : undefined;
        if (!method || !expectedProcedure || expectedProcedure !== procedure) {
          throw new CapabilityAuthError(`Service-Plane ability method not found: ${ability.id}/${methodName ?? ''}`, 404);
        }
        const token = extractServicePlaneToken(callContext.req.raw);
        const proof = callContext.req.header(SERVICE_PLANE_PROOF_HEADER);
        const identity = await verifyAuthenticationToken(token, {
          ...(await serviceVerifier(this.options.auth, this.definition.id, callContext)),
          abilityId: ability.id,
          ...(proof ? { proof } : {}),
        });
        await verifyServiceIngress(this.options.ingress, identity, callContext);
        verifyAbilityAccess(ability, identity);
        requireAbilityMethodScopes(identity, method.scopes);
        if (method.method.kind === 'hibernation' && !webSocket) {
          throw new CapabilityAuthError(
            `Service-Plane hibernation method requires a WebSocket transport: ${ability.id}/${methodName}`,
            405,
          );
        }

        const connInfo = this.options.ingress && identity.brokerServiceId ? normalizeConnInfo(forwardedConnInfo(callContext)) : undefined;
        const remaining = timeoutMs === undefined ? undefined : () => remainingTimeoutMs(timeoutMs, Date.now() - receivedAt) as number;
        const idempotencyKey = idempotencyKeyFromRequest(callContext.req);
        const procedureContext: AbilityMethodContext<TEnv> = {
          abilityId: ability.id,
          methodName: methodName ?? '',
          ...(connInfo ? { connInfo } : {}),
          context: callContext,
          env: callContext.env,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          identity,
          request: callContext.req.raw,
          ...(remaining ? { remainingTimeoutMs: remaining } : {}),
          ...(webSocket ? { webSocket } : {}),
        };
        defineLazyProcedureSignal(procedureContext, deadlineAt, signal ?? transportSignal);
        return {
          context: procedureContext,
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
        };
      },
      defaultMethodTimeoutMs: this.options.timeout?.methodMs ?? DEFAULT_ABILITY_TIMEOUT_MS,
      receivedAt,
      resolveDeadlineAt: ({ headers }) => {
        onProcedureEntry?.();
        return resolveCallDeadlineAt(headers);
      },
      ...(onHandlerFailure
        ? {
            onHandlerFailure: (cause: unknown, methodName: string, methodContext?: AbilityMethodContext<TEnv>) => {
              const failureContext = methodContext?.context ?? context;
              const requestId = requestIdFromContext(failureContext as unknown as Context);
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
                failureContext,
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

function requireAbilityMethodScopes(identity: CapabilityIdentity, scopes: ReadonlyArray<string>): void {
  for (const scope of scopes) {
    if (!identity.scopes.includes(scope)) {
      throw new CapabilityAuthError(`Missing Service-Plane capability scope: ${scope}`, 403);
    }
  }
}

function defineLazyProcedureSignal<TEnv extends Env>(
  context: AbilityMethodContext<TEnv>,
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

function compileAbilityRouter<TEnv extends Env>(ability: NormalizedServiceAbility<TEnv>): Record<string, AnyProcedure> {
  const router = Object.create(null) as Record<string, AnyProcedure>;
  for (const [name, method] of Object.entries(ability.methods)) {
    router[name] = compileAbilityMethod(method.method);
  }
  return router;
}

function rpcMessageContext<TEnv extends Env>(base: Context<TEnv>, message: StandardLazyRequest): Context<TEnv> {
  const headers = new Headers(base.req.raw.headers);
  applyStandardHeaders(headers, message.headers);
  const request = preserveRuntimeRequestMetadata(
    base.req.raw,
    new Request(base.req.url, {
      headers,
      method: message.method,
      ...(message.signal ? { signal: message.signal } : {}),
    }),
  );
  const context = new Context<TEnv>(request, {
    env: base.env,
    ...contextExecutionOptions(base),
    path: base.req.path,
  });
  for (const [name, value] of Object.entries(base.var)) context.set(name as never, value as never);
  const requestId = validRequestId(headers.get(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined) ?? requestIdFromContext(base);
  if (requestId) context.set('requestId' as never, requestId as never);
  return context;
}

function rpcRequestContext<TEnv extends Env>(base: Context<TEnv>, headers: Headers, signal?: AbortSignal): Context<TEnv> {
  const request = preserveRuntimeRequestMetadata(
    base.req.raw,
    new Request(base.req.url, {
      headers,
      method: base.req.method,
      ...(signal ? { signal } : {}),
    }),
  );
  const context = new Context<TEnv>(request, {
    env: base.env,
    ...contextExecutionOptions(base),
    path: base.req.path,
  });
  for (const [name, value] of Object.entries(base.var)) context.set(name as never, value as never);
  const requestId = validRequestId(headers.get(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined) ?? requestIdFromContext(base);
  if (requestId) context.set('requestId' as never, requestId as never);
  return context;
}

function contextExecutionOptions(context: Context): { executionCtx?: Context['executionCtx'] } {
  try {
    return { executionCtx: context.executionCtx };
  } catch {
    return {};
  }
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
  ingress: false | ServicePlaneServiceIngressOptions<TEnv> | undefined,
  identity: CapabilityIdentity,
  context: Context<TEnv>,
): Promise<void> {
  if (!ingress) return;
  const allowed = await resolveIngressBrokerServiceIds(context, ingress);
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

function minimumDefinedTimeout(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
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
  ingress: ServicePlaneServiceIngressOptions<TEnv>,
): Promise<string[]> {
  const configured = ingress.brokerServiceIds;
  const brokerServiceIds = configured
    ? typeof configured === 'function'
      ? await configured(context.env, context)
      : configured
    : ['control-plane'];
  const normalized = [...new Set(brokerServiceIds.map((id) => id.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new CapabilityAuthError('Service-Plane ingress requires at least one broker service id', 500);
  return normalized;
}
