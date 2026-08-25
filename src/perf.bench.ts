import { BatchLinkPlugin } from '@orpc/client/plugins';
import { call, os } from '@orpc/server';
import { BatchHandlerPlugin } from '@orpc/server/plugins';
import { bench, describe } from 'vitest';
import { z } from 'zod';
import { createControlPlaneRpcBroker } from './control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './control-plane/capabilities.js';
import { defineCapabilities } from './service/capabilities.js';
import { createAbilityClient } from './service/client.js';
import { defineAbility } from './service/discovery.js';
import { createAbilityBuilder, createAbilityProcedureRuntimeContext } from './service/orpc.js';
import { ServicePlaneService } from './service/service.js';
import type { CapabilityIdentity } from './shared/types.js';
import { testKeys } from './test-support/index.js';

const ISSUED_AT = new Date('2026-05-09T12:00:00.000Z');
const VERIFIED_AT = new Date('2026-05-09T12:00:01.000Z');
const keys = await testKeys();
const capabilities = defineCapabilities({ scopes: [{ id: 'llm.run' }], serviceId: 'llm' });
const issuer = createCapabilityIssuer({
  capabilities: [capabilities],
  grants: defineServiceGrants({ grants: [{ caller: 'frontend', scopes: ['llm.run'], target: 'llm' }] }),
  issuer: 'control-plane',
  now: () => ISSUED_AT,
  privateJwks: [keys.privateJwk],
});
const issued = await issuer.issueCapabilityToken({
  callerAccess: 'service',
  callerServiceId: 'frontend',
  scopes: ['llm.run'],
  targetServiceId: 'llm',
});
const identity: CapabilityIdentity = {
  audience: 'llm',
  callerAccess: 'service',
  expiresAt: issued.expiresAt,
  issuer: 'control-plane',
  scopes: ['llm.run'],
  serviceId: 'frontend',
  tokenId: 'benchmark',
};
const input = { prompt: 'hello' };
const output = { text: 'HELLO' };
const inputSchema = z.object({ prompt: z.string() });
const outputSchema = z.object({ text: z.string() });

const rawProcedure = os
  .input(inputSchema)
  .output(outputSchema)
  .handler(({ input: value }) => ({ text: value.prompt.toUpperCase() }));

const builder = createAbilityBuilder();
const completion = defineAbility({
  exposure: 'published',
  id: 'llm.completion',
  methods: {
    complete: builder
      .procedure({ scopes: ['llm.run'] })
      .input(inputSchema)
      .output(outputSchema)
      .handler(({ input: value }) => ({ text: value.prompt.toUpperCase() })),
    tokens: builder
      .stream(z.object({ index: z.number() }), { scopes: ['llm.run'] })
      .input(z.object({ count: z.number().int().nonnegative() }))
      .handler(async function* ({ input: value }) {
        for (let index = 0; index < value.count; index += 1) yield { index };
      }),
  },
  rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
  scopes: ['llm.run'],
});
const service = new ServicePlaneService({
  abilities: [completion],
  auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] }, now: () => VERIFIED_AT },
  capabilities,
  id: 'llm',
  logger: false,
  rpc: { plugins: [new BatchHandlerPlugin()] },
  title: 'LLM',
  version: '1.0.0',
});
const runtime = createAbilityProcedureRuntimeContext({
  authorize: () => ({
    abilityId: completion.id,
    context: {} as never,
    env: {},
    identity,
    request: new Request('https://llm.internal/rpc/llm.completion/complete'),
  }),
});
const binding = {
  fetch: async (request: Request) => service.fetch(request),
  invokeAbility: (nativeInput: Parameters<ServicePlaneService['invokeAbility']>[0]) => service.invokeAbility(nativeInput),
};
const nativeClient = createAbilityClient({
  ability: completion,
  callerServiceId: 'frontend',
  requestToken: async () => issued,
  scopes: ['llm.run'],
  targetServiceId: 'llm',
  transport: { binding, origin: 'https://llm.internal', type: 'service-binding' },
});
const fetchClient = createAbilityClient({
  ability: completion,
  callerServiceId: 'frontend',
  requestToken: async () => issued,
  scopes: ['llm.run'],
  targetServiceId: 'llm',
  transport: { fetch: binding, origin: 'https://llm.internal', type: 'fetch' },
});
const batchClient = createAbilityClient({
  ability: completion,
  callerServiceId: 'frontend',
  requestToken: async () => issued,
  scopes: ['llm.run'],
  targetServiceId: 'llm',
  transport: {
    fetch: binding,
    origin: 'https://llm.internal',
    plugins: [new BatchLinkPlugin({ groups: [{ condition: true, context: {} }] })],
    type: 'fetch',
  },
});
const broker = createControlPlaneRpcBroker({
  controlPlaneServiceId: 'control-plane',
  issuer,
  services: [
    {
      abilityRpc: { invokeAbility: (nativeInput) => service.invokeAbility(nativeInput) },
      discovery: () => ({
        ...service.definition,
        abilities: service.definition.abilities.map((ability) => ({
          access: ability.access,
          exposure: ability.exposure,
          id: ability.id,
          methods: Object.fromEntries(
            Object.entries(ability.methods).map(([name, method]) => [
              name,
              {
                inputSchema: method.inputSchema,
                outputSchema: method.outputSchema,
                scopes: method.scopes,
                ...(method.stream ? { stream: true as const } : {}),
              },
            ]),
          ),
          rpc: ability.rpc,
          scopes: ability.scopes,
        })),
      }),
      fetch: binding.fetch,
      grants: [{ caller: 'frontend', scopes: ['llm.run'] }],
      id: 'llm',
      origin: 'https://llm.internal',
    },
  ],
});

function verifyCompletion(value: unknown): void {
  if ((value as { text?: string }).text !== output.text) throw new Error('benchmark call produced an invalid result');
}

describe('oRPC migration throughput', () => {
  bench('raw oRPC procedure call', async () => {
    verifyCompletion(await call(rawProcedure, input));
  });

  bench('Service Plane procedure middleware + schemas', async () => {
    verifyCompletion(await call(completion.methods.complete, input, { context: runtime }));
  });

  bench('ServicePlaneService native invokeAbility', async () => {
    verifyCompletion(
      await service.invokeAbility({
        abilityId: completion.id,
        input,
        method: 'complete',
        token: issued.token,
      }),
    );
  });

  bench('typed client -> Cloudflare native RPC', async () => {
    verifyCompletion(await nativeClient.complete(input));
  });

  bench('typed client -> oRPC Fetch', async () => {
    verifyCompletion(await fetchClient.complete(input));
  });

  bench('control plane -> native service RPC', async () => {
    verifyCompletion(
      await broker.callAbility({
        abilityId: completion.id,
        caller: { id: 'frontend', kind: 'service' },
        input,
        method: 'complete',
        scopes: ['llm.run'],
        targetServiceId: 'llm',
      }),
    );
  });

  bench('10 typed calls in one oRPC batch', async () => {
    const values = await Promise.all(Array.from({ length: 10 }, () => batchClient.complete(input)));
    if (values.length !== 10) throw new Error('benchmark batch produced no samples');
    for (const value of values) verifyCompletion(value);
  });
});

describe('oRPC streaming throughput', () => {
  bench(
    '1,000 validated items over oRPC Fetch',
    async () => {
      const stream = await fetchClient.tokens({ count: 1_000 });
      let count = 0;
      for await (const item of stream as AsyncIterable<{ index: number }>) {
        if (item.index !== count) throw new Error('benchmark stream produced an invalid item');
        count += 1;
      }
      if (count !== 1_000) throw new Error(`benchmark stream produced ${count} items`);
    },
    { iterations: 20 },
  );
});
