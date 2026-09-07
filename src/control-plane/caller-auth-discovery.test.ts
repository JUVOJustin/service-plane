import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bytesToBase64Url } from '../shared/encoding.js';
import {
  generateServicePlaneJwkSigningKey,
  publicJwkFromPrivateJwk,
  SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_JWK_CLIENT_HEADER,
  SERVICE_PLANE_JWK_KEY_ID_HEADER,
  servicePlaneJwkThumbprint,
  signServicePlaneJwkRequest,
} from '../shared/jwk-auth.js';
import {
  type RegistryCache,
  SERVICE_PLANE_REQUEST_ID_HEADER,
  type ServiceDiscoveryDocument,
  type ServiceEndpoint,
} from '../shared/types.js';
import { type JwkServiceClientAuthOptions, jwkServiceClientAuth } from './caller-auth.js';
import { cloudflareServiceBinding, httpsService } from './endpoints.js';
import { memoryRegistryCache } from './registry.js';

const NOW = new Date('2099-08-15T10:00:00.000Z');
const KEY_ID = 'caller-key';
let privateJwk: JsonWebKey;
let otherPrivateJwk: JsonWebKey;

beforeAll(async () => {
  [privateJwk, otherPrivateJwk] = await Promise.all([
    generateServicePlaneJwkSigningKey({ keyId: KEY_ID }),
    generateServicePlaneJwkSigningKey({ keyId: KEY_ID }),
  ]);
});

afterEach(() => vi.useRealTimers());

describe('JWK caller discovery', () => {
  it('does not generate randomness during module-scope authenticator configuration', () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');
    try {
      jwkServiceClientAuth({ clients: [] });
      expect(randomUUID).not.toHaveBeenCalled();
      expect(getRandomValues).not.toHaveBeenCalled();
    } finally {
      randomUUID.mockRestore();
      getRandomValues.mockRestore();
    }
  });

  it.each([
    ['missing key header', compactAssertion(), ''],
    ['malformed compact assertion', 'invalid-assertion', KEY_ID],
    ['empty signature', compactAssertion().replace(/[^.]+$/u, ''), KEY_ID],
    ['truncated signature', compactAssertion().slice(0, -1), KEY_ID],
    ['invalid encoding', '%%%.e30.AA', KEY_ID],
    ['unsupported algorithm', compactAssertion({ alg: 'HS256', kid: KEY_ID }), KEY_ID],
    ['mismatched key id', compactAssertion({ alg: 'ES256', kid: 'other-key' }), KEY_ID],
    ['invalid type header', compactAssertion({ alg: 'ES256', kid: KEY_ID, typ: 'other' }), KEY_ID],
  ])('rejects %s before resolving clients or services', async (_name, assertion, keyId) => {
    const selected = endpoint('workflow');
    const clients = vi.fn(() => []);
    const services = vi.fn(() => [selected]);
    const app = authApp({ clients, services });

    const response = await app.request(unsignedRequest('workflow', assertion, keyId));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME);
    expect(clients).not.toHaveBeenCalled();
    expect(services).not.toHaveBeenCalled();
    expect(selected.fetch).not.toHaveBeenCalled();
  });

  it('does not discover any service for an unknown client', async () => {
    const services = [endpoint('workflow'), endpoint('tasks')];
    const response = await authApp({ services }).request(unsignedRequest('unknown'));

    expect(response.status).toBe(401);
    for (const service of services) expect(service.fetch).not.toHaveBeenCalled();
  });

  it('discovers only the selected endpoint and still rejects an invalid signature', async () => {
    const selected = endpoint('workflow');
    const unrelated = endpoint('tasks');
    const response = await authApp({ services: [unrelated, selected] }).request(unsignedRequest('workflow'));

    expect(response.status).toBe(401);
    expect(selected.fetch).toHaveBeenCalledTimes(1);
    expect(unrelated.fetch).not.toHaveBeenCalled();
  });

  it('coalesces concurrent requests and reuses discovery for repeated invalid signatures', async () => {
    const selected = endpoint('workflow');
    const app = authApp({ services: [selected] });
    const responses = await Promise.all(Array.from({ length: 12 }, () => app.request(unsignedRequest('workflow'))));
    responses.push(await app.request(unsignedRequest('workflow')));

    expect(responses.every((response) => response.status === 401)).toBe(true);
    expect(selected.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['service binding', 'HTTPS'] as const)('reuses request-created %s endpoints and isolates their actual sources', async (kind) => {
    const first = { fetch: vi.fn(async (_request: RequestInfo | URL) => Response.json(document('workflow'))) };
    const second = { fetch: vi.fn(async (_request: RequestInfo | URL) => Response.json(document('workflow', otherPrivateJwk))) };
    let source = first;
    const app = authApp({
      services: () => [
        kind === 'service binding'
          ? cloudflareServiceBinding({ binding: source, id: 'workflow' })
          : httpsService({ baseUrl: 'https://workflow.internal', fetch: source.fetch, id: 'workflow' }),
      ],
    });
    await Promise.all(Array.from({ length: 8 }, () => app.request(unsignedRequest('workflow'))));
    expect((await app.request(await signedRequest('workflow'))).status).toBe(200);
    expect(first.fetch).toHaveBeenCalledTimes(1);

    source = second;
    expect((await app.request(await signedRequest('workflow'))).status).toBe(401);
    expect((await app.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent discovery across many configured callers without evicting pending fills', async () => {
    vi.useFakeTimers();
    const services = Array.from({ length: 129 }, (_, index) => endpoint(`caller-${index}`));
    for (const service of services) service.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const app = authApp({ services });
    const pending = services.slice(0, 128).map((service) => app.request(unsignedRequest(service.id)));
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.request(unsignedRequest('caller-128'))).status).toBe(401);
    expect(services[128]?.fetch).not.toHaveBeenCalled();
    pending.push(app.request(unsignedRequest('caller-0')));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await Promise.all(pending)).every((response) => response.status === 401)).toBe(true);
    for (const service of services.slice(0, 128)) expect(service.fetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes the default cache after 30 seconds', async () => {
    vi.useFakeTimers();
    const selected = endpoint('workflow');
    const app = authApp({ services: [selected] });
    await app.request(unsignedRequest('workflow'));
    await vi.advanceTimersByTimeAsync(29_999);
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(2);
  });

  it('honors the configured discovery TTL without requiring an external cache', async () => {
    vi.useFakeTimers();
    const selected = endpoint('workflow');
    const app = authApp({ registryCacheTtlSeconds: 2, services: [selected] });
    await app.request(unsignedRequest('workflow'));
    await vi.advanceTimersByTimeAsync(1_999);
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(2);
  });

  it('briefly suppresses failed discovery and recovers on the next retry window', async () => {
    vi.useFakeTimers();
    const selected = endpoint('workflow');
    selected.fetch.mockRejectedValueOnce(new Error('temporarily unavailable'));
    const app = authApp({ services: [selected] });
    await app.request(unsignedRequest('workflow'));
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await app.request(unsignedRequest('workflow'));
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['fetch', 'response body'] as const)('times out a stuck %s and permits healthy discovery afterward', async (stuckAt) => {
    vi.useFakeTimers();
    const selected = endpoint('workflow');
    const cancel = vi.fn();
    if (stuckAt === 'fetch') selected.fetch.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    else selected.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const app = authApp({ services: [selected] });
    const pending = app.request(unsignedRequest('workflow'));
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(401);
    if (stuckAt === 'response body') expect(cancel).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps caller entries separate when the external registry cache key is explicit', async () => {
    const workflow = endpoint('workflow');
    const tasks = endpoint('tasks', otherPrivateJwk);
    const cache = memoryRegistryCache();
    const app = authApp({ registryCache: cache, registryCacheKey: 'caller-auth', services: [workflow, tasks] });
    const workflowResponse = await app.request(await signedRequest('workflow'));
    const tasksResponse = await app.request(await signedRequest('tasks', otherPrivateJwk));

    expect(workflowResponse.status).toBe(200);
    expect(tasksResponse.status).toBe(200);
    expect(workflow.fetch).toHaveBeenCalledTimes(1);
    expect(tasks.fetch).toHaveBeenCalledTimes(1);
  });

  it('isolates authenticators sharing an external cache and endpoint identity', async () => {
    const trusted = endpoint('workflow');
    const other = endpoint('workflow', otherPrivateJwk);
    const registryCache = memoryRegistryCache();
    const first = authApp({ registryCache, registryCacheKey: 'shared', services: [trusted] });
    const second = authApp({ registryCache, registryCacheKey: 'shared', services: [other] });
    expect((await first.request(await signedRequest('workflow'))).status).toBe(200);
    expect((await second.request(await signedRequest('workflow'))).status).toBe(401);
    expect((await second.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
    expect(other.fetch).toHaveBeenCalledTimes(1);
  });

  it('isolates changed discovery bindings behind the same configured id and origin', async () => {
    const first = endpoint('workflow');
    const second = endpoint('workflow', otherPrivateJwk);
    let selected: ServiceEndpoint = first;
    const app = authApp({ registryCache: memoryRegistryCache(), registryCacheKey: 'shared', services: () => [selected] });
    expect((await app.request(await signedRequest('workflow'))).status).toBe(200);
    selected = second;
    expect((await app.request(await signedRequest('workflow'))).status).toBe(401);
    expect((await app.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });

  it('isolates changed inline discovery documents and coalesces their resolver', async () => {
    const first = vi.fn(async () => document('workflow'));
    const second = vi.fn(async () => document('workflow', otherPrivateJwk));
    const selected = endpoint('workflow');
    let discovery = first;
    const app = authApp({ services: () => [{ ...selected, discovery }] });
    expect((await app.request(await signedRequest('workflow'))).status).toBe(200);
    await app.request(unsignedRequest('workflow'));
    expect(first).toHaveBeenCalledTimes(1);
    discovery = second;
    expect((await app.request(await signedRequest('workflow'))).status).toBe(401);
    expect((await app.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
    expect(second).toHaveBeenCalledTimes(1);
    expect(selected.fetch).not.toHaveBeenCalled();
  });

  it('does not let a timed-out fill overwrite keys cached by a healthy retry', async () => {
    vi.useFakeTimers();
    const selected = endpoint('workflow', otherPrivateJwk);
    let complete: ((response: Response) => void) | undefined;
    selected.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const cache = memoryRegistryCache();
    const set = vi.spyOn(cache, 'set');
    const app = authApp({ registryCache: cache, services: [selected] });
    const timedOut = app.request(unsignedRequest('workflow'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await timedOut).status).toBe(401);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await app.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
    expect(set).toHaveBeenCalledTimes(1);
    const cancel = vi.fn();
    complete?.(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect((await app.request(await signedRequest('workflow'))).status).toBe(401);
    expect((await app.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
  });

  it('isolates a changed endpoint origin even when its fetch function stays the same', async () => {
    const fetch = vi.fn(async (request: Request) =>
      Response.json(document('workflow', new URL(request.url).hostname === 'first.internal' ? privateJwk : otherPrivateJwk)),
    );
    let origin = 'https://first.internal';
    const app = authApp({
      registryCache: memoryRegistryCache(),
      registryCacheKey: 'shared',
      services: () => [{ fetch, id: 'workflow', origin }],
    });
    expect((await app.request(await signedRequest('workflow'))).status).toBe(200);
    origin = 'https://second.internal';
    expect((await app.request(await signedRequest('workflow'))).status).toBe(401);
    expect((await app.request(await signedRequest('workflow', otherPrivateJwk))).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('authenticates signed callers and preserves signer confirmation', async () => {
    const selected = endpoint('workflow');
    const response = await authApp({ services: [selected] }).request(await signedRequest('workflow'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      confirmation: { jkt: await servicePlaneJwkThumbprint(publicJwkFromPrivateJwk(privateJwk, KEY_ID)) },
      serviceId: 'workflow',
    });
  });

  it.each(['body', 'query', 'request id', 'audience'] as const)('still refuses a signed assertion with the wrong %s', async (part) => {
    const selected = endpoint('workflow');
    const app = authApp({ services: [selected], ...(part === 'audience' ? { assertionAudience: 'other-plane' } : {}) });
    let request = await signedRequest('workflow');
    if (part === 'body') request = new Request(request, { body: '{"changed":true}' });
    if (part === 'query') request = new Request(`${request.url}?changed=true`, request);
    if (part === 'request id') request.headers.set(SERVICE_PLANE_REQUEST_ID_HEADER, 'other-request');

    const response = await app.request(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('keeps explicit clients ahead of discovery and honors custom headers and audience', async () => {
    const services = vi.fn(() => [endpoint('workflow', otherPrivateJwk)]);
    const app = authApp({
      assertionAudience: () => 'custom-audience',
      clientIdHeader: 'custom-client',
      clients: [{ clientId: 'workflow', jwks: { keys: [publicJwkFromPrivateJwk(privateJwk, KEY_ID)] }, serviceId: 'mapped-service' }],
      keyIdHeader: 'custom-key',
      requestIdHeader: 'custom-request',
      services,
    });
    const request = await signServicePlaneJwkRequest(
      new Request('https://plane.example/token', { body: '{}', headers: { 'custom-request': 'request-123' }, method: 'POST' }),
      {
        audience: 'custom-audience',
        clientId: 'workflow',
        clientIdHeaderName: 'custom-client',
        keyId: KEY_ID,
        keyIdHeaderName: 'custom-key',
        now: NOW,
        privateJwk,
        requestIdHeaderName: 'custom-request',
      },
    );
    const response = await app.request(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ serviceId: 'mapped-service' });
    expect(services).not.toHaveBeenCalled();
  });

  it('continues caching locally when an external cache is unavailable', async () => {
    const failed = async () => {
      throw new Error('cache unavailable');
    };
    const registryCache: RegistryCache = { get: failed, set: failed };
    const selected = endpoint('workflow');
    const app = authApp({ registryCache, services: [selected] });
    await app.request(unsignedRequest('workflow'));
    await app.request(unsignedRequest('workflow'));
    expect(selected.fetch).toHaveBeenCalledTimes(1);
  });
});

// Exercise the public authenticator independently of later token-issuer discovery.
function authApp(options: JwkServiceClientAuthOptions): Hono {
  const authenticate = jwkServiceClientAuth({ log: () => undefined, now: () => NOW, ...options });
  const app = new Hono();
  app.post('/token', async (context) => {
    const result = await authenticate(context);
    return result instanceof Response ? result : context.json(result);
  });
  return app;
}

// Discovery has valid metadata, so failures identify authentication behavior.
function document(id: string, signingKey = privateJwk): ServiceDiscoveryDocument {
  return {
    abilities: [],
    callerAuth: { jwks: { keys: [publicJwkFromPrivateJwk(signingKey, KEY_ID)] } },
    capabilities: { scopes: [], serviceId: id },
    id,
    title: id,
    version: '1.0.0',
  };
}

// Keep fetch identity stable while testing request-local endpoint resolution.
function endpoint(id: string, signingKey = privateJwk) {
  return { fetch: vi.fn(async (_request: Request) => Response.json(document(id, signingKey))), id, origin: `https://${id}.internal` };
}

// A shaped but unsigned assertion reaches selected discovery without authenticating.
function compactAssertion(header: unknown = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' }): string {
  const encodedHeader = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  return `${encodedHeader}.e30.${'A'.repeat(86)}`;
}

// Keep malformed requests independent from cryptographic signing helpers.
function unsignedRequest(clientId: string, assertion = compactAssertion(), keyId: string | undefined = KEY_ID): Request {
  return new Request('https://plane.example/token', {
    body: '{}',
    headers: {
      authorization: `${SERVICE_PLANE_JWK_AUTHORIZATION_SCHEME} ${assertion}`,
      [SERVICE_PLANE_JWK_CLIENT_HEADER]: clientId,
      ...(keyId ? { [SERVICE_PLANE_JWK_KEY_ID_HEADER]: keyId } : {}),
    },
    method: 'POST',
  });
}

// Sign exactly the body and route used by the authenticator fixture.
function signedRequest(clientId: string, signingKey = privateJwk): Promise<Request> {
  return signServicePlaneJwkRequest(new Request('https://plane.example/token', { body: '{}', method: 'POST' }), {
    clientId,
    keyId: KEY_ID,
    now: NOW,
    privateJwk: signingKey,
  });
}
