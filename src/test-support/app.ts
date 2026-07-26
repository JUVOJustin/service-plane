import { newHttpBatchRpcSession } from 'capnweb';
import type { BrokerCaller } from '../control-plane/broker.js';
import { ServicePlaneControlPlane, type ServicePlaneControlPlaneOptions } from '../control-plane/control-plane.js';
import { generateCapabilitySigningSecret } from '../control-plane/signing-secret.js';
import { type AnyServiceAbilityDefinition, abilitySession, defineCapabilities, ServicePlaneService } from '../service/index.js';
import type { ServicePlaneLoggableEvent } from '../shared/logging.js';
import {
  type AbilityTransport,
  type CapabilityCatalog,
  type CapabilityJwks,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  SERVICE_PLANE_MCP_PATH,
  type ServiceEndpoint,
  type ServiceEndpointGrant,
} from '../shared/types.js';
import { type DemoEnvironment, type DemoServiceHost, httpBatchEnv } from './env.js';

export const DEMO_PLANE_ORIGIN = 'https://plane.internal';
export const DEMO_PLANE_ISSUER = 'https://plane.internal';
export const DEMO_CALLER_ID = 'workflow-runner';
export const DEMO_CONTROL_PLANE_ID = 'control-plane';

// A service as a deployment, not a constructor call: abilities are a factory over the environment's
// transports so one spec runs anywhere, and every field a real deploy can change (version, scopes,
// ingress) is data the test can hand back to `redeploy`.
export type DemoServiceSpec = {
  abilities: (input: { transports: AbilityTransport[] }) => AnyServiceAbilityDefinition[];
  grants?: ServiceEndpointGrant[];
  id: string;
  ingress?: boolean;
  origin?: string;
  scopes: string[];
  title?: string;
  version?: string;
};

export type DemoAppOptions = {
  brokerCaller?: BrokerCaller;
  callerServiceId?: string;
  controlPlaneServiceId?: string;
  env?: DemoEnvironment;
  issuer?: string;
  log?: ServicePlaneControlPlaneOptions['log'];
  mcp?: { serverInfo?: { name?: string; version?: string } };
  services: DemoServiceSpec[];
};

// Pipelined broker root. HTTP-batch allows one round trip, so the whole chain has to stay in a
// single expression: `app.brokerRoot<Api>().ability(...).connect([...]).method(...)`.
export type DemoBrokerRoot<TApi> = {
  ability(serviceId: string, abilityId: string): { connect(scopes: string[]): TApi };
};

export type DemoApp = {
  brokerRoot<TApi>(): DemoBrokerRoot<TApi>;
  close(): void;
  events: ServicePlaneLoggableEvent[];
  mcp(body: unknown, headers?: Record<string, string>): Promise<Response>;
  plane: ServicePlaneControlPlane;
  // Redeploys one service in place: the plane rediscovers it on the next request, exactly as it
  // would after a real deploy. Everything not named is carried over from the running spec. Grants
  // are deliberately not reachable here — they are the plane's configuration, and a service that
  // could re-grant itself on deploy would make catalog drift impossible to express.
  redeploy(serviceId: string, changes: Partial<Omit<DemoServiceSpec, 'grants' | 'id'>>): void;
  service(serviceId: string): ServicePlaneService;
  session<TApi>(serviceId: string, abilityId: string, scopes: string[]): Promise<TApi>;
  setAvailable(serviceId: string, available: boolean): void;
  setGrants(serviceId: string, grants: ServiceEndpointGrant[]): void;
  token(input: { scopes: string[]; targetServiceId: string; ttlSeconds?: number }): Promise<Response>;
  [Symbol.dispose](): void;
};

export type DemoServiceOptions = {
  callerServiceId?: string;
  controlPlaneServiceId?: string;
  env?: DemoEnvironment;
  // Interposes between the endpoint and the service — availability, request tampering, call
  // counting. Defaults to the service itself.
  host?: (service: ServicePlaneService) => DemoServiceHost;
  issuer?: string;
  jwks: CapabilityJwks | (() => Promise<CapabilityJwks>);
  now?: () => Date;
  spec: DemoServiceSpec;
};

export type DemoService = {
  capabilities: CapabilityCatalog;
  endpoint: ServiceEndpoint;
  service: ServicePlaneService;
};

type Deployment = {
  available: boolean;
  // Held apart from the spec on purpose: grants are plane configuration and outlive any number of
  // service deploys. Only `setGrants` moves them.
  grants: ServiceEndpointGrant[];
  origin: string;
  service: ServicePlaneService;
  spec: DemoServiceSpec;
};

export async function demoApp(options: DemoAppOptions): Promise<DemoApp> {
  const env = options.env ?? httpBatchEnv();
  const callerServiceId = options.callerServiceId ?? DEMO_CALLER_ID;
  const controlPlaneServiceId = options.controlPlaneServiceId ?? DEMO_CONTROL_PLANE_ID;
  const issuer = options.issuer ?? DEMO_PLANE_ISSUER;
  const signingSecret = await generateCapabilitySigningSecret();
  const events: ServicePlaneLoggableEvent[] = [];

  let plane: ServicePlaneControlPlane | undefined;
  // Services verify against the plane's published JWKS, so the trust chain under test is the real
  // one rather than a key handed to both sides.
  const jwks = async (): Promise<CapabilityJwks> => {
    if (!plane) throw new Error('Demo control plane is not initialized');
    const response = await plane.fetch(new Request(`${DEMO_PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    return (await response.json()) as CapabilityJwks;
  };

  const deployments = new Map<string, Deployment>();
  const deploy = (spec: DemoServiceSpec, carried?: Pick<Deployment, 'available' | 'grants'>) => {
    deployments.set(spec.id, {
      available: carried?.available ?? true,
      grants: carried?.grants ?? spec.grants ?? defaultGrants(spec, callerServiceId, controlPlaneServiceId),
      origin: spec.origin ?? `https://${spec.id}.internal`,
      service: demoService({ callerServiceId, controlPlaneServiceId, env, issuer, jwks, spec }).service,
      spec,
    });
  };
  for (const spec of options.services) deploy(spec);

  const host = (deployment: Deployment) => ({
    connectAbility: (input: Parameters<ServicePlaneService['connectAbility']>[0]) => {
      if (!deployment.available) throw new Error(`Service is unavailable: ${deployment.spec.id}`);
      return deployment.service.connectAbility(input);
    },
    fetch: async (request: Request) =>
      deployment.available ? deployment.service.fetch(request) : new Response('Service Unavailable', { status: 503 }),
  });

  const endpoints = (): ServiceEndpoint[] =>
    [...deployments.values()].map((deployment) =>
      env.endpoint({
        grants: deployment.grants,
        id: deployment.spec.id,
        origin: deployment.origin,
        service: host(deployment),
      }),
    );

  plane = new ServicePlaneControlPlane({
    // Caller authentication has dedicated coverage; an application test should not re-prove it on
    // every request. Override `authenticateCaller` through `plane` when that is the subject.
    authenticateCaller: () => callerServiceId,
    broker: { caller: () => options.brokerCaller ?? { id: 'gateway', kind: 'user' } },
    issuer,
    log: options.log ?? ((event) => events.push(event as ServicePlaneLoggableEvent)),
    mcp: {
      caller: () => options.brokerCaller ?? { id: 'gateway', kind: 'user' },
      ...(options.mcp?.serverInfo ? { serverInfo: options.mcp.serverInfo } : {}),
    },
    services: () => endpoints(),
    signingSecret: () => signingSecret,
  });
  const boundPlane = plane;

  // Installed on first use, not at construction: only the capnweb broker client and direct ability
  // sessions dial by URL, and an app that never does should leave global fetch alone.
  let restoreFetch: (() => void) | undefined;
  const wire = () => {
    restoreFetch ??= installFetchRouter(boundPlane, deployments, host);
  };
  const close = () => {
    restoreFetch?.();
    restoreFetch = undefined;
  };

  const token: DemoApp['token'] = async (input) =>
    boundPlane.fetch(
      new Request(`${DEMO_PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_TOKEN_PATH}`, {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );

  const deployment = (serviceId: string): Deployment => {
    const found = deployments.get(serviceId);
    if (!found) throw new Error(`Unknown demo service: ${serviceId}`);
    return found;
  };

  return {
    brokerRoot<TApi>() {
      wire();
      return newHttpBatchRpcSession<Record<string, never>>(`${DEMO_PLANE_ORIGIN}/rpc/broker`) as unknown as DemoBrokerRoot<TApi>;
    },

    close,

    events,

    async mcp(body, headers) {
      return boundPlane.fetch(
        new Request(`${DEMO_PLANE_ORIGIN}${SERVICE_PLANE_MCP_PATH}`, {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...headers },
          method: 'POST',
        }),
      );
    },

    plane: boundPlane,

    redeploy(serviceId, changes) {
      const current = deployment(serviceId);
      // `id` is pinned to the argument, not taken from `changes`: TypeScript skips excess-property
      // checks on spreads, so a spread-in spec carrying a different id would otherwise register a
      // second deployment while the named one kept running its old service.
      deploy({ ...current.spec, ...changes, id: serviceId }, { available: current.available, grants: current.grants });
    },

    service: (serviceId) => deployment(serviceId).service,

    async session<TApi>(serviceId: string, abilityId: string, scopes: string[]) {
      wire();
      const target = deployment(serviceId);
      return abilitySession<TApi>({
        abilityId,
        callerServiceId,
        requestToken: async (input) => {
          const response = await token(input);
          const body = (await response.json()) as { error?: string; expiresAt: string; token: string };
          if (!response.ok) throw new Error(body.error ?? `Token request failed: ${response.status}`);
          return { expiresAt: new Date(body.expiresAt), token: body.token };
        },
        scopes,
        targetServiceId: serviceId,
        transport: env.callerTransport({ abilityId, origin: target.origin, service: host(target) }),
      });
    },

    setAvailable(serviceId, available) {
      deployment(serviceId).available = available;
    },

    setGrants(serviceId, grants) {
      deployment(serviceId).grants = grants;
    },

    [Symbol.dispose]: close,

    token,
  };
}

// One service and the endpoint that reaches it, without a plane. For tests whose subject is a
// lower-level primitive — the broker, an MCP handler, a hand-built issuer — that still want the
// environment presets and a real service rather than a hand-assembled discovery document.
export function demoService(options: DemoServiceOptions): DemoService {
  const env = options.env ?? httpBatchEnv();
  const capabilities = defineCapabilities({ scopes: options.spec.scopes.map((id) => ({ id })), serviceId: options.spec.id });
  const controlPlaneServiceId = options.controlPlaneServiceId ?? DEMO_CONTROL_PLANE_ID;
  const service = new ServicePlaneService({
    abilities: options.spec.abilities({ transports: env.transports }),
    auth: {
      issuer: options.issuer ?? DEMO_PLANE_ISSUER,
      jwks: options.jwks,
      ...(options.now ? { now: options.now } : {}),
    },
    capabilities,
    id: options.spec.id,
    ...(options.spec.ingress ? { ingress: { brokerServiceIds: [controlPlaneServiceId] } } : {}),
    ...(env.upgradeWebSocket ? { rpc: { upgradeWebSocket: env.upgradeWebSocket } } : {}),
    title: options.spec.title ?? options.spec.id,
    version: options.spec.version ?? '1.0.0',
  });

  return {
    capabilities,
    endpoint: env.endpoint({
      grants: options.spec.grants ?? defaultGrants(options.spec, options.callerServiceId ?? DEMO_CALLER_ID, controlPlaneServiceId),
      id: options.spec.id,
      origin: options.spec.origin ?? `https://${options.spec.id}.internal`,
      service: options.host?.(service) ?? serviceHost(service),
    }),
    service,
  };
}

// `ServicePlaneService.fetch` is sync-or-async by signature; endpoints want a plain promise.
export function serviceHost(service: ServicePlaneService): DemoServiceHost {
  return {
    connectAbility: (input) => service.connectAbility(input),
    fetch: async (request) => service.fetch(request),
  };
}

// Both the plane and every service are the caller's grant surface: the control plane brokers, and
// the configured caller requests tokens directly.
function defaultGrants(spec: DemoServiceSpec, callerServiceId: string, controlPlaneServiceId: string): ServiceEndpointGrant[] {
  return [
    { caller: callerServiceId, scopes: spec.scopes },
    { caller: controlPlaneServiceId, scopes: spec.scopes },
  ];
}

// capnweb's HTTP-batch client and the direct ability session both dial through global fetch, so the
// in-memory hosts have to be reachable by URL for those legs to be real. Restored on close.
function installFetchRouter(
  plane: ServicePlaneControlPlane,
  deployments: Map<string, Deployment>,
  host: (deployment: Deployment) => { fetch(request: Request): Promise<Response> },
): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const hostname = new URL(request.url).hostname;
    if (hostname === new URL(DEMO_PLANE_ORIGIN).hostname) return plane.fetch(request);
    const target = [...deployments.values()].find((candidate) => new URL(candidate.origin).hostname === hostname);
    if (!target) throw new Error(`No demo host for ${request.url}`);
    return host(target).fetch(request);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = previous;
  };
}
