import { newRpcResponse } from '@hono/capnweb';
import { type Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import { CapabilityAuthError } from '../shared/errors.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
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
  type ServiceDefinition,
  serviceDiscoveryDocument,
} from './discovery.js';
import { type ServicePlaneLoggerOptions, type ServicePlaneLogVariables, servicePlaneLogger } from './logger.js';

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
  };

// ServicePlaneService provides the Hono shell while Cap'n Web owns the service API.
export class ServicePlaneService<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneServiceEnv<TEnv>>;
  readonly definition: ServiceDefinition<TEnv>;
  readonly discoveryPath: string;

  constructor(private readonly options: ServicePlaneServiceOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneServiceEnv<TEnv>>()) as Hono<ServicePlaneServiceEnv<TEnv>>;
    this.definition = defineAbilityService(options, { requireAbilityScopes: options.requireAbilityScopes ?? true });
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

  async connectAbility(input: { abilityId: string; requestId?: string; token: string }, bindings?: TEnv['Bindings']): Promise<RpcTarget> {
    const ability = this.definition.abilities.find((candidate) => candidate.id === input.abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane ability not found: ${input.abilityId}`, 404);
    const context = syntheticContext<TEnv>(bindings, input.requestId);
    // Native bindings are session-shaped (Workers RPC), so streaming returns are allowed.
    const root = new AuthRoot(this.options.auth, this.options.ingress, this.definition.id, ability, context, true);
    return root.authenticate(input.token);
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
        new AuthRoot(this.options.auth, this.options.ingress, this.definition.id, ability, context as unknown as Context<TEnv>, upgrade),
        this.options.rpc,
      );
    });
  }
}

class AuthRoot<TEnv extends Env> extends RpcTarget {
  constructor(
    private readonly auth: ServicePlaneServiceAuthOptions<TEnv>,
    private readonly ingress: false | ServicePlaneServiceIngressOptions<TEnv> | undefined,
    private readonly serviceId: string,
    private readonly ability: NormalizedServiceAbility<TEnv>,
    private readonly context: Context<TEnv>,
    private readonly allowStreaming: boolean,
  ) {
    super();
  }

  async authenticate(token: string) {
    const identity = await verifyAuthenticationToken(token, await serviceVerifier(this.auth, this.serviceId, this.context));
    await verifyServiceIngress(this.auth, this.ingress, identity, this.context);
    const handler = await this.ability.handler({
      abilityId: this.ability.id,
      context: this.context,
      identity,
    });
    return createValidatingAbilityHandler(this.ability, handler, identity, { allowStreaming: this.allowStreaming });
  }
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

// Mirrors hono/request-id's header validation so a query-supplied id cannot smuggle
// arbitrary characters into logs.
function brokeredRequestId(context: Context): string | undefined {
  const candidate = context.req.query(SERVICE_PLANE_REQUEST_ID_QUERY_PARAM)?.trim();
  if (!candidate || candidate.length > 255 || /[^\w\-=]/.test(candidate)) return undefined;
  return candidate;
}

// Native-binding calls skip the Hono shell, so hand handlers a minimal context that still
// resolves bindings and the brokered request id.
function syntheticContext<TEnv extends Env>(bindings: TEnv['Bindings'] | undefined, requestId: string | undefined): Context<TEnv> {
  const variables = new Map<string, unknown>();
  if (requestId) variables.set('requestId', requestId);
  return {
    env: bindings ?? ({} as TEnv['Bindings']),
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => {
      variables.set(key, value);
    },
  } as unknown as Context<TEnv>;
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
