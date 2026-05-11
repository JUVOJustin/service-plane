import type { Context, Handler } from 'hono';
import { createFactory } from 'hono/factory';
import { CapabilityAuthError } from '../shared/errors.js';
import { publicJwkFromPrivateJwk, signCapabilityToken, verifyCapabilityToken } from '../shared/capability-tokens.js';
import {
  DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS,
  SERVICE_PLANE_CAPABILITY_JWKS_PATH,
  SERVICE_PLANE_CAPABILITY_TOKEN_PATH,
  type CapabilityCatalog,
  type CapabilityJwks,
  type IssueCapabilityTokenInput,
  type IssuedCapabilityToken,
  type ServiceGrant,
  type ServiceGrantDefinition,
} from '../shared/types.js';

const endpointFactory = createFactory();
const DEFAULT_CAPABILITY_KEY_ID = 'default';

export type CapabilityIssuer = {
  issueCapabilityToken(input: IssueCapabilityTokenInput): Promise<IssuedCapabilityToken>;
  jwks(): Promise<CapabilityJwks>;
};

export type CreateCapabilityIssuerOptions = {
  capabilities: CapabilityCatalog[];
  grants: ServiceGrantDefinition;
  issuer: string;
  keyId?: string;
  now?: () => Date;
  privateJwk: JsonWebKey;
  ttlSeconds?: number;
};

export type CreateCapabilityIssuerFromPrivateJwkOptions = CreateCapabilityIssuerOptions & {
  validateKeyPair?: boolean;
};

export type GenerateCapabilitySigningJwkOptions = {
  keyId?: string;
};

export type MountCapabilityTokenEndpointOptions = {
  authenticateCaller(context: Context): Promise<Response | string> | Response | string;
  path?: string;
};

export type CapabilityIssuerResolver = CapabilityIssuer | ((context: Context) => Promise<CapabilityIssuer> | CapabilityIssuer);

export type MountCapabilityJwksEndpointOptions = {
  path?: string;
};

export type MountCapabilityEndpointsOptions = {
  authenticateCaller(context: Context): Promise<Response | string> | Response | string;
  jwksPath?: string;
  tokenPath?: string;
};

type CapabilityEndpointApp = {
  get(path: string, ...handlers: Handler[]): unknown;
  post(path: string, ...handlers: Handler[]): unknown;
};

export function defineServiceGrants(definition: ServiceGrantDefinition): ServiceGrantDefinition {
  return {
    grants: definition.grants.map((grant) => normalizeGrant(grant)),
  };
}

export function createCapabilityIssuer(options: CreateCapabilityIssuerOptions): CapabilityIssuer {
  const keyId = options.keyId ?? DEFAULT_CAPABILITY_KEY_ID;
  const publicJwk = publicJwkFromPrivateJwk(options.privateJwk, keyId);
  const capabilitiesByService = capabilityScopesByService(options.capabilities);
  const grants = options.grants.grants.map((grant) => validateGrant(grant, capabilitiesByService));
  const maxTtlSeconds = normalizeTtlSeconds(options.ttlSeconds ?? DEFAULT_CAPABILITY_TOKEN_TTL_SECONDS, 500);

  return {
    async issueCapabilityToken(input) {
      const requestedScopes = normalizeScopes(input.scopes, 400);
      if (!isGranted(grants, input.callerServiceId, input.targetServiceId, requestedScopes)) {
        throw new CapabilityAuthError('Service-Plane capability grant denied', 403);
      }
      const ttlSeconds =
        input.ttlSeconds === undefined ? maxTtlSeconds : Math.min(normalizeTtlSeconds(input.ttlSeconds, 400), maxTtlSeconds);

      return signCapabilityToken({
        claims: {
          aud: input.targetServiceId,
          iss: options.issuer,
          scp: requestedScopes,
          sub: input.callerServiceId,
        },
        keyId,
        privateJwk: options.privateJwk,
        ttlSeconds,
        ...(options.now ? { now: options.now() } : {}),
      });
    },
    async jwks() {
      return {
        keys: [
          {
            ...publicJwk,
            alg: 'ES256',
            kid: keyId,
            key_ops: ['verify'],
            use: 'sig',
          },
        ],
      };
    },
  };
}

export async function createCapabilityIssuerFromPrivateJwk(options: CreateCapabilityIssuerFromPrivateJwkOptions): Promise<CapabilityIssuer> {
  const keyId = options.keyId ?? DEFAULT_CAPABILITY_KEY_ID;
  const publicJwk = publicJwkFromPrivateJwk(options.privateJwk, keyId);
  if (options.validateKeyPair ?? true) {
    await validateEs256KeyPair(options.privateJwk, publicJwk, keyId);
  }
  return createCapabilityIssuer({ ...options, keyId });
}

export async function generateCapabilitySigningJwk(options: GenerateCapabilitySigningJwkOptions = {}): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    ...privateJwk,
    alg: 'ES256',
    ...(options.keyId ? { kid: options.keyId } : {}),
    key_ops: ['sign'],
    use: 'sig',
  };
}

export function mountCapabilityTokenEndpoint(
  app: {
    post(path: string, ...handlers: Handler[]): unknown;
  },
  issuer: CapabilityIssuerResolver,
  options: MountCapabilityTokenEndpointOptions,
): void {
  app.post(options.path ?? SERVICE_PLANE_CAPABILITY_TOKEN_PATH, ...endpointFactory.createHandlers(async (context) => {
    const caller = await options.authenticateCaller(context);
    if (caller instanceof Response) return caller;
    const resolvedIssuer = typeof issuer === 'function' ? await issuer(context) : issuer;

    try {
      const body = await readTokenRequest(context.req.raw);
      if (body.callerServiceId && body.callerServiceId !== caller) {
        return context.json({ error: 'Caller service mismatch' }, 403);
      }
      const issued = await resolvedIssuer.issueCapabilityToken({
        callerServiceId: caller,
        scopes: body.scopes,
        targetServiceId: body.targetServiceId,
        ...(body.ttlSeconds === undefined ? {} : { ttlSeconds: body.ttlSeconds }),
      });
      return context.json({
        expiresAt: issued.expiresAt.toISOString(),
        token: issued.token,
        tokenType: 'ServicePlane',
      });
    } catch (error) {
      if (error instanceof CapabilityAuthError) return context.json({ error: error.message }, error.status as 400 | 401 | 403 | 500);
      throw error;
    }
  }));
}

export function mountCapabilityEndpoints(app: CapabilityEndpointApp, issuer: CapabilityIssuerResolver, options: MountCapabilityEndpointsOptions): void {
  mountCapabilityTokenEndpoint(app, issuer, {
    authenticateCaller: options.authenticateCaller,
    ...(options.tokenPath ? { path: options.tokenPath } : {}),
  });
  mountCapabilityJwksEndpoint(app, issuer, options.jwksPath ? { path: options.jwksPath } : {});
}

export function mountCapabilityJwksEndpoint(
  app: {
    get(path: string, ...handlers: Handler[]): unknown;
  },
  issuer: CapabilityIssuerResolver,
  options: MountCapabilityJwksEndpointOptions = {},
): void {
  app.get(options.path ?? SERVICE_PLANE_CAPABILITY_JWKS_PATH, ...endpointFactory.createHandlers(async (context) => {
    const resolvedIssuer = typeof issuer === 'function' ? await issuer(context) : issuer;
    return context.json(await resolvedIssuer.jwks());
  }));
}

function normalizeGrant(grant: ServiceGrant): ServiceGrant {
  return {
    caller: normalizeId(grant.caller, 'caller'),
    scopes: normalizeScopes(grant.scopes, 500),
    target: normalizeId(grant.target, 'target'),
  };
}

function validateGrant(grant: ServiceGrant, capabilitiesByService: Map<string, Set<string>>): ServiceGrant {
  const normalized = normalizeGrant(grant);
  const targetScopes = capabilitiesByService.get(normalized.target);
  if (!targetScopes) throw new CapabilityAuthError(`Unknown Service-Plane capability target: ${normalized.target}`, 500);
  for (const scope of normalized.scopes) {
    if (!targetScopes.has(scope)) throw new CapabilityAuthError(`Unknown Service-Plane capability scope: ${scope}`, 500);
  }
  return normalized;
}

function capabilityScopesByService(capabilities: CapabilityCatalog[]): Map<string, Set<string>> {
  const byService = new Map<string, Set<string>>();
  for (const catalog of capabilities) {
    if (byService.has(catalog.serviceId)) throw new CapabilityAuthError(`Duplicate Service-Plane capability service: ${catalog.serviceId}`, 500);
    byService.set(
      catalog.serviceId,
      new Set(catalog.scopes.map((scope) => normalizeScope(scope.id))),
    );
  }
  return byService;
}

function isGranted(grants: ServiceGrant[], caller: string, target: string, scopes: string[]): boolean {
  const matching = grants.filter((grant) => grant.caller === caller && grant.target === target);
  return scopes.every((scope) => matching.some((grant) => grant.scopes.includes(scope)));
}

function normalizeScopes(scopes: string[], status: number): string[] {
  if (!Array.isArray(scopes)) {
    throw new CapabilityAuthError('Service-Plane capability token scopes must be an array', status);
  }
  if (scopes.length === 0) {
    throw new CapabilityAuthError('Service-Plane capability token requires at least one scope', status);
  }
  const normalized = scopes.map(normalizeScope);
  return [...new Set(normalized)];
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim();
  if (!normalized) throw new CapabilityAuthError('Service-Plane capability scope cannot be empty', 500);
  if (normalized.includes('*')) throw new CapabilityAuthError('Service-Plane capability wildcards are not supported', 500);
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
  if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new CapabilityAuthError('Service-Plane capability token TTL must be a positive integer', status);
  }
  return ttlSeconds;
}

async function validateEs256KeyPair(privateJwk: JsonWebKey, publicJwk: JsonWebKey, keyId: string): Promise<void> {
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
