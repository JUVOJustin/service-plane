import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCapabilityIssuer, defineServiceGrants } from '../control-plane/capabilities.js';
import { testKeys } from '../test-support/index.js';
import { createAbilityBuilder } from './ability.js';
import { defineCapabilities } from './capabilities.js';
import { createAbilityClient } from './client.js';
import { defineAbility } from './discovery.js';
import { ServicePlaneService } from './service.js';

// Valid capabilities alone must not let callers bypass the public control plane.
describe('protected service ingress defaults', () => {
  for (const transport of ['fetch', 'service-binding'] as const) {
    it(`requires an allowed broker before validation on ${transport}`, async () => {
      const fixture = await ingressFixture();
      const direct = await fixture.token();
      const wrongBroker = await fixture.token('another-plane');
      const brokered = await fixture.token('control-plane');

      await expect(fixture.client(direct, transport).read({})).rejects.toMatchObject({ status: 403 });
      await expect(fixture.client(wrongBroker, transport).read({})).rejects.toMatchObject({ status: 403 });
      expect(fixture.validations()).toBe(0);
      expect(fixture.executions()).toBe(0);

      await expect(fixture.client(brokered, transport).read({})).resolves.toEqual({ ok: true });
      expect(fixture.validations()).toBe(1);
      expect(fixture.executions()).toBe(1);
    });
  }

  it('advertises protected ingress without requiring an extra configuration option', async () => {
    const fixture = await ingressFixture();
    const response = await fixture.service.fetch(new Request('https://service.internal/.well-known/service-plane/service.json'));
    expect(await response.json()).toMatchObject({ ingress: { required: true } });
  });

  it('permits direct capabilities only with an explicit opt-out', async () => {
    const fixture = await ingressFixture(false);
    const direct = await fixture.token();
    await expect(fixture.client(direct, 'fetch').read({})).resolves.toEqual({ ok: true });
    const response = await fixture.service.fetch(new Request('https://service.internal/.well-known/service-plane/service.json'));
    expect(await response.json()).not.toHaveProperty('ingress');
  });
});

// The token issuer name intentionally differs from the authorized broker identity.
async function ingressFixture(ingress?: false) {
  const keys = await testKeys();
  const capabilities = defineCapabilities({ scopes: [{ id: 'tasks.read' }], serviceId: 'tasks' });
  const issuer = createCapabilityIssuer({
    capabilities: [capabilities],
    grants: defineServiceGrants({ grants: [{ caller: 'caller', scopes: ['tasks.read'], target: 'tasks' }] }),
    issuer: 'https://issuer.example',
    privateJwks: [keys.privateJwk],
  });
  let validations = 0;
  let executions = 0;
  const tasks = defineAbility({
    id: 'tasks',
    scopes: ['tasks.read'],
    rpc: { transports: ['fetch', 'service-binding'] },
    methods: {
      read: createAbilityBuilder().method({
        input: z.object({}).refine(() => {
          validations += 1;
          return true;
        }),
        output: z.object({ ok: z.boolean() }),
        scopes: ['tasks.read'],
        handler: () => {
          executions += 1;
          return { ok: true };
        },
      }),
    },
  });
  const service = new ServicePlaneService({
    abilities: [tasks],
    auth: { issuer: 'https://issuer.example', jwks: { keys: [keys.publicJwk] } },
    capabilities,
    id: 'tasks',
    ...(ingress === false ? { ingress } : {}),
    logger: false,
    title: 'Tasks',
    version: '1.0.0',
  });
  return {
    service,
    validations: () => validations,
    executions: () => executions,
    token: async (brokerServiceId?: string) => {
      const input = { callerAccess: 'plane' as const, callerServiceId: 'caller', scopes: ['tasks.read'], targetServiceId: 'tasks' };
      return brokerServiceId ? issuer.issueBrokeredCapabilityToken({ ...input, brokerServiceId }) : issuer.issueCapabilityToken(input);
    },
    client: (issued: { token: string; expiresAt: Date }, type: 'fetch' | 'service-binding') =>
      createAbilityClient({
        ability: tasks,
        targetServiceId: 'tasks',
        tokenProvider: { token: async () => issued.token },
        transport:
          type === 'fetch'
            ? { type, fetch: { fetch: async (request) => service.fetch(request) } }
            : { type, binding: { invokeAbility: (input) => service.invokeAbility(input) } },
      }),
  };
}
