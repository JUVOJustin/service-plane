import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineCapabilities } from '../service/capabilities.js';
import { verifyCapabilityToken } from '../shared/capability-tokens.js';
import { testKeys } from '../test-support/index.js';
import {
  type CapabilityIssuer,
  createCapabilityIssuer,
  createCapabilityIssuerFromPrivateJwk,
  createCapabilitySigningAuthority,
  defineServiceGrants,
  generateCapabilitySigningJwk,
  mountCapabilityEndpoints,
  mountCapabilityJwksEndpoint,
  mountCapabilityTokenEndpoint,
} from './capabilities.js';

describe('capability issuer', () => {
  it('issues tokens for granted service scopes', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateJwks: [keys.privateJwk],
    });

    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });
    expect(issued.expiresAt).toEqual(new Date('2026-05-09T12:02:00.000Z'));

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await issuer.jwks(),
        now: new Date('2026-05-09T12:00:01.000Z'),
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });
  });

  it('issues brokered tokens without changing the granted caller identity', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateJwks: [keys.privateJwk],
    });

    const issued = await issuer.issueBrokeredCapabilityToken({
      brokerServiceId: 'control-plane',
      callerAccess: 'service',
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await issuer.jwks(),
        now: new Date('2026-05-09T12:00:01.000Z'),
      }),
    ).resolves.toMatchObject({ brokerServiceId: 'control-plane', serviceId: 'moco' });
  });

  it('mints delegated subjects with the caller as the RFC 8693 acting service', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'control-plane', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateJwks: [keys.privateJwk],
    });

    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'control-plane',
      scopes: ['fizzy.users.lookup'],
      subject: { id: 'user-7', orgId: 'org-42' },
      targetServiceId: 'fizzy',
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks: await issuer.jwks(),
        now: new Date('2026-05-09T12:00:01.000Z'),
      }),
    ).resolves.toMatchObject({ serviceId: 'control-plane', subject: { id: 'user-7', orgId: 'org-42' } });

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'control-plane',
        scopes: ['fizzy.users.lookup'],
        subject: { id: '  ' },
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Invalid Service-Plane capability subject');
  });

  it('rejects unknown scopes and unauthorized grants', async () => {
    const keys = await testKeys();

    const unknownScope = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.unknown'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });

    await expect(
      unknownScope.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Unknown Service-Plane capability scope: fizzy.unknown');

    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['fizzy.boards.sync'],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Service-Plane capability grant denied');
  });

  it('confines a stale or undiscoverable grant target to that target', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      // `buzzy` never reported a catalog (discovery outage) and `fizzy` renamed a granted scope.
      capabilities: [fizzyCapabilities, whizzyCapabilities],
      grants: defineServiceGrants({
        grants: [
          { caller: 'moco', scopes: ['fizzy.renamed'], target: 'fizzy' },
          { caller: 'moco', scopes: ['whizzy.jobs.run'], target: 'whizzy' },
          { caller: 'moco', scopes: ['buzzy.jobs.run'], target: 'buzzy' },
        ],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['whizzy.jobs.run'],
        targetServiceId: 'whizzy',
      }),
    ).resolves.toMatchObject({ token: expect.any(String) });

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Unknown Service-Plane capability scope: fizzy.renamed');

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['buzzy.jobs.run'],
        targetServiceId: 'buzzy',
      }),
    ).rejects.toThrow('Unknown Service-Plane capability target: buzzy');

    // A target nobody granted stays an ordinary authorization refusal, not a misconfiguration.
    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['whizzy.jobs.run'],
        targetServiceId: 'unlisted',
      }),
    ).rejects.toThrow('Service-Plane capability grant denied');
  });

  it('rejects empty scope token requests', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: [],
        targetServiceId: 'fizzy',
      }),
    ).rejects.toThrow('Service-Plane capability token requires at least one scope');
  });

  it('clamps and validates caller requested token TTLs', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      now: () => new Date('2026-05-09T12:00:00.000Z'),
      privateJwks: [keys.privateJwk],
      ttlSeconds: 300,
    });

    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
      ttlSeconds: 3600,
    });
    expect(issued.expiresAt).toEqual(new Date('2026-05-09T12:05:00.000Z'));

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 0,
      }),
    ).rejects.toThrow('Service-Plane capability token TTL must be a positive integer');

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 1.5,
      }),
    ).rejects.toThrow('Service-Plane capability token TTL must be a positive integer');

    await expect(
      issuer.issueCapabilityToken({
        callerAccess: 'service',
        callerServiceId: 'moco',
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 90_000,
      }),
    ).rejects.toThrow('Service-Plane capability token TTL must be a positive integer');
  });

  it('rejects malformed token endpoint TTLs', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });
    const app = new Hono();
    mountCapabilityTokenEndpoint(app, issuer, {
      authenticateCaller: () => 'moco',
    });

    const nonNumberResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: '3600',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const zeroResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
        ttlSeconds: 0,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(nonNumberResponse.status).toBe(400);
    expect(zeroResponse.status).toBe(400);
  });

  it('rejects malformed token endpoint scopes as bad requests', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });
    const app = new Hono();
    mountCapabilityTokenEndpoint(app, issuer, {
      authenticateCaller: () => 'moco',
    });

    const emptyScopeResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: [' '],
        targetServiceId: 'fizzy',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const wildcardScopeResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.*'],
        targetServiceId: 'fizzy',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(emptyScopeResponse.status).toBe(400);
    expect(wildcardScopeResponse.status).toBe(400);
  });

  it('rejects caller-asserted subjects at the token endpoint', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });
    const app = new Hono();
    mountCapabilityTokenEndpoint(app, issuer, {
      authenticateCaller: () => 'moco',
    });

    const response = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.users.lookup'],
        subject: { id: 'user-7' },
        targetServiceId: 'fizzy',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Service-Plane capability token subject cannot be asserted by callers' });
  });

  it('can mount token and JWKS endpoints together', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });
    const app = new Hono();
    mountCapabilityEndpoints(app, issuer, {
      authenticateCaller: () => 'moco',
      jwks: createCapabilitySigningAuthority({ issuer: 'control-plane', privateJwks: [keys.privateJwk] }),
    });

    expect((await app.request('/.well-known/service-plane/jwks.json')).status).toBe(200);
    const tokenResponse = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({
        scopes: ['fizzy.users.lookup'],
        targetServiceId: 'fizzy',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('cache-control')).toBe('no-store');
    expect(tokenResponse.headers.get('pragma')).toBe('no-cache');
  });

  it('serves JWKS with ETag revalidation', async () => {
    const keys = await testKeys();
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });
    const app = new Hono();
    // A full issuer is still a valid JWKS provider; passing it just accepts the discovery coupling.
    mountCapabilityEndpoints(app, issuer, {
      authenticateCaller: () => 'moco',
      jwks: issuer,
    });

    const first = await app.request('/.well-known/service-plane/jwks.json');
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();

    const revalidated = await app.request('/.well-known/service-plane/jwks.json', {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(await revalidated.text()).toBe('');
  });

  it('generates a private JWK and publishes public JWKS without extra config', async () => {
    const privateJwk = await generateCapabilitySigningJwk({ keyId: 'test-key' });
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [privateJwk],
    });

    const jwks = await issuer.jwks();
    expect(jwks.keys[0]?.kid).toBe('test-key');
    expect(jwks.keys[0]).not.toHaveProperty('d');

    const issued = await issuer.issueCapabilityToken({
      callerAccess: 'service',
      callerServiceId: 'moco',
      scopes: ['fizzy.users.lookup'],
      targetServiceId: 'fizzy',
    });

    await expect(
      verifyCapabilityToken(issued.token, {
        expectedAudience: 'fizzy',
        issuer: 'control-plane',
        jwks,
        requiredScopes: ['fizzy.users.lookup'],
      }),
    ).resolves.toMatchObject({ serviceId: 'moco' });
  });

  it('can create issuers directly from private JWK material and validates key pairs', async () => {
    const keys = await testKeys();
    const issuer = await createCapabilityIssuerFromPrivateJwk({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });

    await expect(issuer.jwks()).resolves.toEqual({ keys: [keys.publicJwk] });

    await expect(
      createCapabilityIssuerFromPrivateJwk({
        capabilities: [fizzyCapabilities],
        grants: defineServiceGrants({
          grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
        }),
        issuer: 'control-plane',
        privateJwks: [{ crv: 'P-256', kid: 'test-key', kty: 'EC' }],
      }),
    ).rejects.toThrow('Service-Plane public JWK does not match private signing key');
  });

  it('publishes the same JWKS from a signing authority as from the full issuer', async () => {
    const keys = await testKeys();
    const authority = createCapabilitySigningAuthority({
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });
    const issuer = createCapabilityIssuer({
      capabilities: [fizzyCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', scopes: ['fizzy.users.lookup'], target: 'fizzy' }],
      }),
      issuer: 'control-plane',
      privateJwks: [keys.privateJwk],
    });

    await expect(authority.jwks()).resolves.toEqual({ keys: [keys.publicJwk] });
    await expect(issuer.jwks()).resolves.toEqual(await authority.jwks());
  });

  it('mounts the JWKS route on a signing authority that cannot issue tokens', async () => {
    const keys = await testKeys();
    const app = new Hono();
    mountCapabilityJwksEndpoint(app, createCapabilitySigningAuthority({ issuer: 'control-plane', privateJwks: [keys.privateJwk] }));

    const response = await app.request('/.well-known/service-plane/jwks.json');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ keys: [keys.publicJwk] });
  });

  it('serves JWKS from the signing authority while the issuer resolver is failing', async () => {
    const keys = await testKeys();
    const app = new Hono();
    mountCapabilityEndpoints(
      app,
      (): CapabilityIssuer => {
        throw new Error('service discovery unavailable');
      },
      {
        authenticateCaller: () => 'moco',
        jwks: createCapabilitySigningAuthority({ issuer: 'control-plane', privateJwks: [keys.privateJwk] }),
      },
    );

    const jwks = await app.request('/.well-known/service-plane/jwks.json');
    expect(jwks.status).toBe(200);
    await expect(jwks.json()).resolves.toEqual({ keys: [keys.publicJwk] });

    const token = await app.request('/.well-known/service-plane/capability-token', {
      body: JSON.stringify({ scopes: ['fizzy.users.lookup'], targetServiceId: 'fizzy' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(token.status).toBe(500);
  });
});

const fizzyCapabilities = defineCapabilities({
  scopes: [
    { id: 'fizzy.users.lookup', title: 'Lookup Fizzy users' },
    { id: 'fizzy.boards.sync', title: 'Sync Fizzy boards' },
  ],
  serviceId: 'fizzy',
});

const whizzyCapabilities = defineCapabilities({
  scopes: [{ id: 'whizzy.jobs.run', title: 'Run Whizzy jobs' }],
  serviceId: 'whizzy',
});
