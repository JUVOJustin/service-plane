import { readBoundedResponseJson, validateBodyByteLimit } from '../shared/body-limit.js';
import { isAbilityAccess, isAbilityExposure, isAbilityTransport, isRecord, isServiceHttpMethod } from '../shared/guards.js';
import { jsonSchemaRootProperties } from '../shared/json-schema.js';
import { hasOnlySimpleTemplateExpressions, isOriginRelativePath, normalizePath, pathTemplateVariables } from '../shared/paths.js';
import {
  type CapabilityCatalog,
  type CapabilityScopeDefinition,
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  type DiscoveredServiceAbility,
  type RegistryCache,
  SERVICE_DISCOVERY_PATH,
  type ServiceAbilityDiscovery,
  type ServiceAbilityMethodDiscovery,
  type ServiceDiscoveryDocument,
  type ServiceDiscoverySnapshot,
  type ServiceEndpoint,
  type ServiceRegistry,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import { runBestEffortCacheOperation } from './best-effort-cache.js';
import { serviceDiscoveryRequest } from './endpoints.js';

/** Default maximum response size for one service discovery document: 1 MiB. */
export const DEFAULT_SERVICE_DISCOVERY_RESPONSE_MAX_BYTES = 1_048_576;

// Coalescing is a stampede guard, not ownership of the underlying network operation. A fill that
// never settles must eventually stop being handed to healthy follow-up requests.
const DEFAULT_IN_FLIGHT_DISCOVERY_MAX_AGE_MS = 10_000;
const IN_FLIGHT_DISCOVERY_RELEASE_SKEW_MS = 10;

export type CreateServiceRegistryOptions = {
  cache?: RegistryCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  discoveryPath?: string;
  /** Maximum accepted response size for one remote discovery document. Defaults to 1 MiB. */
  maxResponseBytes?: number;
  /** Control-plane paths that published REST projections must not shadow; a trailing `/*` reserves descendants. */
  reservedRestPaths?: string[];
  services: ServiceEndpoint[];
};

export function createServiceRegistry(options: CreateServiceRegistryOptions): ServiceRegistry {
  return createRequestServiceRegistry(options);
}

/** Builds a request-owned registry whose caller deadline can release a shared stuck fill. */
export function createRequestServiceRegistry(options: CreateServiceRegistryOptions, deadlineAt?: number): ServiceRegistry {
  const discoveryPath = options.discoveryPath ?? SERVICE_DISCOVERY_PATH;
  const reservedRestPaths = normalizedReservedRestPaths(options.reservedRestPaths);
  const maxResponseBytes = validateBodyByteLimit(
    options.maxResponseBytes ?? DEFAULT_SERVICE_DISCOVERY_RESPONSE_MAX_BYTES,
    'Service-Plane discovery maxResponseBytes must be a positive safe integer',
  );
  const cacheKey = options.cacheKey ?? serviceRegistryCacheKey(options.services, discoveryPath, reservedRestPaths, maxResponseBytes);
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
  const cache = options.cache;
  const endpointsById = new Map(options.services.map((endpoint) => [endpoint.id, endpoint] as const));

  return {
    async abilities() {
      return (await this.discover()).abilities;
    },

    async ability(serviceId: string, abilityId: string) {
      const snapshot = await this.discover();
      return snapshot.abilities.find((candidate) => candidate.serviceId === serviceId && candidate.id === abilityId);
    },

    async discover() {
      const cached = await runBestEffortCacheOperation(cache ? () => cache.get(cacheKey) : undefined);
      if (cached) return withAbilities(cached, endpointsById);

      // Coalesced per cache key: without this, every request that arrives before the first one
      // finishes writing observes the same miss and fans out independently, so a cold start or a
      // TTL boundary costs services × concurrent requests rather than one fan-out. That is the load
      // this cache exists to prevent, at exactly the moment it is highest. The fetched documents are
      // a function of the services and the discovery path — which is what the key covers — so
      // sharing one resolution between callers is sound even when their caches differ; each still
      // writes its own entry below.
      const { complete, etags, services } = await coalescedDiscovery(cache, cacheKey, deadlineAt, async () => {
        const getStale = cache?.getStale?.bind(cache);
        const stale = await runBestEffortCacheOperation(getStale ? () => getStale(cacheKey) : undefined);
        return discoverServices(options.services, discoveryPath, reservedRestPaths, maxResponseBytes, stale);
      });
      const snapshot: ServiceDiscoverySnapshot = {
        discoveredAt: new Date().toISOString(),
        ...(Object.keys(etags).length > 0 ? { etags } : {}),
        services,
      };
      // Caching an incomplete snapshot would turn a brief outage into a catalog gap for the full
      // TTL, so the next request retries instead. Issue #28 tracks the remaining removal condition:
      // expose degraded state and bound repeated fan-out when an endpoint fails permanently.
      if (complete) {
        await runBestEffortCacheOperation(cache ? () => cache.set(cacheKey, snapshot, cacheTtlSeconds) : undefined);
      }
      return withAbilities(snapshot, endpointsById);
    },

    endpoint(id) {
      return endpointsById.get(id);
    },
  };
}

export function serviceRegistryCacheKey(
  services: ServiceEndpoint[],
  discoveryPath = SERVICE_DISCOVERY_PATH,
  reservedRestPaths: string[] = [],
  maxResponseBytes = DEFAULT_SERVICE_DISCOVERY_RESPONSE_MAX_BYTES,
): string {
  return JSON.stringify({
    discoveryPath,
    namespace: 'service-plane:registry:v5',
    maxResponseBytes,
    reservedRestPaths: normalizedReservedRestPaths(reservedRestPaths),
    services: sortedServiceIdentities(services),
  });
}

/** The cache identity of a service set: ids and origins, ordered so equal sets key equally. */
export function sortedServiceIdentities(
  services: Array<Pick<ServiceEndpoint, 'id' | 'origin'>>,
): Array<Pick<ServiceEndpoint, 'id' | 'origin'>> {
  return services
    .map((service) => ({ id: service.id, origin: service.origin }))
    .sort((left, right) => `${left.id}\u0000${left.origin}`.localeCompare(`${right.id}\u0000${right.origin}`));
}

type DiscoveredDocument = {
  document: ServiceDiscoveryDocument;
  endpointId: string;
  etag?: string;
};

type DiscoveryResult = { complete: boolean; etags: Record<string, string>; services: ServiceDiscoveryDocument[] };

const NO_RESERVED_REST_PATHS = new Set<string>();

// Scoped per cache instance, never module-wide: two planes in one process can share endpoint ids
// and origins (the default origin is derived from the id) while resolving genuinely different
// catalogs behind them, and a global map would hand the second plane the first one's result — and
// write it into the second plane's cache, bypassing exactly the isolation separate caches exist
// for. Sharing a fill is only sound between callers that already share the entry it fills, and the
// cache instance is what defines that group. Entries only ever hold a resolution that is still
// running — dropped as soon as it settles — so this is a stampede guard, not a second cache.
type InFlightDiscovery = {
  pending: Promise<DiscoveryResult>;
  releaseAt: number;
  timer: ReturnType<typeof setTimeout>;
};

const inFlightDiscovery = new WeakMap<RegistryCache, Map<string, InFlightDiscovery>>();

function coalescedDiscovery(
  cache: RegistryCache | undefined,
  cacheKey: string,
  deadlineAt: number | undefined,
  discover: () => Promise<DiscoveryResult>,
): Promise<DiscoveryResult> {
  // No cache, no coalescing: without an instance there is nothing safe to group callers by, and a
  // plane configured with `discoveryCache: false` has chosen freshness over shared work anyway.
  if (!cache) return discover();

  let inFlight = inFlightDiscovery.get(cache);
  if (!inFlight) {
    inFlight = new Map();
    inFlightDiscovery.set(cache, inFlight);
  }
  const running = inFlight.get(cacheKey);
  if (running) {
    if (running.releaseAt > Date.now()) return running.pending;
    clearTimeout(running.timer);
    inFlight.delete(cacheKey);
  }

  const pending = discover();
  const fill = discoveryFill(inFlight, cacheKey, pending, deadlineAt);
  inFlight.set(cacheKey, fill);
  const settle = () => {
    clearTimeout(fill.timer);
    if (inFlight.get(cacheKey) === fill) inFlight.delete(cacheKey);
  };
  // Both handlers, so a rejection clears the entry without becoming an unhandled rejection here —
  // the callers awaiting `pending` are the ones that see it.
  pending.then(settle, settle);
  return pending;
}

function discoveryFill(
  inFlight: Map<string, InFlightDiscovery>,
  cacheKey: string,
  pending: Promise<DiscoveryResult>,
  deadlineAt: number | undefined,
): InFlightDiscovery {
  const releaseAt = discoveryReleaseAt(deadlineAt);
  let fill: InFlightDiscovery;
  const timer = setTimeout(
    () => {
      if (inFlight.get(cacheKey) === fill) inFlight.delete(cacheKey);
    },
    Math.max(0, releaseAt - Date.now()),
  );
  fill = { pending, releaseAt, timer };
  return fill;
}

function discoveryReleaseAt(deadlineAt: number | undefined): number {
  const maxAgeDeadline = Date.now() + DEFAULT_IN_FLIGHT_DISCOVERY_MAX_AGE_MS;
  // Release just before the waiting request's own timer. Deleting the map entry does not interrupt
  // that request; it only guarantees a follow-up cannot inherit the stuck fill after seeing 504.
  const callerDeadline =
    deadlineAt === undefined || !Number.isFinite(deadlineAt) ? maxAgeDeadline : deadlineAt - IN_FLIGHT_DISCOVERY_RELEASE_SKEW_MS;
  return Math.min(callerDeadline, maxAgeDeadline);
}

async function discoverServices(
  endpoints: ServiceEndpoint[],
  discoveryPath: string,
  reservedRestPaths: string[],
  maxResponseBytes: number,
  previous?: ServiceDiscoverySnapshot,
): Promise<DiscoveryResult> {
  const reservedRestPathSet = new Set(reservedRestPaths);
  const previousServices = new Map(previous?.services.map((service) => [service.id, service]));
  const discovered = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        if (endpoint.discovery) {
          const discovery = typeof endpoint.discovery === 'function' ? await endpoint.discovery() : endpoint.discovery;
          return isDiscoveryForEndpoint(discovery, endpoint, reservedRestPathSet)
            ? { document: discovery, endpointId: endpoint.id }
            : undefined;
        }

        const request = serviceDiscoveryRequest(endpoint, discoveryPath);
        const previousEtag = previous?.etags?.[endpoint.id];
        if (previousEtag) request.headers.set('if-none-match', previousEtag);

        const response = await endpoint.fetch(request);
        if (response.status === 304) {
          const document = previousServices.get(endpoint.id);
          return document ? { document, endpointId: endpoint.id, etag: previousEtag } : undefined;
        }
        if (!response.ok) return undefined;

        const value = await readBoundedResponseJson(response, maxResponseBytes, {
          invalidJsonMessage: 'Invalid Service-Plane discovery response',
          tooLargeMessage: 'Service-Plane discovery response is too large',
        });
        if (!isDiscoveryForEndpoint(value, endpoint, reservedRestPathSet)) return undefined;
        const etag = response.headers.get('etag') ?? undefined;
        return { document: value, endpointId: endpoint.id, ...(etag ? { etag } : {}) };
      } catch {
        return undefined;
      }
    }),
  );

  const documents = discovered.filter((entry): entry is DiscoveredDocument => !!entry);
  return {
    complete: documents.length === endpoints.length,
    etags: documents.reduce<Record<string, string>>((metadata, entry) => {
      if (entry.etag) metadata[entry.endpointId] = entry.etag;
      return metadata;
    }, {}),
    services: documents.map((entry) => entry.document),
  };
}

// The configured endpoint is the plane's identity authority; discovery may describe that service,
// but it cannot redirect metadata or capability scopes onto another configured endpoint.
function isDiscoveryForEndpoint(
  value: unknown,
  endpoint: ServiceEndpoint,
  reservedRestPaths: Set<string>,
): value is ServiceDiscoveryDocument {
  return (
    isServiceDiscoveryDocument(value, reservedRestPaths) &&
    value.id === endpoint.id &&
    (value.capabilities === undefined || value.capabilities.serviceId === endpoint.id)
  );
}

function withAbilities(snapshot: ServiceDiscoverySnapshot, endpointsById: ReadonlyMap<string, ServiceEndpoint>): ServiceRegistrySnapshot {
  const abilities = snapshot.services.flatMap((service) => {
    const endpoint = endpointsById.get(service.id);
    if (!endpoint) return [];
    return service.abilities.map((ability) => discoveredAbility(service, ability, endpoint));
  });
  return {
    ...snapshot,
    abilities,
  };
}

function discoveredAbility(
  service: ServiceDiscoveryDocument,
  ability: ServiceAbilityDiscovery,
  endpoint: ServiceEndpoint,
): DiscoveredServiceAbility {
  return {
    ...ability,
    service: endpoint,
    serviceId: service.id,
    ...(service.ingress ? { serviceIngress: service.ingress } : {}),
    serviceTitle: service.title,
    serviceVersion: service.version,
  };
}

function isServiceDiscoveryDocument(value: unknown, reservedRestPaths: Set<string>): value is ServiceDiscoveryDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as ServiceDiscoveryDocument;
  return (
    typeof document.id === 'string' &&
    typeof document.title === 'string' &&
    typeof document.version === 'string' &&
    Array.isArray(document.abilities) &&
    document.abilities.every((ability) => isAbilityDiscovery(ability, reservedRestPaths)) &&
    (document.capabilities === undefined || isCapabilityCatalog(document.capabilities)) &&
    (!document.callerAuth ||
      (isRecord(document.callerAuth) && isRecord(document.callerAuth.jwks) && Array.isArray(document.callerAuth.jwks.keys))) &&
    (document.ingress === undefined || (isRecord(document.ingress) && document.ingress.required === true))
  );
}

// Discovery is an untyped network boundary. Validate the complete catalog before the control plane
// passes it to the shared issuer, which legitimately dereferences every scope during construction.
// Mirroring `defineCapabilities` here also keeps hand-authored discovery from advertising a shape a
// Service Plane service cannot produce.
function isCapabilityCatalog(value: unknown): value is CapabilityCatalog {
  if (!isRecord(value) || !isCanonicalId(value.serviceId) || !Array.isArray(value.scopes)) return false;

  const scopeIds = new Set<string>();
  for (const scope of value.scopes) {
    if (!isCapabilityScopeDefinition(scope) || scopeIds.has(scope.id)) return false;
    scopeIds.add(scope.id);
  }
  return true;
}

function isCapabilityScopeDefinition(value: unknown): value is CapabilityScopeDefinition {
  return (
    isRecord(value) &&
    isCanonicalScope(value.id) &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.title === undefined || typeof value.title === 'string')
  );
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function isCanonicalScope(value: unknown): value is string {
  return isCanonicalId(value) && !value.includes('*');
}

function isAbilityDiscovery(value: unknown, reservedRestPaths: Set<string>): value is ServiceAbilityDiscovery {
  if (!value || typeof value !== 'object') return false;
  const ability = value as ServiceAbilityDiscovery;
  const methodReservedRestPaths = ability.exposure === 'published' ? reservedRestPaths : NO_RESERVED_REST_PATHS;
  return (
    typeof ability.id === 'string' &&
    isAbilityAccess(ability.access) &&
    isAbilityExposure(ability.exposure) &&
    Array.isArray(ability.scopes) &&
    ability.scopes.every((scope) => typeof scope === 'string') &&
    !!ability.rpc &&
    typeof ability.rpc === 'object' &&
    typeof ability.rpc.path === 'string' &&
    (ability.rpc.protocol === undefined || typeof ability.rpc.protocol === 'string') &&
    isOriginRelativePath(ability.rpc.path) &&
    Array.isArray(ability.rpc.transports) &&
    ability.rpc.transports.every(isAbilityTransport) &&
    isRecord(ability.methods) &&
    Object.values(ability.methods).every((method) => isAbilityMethodDiscovery(method, methodReservedRestPaths))
  );
}

function isAbilityMethodDiscovery(value: unknown, reservedRestPaths: Set<string>): value is ServiceAbilityMethodDiscovery {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string') &&
    isRecord(value.inputSchema) &&
    isRecord(value.outputSchema) &&
    (value.stream === undefined || value.stream === true) &&
    // Mirrors defineAbilityService for the same reason as the projection checks below: a foreign
    // document does not get to advertise a bound the defining side could never produce.
    (value.idempotent === undefined || value.idempotent === true) &&
    (value.timeoutMs === undefined ||
      (typeof value.timeoutMs === 'number' && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 && value.stream !== true)) &&
    // Mirrors defineAbilityService: streaming methods cannot claim single-response projections,
    // and foreign discovery documents do not get to bypass that.
    (value.stream !== true || (value.mcpPrompt === undefined && value.mcpResource === undefined && value.rest === undefined)) &&
    (value.rest === undefined || isValidRestDiscovery(value.rest, value.inputSchema, reservedRestPaths)) &&
    (value.mcp === undefined || isMcpProjection(value.mcp)) &&
    (value.mcpPrompt === undefined || isMcpPromptProjection(value.mcpPrompt)) &&
    (value.mcpResource === undefined || isMcpResourceProjection(value.mcpResource))
  );
}

function isMcpProjection(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isCanonicalId(value.name) && (value.description === undefined || typeof value.description === 'string');
}

function isMcpPromptProjection(value: unknown): boolean {
  return (
    isMcpProjection(value) &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.arguments === undefined || (Array.isArray(value.arguments) && value.arguments.every(isMcpPromptArgument)))
  );
}

function isMcpPromptArgument(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCanonicalId(value.name) &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.required === undefined || typeof value.required === 'boolean')
  );
}

function isMcpResourceProjection(value: unknown): boolean {
  return (
    isMcpProjection(value) &&
    isCanonicalId(value.uri) &&
    hasOnlySimpleTemplateExpressions(value.uri) &&
    (value.mimeType === undefined || typeof value.mimeType === 'string') &&
    (value.title === undefined || typeof value.title === 'string')
  );
}

function isValidRestDiscovery(rest: unknown, inputSchema: Record<string, unknown>, reservedRestPaths: Set<string>): boolean {
  if (
    !isRecord(rest) ||
    !isServiceHttpMethod(rest.method) ||
    typeof rest.path !== 'string' ||
    !isOriginRelativePath(rest.path) ||
    isReservedRestPath(normalizePath(rest.path), reservedRestPaths) ||
    (rest.operationId !== undefined && typeof rest.operationId !== 'string') ||
    (rest.tags !== undefined && (!Array.isArray(rest.tags) || !rest.tags.every((tag) => typeof tag === 'string'))) ||
    (rest.status !== undefined &&
      (typeof rest.status !== 'number' || !Number.isInteger(rest.status) || rest.status < 200 || rest.status > 299))
  ) {
    return false;
  }
  const variables = pathTemplateVariables(rest.path);
  if (!variables) return false;
  const properties = jsonSchemaRootProperties(inputSchema);
  return variables.every((name) => !!properties && Object.hasOwn(properties, name));
}

function isReservedRestPath(path: string, rules: ReadonlySet<string>): boolean {
  for (const rule of rules) {
    if (rule.endsWith('/*')) {
      const prefix = rule.slice(0, -2) || '/';
      if (prefix === '/' || path.startsWith(`${prefix}/`)) return true;
      continue;
    }
    if (path === rule) return true;
  }
  return false;
}

/** Reserved control-plane paths in canonical form, so two spellings of one route compare equal. */
export function normalizedReservedRestPaths(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).map(normalizePath))].sort();
}

/**
 * The default discovery cache, and the one a plane uses unless it is given another. Process-local by
 * nature: on Cloudflare that means per isolate, on Node per process. That is the bulk of the win —
 * it turns a catalog fan-out per request into one per process per TTL — while a shared store (KV,
 * Redis) additionally collapses it to one for the whole fleet. Both are worth having; only this one
 * needs no infrastructure, which is why it is the default rather than an opt-in.
 *
 * Deliberately unbounded, and the TTL is not what bounds it: expiry only makes `get` miss, while the
 * entry itself stays for `getStale` to revalidate against. Nothing here ever deletes, so an entry
 * written once is retained for the life of the process. The TTL bounds freshness, not memory.
 *
 * What bounds memory is the number of distinct *service sets* resolved, which is a configuration
 * dimension rather than a per-request one: `serviceRegistryCacheKey` covers ids and origins only, so
 * per-caller grants resolve to a single entry and the ordinary plane holds exactly one. The two
 * dimensions also trade against each other — a 200-service catalog is one entry at ~800 KB, while a
 * plane with many distinct sets has small ones at ~4 KB each — so the product stays modest in any
 * shape that corresponds to a real deployment.
 *
 * A capacity bound was tried and removed. A miss here is a network fan-out over every configured
 * service, so any cap low enough to fire produces the eviction thrashing that made the issuer
 * cache's bound not worth carrying, and worse: that miss cost microseconds, this one costs round
 * trips. A cap set high enough never to fire would be a memory backstop rather than a cache policy —
 * defensible, but it guards a shape we could not construct without inventing hundreds of distinct
 * large catalogs.
 */
export function memoryRegistryCache(now: () => number = () => Date.now()): RegistryCache {
  const entries = new Map<string, { expiresAt: number; value: ServiceDiscoverySnapshot }>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) return undefined;
      return entry.value;
    },
    // Kept past expiry on purpose: an expired entry is still the right thing to revalidate against
    // with `if-none-match`, which is what turns a refresh into a 304 instead of a full document.
    async getStale(key) {
      return entries.get(key)?.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, { expiresAt: now() + ttlSeconds * 1000, value });
    },
  };
}
