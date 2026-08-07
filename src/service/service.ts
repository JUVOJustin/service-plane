import { newRpcResponse } from '@hono/capnweb';
import { Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import {
  type ConnInfo,
  normalizeConnInfo,
  parseConnInfo,
  SERVICE_PLANE_CONN_INFO_HEADER,
  SERVICE_PLANE_CONN_INFO_QUERY_PARAM,
} from '../shared/conn-info.js';
import {
  remainingTimeoutMs,
  resolveTimeoutMs,
  type ServicePlaneTimeoutPolicy,
  timeoutMsFromRequest,
  validateTimeoutPolicy,
} from '../shared/deadline.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import { idempotencyKeyFromRequest, normalizeForwardedToken, normalizeIdempotencyKey } from '../shared/idempotency.js';
import { defaultServicePlaneLogSink } from '../shared/logging.js';
import {
  type CapabilityIdentity,
  type CapabilityJwksResolver,
  type CapabilityVerifierOptions,
  type FetchLike,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  SERVICE_PLANE_REQUEST_ID_QUERY_PARAM,
} from '../shared/types.js';
import { jwksFromServiceBinding, RpcTarget, verifyAuthenticationToken } from './capabilities.js';
import {
  createValidatingAbilityHandler,
  type DefineServiceInput,
  type DefineServiceOptions,
  defineAbilityService,
  type NormalizedServiceAbility,
  type ServiceAbilityHandlerFactoryInput,
  type ServiceDefinition,
  serviceDiscoveryDocument,
  verifyAbilityAccess,
} from './discovery.js';
import {
  recordServicePlaneLogEvent,
  type ServicePlaneHandlerFailureLogEvent,
  type ServicePlaneLoggerOptions,
  type ServicePlaneLogVariables,
  servicePlaneLogger,
} from './logger.js';

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
     * `maxMs` clamps a budget a caller forwarded. `defaultMs` supplies one when a caller sent none —
     * on per-call transports (HTTP-batch) only: a session transport (WebSocket upgrade, native
     * binding) resolves its budget once at session open, so a manufactured default would become a
     * death timer for long-lived sessions whose callers never asked for a deadline. An explicit
     * caller budget on a session transport still applies, as documented.
     */
    timeout?: ServicePlaneTimeoutPolicy & {
      methodMs?: false | number;
    };
  };

/**
 * ServicePlaneService provides the Hono shell while Cap'n Web owns the service API.
 */
export class ServicePlaneService<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneServiceEnv<TEnv>>;
  readonly definition: ServiceDefinition<TEnv>;
  readonly discoveryPath: string;

  // Session transports get no manufactured default; misconfigured policy values fail here, not at
  // the first request they silently loosen.
  private readonly timeoutPolicy: ServicePlaneTimeoutPolicy | undefined;
  private readonly sessionTimeoutPolicy: ServicePlaneTimeoutPolicy | undefined;
  private readonly logHandlerFailure: ((event: ServicePlaneHandlerFailureLogEvent, context: Context<TEnv>) => void) | undefined;

  constructor(private readonly options: ServicePlaneServiceOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneServiceEnv<TEnv>>()) as Hono<ServicePlaneServiceEnv<TEnv>>;
    this.timeoutPolicy = validateTimeoutPolicy(options.timeout);
    this.sessionTimeoutPolicy = this.timeoutPolicy?.maxMs === undefined ? undefined : { maxMs: this.timeoutPolicy.maxMs };
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

    // @hono/capnweb answers upgrades with 400 unless an upgradeWebSocket helper is wired in,
    // so a websocket declaration without one is dead configuration that discovery would still
    // advertise as usable; fail at construction instead of at the first upgrade.
    if (!options.rpc?.upgradeWebSocket) {
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

  async connectAbility(
    input: {
      abilityId: string;
      connInfo?: ConnInfo;
      /**
       * The caller's key for this attempt, surfaced to handlers as `idempotencyKey`.
       */
      idempotencyKey?: string;
      proof?: string;
      requestId?: string;
      /**
       * Milliseconds of the caller's budget, bounding this whole session. The service's `maxMs`
       * clamps it; `defaultMs` does not apply — a session transport gets no manufactured deadline.
       */
      timeoutMs?: number;
      token: string;
    },
    bindings?: TEnv['Bindings'],
  ): Promise<RpcTarget> {
    const ability = this.definition.abilities.find((candidate) => candidate.id === input.abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane ability not found: ${input.abilityId}`, 404);
    if (!ability.rpc.transports.includes('cloudflare-binding-rpc')) {
      throw new CapabilityAuthError(`Service-Plane native binding RPC is not enabled for ability: ${input.abilityId}`, 405);
    }
    const context = nativeBindingContext<TEnv>(ability.rpc.path, bindings, input.requestId);
    // Native bindings are session-shaped (Workers RPC), so streaming returns are allowed — and the
    // budget policy is the session one: maxMs clamps, defaultMs does not apply.
    const root = new AuthRoot<TEnv>({
      ability,
      allowStreaming: true,
      auth: this.options.auth,
      connInfo: input.connInfo,
      context,
      idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
      ingress: this.options.ingress,
      logHandlerFailure: this.logHandlerFailure,
      serviceId: this.definition.id,
      timeoutMs: resolveTimeoutMs(input.timeoutMs, this.sessionTimeoutPolicy),
    });
    return root.authenticate(input.token, input.proof);
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
    this.app.all(ability.rpc.path, async (context) => {
      const upgrade = context.req.header('upgrade')?.toLowerCase() === 'websocket';
      if (upgrade && !ability.rpc.transports.includes('websocket')) {
        return new Response('WebSocket RPC is not enabled for this ability', { status: 405 });
      }
      if (!upgrade && context.req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }
      if (!upgrade && !ability.rpc.transports.includes('http-batch')) {
        return new Response('HTTP-batch RPC is not enabled for this ability', { status: 405 });
      }

      // Streaming methods only survive session transports: a WebSocket upgrade keeps the
      // Cap'n Web session open, while an HTTP batch ends after one round trip and would
      // leave the returned stream stub dangling.
      return newRpcResponse(
        context,
        new AuthRoot<TEnv>({
          ability,
          allowStreaming: upgrade,
          auth: this.options.auth,
          connInfo: forwardedConnInfo(context),
          context: context as unknown as Context<TEnv>,
          idempotencyKey: idempotencyKeyFromRequest(context.req),
          ingress: this.options.ingress,
          logHandlerFailure: this.logHandlerFailure,
          serviceId: this.definition.id,
          // A WebSocket upgrade opens a session whose budget is fixed for its lifetime, so the
          // default is not manufactured there; an explicit caller budget still applies.
          timeoutMs: resolveTimeoutMs(timeoutMsFromRequest(context.req), upgrade ? this.sessionTimeoutPolicy : this.timeoutPolicy),
        }),
        this.options.rpc,
      );
    });
  }
}

// One options object rather than positional arguments: the forwarded per-call values grew this
// constructor past the point where call sites were readable by counting commas.
type AuthRootInput<TEnv extends Env> = {
  ability: NormalizedServiceAbility<TEnv>;
  allowStreaming: boolean;
  auth: ServicePlaneServiceAuthOptions<TEnv>;
  connInfo: ConnInfo | undefined;
  context: Context<TEnv>;
  idempotencyKey: string | undefined;
  ingress: false | ServicePlaneServiceIngressOptions<TEnv> | undefined;
  logHandlerFailure: ((event: ServicePlaneHandlerFailureLogEvent, context: Context<TEnv>) => void) | undefined;
  serviceId: string;
  timeoutMs: number | undefined;
};

class AuthRoot<TEnv extends Env> extends RpcTarget {
  constructor(private readonly input: AuthRootInput<TEnv>) {
    super();
  }

  // `proof` is a proof of possession for a sender-constrained token. It is optional on the wire and
  // required by the verifier whenever the token carries a `cnf` claim, so a caller cannot downgrade a
  // sender-constrained token to a bearer token by simply omitting it.
  async authenticate(token: string, proof?: string) {
    const { ability, allowStreaming, auth, context, idempotencyKey, ingress, serviceId, timeoutMs } = this.input;
    const identity = await verifyAuthenticationToken(token, {
      ...(await serviceVerifier(auth, serviceId, context)),
      abilityId: ability.id,
      ...(proof === undefined ? {} : { proof }),
    });
    await verifyServiceIngress(auth, ingress, identity, context);
    // From the ability's own definition, before the handler factory runs. The broker checks the
    // same rule from its cached catalog; this is the authoritative end, so tightening an ability
    // to `access: 'service'` takes effect the moment the service deploys.
    verifyAbilityAccess(ability, identity);
    // Connection info is an unsigned assertion about a connection this service never saw, so it is
    // only trustworthy once the peer is proven to be the broker: ingress restricts the service to
    // brokered tokens, and `brokerServiceId` is a signed claim only the control plane can mint.
    // Without ingress any direct caller could set the header, so handlers see nothing.
    const connInfo = ingress && identity.brokerServiceId ? normalizeConnInfo(this.input.connInfo) : undefined;
    // Unlike conn info, a forwarded deadline needs no brokered provenance: it is not an
    // authorization input, a caller shortening its own budget can only cut itself off, and the
    // normalizer clamps a long one. So it is honoured from any caller. Both readings below are this
    // machine's clock, so what a handler passes onward never needs two machines to agree.
    const startedAt = Date.now();
    const deadlineAt = timeoutMs === undefined ? undefined : startedAt + timeoutMs;
    const remaining = timeoutMs === undefined ? undefined : () => remainingTimeoutMs(timeoutMs, Date.now() - startedAt) as number;
    const factoryInput: ServiceAbilityHandlerFactoryInput<TEnv> = {
      abilityId: ability.id,
      ...(connInfo ? { connInfo } : {}),
      context,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      identity,
      ...(remaining ? { remainingTimeoutMs: remaining } : {}),
    };
    if (deadlineAt !== undefined) {
      // Lazily materialized: most handlers never read `signal`, and an eager AbortSignal.timeout is
      // an uncancellable timer that outlives every fast request by the rest of the budget. The
      // getter keeps the documented shape — present exactly when the caller sent a budget.
      let lazySignal: AbortSignal | undefined;
      Object.defineProperty(factoryInput, 'signal', {
        configurable: true,
        enumerable: true,
        get: () => {
          lazySignal ??= AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
          return lazySignal;
        },
      });
    }
    const handler = await ability.handler(factoryInput);
    const logHandlerFailure = this.input.logHandlerFailure;
    return createValidatingAbilityHandler(ability, handler, identity, {
      allowStreaming,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...(logHandlerFailure
        ? {
            onHandlerFailure: (cause: unknown, methodName: string) => {
              const requestId = requestIdFromContext(context as unknown as Context);
              logHandlerFailure(
                {
                  abilityId: ability.id,
                  error: cause instanceof Error ? { message: cause.message, name: cause.name } : { message: String(cause), name: 'Error' },
                  event: 'service_plane.ability.handler_failed',
                  level: 'error',
                  method: methodName,
                  ...(requestId ? { requestId } : {}),
                  serviceId,
                },
                context,
              );
            },
          }
        : {}),
    });
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
): Context<TEnv> {
  const normalizedRequestId = validRequestId(requestId);
  const headers = new Headers();
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
