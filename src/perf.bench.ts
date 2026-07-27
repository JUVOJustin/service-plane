import { newHttpBatchRpcSession, RpcTarget as RawRpcTarget, RpcSession } from 'capnweb';
import { Hono } from 'hono';
import { bench, describe } from 'vitest';
import * as z from 'zod';
import {
  cloudflareServiceBinding,
  createCapabilityIssuerFromSigningKeys,
  createControlPlaneRpcBroker,
  createServiceRegistry,
  defineServiceGrants,
  generateCapabilitySigningSecret,
  ServicePlaneControlPlane,
} from './control-plane/index.js';
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

// Compares hand-rolled ("native") integrations against service-plane for the shapes that matter
// in production, simulating an LLM workload (one unary completion, one token-delta stream):
//
//   1. request -> plane worker -> service worker, one call per request
//   2. frequent service-to-service calls where tokens/keys/connections amortize
//   3. streaming many token deltas, direct and through the plane
//
// Everything runs in-memory: numbers exclude network latency and isolate CPU cost per call/item
// (token crypto, Cap'n Web serialization, Zod validation). Run with `npm run bench`;
// BENCH_STREAM_ITEMS overrides the stream size.

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

// --- native baselines -------------------------------------------------------------------------

// Absolute floor: one Hono route, no auth at all.
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

// Hand-rolled plane-in-the-middle: two Hono apps with static bearer middleware and a forwarding
// fetch — the shape a team without service-plane typically deploys.
const chainServiceApp = new Hono();
chainServiceApp.use('*', async (context, next) => {
  if (context.req.header('authorization') !== 'Bearer service-secret') return context.json({ error: 'unauthorized' }, 401);
  await next();
});
chainServiceApp.post('/complete', async (context) => context.json(completeImpl(await context.req.json())));

const chainPlaneApp = new Hono();
chainPlaneApp.use('*', async (context, next) => {
  if (context.req.header('authorization') !== 'Bearer plane-secret') return context.json({ error: 'unauthorized' }, 401);
  await next();
});
chainPlaneApp.post('/proxy/complete', async (context) =>
  chainServiceApp.fetch(
    new Request('https://hub.internal/complete', {
      body: JSON.stringify(await context.req.json()),
      headers: { authorization: 'Bearer service-secret' },
      method: 'POST',
    }),
  ),
);

// Raw capnweb over the identical session transport, no service-plane layer at all.
class RawLlmTarget extends RawRpcTarget {
  complete(input: { prompt: string }) {
    return completeImpl(input);
  }

  streamTokens() {
    return rawDeltaStream();
  }
}

// --- service-plane fixture ----------------------------------------------------------------------

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
    streamBatched: abilityMethod({
      input: z.object({}),
      output: z.array(z.object({ delta: z.string(), index: z.number() })),
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

  // The coalescing recipe from docs/streaming.md: flush at 2 KiB or 50 ms, whichever first.
  async *streamBatched(_input: Record<string, never>) {
    let batch: Array<{ delta: string; index: number }> = [];
    let batchBytes = 0;
    let flushBy = 0;
    for (const item of DELTAS) {
      if (batch.length === 0) flushBy = Date.now() + 50;
      batch.push(item);
      batchBytes += JSON.stringify(item).length;
      if (batchBytes >= 2048 || Date.now() >= flushBy) {
        yield batch;
        batch = [];
        batchBytes = 0;
      }
    }
    if (batch.length > 0) yield batch;
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
const signingSecret = await generateCapabilitySigningSecret();
const GRANTS = [
  { caller: 'bench-caller', scopes: ['llm.call'] },
  { caller: 'control-plane', scopes: ['llm.call'] },
];

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

const hubEndpoint = cloudflareServiceBinding({
  binding: {
    connectAbility: (input: { abilityId: string; requestId?: string; token: string }) => service.connectAbility(input),
    fetch: async (request: Request) => service.fetch(request),
  },
  grants: GRANTS,
  id: 'hub',
  origin: 'https://hub.internal',
});

plane = new ServicePlaneControlPlane({
  broker: { caller: () => ({ id: 'bench-caller', kind: 'service' as const }) },
  log: false,
  services: () => [hubEndpoint],
  signingKeys: () => [{ kid: 'test-key', secret: signingSecret }],
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

// The plane is the control plane only: it mints the token once (cached until expiry), then the
// data path goes directly caller -> service. The broker keeps the plane in the data path and is
// only required for ingress-protected services.
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

// Direct data path over the HTTP-batch transport (token cached, verified per call).
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

const rawPair = memoryRpcTransportPair();
new RpcSession(rawPair.right, new RawLlmTarget());
const rawApi = new RpcSession<RawLlmTarget>(rawPair.left).getRemoteMain();

// Plane in the data path over a real wire: a broker session with one serialized hop
// (caller <-> plane); the plane reaches the service over the in-process native binding.
const brokerIssuer = await createCapabilityIssuerFromSigningKeys({
  capabilities: [capabilities],
  grants: defineServiceGrants({ grants: GRANTS.map((grant) => ({ ...grant, target: 'hub' })) }),
  keys: [{ kid: 'bench-key', secret: signingSecret }],
  ttlSeconds: 3600,
});
const broker = createControlPlaneRpcBroker({
  controlPlaneServiceId: 'control-plane',
  issuer: brokerIssuer,
  registry: createServiceRegistry({ services: [hubEndpoint] }),
});
type BrokeredLlm = {
  complete(input: { prompt: string }): Promise<{ text: string }>;
  streamTokens(input: Record<string, never>): Promise<unknown>;
};
const brokerPair = memoryRpcTransportPair();
new RpcSession(brokerPair.right, broker.rootCapability({ id: 'bench-caller', kind: 'service' }, { allowStreaming: true }));
const brokerWireRoot = new RpcSession<{
  ability(serviceId: string, abilityId: string): Promise<{ connect(scopes: string[]): Promise<BrokeredLlm> }>;
}>(brokerPair.left).getRemoteMain();
const brokeredApi = await (await brokerWireRoot.ability('hub', 'hub.llm')).connect(['llm.call']);

type BrokerPipeline = {
  ability(
    serviceId: string,
    abilityId: string,
  ): {
    connect(scopes: string[]): LlmRpc;
  };
};

describe('unary: request -> plane -> service (one call per request)', () => {
  bench(
    'hand-rolled hono chain, bearer middleware (baseline)',
    async () => {
      const response = await chainPlaneApp.fetch(
        new Request('https://plane.internal/proxy/complete', {
          body: JSON.stringify(PROMPT),
          headers: { authorization: 'Bearer plane-secret' },
          method: 'POST',
        }),
      );
      await response.json();
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane broker, connect + call per request (pipelined HTTP-batch)',
    async () => {
      const root = newHttpBatchRpcSession<Record<string, never>>('https://plane.internal/rpc/broker') as unknown as BrokerPipeline;
      await root.ability('hub', 'hub.llm').connect(['llm.call']).complete(PROMPT);
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane brokered session, connection reused (frequent requests)',
    async () => {
      await brokeredApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );
});

describe('unary: frequent service-to-service calls (direct data path)', () => {
  bench(
    'native hono fetch, no auth (floor)',
    async () => {
      const response = await nativeApp.fetch(
        new Request('https://hub.internal/complete', { body: JSON.stringify(PROMPT), method: 'POST' }),
      );
      await response.json();
    },
    UNARY_BENCH,
  );

  bench(
    'hand-rolled direct hono, bearer middleware (baseline)',
    async () => {
      const response = await chainServiceApp.fetch(
        new Request('https://hub.internal/complete', {
          body: JSON.stringify(PROMPT),
          headers: { authorization: 'Bearer service-secret' },
          method: 'POST',
        }),
      );
      await response.json();
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane direct HTTP-batch (cached token, verify per call)',
    async () => {
      await directHttpApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );

  bench(
    'raw capnweb persistent session (baseline)',
    async () => {
      await rawApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );

  bench(
    'service-plane persistent session (verify once per session)',
    async () => {
      await sessionApi.complete(PROMPT);
    },
    UNARY_BENCH,
  );
});

describe(`stream ${STREAM_ITEMS} LLM token deltas`, () => {
  bench(
    'native hono ReadableStream over fetch (floor)',
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
    'service-plane session (hand-rolled 2 KiB batches, docs recipe)',
    async () => {
      await drain(await sessionApi.streamBatched({}));
    },
    STREAM_BENCH,
  );

  bench(
    'service-plane brokered session over wire (plane in data path)',
    async () => {
      await drain((await brokeredApi.streamTokens({})) as ReadableStream<unknown>);
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
