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

An ability that declares streaming methods must enable `websocket` or `cloudflare-binding-rpc` in `rpc.transports` (checked at setup). Unary methods on the same ability keep working over HTTP-batch — batch stays the right default for request/response calls.

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

## MCP Streaming Tools

Published streaming methods with `mcp` metadata become tools whose `tools/call` answers over SSE per MCP streamable HTTP: progress notifications while items arrive, then one final result aggregating `structuredContent: { items }`. See [OpenAPI and MCP](openapi-mcp.md#tools).

Next: [reference](reference.md#streaming-methods), [Cloudflare](cloudflare.md), and [Node.js](nodejs.md).
