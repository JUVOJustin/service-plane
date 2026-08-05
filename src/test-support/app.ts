import { newHttpBatchRpcSession } from 'capnweb';
import type { BrokerCaller } from '../control-plane/broker.js';
import { ServicePlaneControlPlane, type ServicePlaneControlPlaneOptions } from '../control-plane/control-plane.js';
import type { ControlPlaneOpenApiOptions } from '../control-plane/openapi.js';
import { type CapabilitySigningKey, generateCapabilitySigningSecret } from '../control-plane/signing-keys.js';
import { type AnyServiceAbilityDefinition, abilitySession, defineCapabilities, ServicePlaneService } from '../service/index.js';
import type { ServicePlaneLoggableEvent } from '../shared/logging.js';
import {
  type AbilityTransport,
  type CapabilityCatalog,
  type CapabilityJwks,
  type RegistryCache,
  SERVICE_DISCOVERY_PATH,
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
export const DEMO_SIGNING_KEY_ID = 'demo-key-1';

// The address of one specific replica, bypassing the load balancer. A test that needs "issued by A,
// verified against B" has to be able to name A and B.
export function demoReplicaOrigin(index: number): string {
  return `https://plane-${index}.internal`;
}

// A fresh signing key with a caller-chosen id, for composing rotation states by hand.
export async function demoSigningKey(kid: string): Promise<CapabilitySigningKey> {
  return { kid, secret: await generateCapabilitySigningSecret() };
}

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

// One replica's configuration. A real fleet is uniform, so every field defaults to the app-wide
// value; they exist so a test can build the fleet that is *not* uniform — divergent signing keys
// mid-rollout, or the local caches that must never become an authorization input.
export type DemoReplicaSpec = {
  issuer?: string;
  openapi?: ControlPlaneOpenApiOptions;
  // Backs every route that resolves the catalog on this replica: token issuance, broker and MCP.
  // Per replica by construction — an in-memory cache is exactly what each isolate or process gets
  // on its own, and passing one instance to several replicas is what a shared KV/Redis looks like.
  registryCache?: RegistryCache;
  signingKeys?: CapabilitySigningKey[];
};

export type DemoAppOptions = {
  brokerCaller?: BrokerCaller;
  callerServiceId?: string;
  // Mirrors a real service's JWKS cache. When set, services keep verifying against the snapshot
  // they last fetched until `refreshJwks()` — which is exactly what a rotation looks like from a
  // service whose cache has not expired yet.
  cacheJwks?: boolean;
  controlPlaneServiceId?: string;
  env?: DemoEnvironment;
  issuer?: string;
  log?: ServicePlaneControlPlaneOptions['log'];
  mcp?: { serverInfo?: { name?: string; version?: string } };
  // How many independent control-plane replicas serve this deployment. Each is its own
  // `ServicePlaneControlPlane` with its own caches and its own issuer object; they share only what
  // a real fleet shares through configuration. Pass an array to configure replicas individually.
  replicas?: number | DemoReplicaSpec[];
  services: DemoServiceSpec[];
  signingKeys?: CapabilitySigningKey[];
};

// Pipelined broker root. HTTP-batch allows one round trip, so the whole chain has to stay in a
// single expression: `app.brokerRoot<Api>().ability(...).connect([...]).method(...)`.
export type DemoBrokerRoot<TApi> = {
  ability(serviceId: string, abilityId: string): { connect(scopes: string[]): TApi };
};

// One control-plane replica, addressable on its own so a test can pin which replica serves a leg.
export type DemoReplica = {
  brokerRoot<TApi>(): DemoBrokerRoot<TApi>;
  index: number;
  jwks(): Promise<CapabilityJwks>;
  mcp(body: unknown, headers?: Record<string, string>): Promise<Response>;
  origin: string;
  plane: ServicePlaneControlPlane;
  // Rewrites this replica's signing keys the way a rolling restart hands one replica new
  // configuration. Takes effect on its next request; the other replicas are untouched.
  setSigningKeys(keys: CapabilitySigningKey[]): void;
  signingKeys(): CapabilitySigningKey[];
  token(input: { scopes: string[]; targetServiceId: string; ttlSeconds?: number }): Promise<Response>;
};

export type DemoApp = {
  brokerRoot<TApi>(): DemoBrokerRoot<TApi>;
  close(): void;
  // Discovery requests the services have answered since the last reset. Discovery is a fan-out —
  // one request per configured service — so this counts what a cache is there to avoid.
  discoveryFetches(): number;
  events: ServicePlaneLoggableEvent[];
  mcp(body: unknown, headers?: Record<string, string>): Promise<Response>;
  // Replica 0. Every single-replica test addresses the fleet through this.
  plane: ServicePlaneControlPlane;
  // Drops the services' cached JWKS, standing in for the cache TTL expiring. Only meaningful with
  // `cacheJwks`.
  refreshJwks(): void;
  replica(index: number): DemoReplica;
  replicas: DemoReplica[];
  // Chooses which replica the load-balanced plane origin serves. `'round-robin'` alternates, a
  // number pins. Everything reaching the fleet through `DEMO_PLANE_ORIGIN` follows this — including
  // the services' own JWKS fetches.
  route(next: number | 'round-robin'): void;
  // Takes one replica out of the fleet. The load balancer stops choosing it and its own origin
  // stops answering, which is what a session pinned to that replica sees when it disappears.
  setReplicaAvailable(index: number, available: boolean): void;
  // Redeploys one service in place: the plane rediscovers it on the next request, exactly as it
  // would after a real deploy. Everything not named is carried over from the running spec. Grants
  // are deliberately not reachable here — they are the plane's configuration, and a service that
  // could re-grant itself on deploy would make catalog drift impossible to express.
  redeploy(serviceId: string, changes: Partial<Omit<DemoServiceSpec, 'grants' | 'id'>>): void;
  service(serviceId: string): ServicePlaneService;
  session<TApi>(serviceId: string, abilityId: string, scopes: string[]): Promise<TApi>;
  // A direct session presenting an already-minted token instead of requesting a fresh one. Rotation
  // tests need to hold a token from before a rotation and replay it against the service's current
  // view of the JWKS, which a self-refreshing session can never express.
  sessionWith<TApi>(input: { abilityId: string; scopes: string[]; serviceId: string; token: string }): Promise<TApi>;
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
  const defaultSigningKeys = options.signingKeys ?? [await demoSigningKey(DEMO_SIGNING_KEY_ID)];
  const replicaSpecs: DemoReplicaSpec[] =
    typeof options.replicas === 'number' ? Array.from({ length: options.replicas }, () => ({})) : (options.replicas ?? [{}]);
  const events: ServicePlaneLoggableEvent[] = [];

  // Mutable per replica so a test can restart one replica onto new configuration without touching
  // the others — the state a rolling deploy is actually in for most of its duration.
  const replicaKeys = replicaSpecs.map((spec) => [...(spec.signingKeys ?? defaultSigningKeys)]);

  let planes: ServicePlaneControlPlane[] = [];
  let routed: number | 'round-robin' = 'round-robin';
  let nextReplica = 0;
  const availability = replicaSpecs.map(() => true);
  // The load balancer in front of the fleet. Round-robin over the healthy replicas by default, so a
  // multi-replica test that does not pin still crosses replicas rather than testing one by accident.
  const balanced = (): ServicePlaneControlPlane => {
    if (typeof routed === 'number') {
      const pinned = planes[routed];
      // A pinned replica is still a member of the fleet: taking it out has to be visible here, or a
      // test could "prove" a dead replica still serves.
      if (!pinned || !availability[routed]) throw new Error('No healthy demo control-plane replica');
      return pinned;
    }
    const healthy = planes.filter((_, index) => availability[index]);
    if (healthy.length === 0) throw new Error('No healthy demo control-plane replica');
    const chosen = healthy[nextReplica % healthy.length] as ServicePlaneControlPlane;
    nextReplica += 1;
    return chosen;
  };

  // Services verify against the plane's published JWKS, so the trust chain under test is the real
  // one rather than a key handed to both sides. The fetch goes through the balancer: which replica
  // answers a service's JWKS refresh is not something a real deployment controls either.
  let cachedJwks: Promise<CapabilityJwks> | undefined;
  const fetchJwks = async (): Promise<CapabilityJwks> => {
    if (planes.length === 0) throw new Error('Demo control plane is not initialized');
    const response = await balanced().fetch(new Request(`${DEMO_PLANE_ORIGIN}${SERVICE_PLANE_CAPABILITY_JWKS_PATH}`));
    return (await response.json()) as CapabilityJwks;
  };
  const jwks = async (): Promise<CapabilityJwks> => {
    if (!options.cacheJwks) return fetchJwks();
    cachedJwks ??= fetchJwks();
    return cachedJwks;
  };

  const deployments = new Map<string, Deployment>();
  // Counted at the service host so it reflects requests that actually reached a service, not what
  // the plane intended to ask for.
  const discoveryFetches = { count: 0 };
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
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === SERVICE_DISCOVERY_PATH) discoveryFetches.count += 1;
      return deployment.available ? deployment.service.fetch(request) : new Response('Service Unavailable', { status: 503 });
    },
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

  // Each replica is constructed independently and shares no issuer, registry, or OpenAPI cache with
  // its peers — the isolation the horizontal-scaling contract claims has to be real in the fixture
  // or the tests prove nothing.
  planes = replicaSpecs.map(
    (spec, index) =>
      new ServicePlaneControlPlane({
        // Caller authentication has dedicated coverage; an application test should not re-prove it
        // on every request. Override `authenticateCaller` through `plane` when that is the subject.
        authenticateCaller: () => callerServiceId,
        broker: {
          caller: () => options.brokerCaller ?? { id: 'gateway', kind: 'user' },
        },
        // Explicit either way: a fixture that silently cached discovery would make `redeploy()`
        // and grant changes land a TTL later, which is the opposite of what most tests are about.
        discoveryCache: spec.registryCache ?? false,
        issuer: spec.issuer ?? issuer,
        log: options.log ?? ((event) => events.push(event as ServicePlaneLoggableEvent)),
        mcp: {
          caller: () => options.brokerCaller ?? { id: 'gateway', kind: 'user' },
          ...(options.mcp?.serverInfo ? { serverInfo: options.mcp.serverInfo } : {}),
        },
        ...(spec.openapi ? { openapi: spec.openapi } : {}),
        services: () => endpoints(),
        signingKeys: () => replicaKeys[index] as CapabilitySigningKey[],
      }),
  );
  const boundPlane = planes[0] as ServicePlaneControlPlane;

  const planeRequest = (plane: ServicePlaneControlPlane, path: string, body?: unknown, headers?: Record<string, string>) =>
    plane.fetch(
      body === undefined
        ? new Request(`${DEMO_PLANE_ORIGIN}${path}`)
        : new Request(`${DEMO_PLANE_ORIGIN}${path}`, {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', ...headers },
            method: 'POST',
          }),
    );

  const replicas: DemoReplica[] = planes.map((plane, index) => ({
    brokerRoot<TApi>() {
      wire();
      return newHttpBatchRpcSession<Record<string, never>>(`${demoReplicaOrigin(index)}/rpc/broker`) as unknown as DemoBrokerRoot<TApi>;
    },
    index,
    async jwks() {
      return (await planeRequest(plane, SERVICE_PLANE_CAPABILITY_JWKS_PATH)).json() as Promise<CapabilityJwks>;
    },
    async mcp(body, headers) {
      return planeRequest(plane, SERVICE_PLANE_MCP_PATH, body, headers);
    },
    origin: demoReplicaOrigin(index),
    plane,
    setSigningKeys(keys) {
      replicaKeys[index] = [...keys];
    },
    signingKeys: () => [...(replicaKeys[index] as CapabilitySigningKey[])],
    async token(input) {
      return planeRequest(plane, SERVICE_PLANE_CAPABILITY_TOKEN_PATH, input);
    },
  }));

  // Installed on first use, not at construction: only the capnweb broker client and direct ability
  // sessions dial by URL, and an app that never does should leave global fetch alone.
  let restoreFetch: (() => void) | undefined;
  const wire = () => {
    restoreFetch ??= installFetchRouter(balanced, planes, availability, deployments, host);
  };
  const close = () => {
    restoreFetch?.();
    restoreFetch = undefined;
  };

  const token: DemoApp['token'] = async (input) => planeRequest(balanced(), SERVICE_PLANE_CAPABILITY_TOKEN_PATH, input);

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

    discoveryFetches: () => discoveryFetches.count,

    events,

    async mcp(body, headers) {
      return planeRequest(balanced(), SERVICE_PLANE_MCP_PATH, body, headers);
    },

    plane: boundPlane,

    refreshJwks() {
      cachedJwks = undefined;
    },

    replica(index) {
      const found = replicas[index];
      if (!found) throw new Error(`Unknown demo replica: ${index}`);
      return found;
    },

    replicas,

    route(next) {
      // Rejected at the call site rather than on the next request, so a typo reads as a bad index
      // instead of an undefined plane failing somewhere inside a session.
      if (typeof next === 'number' && !replicas[next]) throw new Error(`Unknown demo replica: ${next}`);
      routed = next;
      nextReplica = 0;
    },

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

    async sessionWith<TApi>(input: { abilityId: string; scopes: string[]; serviceId: string; token: string }) {
      wire();
      const target = deployment(input.serviceId);
      return abilitySession<TApi>({
        abilityId: input.abilityId,
        callerServiceId,
        // Far enough out that the session never decides to refresh: the point is to present this
        // exact token, whatever the plane would hand out now.
        requestToken: async () => ({ expiresAt: new Date(Date.now() + 3_600_000), token: input.token }),
        scopes: input.scopes,
        targetServiceId: input.serviceId,
        transport: env.callerTransport({ abilityId: input.abilityId, origin: target.origin, service: host(target) }),
      });
    },

    setAvailable(serviceId, available) {
      deployment(serviceId).available = available;
    },

    setReplicaAvailable(index, available) {
      if (!replicas[index]) throw new Error(`Unknown demo replica: ${index}`);
      availability[index] = available;
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
  balanced: () => ServicePlaneControlPlane,
  planes: ServicePlaneControlPlane[],
  availability: boolean[],
  deployments: Map<string, Deployment>,
  host: (deployment: Deployment) => { fetch(request: Request): Promise<Response> },
): () => void {
  const previous = globalThis.fetch;
  const replicaHosts = new Map(planes.map((plane, index) => [new URL(demoReplicaOrigin(index)).hostname, { index, plane }]));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const hostname = new URL(request.url).hostname;
    // The shared origin is the load balancer; a replica origin bypasses it and pins the replica.
    if (hostname === new URL(DEMO_PLANE_ORIGIN).hostname) return balanced().fetch(request);
    const replica = replicaHosts.get(hostname);
    if (replica) {
      return availability[replica.index] ? replica.plane.fetch(request) : new Response('Service Unavailable', { status: 503 });
    }
    const target = [...deployments.values()].find((candidate) => new URL(candidate.origin).hostname === hostname);
    if (!target) throw new Error(`No demo host for ${request.url}`);
    return host(target).fetch(request);
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = previous;
  };
}
