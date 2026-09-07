import { call, os } from '@orpc/server';
import { bench, describe } from 'vitest';
import { z } from 'zod';
import { createControlPlaneRpcBroker } from './control-plane/broker.js';
import { createCapabilityIssuer, defineServiceGrants } from './control-plane/capabilities.js';
import { ServicePlaneControlPlane } from './control-plane/control-plane.js';
import { cloudflareServiceBinding } from './control-plane/endpoints.js';
import { createAbilityBuilder } from './service/ability.js';
import { defineCapabilities } from './service/capabilities.js';
import { createAbilityClient, createBrokeredAbilityClient } from './service/client.js';
import { defineAbility, serviceDiscoveryDocument } from './service/discovery.js';
import { compileAbilityMethod, createAbilityRpcRuntimeContext } from './service/orpc.js';
import { ServicePlaneService } from './service/service.js';
import { SERVICE_PLANE_RPC_PROTOCOL } from './shared/rpc-protocol.js';
import type { CapabilityIdentity } from './shared/types.js';
import { testKeys } from './test-support/index.js';

// All adapters below run in the same Node process. These measurements isolate library overhead;
// they include neither network latency nor Cloudflare's RPC serialization, scheduling, or billing.
const keys = await testKeys();
const signingSecret = keys.privateJwk.d;
if (!signingSecret) throw new Error('benchmark signing key is missing private material');
const capabilities = defineCapabilities({ scopes: [{ id: 'llm.run' }], serviceId: 'llm' });
const issuer = createCapabilityIssuer({
  capabilities: [capabilities],
  grants: defineServiceGrants({ grants: [{ caller: 'frontend', scopes: ['llm.run'], target: 'llm' }] }),
  issuer: 'control-plane',
  privateJwks: [keys.privateJwk],
  ttlSeconds: 3_600,
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
    complete: builder.method({
      handler: ({ input: value }) => ({ text: value.prompt.toUpperCase() }),
      input: inputSchema,
      output: outputSchema,
      scopes: ['llm.run'],
    }),
    tokens: builder.stream({
      handler: async function* ({ input: value }) {
        for (let index = 0; index < value.count; index += 1) yield { index };
      },
      input: z.object({ count: z.number().int().nonnegative() }),
      output: z.object({ index: z.number() }),
      scopes: ['llm.run'],
    }),
  },
  rpc: { transports: ['fetch', 'service-binding'] },
  scopes: ['llm.run'],
});
const service = new ServicePlaneService({
  abilities: [completion],
  auth: { issuer: 'control-plane', jwks: { keys: [keys.publicJwk] } },
  capabilities,
  id: 'llm',
  ingress: false,
  logger: false,
  rpc: { batch: true },
  title: 'LLM',
  version: '1.0.0',
});
const runtime = createAbilityRpcRuntimeContext({
  authorize: () => ({
    context: {
      abilityId: completion.id,
      context: {} as never,
      env: {},
      identity,
      request: new Request('https://llm.internal/rpc/v1/llm.completion/complete'),
    },
  }),
});
const binding = {
  fetch: async (request: Request) => service.fetch(request),
  invokeAbility: (nativeInput: Parameters<ServicePlaneService['invokeAbility']>[0]) => service.invokeAbility(nativeInput),
};
const compiledCompletion = compileAbilityMethod(completion.methods.complete);
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
    batch: true,
    fetch: binding,
    origin: 'https://llm.internal',
    type: 'fetch',
  },
});
const broker = createControlPlaneRpcBroker({
  controlPlaneServiceId: 'control-plane',
  issuer,
  services: [
    {
      abilityRpc: { invokeAbility: (nativeInput) => service.invokeAbility(nativeInput) },
      discovery: () => serviceDiscoveryDocument(service.definition),
      fetch: binding.fetch,
      grants: [{ caller: 'frontend', scopes: ['llm.run'] }],
      id: 'llm',
      origin: 'https://llm.internal',
    },
  ],
});
const plane = new ServicePlaneControlPlane({
  broker: { batch: true },
  controlPlaneServiceId: 'control-plane',
  invocationMiddleware: async (context, next) => {
    context.set('servicePlaneCaller', { id: 'frontend', kind: 'service' });
    await next();
  },
  log: false,
  openapi: false,
  services: () => [
    cloudflareServiceBinding({
      abilityRpc: binding,
      binding,
      grants: [{ caller: 'frontend', scopes: ['llm.run'] }],
      id: 'llm',
      origin: 'https://llm.internal',
    }),
  ],
  signingKeys: () => [{ kid: keys.privateJwk.kid ?? 'benchmark-key', secret: signingSecret }],
});
const publicBrokerClient = createBrokeredAbilityClient({
  ability: completion,
  targetServiceId: 'llm',
  transport: {
    fetch: async (url, init) => plane.fetch(new Request(url, init)),
    origin: 'https://plane.internal',
  },
});
const publicBrokerBatchClient = createBrokeredAbilityClient({
  ability: completion,
  targetServiceId: 'llm',
  transport: {
    batch: true,
    fetch: async (url, init) => plane.fetch(new Request(url, init)),
    origin: 'https://plane.internal',
  },
});

function verifyCompletion(value: unknown): void {
  if ((value as { text?: string }).text !== output.text) throw new Error('benchmark call produced an invalid result');
}

describe('Service Plane RPC throughput', () => {
  bench('raw oRPC procedure call', async () => {
    verifyCompletion(await call(rawProcedure, input));
  });

  bench('Service Plane method middleware + schemas', async () => {
    verifyCompletion(await call(compiledCompletion, input, { context: runtime }));
  });

  bench('ServicePlaneService.invokeAbility (in-process)', async () => {
    verifyCompletion(
      await service.invokeAbility({
        abilityId: completion.id,
        input,
        method: 'complete',
        protocol: SERVICE_PLANE_RPC_PROTOCOL,
        token: issued.token,
      }),
    );
  });

  bench('typed client -> local JS service-binding adapter', async () => {
    verifyCompletion(await nativeClient.complete(input));
  });

  bench('typed client -> local Service Plane Fetch', async () => {
    verifyCompletion(await fetchClient.complete(input));
  });

  bench('control plane -> local JS service-binding adapter', async () => {
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

  bench('typed public client -> local plane Fetch -> local JS binding', async () => {
    verifyCompletion(await publicBrokerClient.complete(input));
  });
});

describe('Service Plane local batch throughput (10 logical calls per sample)', () => {
  bench('10 concurrent typed calls over separate local Fetch requests', async () => {
    const values = await Promise.all(Array.from({ length: 10 }, () => fetchClient.complete(input)));
    for (const value of values) verifyCompletion(value);
  });

  bench('10 concurrent typed calls in one local Fetch batch', async () => {
    const values = await Promise.all(Array.from({ length: 10 }, () => batchClient.complete(input)));
    if (values.length !== 10) throw new Error('benchmark batch produced no samples');
    for (const value of values) verifyCompletion(value);
  });

  bench('10 concurrent public calls over separate local plane Fetch requests', async () => {
    const values = await Promise.all(Array.from({ length: 10 }, () => publicBrokerClient.complete(input)));
    for (const value of values) verifyCompletion(value);
  });

  bench('10 concurrent public calls in one local plane Fetch batch', async () => {
    const values = await Promise.all(Array.from({ length: 10 }, () => publicBrokerBatchClient.complete(input)));
    if (values.length !== 10) throw new Error('benchmark public broker batch produced no samples');
    for (const value of values) verifyCompletion(value);
  });
});

describe('Service Plane streaming throughput', () => {
  bench(
    '1,000 validated items over local Service Plane Fetch',
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
