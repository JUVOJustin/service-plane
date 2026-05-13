import { type Context, type Env, Hono } from 'hono';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import { type RegistryCache, SERVICE_PLANE_REQUEST_ID_HEADER, type ServiceEndpoint, type ServiceGrant } from '../shared/types.js';
import { type CapabilityIssuer, type MountCapabilityEndpointsOptions, mountCapabilityEndpoints } from './capabilities.js';
import { type ControlPlaneProxyOptions, createControlPlaneProxy } from './proxy.js';
import { createServiceRegistry } from './registry.js';
import { type IssueCapabilityTokenForCallerInput, issueCapabilityTokenForCaller, type RpcIssuedCapabilityToken } from './rpc.js';
import { createCapabilityIssuerFromSigningSecret } from './signing-secret.js';

type ServicePlaneControlPlaneEnv<TEnv extends Env> = TEnv & {
  Variables: RequestIdVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;
type RegistryCacheKeyResolver<TEnv extends Env> =
  | string
  | ((context: Context<TEnv>, services: ServiceEndpoint[]) => Promise<string> | string);

export type ServicePlaneControlPlaneOptions<TEnv extends Env = Env> = {
  app?: Hono<TEnv>;
  authenticateCaller?: MountCapabilityEndpointsOptions['authenticateCaller'];
  issuer?: string;
  keyId?: string;
  proxy?:
    | false
    | (Omit<ControlPlaneProxyOptions, 'capabilityToken' | 'registry'> & {
        cache?: RegistryCache;
        cacheKey?: RegistryCacheKeyResolver<TEnv>;
      });
  requestId?: ServicePlaneRequestIdOptions;
  services: (context: Context<TEnv>) => ServiceEndpoint[] | Promise<ServiceEndpoint[]>;
  signingSecret: (bindings: TEnv['Bindings'], context: Context<TEnv>) => string | Promise<string>;
  ttlSeconds?: number;
};

// Provides the default control-plane wiring: STS endpoints, registry discovery, and public/auth proxying.
export class ServicePlaneControlPlane<TEnv extends Env = Env> {
  readonly app: Hono<ServicePlaneControlPlaneEnv<TEnv>>;
  private readonly issuers = new Map<string, Promise<CapabilityIssuer>>();

  constructor(private readonly options: ServicePlaneControlPlaneOptions<TEnv>) {
    this.app = (options.app ?? new Hono<ServicePlaneControlPlaneEnv<TEnv>>()) as Hono<ServicePlaneControlPlaneEnv<TEnv>>;

    this.app.use(
      '*',
      requestId({
        headerName: SERVICE_PLANE_REQUEST_ID_HEADER,
        ...options.requestId,
      }),
    );

    mountCapabilityEndpoints(this.app, (context) => this.issuerFor(context as Context<TEnv>), {
      authenticateCaller: options.authenticateCaller ?? missingAuthenticateCaller,
    });

    if (options.proxy !== false) {
      const proxyOptions = options.proxy ?? {};
      this.app.use('*', async (context, next) => {
        const services = await options.services(context as Context<TEnv>);
        const registry = createServiceRegistry({
          ...(proxyOptions.cache
            ? {
                cache: proxyOptions.cache,
                cacheKey: await resolveRegistryCacheKey(proxyOptions.cacheKey, context as Context<TEnv>, services),
              }
            : {}),
          services,
        });
        const { cache: _cache, cacheKey: _cacheKey, ...controlPlaneProxyOptions } = proxyOptions;
        return createControlPlaneProxy({
          ...controlPlaneProxyOptions,
          capabilityToken: async (_capabilityContext, route) => {
            const issuer = await this.issuerFor(context as Context<TEnv>, services);
            const issued = await issuer.issueCapabilityToken({
              callerServiceId: 'control-plane',
              scopes: route.requiredScopes ?? [],
              targetServiceId: route.serviceId,
            });
            return issued.token;
          },
          requestIdHeaderName: options.requestId?.headerName ?? SERVICE_PLANE_REQUEST_ID_HEADER,
          registry,
        })(context, next);
      });
    }
  }

  fetch: Hono<ServicePlaneControlPlaneEnv<TEnv>>['fetch'] = (request, env, executionCtx) => this.app.fetch(request, env, executionCtx);

  async issueCapabilityTokenForCaller(
    callerServiceId: string,
    input: IssueCapabilityTokenForCallerInput,
    bindings: TEnv['Bindings'],
  ): Promise<RpcIssuedCapabilityToken> {
    const context = { env: bindings } as Context<TEnv>;
    return issueCapabilityTokenForCaller(await this.issuerFor(context), callerServiceId, input);
  }

  private async issuerFor(context: Context<TEnv>, services?: ServiceEndpoint[]): Promise<CapabilityIssuer> {
    const signingSecret = await this.options.signingSecret(context.env, context);
    const resolvedServices = services ?? (await this.options.services(context));
    const capabilities = await discoverServiceCapabilities(resolvedServices);
    const grantDefinition = {
      grants: serviceGrantsFromEndpoints(resolvedServices),
    };
    const cacheKey = JSON.stringify({
      capabilities,
      grants: grantDefinition.grants,
      issuer: this.options.issuer ?? 'control-plane',
      keyId: this.options.keyId ?? 'default',
      signingSecret,
      ttlSeconds: this.options.ttlSeconds ?? null,
    });
    const existing = this.issuers.get(cacheKey);
    if (existing) return existing;

    const issuer = createCapabilityIssuerFromSigningSecret({
      capabilities,
      grants: grantDefinition,
      signingSecret,
      ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
      ...(this.options.keyId ? { keyId: this.options.keyId } : {}),
      ...(this.options.ttlSeconds ? { ttlSeconds: this.options.ttlSeconds } : {}),
    });
    this.issuers.set(cacheKey, issuer);
    return issuer;
  }
}

function missingAuthenticateCaller(context: Context): Response {
  const requestId = requestIdFromContext(context) ?? context.req.header(SERVICE_PLANE_REQUEST_ID_HEADER) ?? undefined;
  console.error(
    JSON.stringify({
      event: 'service_plane.caller_auth.not_configured',
      level: 'error',
      message: 'Service-Plane caller authentication is not configured',
      path: new URL(context.req.url).pathname,
      ...(requestId ? { requestId } : {}),
    }),
  );
  return context.json({ error: 'Service-Plane caller authentication is not configured' }, 500);
}

function requestIdFromContext(context: Context): string | undefined {
  const value = context.get('requestId' as never) as unknown;
  return typeof value === 'string' ? value : undefined;
}

async function resolveRegistryCacheKey<TEnv extends Env>(
  resolver: RegistryCacheKeyResolver<TEnv> | undefined,
  context: Context<TEnv>,
  services: ServiceEndpoint[],
): Promise<string> {
  if (typeof resolver === 'function') return resolver(context, services);
  if (typeof resolver === 'string') return resolver;
  return `service-plane:registry:${JSON.stringify(services.map(registryCacheKeyServicePart))}`;
}

function registryCacheKeyServicePart(service: ServiceEndpoint): unknown {
  return {
    discovery: typeof service.discovery === 'function' ? '[dynamic]' : (service.discovery ?? null),
    grants: service.grants ?? [],
    id: service.id,
    origin: service.origin,
  };
}

async function discoverServiceCapabilities(services: ServiceEndpoint[]) {
  const registry = createServiceRegistry({ services });
  const snapshot = await registry.discover();
  return snapshot.services.flatMap((service) => (service.capabilities ? [service.capabilities] : []));
}

function serviceGrantsFromEndpoints(services: ServiceEndpoint[]): ServiceGrant[] {
  return services.flatMap((service) =>
    (service.grants ?? []).map((grant) => ({
      ...grant,
      target: grant.target ?? service.id,
    })),
  );
}
