import type { Context, Handler } from 'hono';
import { etag } from 'hono/etag';
import { createFactory } from 'hono/factory';
import {
  normalizeCapabilitySubject,
  publicJwkFromPrivateJwk,
  signCapabilityToken,
  verifyCapabilityToken,
} from '../shared/capability-tokens.js';
import { CapabilityAuthError } from '../shared/errors.js';
import { applyHttpCacheHeaders, type ServicePlaneHttpCacheOption, servicePlaneHttpCacheHeaders } from '../shared/http-cache.js';
import { generateServicePlaneJwkSigningKey } from '../shared/jwk-auth.js';
import {
  type CapabilityCatalog,
  type CapabilityConfirmation,
  type CapabilityJwks,
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
  MAX_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  type ServiceGrant,
  type ServiceGrantDefinition,
} from '../shared/types.js';
import { issuedCapabilityTokenRpcResponse, rejectCallerAssertedSubject } from './rpc.js';

const endpointFactory = createFactory();

// Rotation makes the key id load-bearing rather than cosmetic: a verifier picks its verification key
// by `kid` alone, so a published key without one — or two sharing one — is unusable. The type makes
// that a compile error instead of a runtime surprise during a rollout.
export type CapabilitySigningJwk = JsonWebKey & { kid: string };

export type CapabilityIssuer = {
  issueBrokeredCapabilityToken(input: IssueCapabilityTokenInput & { brokerServiceId: string }): Promise<IssuedCapabilityToken>;
  issueCapabilityToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken>;
  jwks(): Promise<CapabilityJwks>;
};

// The signing authority owns key material only: issuer, key ids, and public JWKS. It is deliberately
// separate from the authorization catalog (services, scopes, grants) so publishing JWKS never
// depends on downstream service discovery — verifiers must be able to refresh keys during an outage.
export type CapabilitySigningAuthority = {
  issuer: string;
  jwks(): Promise<CapabilityJwks>;
  // The key new tokens are signed with. `jwks()` also publishes every retired key still inside the
  // rotation overlap window, so this is not the full set a verifier may legitimately see.
  keyId: string;
  keyIds: string[];
};

// Anything that can publish JWKS. A full CapabilityIssuer satisfies it, so JWKS mounts accept either.
export type CapabilityJwksProvider = Pick<CapabilityIssuer, 'jwks'>;

export type CapabilityJwksProviderResolver =
  | CapabilityJwksProvider
  | ((context: Context) => Promise<CapabilityJwksProvider> | CapabilityJwksProvider);

// `privateJwks[0]` signs; every entry is published for verification. Retired entries may be public
// JWKs — the private members are stripped before publication either way — so old private material can
// be destroyed the moment the active key changes.
export type CreateCapabilitySigningAuthorityOptions = {
  issuer: string;
  privateJwks: CapabilitySigningJwk[];
};

export type CreateCapabilityIssuerOptions = {
  capabilities: CapabilityCatalog[];
  grants: ServiceGrantDefinition;
  issuer: string;
  now?: () => Date;
  privateJwks: CapabilitySigningJwk[];
  ttlSeconds?: number;
};

export type CreateCapabilityIssuerFromPrivateJwkOptions = CreateCapabilityIssuerOptions & {
  validateKeyPair?: boolean;
};

export type GenerateCapabilitySigningJwkOptions = {
  keyId: string;
};

// A caller-auth result. The bare string form says "authenticated, no key to bind" — which is all HMAC
// and service-binding callers can offer. The object form reports the key that actually authenticated,
// so issuance can sender-constrain the token to it.
export type CallerAuthResult = {
  confirmation?: CapabilityConfirmation;
  serviceId: string;
};

export type CallerAuthenticator = (
  context: Context,
) => Promise<Response | CallerAuthResult | string> | Response | CallerAuthResult | string;

export type MountCapabilityTokenEndpointOptions = {
  authenticateCaller: CallerAuthenticator;
  path?: string;
};

export type CapabilityIssuerResolver = CapabilityIssuer | ((context: Context) => Promise<CapabilityIssuer> | CapabilityIssuer);

export type MountCapabilityJwksEndpointOptions = {
  httpCache?: ServicePlaneHttpCacheOption;
  path?: string;
};

export type MountCapabilityEndpointsOptions = {
  authenticateCaller: CallerAuthenticator;
  httpCache?: ServicePlaneHttpCacheOption;
  // Required, and separate from the issuer on purpose: passing the issuer here couples key
  // publication to the authorization catalog, so a service-discovery outage takes JWKS down with it.
  // Pass a signing authority unless you have a reason to accept that coupling.
  jwks: CapabilityJwksProviderResolver;
  jwksPath?: string;
  tokenPath?: string;
};

// Per-target validation outcome: either the target's usable grants, or the error that refuses it.
type ValidatedTargetGrants = {
  error?: CapabilityAuthError;
  grants: ServiceGrant[];
};

type CapabilityEndpointApp = {
  get(path: string, ...handlers: Handler[]): unknown;
  post(path: string, ...handlers: Handler[]): unknown;
  use(path: string, ...handlers: Handler[]): unknown;
};

export function defineServiceGrants(definition: ServiceGrantDefinition): ServiceGrantDefinition {
  return {
    grants: definition.grants.map((grant) => normalizeGrant(grant)),
  };
}

// Derives the public JWKS from private key material alone. No catalog, no discovery, no I/O.
export function createCapabilitySigningAuthority(options: CreateCapabilitySigningAuthorityOptions): CapabilitySigningAuthority {
  const privateJwks = normalizeSigningJwks(options.privateJwks);
  const publicJwks = privateJwks.map((privateJwk) => publicJwkFromPrivateJwk(privateJwk, privateJwk.kid));
  const keyIds = privateJwks.map((privateJwk) => privateJwk.kid);

  return {
    issuer: options.issuer,
    async jwks() {
      // A fresh array per call: the authority holds this key set for its whole lifetime, and a
      // caller aggregating or sorting the result would otherwise edit every later document.
      return {
        keys: [...publicJwks],
      };
    },
    keyId: keyIds[0] as string,
    keyIds,
  };
}

export function createCapabilityIssuer(options: CreateCapabilityIssuerOptions): CapabilityIssuer {
  const signingAuthority = createCapabilitySigningAuthority(options);
  // Only the active key ever signs. Retired keys reach `jwks()` and nothing else.
  const signingJwk = normalizeSigningJwks(options.privateJwks)[0] as CapabilitySigningJwk;
  const keyId = signingJwk.kid;
  const capabilitiesByService = capabilityScopesByService(options.capabilities);
  const grantsByTarget = validateGrantsByTarget(options.grants.grants, capabilitiesByService);
  const maxTtlSeconds = normalizeTtlSeconds(options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS, 500);

  return {
    async issueBrokeredCapabilityToken(input) {
      return issueCapabilityToken({
        brokerServiceId: normalizeId(input.brokerServiceId, 'broker service id'),
        input,
        issuer: options.issuer,
        grantsByTarget,
        keyId,
        maxTtlSeconds,
        ...(options.now ? { now: options.now } : {}),
        privateJwk: signingJwk,
      });
    },
    async issueCapabilityToken(input) {
      return issueCapabilityToken({
        input,
        issuer: options.issuer,
        grantsByTarget,
        keyId,
        maxTtlSeconds,
        ...(options.now ? { now: options.now } : {}),
        privateJwk: signingJwk,
      });
    },
    jwks: signingAuthority.jwks,
  };
}

function issueCapabilityToken(options: {
  brokerServiceId?: string;
  grantsByTarget: Map<string, ValidatedTargetGrants>;
  input: IssueCapabilityTokenInput;
  issuer: string;
  keyId: string;
  maxTtlSeconds: number;
  now?: () => Date;
  privateJwk: JsonWebKey;
}): Promise<IssuedCapabilityToken> {
  const requestedScopes = normalizeScopes(options.input.scopes, 400);
  const grants = grantsForTarget(options.grantsByTarget, options.input.targetServiceId);
  if (!isGranted(grants, options.input.callerServiceId, requestedScopes)) {
    throw new CapabilityAuthError('Service-Plane capability grant denied', 403);
  }
  const ttlSeconds =
    options.input.ttlSeconds === undefined
      ? options.maxTtlSeconds
      : Math.min(normalizeTtlSeconds(options.input.ttlSeconds, 400), options.maxTtlSeconds);
  const subject = options.input.subject === undefined ? undefined : normalizeCapabilitySubject(options.input.subject);

  // RFC 8693 delegation: with a subject, sub carries the end user and act names the acting service.
  // RFC 7800 `cnf`: present only when the caller authenticated with a key, sender-constraining the
  // token to it so the bytes alone are not enough to use it.
  return signCapabilityToken({
    claims: {
      ...(subject ? { act: { sub: options.input.callerServiceId } } : {}),
      aud: options.input.targetServiceId,
      ...(options.input.confirmation ? { cnf: normalizeConfirmation(options.input.confirmation) } : {}),
      iss: options.issuer,
      scp: requestedScopes,
      ...(options.brokerServiceId ? { spb: options.brokerServiceId } : {}),
      ...(subject?.orgId ? { spo: subject.orgId } : {}),
      sub: subject ? subject.id : options.input.callerServiceId,
    },
    keyId: options.keyId,
    privateJwk: options.privateJwk,
    ttlSeconds,
    ...(options.now ? { now: options.now() } : {}),
  });
}

export async function createCapabilityIssuerFromPrivateJwk(
  options: CreateCapabilityIssuerFromPrivateJwkOptions,
): Promise<CapabilityIssuer> {
  // Only the active key is round-tripped: retired entries are allowed to be public-only, so there is
  // no private half left to check against them.
  const signingJwk = normalizeSigningJwks(options.privateJwks)[0] as CapabilitySigningJwk;
  if (options.validateKeyPair ?? true) {
    await validateEs256KeyPair(signingJwk, publicJwkFromPrivateJwk(signingJwk, signingJwk.kid), signingJwk.kid);
  }
  return createCapabilityIssuer(options);
}

export async function generateCapabilitySigningJwk(options: GenerateCapabilitySigningJwkOptions): Promise<CapabilitySigningJwk> {
  return (await generateServicePlaneJwkSigningKey(options)) as CapabilitySigningJwk;
}

export function mountCapabilityTokenEndpoint(
  app: {
    post(path: string, ...handlers: Handler[]): unknown;
  },
  issuer: CapabilityIssuerResolver,
  options: MountCapabilityTokenEndpointOptions,
): void {
  app.post(
    options.path ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
    ...endpointFactory.createHandlers(async (context) => {
      // Token responses carry bearer credentials; keep them out of shared caches (RFC 6749 §5.1).
      context.header('cache-control', 'no-store');
      context.header('pragma', 'no-cache');
      const authenticated = await options.authenticateCaller(context);
      if (authenticated instanceof Response) return authenticated;
      const caller = typeof authenticated === 'string' ? { serviceId: authenticated } : authenticated;

      try {
        // Resolved inside the guard so an unavailable authorization catalog fails closed with the
        // issuer's own error instead of an opaque unhandled rejection.
        const resolvedIssuer = typeof issuer === 'function' ? await issuer(context) : issuer;
        const body = await readTokenRequest(context.req.raw);
        if (body.callerServiceId && body.callerServiceId !== caller.serviceId) {
          return context.json({ error: 'Caller service mismatch' }, 403);
        }
        const issued = await resolvedIssuer.issueCapabilityToken({
          callerServiceId: caller.serviceId,
          // Comes from the authenticator, never from the request body: a caller-supplied confirmation
          // would let it bind a key of its choosing and defeat the point.
          ...(caller.confirmation ? { confirmation: caller.confirmation } : {}),
          scopes: body.scopes,
          targetServiceId: body.targetServiceId,
          ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
        });
        return context.json(issuedCapabilityTokenRpcResponse(issued));
      } catch (error) {
        if (error instanceof CapabilityAuthError) return context.json({ error: error.message }, error.status as 400 | 401 | 403 | 500);
        throw error;
      }
    }),
  );
}

export function mountCapabilityEndpoints(
  app: CapabilityEndpointApp,
  issuer: CapabilityIssuerResolver,
  options: MountCapabilityEndpointsOptions,
): void {
  mountCapabilityTokenEndpoint(app, issuer, {
    authenticateCaller: options.authenticateCaller,
    ...(options.tokenPath ? { path: options.tokenPath } : {}),
  });
  mountCapabilityJwksEndpoint(app, options.jwks, {
    ...(options.httpCache === undefined ? {} : { httpCache: options.httpCache }),
    ...(options.jwksPath ? { path: options.jwksPath } : {}),
  });
}

export function mountCapabilityJwksEndpoint(
  app: {
    get(path: string, ...handlers: Handler[]): unknown;
    use(path: string, ...handlers: Handler[]): unknown;
  },
  jwks: CapabilityJwksProviderResolver,
  options: MountCapabilityJwksEndpointOptions = {},
): void {
  const path = options.path ?? SERVICE_PLANE_CAPABILITY_JWKS_PATH;
  const cacheHeaders = servicePlaneHttpCacheHeaders(options.httpCache, ['service-plane', 'service-plane:jwks']);
  app.use(path, etag());
  app.get(
    path,
    ...endpointFactory.createHandlers(async (context) => {
      try {
        const provider = typeof jwks === 'function' ? await jwks(context) : jwks;
        const document = await provider.jwks();
        // Applied only once the document exists: a shared cache told to keep a key-misconfiguration
        // error for max-age + stale-while-revalidate would take key publication down for the whole
        // window, during exactly the deploy that caused it.
        applyHttpCacheHeaders(cacheHeaders, (name, value) => context.header(name, value));
        return context.json(document);
      } catch (error) {
        if (error instanceof CapabilityAuthError) {
          context.header('cache-control', 'no-store');
          return context.json({ error: error.message }, error.status as 400 | 401 | 403 | 500);
        }
        throw error;
      }
    }),
  );
}

function normalizeConfirmation(confirmation: CapabilityConfirmation): CapabilityConfirmation {
  const jkt = confirmation.jkt.trim();
  if (!jkt) throw new CapabilityAuthError('Service-Plane capability confirmation thumbprint cannot be empty', 500);
  return { jkt };
}

function normalizeGrant(grant: ServiceGrant): ServiceGrant {
  return {
    caller: normalizeId(grant.caller, 'caller'),
    scopes: normalizeScopes(grant.scopes, 500),
    target: normalizeId(grant.target, 'target'),
  };
}

// Grants are validated against the discovered catalog per target, and a failure is recorded rather
// than thrown. Every service deploys on its own cadence, so one stale or undiscoverable target must
// not take token issuance down for the rest of the plane; the error is kept verbatim and rethrown
// only when that target is the one actually requested.
function validateGrantsByTarget(
  grants: ServiceGrant[],
  capabilitiesByService: Map<string, Set<string>>,
): Map<string, ValidatedTargetGrants> {
  const byTarget = new Map<string, ValidatedTargetGrants>();
  for (const grant of grants) {
    // Normalization failures are plane-side configuration errors, not catalog drift, and carry no
    // trustworthy target to attribute them to — they stay fail-fast at construction.
    const normalized = normalizeGrant(grant);
    const entry = byTarget.get(normalized.target) ?? { grants: [] };
    byTarget.set(normalized.target, entry);
    if (entry.error) continue;
    try {
      validateGrantScopes(normalized, capabilitiesByService);
      entry.grants.push(normalized);
    } catch (error) {
      if (!(error instanceof CapabilityAuthError)) throw error;
      // One bad grant refuses the whole target: silently keeping its other grants would look like a
      // permissions bug instead of the misconfiguration it is.
      entry.error = error;
      entry.grants = [];
    }
  }
  return byTarget;
}

function validateGrantScopes(grant: ServiceGrant, capabilitiesByService: Map<string, Set<string>>): void {
  const targetScopes = capabilitiesByService.get(grant.target);
  if (!targetScopes) throw new CapabilityAuthError(`Unknown Service-Plane capability target: ${grant.target}`, 500);
  for (const scope of grant.scopes) {
    if (!targetScopes.has(scope)) throw new CapabilityAuthError(`Unknown Service-Plane capability scope: ${scope}`, 500);
  }
}

function grantsForTarget(byTarget: Map<string, ValidatedTargetGrants>, target: string): ServiceGrant[] {
  const entry = byTarget.get(target);
  if (!entry) return [];
  if (entry.error) throw entry.error;
  return entry.grants;
}

function capabilityScopesByService(capabilities: CapabilityCatalog[]): Map<string, Set<string>> {
  const byService = new Map<string, Set<string>>();
  for (const catalog of capabilities) {
    if (byService.has(catalog.serviceId))
      throw new CapabilityAuthError(`Duplicate Service-Plane capability service: ${catalog.serviceId}`, 500);
    byService.set(catalog.serviceId, new Set(catalog.scopes.map((scope) => normalizeScope(scope.id))));
  }
  return byService;
}

// Receives the requested target's grants only, so caller is the remaining dimension to match.
function isGranted(grants: ServiceGrant[], caller: string, scopes: string[]): boolean {
  const matching = grants.filter((grant) => grant.caller === caller);
  return scopes.every((scope) => matching.some((grant) => grant.scopes.includes(scope)));
}

function normalizeScopes(scopes: string[], status: number): string[] {
  if (!Array.isArray(scopes)) {
    throw new CapabilityAuthError('Service-Plane capability token scopes must be an array', status);
  }
  if (scopes.length === 0) {
    throw new CapabilityAuthError('Service-Plane capability token requires at least one scope', status);
  }
  const normalized = scopes.map((scope) => normalizeScope(scope, status));
  return [...new Set(normalized)];
}

function normalizeScope(scope: string, status = 500): string {
  const normalized = scope.trim();
  if (!normalized) throw new CapabilityAuthError('Service-Plane capability scope cannot be empty', status);
  if (normalized.includes('*')) throw new CapabilityAuthError('Service-Plane capability wildcards are not supported', status);
  return normalized;
}

function normalizeId(id: string, field: string): string {
  const normalized = id.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane capability ${field} cannot be empty`, 500);
  return normalized;
}

async function readTokenRequest(request: Request): Promise<IssueCapabilityTokenInput> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new CapabilityAuthError('Invalid Service-Plane capability token request', 400);
  }

  if (!body || typeof body !== 'object') throw new CapabilityAuthError('Invalid Service-Plane capability token request', 400);
  const record = body as Record<string, unknown>;
  rejectCallerAssertedSubject(record.subject);
  const scopes = record.scopes;
  if (typeof record.targetServiceId !== 'string' || !Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) {
    throw new CapabilityAuthError('Invalid Service-Plane capability token request', 400);
  }
  if ('ttlSeconds' in record && typeof record.ttlSeconds !== 'number') {
    throw new CapabilityAuthError('Invalid Service-Plane capability token TTL', 400);
  }

  return {
    callerServiceId: typeof record.callerServiceId === 'string' ? record.callerServiceId : '',
    scopes,
    targetServiceId: record.targetServiceId,
    ...(typeof record.ttlSeconds === 'number' ? { ttlSeconds: record.ttlSeconds } : {}),
  };
}

function normalizeTtlSeconds(ttlSeconds: number, status: number): number {
  if (
    !Number.isFinite(ttlSeconds) ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_CAPABILITY_TOKEN_TTL_SECONDS
  ) {
    throw new CapabilityAuthError(
      `Service-Plane capability token TTL must be a positive integer no greater than ${MAX_CAPABILITY_TOKEN_TTL_SECONDS} seconds`,
      status,
    );
  }
  return ttlSeconds;
}

// Rotation is only safe if a verifier can tell the published keys apart. A missing or duplicated key
// id is refused at construction rather than published, because the failure it causes downstream — a
// verifier picking the wrong key for a `kid` it has cached — surfaces as an unexplained signature
// error on every request, which reads as a crypto bug rather than a rollout mistake.
function normalizeSigningJwks(privateJwks: CapabilitySigningJwk[]): CapabilitySigningJwk[] {
  if (privateJwks.length === 0) throw new CapabilityAuthError('Service-Plane signing keys cannot be empty', 500);
  const seen = new Set<string>();
  return privateJwks.map((privateJwk) => {
    const kid = typeof privateJwk.kid === 'string' ? privateJwk.kid.trim() : '';
    if (!kid) throw new CapabilityAuthError('Service-Plane signing key id cannot be empty', 500);
    if (seen.has(kid)) throw new CapabilityAuthError(`Duplicate Service-Plane signing key id: ${kid}`, 500);
    seen.add(kid);
    return { ...privateJwk, kid };
  });
}

// Exported so a caller that memoizes derived key material can pay this round-trip once per key set
// rather than once per issuer. Deliberately not re-exported from `index.ts`.
export async function validateEs256KeyPair(privateJwk: JsonWebKey, publicJwk: JsonWebKey, keyId: string): Promise<void> {
  try {
    const issued = await signCapabilityToken({
      claims: {
        aud: 'service-plane-key-check',
        iss: 'service-plane-key-check',
        scp: ['service-plane.key.check'],
        sub: 'service-plane-key-check',
      },
      keyId,
      now: new Date('2026-01-01T00:00:00.000Z'),
      privateJwk,
      ttlSeconds: 60,
    });
    await verifyCapabilityToken(issued.token, {
      expectedAudience: 'service-plane-key-check',
      issuer: 'service-plane-key-check',
      jwks: { keys: [{ ...publicJwk, kid: keyId }] },
      now: new Date('2026-01-01T00:00:01.000Z'),
      requiredScopes: ['service-plane.key.check'],
    });
  } catch {
    throw new CapabilityAuthError('Service-Plane public JWK does not match private signing key', 500);
  }
}
