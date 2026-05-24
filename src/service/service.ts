import { newRpcResponse } from '@hono/capnweb';
import { type Context, type Env, Hono, type MiddlewareHandler } from 'hono';
import { etag } from 'hono/etag';
import type { UpgradeWebSocket } from 'hono/ws';
import { CapabilityAuthError } from '../shared/errors.js';
import { type CapabilityJwksResolver, type CapabilityVerifierOptions, type FetchLike, SERVICE_DISCOVERY_PATH } from '../shared/types.js';
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

export type ServicePlaneServiceAuthOptions<TEnv extends Env> = {
  controlPlaneBinding?: (bindings: TEnv['Bindings'], context: Context<TEnv>) => FetchLike;
  expectedAudience?: string;
  issuer?: string;
  jwks?: CapabilityJwksResolver | ((context: Context<TEnv>) => CapabilityJwksResolver | Promise<CapabilityJwksResolver>);
  now?: Date | (() => Date);
};

export type ServicePlaneServiceOptions<TEnv extends Env = Env> = DefineServiceInput<TEnv> &
  DefineServiceOptions & {
    app?: Hono<TEnv>;
    auth: ServicePlaneServiceAuthOptions<TEnv>;
    discoveryPath?: string;
    middleware?: MiddlewareHandler<TEnv>[];
    rpc?: {
      upgradeWebSocket?: UpgradeWebSocket;
    };
  };

// ServicePlaneService provides the Hono shell while Cap'n Web owns the service API.
export class ServicePlaneService<TEnv extends Env = Env> {
  readonly app: Hono<TEnv>;
  readonly definition: ServiceDefinition<TEnv>;
  readonly discoveryPath: string;

  constructor(private readonly options: ServicePlaneServiceOptions<TEnv>) {
    this.app = options.app ?? new Hono<TEnv>();
    this.definition = defineAbilityService(options, { requireAbilityScopes: options.requireAbilityScopes ?? true });
    this.discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;

    for (const middleware of options.middleware ?? []) {
      this.app.use('*', middleware);
    }

    this.mountDiscovery();
    for (const ability of this.definition.abilities) {
      this.mountAbility(ability);
    }
  }

  fetch: Hono<TEnv>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);

  async connectAbility(input: { abilityId: string; token: string }, bindings?: TEnv['Bindings']): Promise<RpcTarget> {
    const ability = this.definition.abilities.find((candidate) => candidate.id === input.abilityId);
    if (!ability) throw new CapabilityAuthError(`Service-Plane ability not found: ${input.abilityId}`, 404);
    const context = { env: bindings ?? ({} as TEnv['Bindings']) } as Context<TEnv>;
    const root = new AuthRoot(this.options.auth, this.definition.id, ability, context);
    return root.authenticate(input.token);
  }

  private mountDiscovery(): void {
    this.app.use(this.discoveryPath, etag());
    this.app.get(this.discoveryPath, (context) => context.json(serviceDiscoveryDocument(this.definition)));
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

      return newRpcResponse(context, new AuthRoot(this.options.auth, this.definition.id, ability, context), this.options.rpc);
    });
  }
}

class AuthRoot<TEnv extends Env> extends RpcTarget {
  constructor(
    private readonly auth: ServicePlaneServiceAuthOptions<TEnv>,
    private readonly serviceId: string,
    private readonly ability: NormalizedServiceAbility<TEnv>,
    private readonly context: Context<TEnv>,
  ) {
    super();
  }

  async authenticate(token: string) {
    const identity = await verifyAuthenticationToken(token, await this.verifier());
    const handler = await this.ability.handler({
      abilityId: this.ability.id,
      context: this.context,
      identity,
    });
    return createValidatingAbilityHandler(this.ability, handler, identity);
  }

  private async verifier(): Promise<CapabilityVerifierOptions> {
    const jwks = await resolveServiceJwks(this.context, this.auth);
    return {
      expectedAudience: this.auth.expectedAudience ?? this.serviceId,
      issuer: this.auth.issuer ?? 'control-plane',
      jwks,
      ...(this.auth.now ? { now: typeof this.auth.now === 'function' ? this.auth.now() : this.auth.now } : {}),
    };
  }
}

async function resolveServiceJwks<TEnv extends Env>(
  context: Context<TEnv>,
  auth: ServicePlaneServiceAuthOptions<TEnv>,
): Promise<CapabilityJwksResolver> {
  if (auth.jwks) return typeof auth.jwks === 'function' ? auth.jwks(context) : auth.jwks;
  if (auth.controlPlaneBinding) return jwksFromServiceBinding(auth.controlPlaneBinding(context.env, context));
  throw new CapabilityAuthError('Service-Plane service auth requires jwks or controlPlaneBinding', 500);
}
