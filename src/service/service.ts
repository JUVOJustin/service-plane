import { type Context, type Env, Hono } from 'hono';
import {
  type CapabilityAuthVariables,
  type CapabilityJwksResolver,
  type FetchLike,
  SERVICE_DISCOVERY_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceDefinition,
  type ServiceDiscoveryDocument,
  type ServiceNamespaceDefinition,
} from '../shared/types.js';
import { capabilityAuth, jwksFromServiceBinding } from './capabilities.js';
import { defineService, mountDiscovery, serviceDiscoveryDocument } from './discovery.js';
import { type ServicePlaneLoggerOptions, servicePlaneLogger } from './logger.js';

export type ServicePlaneNamespace = Omit<ServiceNamespaceDefinition, 'prefix'> & {
  prefix?: string;
};

type ServicePlaneServiceEnv<TEnv extends Env> = TEnv &
  CapabilityAuthVariables & {
    Variables: {
      requestId?: string;
    };
  };

export type ServicePlaneServiceAuthOptions<TEnv extends Env> = {
  controlPlaneBinding?: (bindings: TEnv['Bindings'], context: Context<TEnv & CapabilityAuthVariables>) => FetchLike;
  expectedAudience?: string;
  issuer?: string;
  jwks?:
    | CapabilityJwksResolver
    | ((context: Context<TEnv & CapabilityAuthVariables>) => CapabilityJwksResolver | Promise<CapabilityJwksResolver>);
  now?: Date;
  skipPath?: (path: string) => boolean;
};

export type ServicePlaneServiceOptions<TEnv extends Env = Env> = Omit<ServiceDefinition, 'namespaces'> & {
  app?: Hono<TEnv & CapabilityAuthVariables>;
  auth?: false | ServicePlaneServiceAuthOptions<TEnv>;
  discoveryPath?: string;
  logging?: boolean | ServicePlaneLoggerOptions;
  namespaces: ServicePlaneNamespace[];
  requestIdHeaderName?: string;
  requireRouteScopes?: boolean;
};

// Provides the default service Worker wiring while keeping the underlying Hono app public.
export class ServicePlaneService<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneServiceEnv<TEnv>>;
  readonly definition: ServiceDefinition;
  readonly discovery: ServiceDiscoveryDocument;

  constructor(options: ServicePlaneServiceOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneServiceEnv<TEnv>>()) as Hono<ServicePlaneServiceEnv<TEnv>>;
    this.definition = defineService(
      {
        ...options,
        namespaces: options.namespaces.map((namespace) => ({ ...namespace, prefix: namespace.prefix ?? '/' })),
      },
      { requireRouteScopes: options.requireRouteScopes ?? true },
    );
    this.discovery = serviceDiscoveryDocument(this.definition);

    const requestIdHeaderName = options.requestIdHeaderName ?? SERVICE_PLANE_REQUEST_ID_HEADER;
    this.app.use('*', async (context, next) => {
      const requestId = context.req.header(requestIdHeaderName);
      if (requestId) context.set('requestId', requestId);
      await next();
    });

    if (options.logging !== false) {
      const loggerOptions = typeof options.logging === 'object' ? options.logging : {};
      this.app.use(
        '*',
        servicePlaneLogger(this.definition, {
          requestIdHeaderName,
          ...loggerOptions,
        }),
      );
    }

    mountDiscovery(this.app, this.definition, options.discoveryPath ?? SERVICE_DISCOVERY_PATH);

    if (options.auth !== false) {
      const auth = options.auth ?? {};
      this.app.use('*', async (context, next) => {
        const path = new URL(context.req.url).pathname;
        if ((auth.skipPath ?? defaultAuthSkipPath)(path)) {
          await next();
          return;
        }

        const jwks = await resolveServiceJwks(context as never, auth);
        const authMiddleware = capabilityAuth({
          expectedAudience: auth.expectedAudience ?? this.definition.id,
          issuer: auth.issuer ?? 'control-plane',
          jwks,
          ...(auth.now ? { now: auth.now } : {}),
        });
        return authMiddleware(context as never, next);
      });
    }

    for (const namespace of this.definition.namespaces) {
      this.app.route(namespace.prefix, namespace.app as Hono<ServicePlaneServiceEnv<TEnv>>);
    }
  }

  fetch: Hono<ServicePlaneServiceEnv<TEnv>>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);
}

function defaultAuthSkipPath(path: string): boolean {
  return path.startsWith('/.well-known/service-plane/');
}

async function resolveServiceJwks<TEnv extends Env>(
  context: Context<TEnv & CapabilityAuthVariables>,
  auth: ServicePlaneServiceAuthOptions<TEnv>,
): Promise<CapabilityJwksResolver> {
  if (auth.jwks) return typeof auth.jwks === 'function' ? auth.jwks(context) : auth.jwks;
  if (auth.controlPlaneBinding) return jwksFromServiceBinding(auth.controlPlaneBinding(context.env, context));
  throw new Error('Service-Plane service auth requires jwks or controlPlaneBinding');
}
