import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createAbilityBuilder,
  createBrokeredAbilityClient,
  defineAbility,
  defineCapabilities,
  ServicePlaneService,
} from '../service/index.js';
import { publicJwkFromPrivateJwk } from '../shared/jwk-auth.js';
import type { ControlPlaneAuthorizationInvocation, ControlPlaneInvocationAuthorizer } from './caller.js';
import { ServicePlaneControlPlane } from './control-plane.js';
import { cloudflareServiceBinding } from './endpoints.js';
import { generateCapabilitySigningSecret, privateJwkFromCapabilitySigningSecret } from './signing-keys.js';

type Surface = 'rpc' | 'rest' | 'mcp' | 'in-process';

// Every facade reaches a real ingress-protected service, so policy cannot merely hide a response after execution.
async function fixture(authorizeInvocation: ControlPlaneInvocationAuthorizer, native = true, granted = true) {
  const secret = await generateCapabilitySigningSecret();
  const privateJwk = privateJwkFromCapabilitySigningSecret(secret, 'policy-test');
  const handler = vi.fn(() => ({ ok: true }));
  const method = createAbilityBuilder();
  const contract = defineAbility({
    exposure: 'published',
    id: 'tasks',
    methods: {
      read: method.method({
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler,
        mcp: { name: 'tasks_read' },
        rest: { method: 'get', path: '/tasks/read' },
        scopes: ['tasks.read'],
      }),
      write: method.method({
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        handler,
        mcp: { name: 'tasks_write' },
        rest: { method: 'get', path: '/tasks/write' },
        scopes: ['tasks.write'],
      }),
    },
    rpc: { transports: ['fetch', 'service-binding'] },
    scopes: ['tasks.read', 'tasks.write'],
  });
  const service = new ServicePlaneService({
    abilities: [contract],
    auth: { jwks: { keys: [publicJwkFromPrivateJwk(privateJwk, 'policy-test')] } },
    capabilities: defineCapabilities({ serviceId: 'tasks-service', scopes: [{ id: 'tasks.read' }, { id: 'tasks.write' }] }),
    id: 'tasks-service',
    logger: false,
    title: 'Tasks',
    version: '1.0.0',
  });
  const endpoint = cloudflareServiceBinding({
    ...(native
      ? { abilityRpc: { invokeAbility: (input: Parameters<typeof service.invokeAbility>[0]) => service.invokeAbility(input) } }
      : {}),
    binding: { fetch: async (request) => service.fetch(request) },
    grants: granted ? [{ caller: 'control-plane', scopes: ['tasks.read', 'tasks.write'] }] : [],
    id: 'tasks-service',
  });
  const signingKeys = vi.fn(() => [{ kid: 'policy-test', secret }]);
  const plane = new ServicePlaneControlPlane({
    authorizeInvocation,
    broker: { batch: true },
    invocationMiddleware: async (context, next) => {
      context.set('servicePlaneCaller', { id: context.req.header('x-test-caller') ?? 'alice', kind: 'user' });
      await next();
    },
    log: false,
    mcp: {},
    openapi: false,
    services: () => [endpoint],
    signingKeys,
  });
  const client = (caller = 'alice') =>
    createBrokeredAbilityClient({
      ability: contract,
      targetServiceId: 'tasks-service',
      transport: {
        batch: true,
        headers: { 'x-test-caller': caller },
        origin: 'https://plane.internal',
        fetch: (url, init) => Promise.resolve(plane.fetch(new Request(url, init))),
      },
    });
  const invoke = async (surface: Surface, name: 'read' | 'write', caller = 'alice') => {
    if (surface === 'rpc' || surface === 'in-process') {
      const methods =
        surface === 'rpc'
          ? client(caller)
          : plane.abilityClient({ ability: contract, caller: { id: caller, kind: 'user' }, targetServiceId: 'tasks-service' }, {});
      try {
        return { allowed: true, result: await methods[name]({}) };
      } catch (error) {
        return { allowed: false, error };
      }
    }
    const response =
      surface === 'rest'
        ? await plane.fetch(new Request(`https://plane.internal/tasks/${name}`, { headers: { 'x-test-caller': caller } }))
        : await plane.fetch(
            new Request('https://plane.internal/mcp', {
              body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: {}, name: `tasks_${name}` } }),
              headers: { 'content-type': 'application/json', 'x-test-caller': caller },
              method: 'POST',
            }),
          );
    const result = (await response.json()) as { error?: unknown; result?: { isError?: boolean } };
    return { allowed: response.ok && !result.error && !result.result?.isError, result };
  };
  return { client, contract, endpoint, handler, invoke, plane, signingKeys };
}

describe('per-invocation product authorization', () => {
  it.each(['rpc', 'rest', 'mcp', 'in-process'] as const)(
    'checks authenticated caller and method before %s token issuance',
    async (surface) => {
      const authorize = vi.fn(
        (invocation: ControlPlaneAuthorizationInvocation) => invocation.caller?.id === 'alice' && invocation.method === 'read',
      );
      const test = await fixture(authorize);

      expect((await test.invoke(surface, 'read', 'bob')).allowed).toBe(false);
      expect((await test.invoke(surface, 'write')).allowed).toBe(false);
      expect(test.handler).not.toHaveBeenCalled();
      expect(test.signingKeys).not.toHaveBeenCalled();
      expect((await test.invoke(surface, 'read')).allowed).toBe(true);
      expect(test.handler).toHaveBeenCalledOnce();
      expect(authorize.mock.calls.map(([call]) => [call.caller?.id, call.method])).toEqual([
        ['bob', 'read'],
        ['alice', 'write'],
        ['alice', 'read'],
      ]);
    },
  );

  it('applies policy independently to concurrent logical calls in one Fetch batch', async () => {
    const authorize = vi.fn((invocation: ControlPlaneAuthorizationInvocation) => invocation.method === 'read');
    const test = await fixture(authorize, false);
    const client = test.client();
    const [read, write] = await Promise.allSettled([client.read({}), client.write({})]);

    expect(read).toEqual({ status: 'fulfilled', value: { ok: true } });
    expect(write).toMatchObject({ status: 'rejected', reason: { status: 403 } });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(test.handler).toHaveBeenCalledOnce();
  });

  it.each([
    ['false', (): boolean => false],
    ['undefined', (): boolean => undefined as unknown as boolean],
    [
      'exception',
      (): boolean => {
        throw new Error('secret-policy-credential');
      },
    ],
  ] as const)('fails closed for a policy returning %s', async (_name, authorize) => {
    const test = await fixture(authorize);
    const result = await test.invoke('rpc', 'read');

    expect(result).toMatchObject({ allowed: false, error: { status: 403, message: 'Service-Plane invocation is not permitted' } });
    expect(JSON.stringify(result)).not.toContain('secret-policy-credential');
    expect(test.handler).not.toHaveBeenCalled();
    expect(test.signingKeys).not.toHaveBeenCalled();
  });

  it('freezes detached authorization facts and still requires the configured service grant', async () => {
    const authorize = vi.fn((invocation: ControlPlaneAuthorizationInvocation) => {
      expect(Object.isFrozen(invocation)).toBe(true);
      expect(Object.isFrozen(invocation.caller)).toBe(true);
      expect(Object.isFrozen(invocation.scopes)).toBe(true);
      expect(Reflect.set(invocation.caller as object, 'kind', 'service')).toBe(false);
      return true;
    });
    const test = await fixture(authorize, true, false);

    expect((await test.invoke('rpc', 'read')).allowed).toBe(false);
    expect(authorize).toHaveBeenCalledOnce();
    expect(test.handler).not.toHaveBeenCalled();
  });
});
