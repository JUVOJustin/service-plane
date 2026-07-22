import { newHttpBatchRpcSession, RpcTarget as RawRpcTarget, RpcSession } from 'capnweb';
import { Hono } from 'hono';
import { bench, describe } from 'vitest';
import * as z from 'zod';
import { cloudflareServiceBinding, generateCapabilitySigningSecret, ServicePlaneControlPlane } from './control-plane/index.js';
import {
  type AbilityRpc,
  abilityMethod,
  abilitySession,
  cloudflareNativeRpc,
  cloudflareServiceBindingRpc,
  customRpcTransport,
  defineAbility,
  defineCapabilities,
  RpcTarget,
  ServicePlaneService,
} from './service/index.js';
import { memoryRpcTransportPair } from './testing/index.js';

// Measures the overhead service-plane adds over hand-rolled ("native") integrations for the
// website -> control-plane -> worker shape, simulating an LLM: one unary completion and one
// token-delta stream. All fixtures are in-memory, so numbers exclude real network latency and
// isolate CPU cost per call/item (token crypto, Cap'n Web serialization, Zod validation).
// Run with `npm run bench`.

// 100k token deltas by default (BENCH_STREAM_ITEMS overrides); unary benches sample for
// several seconds to wash out one-time effects (JIT, key import, first-fetch caches).
const STREAM_ITEMS = Number(process.env.BENCH_STREAM_ITEMS ?? 100_000);
const UNARY_BENCH = { time: 2_000, warmupTime: 250 };
const STREAM_BENCH = { time: 5_000, warmupIterations: 1 };
const PROMPT = { prompt: 'Explain how streaming works in one paragraph.' };
const DELTAS = Array.from({ length: STREAM_ITEMS }, (_, index) => ({ delta: `token-${index} lorem ipsum `, index }));
const COMPLETION = DELTAS.map((item) => item.delta).join('');

function completeImpl(input: { prompt: string }): { text: string } {
  return { text: `${input.prompt.length}:${COMPLETION.slice(0, 512)}` };
}

function rawDeltaStream(): ReadableStream<{ delta: string; index: number }> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= STREAM_ITEMS) return controller.close();
      controller.enqueue(DELTAS[index++] as { delta: string; index: number });
    },
  });
}

async function drain(stream: ReadableStream<unknown>): Promise<number> {
  const reader = stream.getReader();
  let count = 0;
  while (true) {
    const { done } = await reader.read();
    if (done) return count;
    count += 1;
  }
}

// --- native baselines -----------------------------------------------------------------------

const nativeApp = new Hono();
nativeApp.post('/complete', async (context) => context.json(completeImpl(await context.req.json())));
nativeApp.post('/stream', () => {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= STREAM_ITEMS) return controller.close();
        controller.enqueue(encoder.encode(`${JSON.stringify(DELTAS[index++])}\n`));
      },
    }),
  );
});

class RawLlmTarget extends RawRpcTarget {
  complete(input: { prompt: string }) {
    return completeImpl(input);
  }

  streamTokens() {
    return rawDeltaStream();
  }
}

// --- service-plane fixture ------------------------------------------------------------------

const capabilities = defineCapabilities({ scopes: [{ id: 'llm.call' }], serviceId: 'hub' });

const llmAbility = defineAbility({
  access: 'plane',
  id: 'hub.llm',
  methods: {
    complete: abilityMethod({
      input: z.object({ prompt: z.string() }),
      output: z.object({ text: z.string() }),
      scopes: ['llm.call'],
    }),
    streamCoalesced: abilityMethod({
      coalesce: { maxBufferedBytes: 2048, maxWaitMs: 50 },
      input: z.object({}),
      output: z.object({ delta: z.string(), index: z.number() }),
      scopes: ['llm.call'],
      stream: true,
    }),
    streamLoose: abilityMethod({
      input: z.object({}),
      output: z.unknown(),
      scopes: ['llm.call'],
      stream: true,
    }),
    streamTokens: abilityMethod({
      input: z.object({}),
      output: z.object({ delta: z.string(), index: z.number() }),
      scopes: ['llm.call'],
      stream: true,
    }),
  },
  rpc: { transports: ['http-batch', 'cloudflare-binding-rpc'] },
  scopes: ['llm.call'],
  handler: () => new LlmHandler() as LlmHandler & Record<string, unknown>,
});

class LlmHandler extends RpcTarget {
  async complete(input: { prompt: string }) {
    return completeImpl(input);
  }

  streamCoalesced(_input: Record<string, never>) {
    // Declarative coalescing (see the method definition): the handler yields plain items and
    // the wrapper batches them — 2 KiB or 50 ms, whichever comes first.
    return rawDeltaStream();
  }

  streamLoose(_input: Record<string, never>) {
    return rawDeltaStream();
  }

  streamTokens(_input: Record<string, never>) {
    return rawDeltaStream();
  }
}

let plane: ServicePlaneControlPlane | undefined;
let cachedJwks: { keys: JsonWebKey[] } | undefined;
const signingSecret = generateCapabilitySigningSecret();

const service = new ServicePlaneService({
  abilities: [llmAbility],
  auth: {
    issuer: 'control-plane',
    // Cached after the first fetch, mirroring jwksFromUrl in real deployments.
    jwks: async () => {
      if (!plane) throw new Error('plane not ready');
      cachedJwks ??= (await (await plane.fetch(new Request('https://plane.internal/.well-known/service-plane/jwks.json'))).json()) as {
        keys: JsonWebKey[];
      };
      return cachedJwks;
    },
  },
  capabilities,
  id: 'hub',
  logger: false,
  title: 'Hub',
  version: '0.0.0',
});

plane = new ServicePlaneControlPlane({
  broker: { caller: () => ({ id: 'bench-caller', kind: 'service' as const }) },
  log: false,
  services: () => [
    cloudflareServiceBinding({
      binding: {
        connectAbility: (input: { abilityId: string; requestId?: string; token: string }) => service.connectAbility(input),
        fetch: async (request: Request) => service.fetch(request),
      },
      grants: [
        { caller: 'bench-caller', scopes: ['llm.call'] },
        { caller: 'control-plane', scopes: ['llm.call'] },
      ],
      id: 'hub',
      origin: 'https://hub.internal',
    }),
  ],
  signingSecret: () => signingSecret,
  ttlSeconds: 3600,
});
const boundPlane = plane;

// Route the in-memory hosts through global fetch so capnweb's HTTP-batch client can reach them.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === 'plane.internal') return boundPlane.fetch(request);
  if (url.hostname === 'hub.internal') return service.fetch(request);
  return realFetch(request);
}) as typeof fetch;

// The plane is the control plane only: it mints the token, then the data path goes directly
// caller -> service. The broker keeps the plane in the data path and is only required for
// ingress-protected services.
const issued = await boundPlane.issueCapabilityTokenForCaller('bench-caller', { scopes: ['llm.call'], targetServiceId: 'hub' }, {});
const requestToken = async () => issued;
const sessionOptions = {
  abilityId: 'hub.llm',
  callerServiceId: 'bench-caller',
  requestToken,
  scopes: ['llm.call'],
  targetServiceId: 'hub',
};

type LlmRpc = AbilityRpc<typeof llmAbility>;

// Direct data path over the HTTP-batch transport (token verified per batch).
const directHttpApi = await abilitySession<LlmRpc>({
  ...sessionOptions,
  transport: cloudflareServiceBindingRpc({ fetch: async (request) => service.fetch(request) }, undefined, 'https://hub.internal'),
});

// Direct data path over the native binding (session-shaped; authenticated per session).
const nativeRpcApi = await abilitySession<LlmRpc>({
  ...sessionOptions,
  transport: cloudflareNativeRpc(service),
});

// Direct data path over a persistent Cap'n Web session (≈ WebSocket minus the network):
// the in-memory transport still serializes every message to JSON strings.
class SessionRoot extends RpcTarget {
  authenticate(token: string) {
    return service.connectAbility({ abilityId: 'hub.llm', token });
  }
}
const spPair = memoryRpcTransportPair();
new RpcSession(spPair.right, new SessionRoot());
const sessionApi = await abilitySession<LlmRpc>({
  ...sessionOptions,
  transport: customRpcTransport(spPair.left),
});
await sessionApi.complete(PROMPT); // authenticate once up front, like a real long-lived session

// Raw capnweb baseline over the identical transport, no service-plane layer at all.
const rawPair = memoryRpcTransportPair();
new RpcSession(rawPair.right, new RawLlmTarget());
const rawSession = new RpcSession<RawLlmTarget>(rawPair.left);
const rawApi = rawSession.getRemoteMain();

type BrokerPipeline = {
  ability(
    serviceId: string,
    abilityId: string,
  ): {
    connect(scopes: string[]): LlmRpc;
  };
};

describe(`unary completion: website -> worker (HTTP)`, () => {
  bench(
    'native hono fetch (baseline)',
    async () => {
      const response = await nativeApp.fetch(
        new Request('https://hub.internal/complete', { body: JSON.stringify(PROMPT), method: 'POST' }),
      );
      await response.json();
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane direct (HTTP-batch, token verify per call)',
    async () => {
      await directHttpApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane via control-plane broker (HTTP-batch, pipelined)',
    async () => {
      const root = newHttpBatchRpcSession<Record<string, never>>('https://plane.internal/rpc/broker') as unknown as BrokerPipeline;
      await root.ability('hub', 'hub.llm').connect(['llm.call']).complete(PROMPT);
    },
    UNARY_BENCH,
  );
});

describe(`unary completion: persistent session (≈WebSocket, in-memory)`, () => {
  bench(
    'raw capnweb session (baseline)',
    async () => {
      await rawApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane session (validated)',
    async () => {
      await sessionApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );
});

describe(`stream ${STREAM_ITEMS} LLM token deltas`, () => {
  bench(
    'native hono ReadableStream over fetch (baseline)',
    async () => {
      const response = await nativeApp.fetch(new Request('https://hub.internal/stream', { method: 'POST' }));
      if (!response.body) throw new Error('no body');
      await drain(response.body);
    },
    STREAM_BENCH,
  );

  bench(
    'raw capnweb stream over session (baseline)',
    async () => {
      // Cast: raw capnweb's own types cannot express typed item streams (see PR notes).
      await drain((await rawApi.streamTokens()) as unknown as ReadableStream<unknown>);
    },
    STREAM_BENCH,
  );

  bench(
    'service-plane session (validated per item)',
    async () => {
      await drain(await sessionApi.streamTokens({}));
    },
    STREAM_BENCH,
  );

  bench(
    'service-plane session (schema z.unknown)',
    async () => {
      await drain(await sessionApi.streamLoose({}));
    },
    STREAM_BENCH,
  );

  bench(
    'service-plane session (coalesced 2 KiB / 50 ms batches)',
    async () => {
      await drain(await sessionApi.streamCoalesced({}));
    },
    STREAM_BENCH,
  );

  bench(
    'service-plane native binding (validated, in-process)',
    async () => {
      await drain(await nativeRpcApi.streamTokens({}));
    },
    STREAM_BENCH,
  );
});
