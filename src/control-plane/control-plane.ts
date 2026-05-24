import { newRpcResponse } from '@hono/capnweb';
import { type Context, type Env, Hono } from 'hono';
import { type RequestIdVariables, requestId } from 'hono/request-id';
import type { UpgradeWebSocket } from 'hono/ws';
import {
  type RegistryCache,
  SERVICE_PLANE_OPENAPI_PATH,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  SERVICE_PLANE_SWAGGER_PATH,
  type ServiceEndpoint,
  type ServiceGrant,
} from '../shared/types.js';
import { type BrokerCaller, createControlPlaneRpcBroker } from './broker.js';
import { type CapabilityIssuer, type MountCapabilityEndpointsOptions, mountCapabilityEndpoints } from './capabilities.js';
import { createControlPlaneMcpBroker, DEFAULT_MCP_PATH } from './mcp.js';
import {
  type ControlPlaneOpenApiOptions,
  controlPlaneOpenApiCacheKey,
  DEFAULT_OPENAPI_CACHE_TTL_SECONDS,
  generateControlPlaneOpenApi,
  swaggerUiHtml,
} from './openapi.js';
import { createServiceRegistry } from './registry.js';
import { type IssueCapabilityTokenForCallerInput, issueCapabilityTokenForCaller, type RpcIssuedCapabilityToken } from './rpc.js';
import { createCapabilityIssuerFromSigningSecret } from './signing-secret.js';

type ServicePlaneControlPlaneEnv<TEnv extends Env> = TEnv & {
  Variables: RequestIdVariables;
};

type ServicePlaneRequestIdOptions = NonNullable<Parameters<typeof requestId>[0]>;

export type ServicePlaneControlPlaneOptions<TEnv extends Env = Env> = {
  app?: Hono<TEnv>;
  authenticateCaller?: MountCapabilityEndpointsOptions['authenticateCaller'];
  broker?:
    | false
    | {
        cache?: RegistryCache;
        caller?: (context: Context<TEnv>) => BrokerCaller | Promise<BrokerCaller | undefined> | undefined;
        path?: string;
        upgradeWebSocket?: UpgradeWebSocket;
      };
  controlPlaneServiceId?: string;
  issuer?: string;
  keyId?: string;
  mcp?:
    | false
    | {
        cache?: RegistryCache;
        caller?: (context: Context<TEnv>) => BrokerCaller | Promise<BrokerCaller | undefined> | undefined;
        path?: string;
        upgradeWebSocket?: UpgradeWebSocket;
      };
  openapi?: false | ControlPlaneOpenApiOptions;
  requestId?: ServicePlaneRequestIdOptions;
  services: (context: Context<TEnv>) => ServiceEndpoint[] | Promise<ServiceEndpoint[]>;
  signingSecret: (bindings: TEnv['Bindings'], context: Context<TEnv>) => string | Promise<string>;
  ttlSeconds?: number;
};

// ServicePlaneControlPlane is now only STS/JWKS plus an optional Cap'n Web broker.
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

    if (options.openapi !== false) {
      this.mountOpenApi(options.openapi ?? {});
    }

    if (options.broker) {
      this.mountBroker(options.broker);
    }

    if (options.mcp !== false) {
      this.mountMcp(options.mcp ?? {});
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

  private mountBroker(brokerOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['broker'], false | undefined>): void {
    const path = brokerOptions.path ?? '/rpc/broker';
    this.app.all(path, async (context) => {
      const services = await this.options.services(context as Context<TEnv>);
      const issuer = await this.issuerFor(context as Context<TEnv>, services);
      const registry = createServiceRegistry({
        ...(brokerOptions.cache ? { cache: brokerOptions.cache } : {}),
        services,
      });
      const broker = createControlPlaneRpcBroker({
        controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
        issuer,
        registry,
      });
      const caller = await brokerOptions.caller?.(context as Context<TEnv>);
      return newRpcResponse(
        context,
        broker.rootCapability(caller),
        brokerOptions.upgradeWebSocket ? { upgradeWebSocket: brokerOptions.upgradeWebSocket } : undefined,
      );
    });
  }

  private mountMcp(mcpOptions: Exclude<ServicePlaneControlPlaneOptions<TEnv>['mcp'], false | undefined>): void {
    const path = mcpOptions.path ?? DEFAULT_MCP_PATH;
    this.app.all(path, async (context) => {
      const services = await this.options.services(context as Context<TEnv>);
      const issuer = await this.issuerFor(context as Context<TEnv>, services);
      const registry = createServiceRegistry({
        ...(mcpOptions.cache ? { cache: mcpOptions.cache } : {}),
        services,
      });
      const caller = await mcpOptions.caller?.(context as Context<TEnv>);
      const broker = createControlPlaneMcpBroker({
        ...(caller ? { caller } : {}),
        controlPlaneServiceId: this.options.controlPlaneServiceId ?? 'control-plane',
        issuer,
        registry,
      });
      return newRpcResponse(
        context,
        broker.rootCapability(),
        mcpOptions.upgradeWebSocket ? { upgradeWebSocket: mcpOptions.upgradeWebSocket } : undefined,
      );
    });
  }

  private mountOpenApi(openApiOptions: ControlPlaneOpenApiOptions): void {
    const path = openApiOptions.path ?? SERVICE_PLANE_OPENAPI_PATH;
    this.app.get(path, async (context) => {
      const services = await this.options.services(context as Context<TEnv>);
      const cacheKey = openApiOptions.cacheKey ?? controlPlaneOpenApiCacheKey(services, openApiOptions);
      const cached = await openApiOptions.cache?.get(cacheKey);
      if (cached) return context.json(cached);

      const snapshot = await createServiceRegistry({ services }).discover();
      const document = generateControlPlaneOpenApi({
        ...(openApiOptions.description ? { description: openApiOptions.description } : {}),
        ...(openApiOptions.servers ? { servers: openApiOptions.servers } : {}),
        snapshot,
        ...(openApiOptions.title ? { title: openApiOptions.title } : {}),
        ...(openApiOptions.version ? { version: openApiOptions.version } : {}),
      });
      await openApiOptions.cache?.set(cacheKey, document, openApiOptions.cacheTtlSeconds ?? DEFAULT_OPENAPI_CACHE_TTL_SECONDS);
      return context.json(document);
    });

    const swagger = openApiOptions.swagger;
    if (swagger !== false) {
      const swaggerPath = swagger?.path ?? SERVICE_PLANE_SWAGGER_PATH;
      this.app.get(swaggerPath, (context) => {
        const title = swagger?.title ?? openApiOptions.title;
        return context.html(swaggerUiHtml({ openApiPath: path, ...(title ? { title } : {}) }));
      });
    }
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
