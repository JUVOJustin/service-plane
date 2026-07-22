# Streaming

Goal: return many results over time from one ability method — large file transfers, long exports, incremental tool output — without inventing a wire protocol.

Service Plane uses Cap'n Web's native stream support: a streaming method resolves to a standard `ReadableStream`, transferred over the RPC session with built-in flow control. Service Plane adds only its usual layer on top — per-item Zod validation, scopes, discovery, and projections.

## Declare A Streaming Method

Set `stream: true`. The `output` schema then validates **each streamed item**, not the whole return:

```ts
readFile: abilityMethod({
  input: z.object({ path: z.string() }),
  output: z.object({ chunk: z.string() }), // one streamed item
  scopes: ['hub.files.read'],
  stream: true,
}),
```

The handler returns an async generator (or any iterable / `ReadableStream`); the wrapper turns it into a validated `ReadableStream` lazily, so consumer backpressure reaches the generator untouched:

```ts
class HubFilesHandler extends RpcTarget {
  async *readFile(input: { path: string }) {
    for await (const chunk of this.storage.read(input.path)) {
      yield { chunk };
    }
  }
}
```

### Why `stream: true` is explicit

The flag is declarative metadata, like `rest` and `mcp` — it cannot be inferred from the handler returning a `ReadableStream` at runtime, because it changes meaning before any call happens:

- It flips what the `output` schema describes (one item instead of the whole return), which drives per-item validation and the JSON Schemas in discovery.
- Projections are static: MCP tools advertise the aggregated `{ items }` schema and `_meta.servicePlane.stream`, and the broker/MCP pick a session transport *before* invoking the method.
- Setup checks fail fast: streaming abilities must enable a session transport, and streaming methods cannot project REST, MCP resources, or prompts.
- The TypeScript contracts (`AbilityImplementation`, `AbilityRpc`) derive handler and caller signatures from it.

Without the flag, a method that accidentally returned a stream would silently change transport semantics instead of failing output validation.

## Transports

Cap'n Web streams ride the ongoing RPC session, so streaming methods need a **session transport**:

| Transport | Streams | Notes |
| --- | --- | --- |
| `cloudflareNativeRpc(binding)` | yes | Workers RPC streams natively; preferred same-account on Cloudflare |
| `websocketRpc(url)` | yes | long-lived Cap'n Web session |
| `customRpcTransport(transport)` | yes | any bidirectional transport |
| `cloudflareServiceBindingRpc(binding)` / `httpBatchRpc(url)` | no | one round trip; streaming calls fail with 405 |

An ability that declares streaming methods must enable `websocket` or `cloudflare-binding-rpc` in `rpc.transports` (checked at setup). Unary methods on the same ability keep working over HTTP-batch — batch stays the right default for request/response calls. For the full environment/cost decision guide, see [Choosing A Transport](transports.md).

## Serve WebSocket Sessions

The service shell serves HTTP-batch and WebSocket on the same `/rpc/<abilityId>` route through [`@hono/capnweb`](https://github.com/honojs/middleware/tree/main/packages/capnweb); you only wire the runtime's `upgradeWebSocket` helper, exactly as that adapter documents.

Cloudflare Workers:

```ts
import { upgradeWebSocket } from 'hono/cloudflare-workers';

const service = new ServicePlaneService({
  // ...
  rpc: { upgradeWebSocket },
});
```

Node.js:

```ts
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const service = new ServicePlaneService({
  // ...
  app,
  rpc: { upgradeWebSocket },
});

const server = serve({ fetch: service.fetch, port: 8787 });
injectWebSocket(server);
```

Deno and Bun follow the same pattern with `upgradeWebSocket` from `hono/deno` or `hono/bun`. The control-plane broker takes the same option: `broker: { caller, upgradeWebSocket }`.

On Cloudflare, same-account callers can skip WebSocket entirely: expose `connectAbility` from a `WorkerEntrypoint` and use native binding RPC, which streams natively (see [Cloudflare](cloudflare.md)).

## Call A Streaming Method

Nothing changes on the caller except the transport choice — the method resolves to a `ReadableStream` of validated items:

```ts
const api = await abilitySession<AbilityRpc<typeof hubFiles>>({
  abilityId: 'hub.files',
  callerServiceId: 'workflow-runner',
  targetServiceId: 'hub',
  scopes: ['hub.files.read'],
  requestToken,
  transport: websocketRpc('wss://hub.example.com/rpc/hub.files'), // or cloudflareNativeRpc(binding)
});

const stream = await api.readFile({ path: '/big.bin' });
for await (const item of stream) {
  // { chunk: string }, already output-validated by the service
}
```

Cancel by exiting the loop early (or `reader.cancel()`); cancellation propagates to the handler's generator. A handler failure or an item that fails output validation surfaces as a stream error on `read()`.

## Stream Through The Broker

Streams proxy transparently across broker sessions — no extra routes. Connect to `/rpc/broker` over WebSocket; the plane authorizes the caller, mints the (brokered) token, and reaches the service over its own session transport:

1. the endpoint's native ability RPC binding, when available (`ServiceEndpoint.abilityRpc` — picked up automatically by `cloudflareServiceBinding` when the binding exposes `connectAbility`),
2. otherwise WebSocket.

```ts
const ability = await broker.ability('hub', 'hub.files');
const api = await ability.connect(['hub.files.read']);
const stream = await api.readFile({ path: '/big.bin' });
```

Ingress-protected services work unchanged: the broker's token carries the signed broker claim, and the stream flows service → plane → caller with flow control on each hop.

## High-Frequency Streams

Per-item cost is CPU, not waiting: validation runs on one item as it passes through (microseconds), and Cap'n Web serializes one message per item per hop. Cost therefore scales with **message rate × hops** — and serialization dominates, not validation (`npm run bench` streams 100,000 token-sized items per iteration against native baselines; disabling validation changes almost nothing, while batching items changes everything).

For LLM-style token streams, batch deltas instead of sending one message per token. This is deliberately a recipe, not an API: the batching policy is application-owned, and the batch belongs in the method contract — declare it as the item and flush on whichever limit is hit first, size or time. The size cap flushes chunky items early instead of piling them up in memory; the time cap bounds latency when the producer trickles:

```ts
streamCompletion: abilityMethod({
  input: z.object({ prompt: z.string() }),
  output: z.array(z.object({ delta: z.string() })), // the batch is the item
  scopes: ['llm.call'],
  stream: true,
}),
```

```ts
async *streamCompletion(input: { prompt: string }) {
  let batch: Array<{ delta: string }> = [];
  let batchBytes = 0;
  let flushBy = 0;
  for await (const delta of this.llm.tokens(input.prompt)) {
    if (batch.length === 0) flushBy = Date.now() + 50; // latency bound for slow producers
    batch.push(delta);
    batchBytes += JSON.stringify(delta).length;
    if (batchBytes >= 2048 || Date.now() >= flushBy) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }
  }
  if (batch.length > 0) yield batch;
}
```

In the benchmark (100,000 deltas per stream) this cuts a stream from ~1.0 s to ~87 ms — ~2,400 wire messages instead of ~100k — and lands *below* the per-item native-binding cost, because validating one array per batch is also cheaper than validating items one by one.

Two more levers for hot paths:

- **Keep the plane out of the data path.** The plane is a control plane: it mints the token, and the caller opens a direct session to the service (`websocketRpc`, `cloudflareNativeRpc`). Route through the broker only when you need it — ingress-protected services, or callers that must never hold tokens. Direct-vs-brokered is an explicit choice, not a hidden mode.
- **Prefer persistent sessions over HTTP-batch for chatty callers.** A batch call verifies the capability token per request; a session verifies once at `authenticate` and then costs microseconds per call.

## MCP Streaming Tools

Published streaming methods with `mcp` metadata become tools whose `tools/call` answers over SSE per MCP streamable HTTP: progress notifications while items arrive, then one final result aggregating `structuredContent: { items }`. See [OpenAPI and MCP](openapi-mcp.md#tools).

Next: [reference](reference.md#streaming-methods), [Cloudflare](cloudflare.md), and [Node.js](nodejs.md).
