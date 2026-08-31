# Streaming

Goal: return validated results over time without adding a service-specific wire protocol.

Service Plane exposes typed async iterators. The service validates every yielded item; Fetch and
WebSocket preserve backpressure; the control-plane broker proxies the iterator; and MCP tools expose
the same method over SSE.

## Declare A Streaming Method

Pass the yielded-item schema to `ability.stream()`:

```ts
const ability = createAbilityBuilder<{ Bindings: Env }>();

export const hubFiles = defineAbility({
  id: 'hub.files',
  scopes: ['hub.files.read'],
  methods: {
    readFile: ability
      .stream(z.object({ chunk: z.string() }), {
        scopes: ['hub.files.read'],
        mcp: { name: 'hub_read_file' },
      })
      .input(z.object({ path: z.string() }))
      .handler(async function* ({ context, input }) {
        for await (const chunk of context.env.STORAGE.read(input.path)) {
          context.signal?.throwIfAborted();
          yield { chunk };
        }
      }),
  },
  rpc: { transports: ['fetch', 'cloudflare-service-binding', 'websocket'] },
});
```

The item schema drives runtime validation, discovery, and the aggregated MCP tool schema. Streaming
methods cannot project REST operations, MCP resources, or MCP prompts because those surfaces have
one response value. MCP tools are supported.

## Call A Stream

The typed method resolves to an async iterator:

```ts
const files = createBrokeredAbilityClient({
  ability: hubFiles,
  scopes: ['hub.files.read'],
  targetServiceId: 'hub',
  transport: { origin: 'https://api.example.com' },
});

const stream = await files.readFile({ path: '/large.ndjson' });
for await (const item of stream) {
  console.log(item.chunk);
}
```

Breaking out of the loop closes the iterator. Pass an `AbortSignal` as the second method argument
when the consumer has an explicit cancellation lifecycle:

```ts
await files.readFile({ path: '/large.ndjson' }, { signal });
```

The service combines transport cancellation with the forwarded Service Plane deadline and exposes
it as `context.signal`.

## Choose The Transport

| Hop | Recommended stream transport |
| --- | --- |
| browser/headless front -> control plane | Fetch streaming by default; WebSocket for interactive sessions |
| control plane -> same-account Cloudflare service | service binding Fetch |
| control plane -> HTTPS service | Fetch streaming |
| long-running bidirectional session | WebSocket |
| Durable Object that must sleep between messages | WebSocket Hibernation |

Cloudflare native RPC remains the unary fast path. `createAbilityClient({ transport: { type:
'service-binding' } })` and the control-plane broker inspect the method definition: unary calls use
`invokeAbility`, while streaming calls use `binding.fetch`. The application still uses one client.

## Serve WebSocket Streams

For the normal Hono-managed path, inject the runtime's upgrade helper:

```ts
import { upgradeWebSocket } from 'hono/cloudflare-workers';

const service = new ServicePlaneService({
  // ...
  rpc: { upgradeWebSocket },
});
```

The public control-plane socket uses `broker: { caller, upgradeWebSocket }` and the endpoint
`/rpc/broker/ws`. `createBrokeredAbilityClient({ transport: { type: 'websocket', url } })` keeps the
same typed ability client and sends caller-auth headers per logical call.

On Node, use the `upgradeWebSocket` function from `@hono/node-ws`; Deno and Bun use their respective
Hono adapters.

## Use Durable Object Hibernation

Hibernation belongs to the Worker that owns the client socket. It is not transparent through the
generic two-hop broker: the control plane can proxy a live service iterator, but it cannot transfer
the private service socket's hibernation subscription into its public socket. The APIs below are
therefore for a `ServicePlaneService` hosted in the Durable Object itself, typically for trusted
service callers or an application-owned control-plane handoff. The shipped
`createBrokeredAbilityClient()` path supports live Fetch and WebSocket streams, but does not turn a
private service's hibernating socket into an end-to-end hibernating broker stream.

Hibernation support is installed automatically when an ability contains a hibernating method. The
Durable Object only enables manual platform events:

```ts
const service = new ServicePlaneService({
  // ...
  rpc: { manualWebSocket: true },
});

export class FileEvents extends DurableObject<Env> {
  fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return service.webSocketMessage('hub.files', ws, message, this.env);
  }

  webSocketClose(ws: WebSocket) {
    return service.webSocketClose('hub.files', ws);
  }
}
```

A hibernating method stores the generated iterator id on the current socket using Service Plane's
own subscription class:

```ts
events: ability
  .hibernationStream(EventSchema, { scopes: ['hub.events.read'] })
  .input(z.object({ channel: z.string() }))
  .handler(({ context }) =>
    new AbilityHibernationStream((id) => {
      context.webSocket?.serializeAttachment?.({ id });
    }),
  ),
```

Later Durable Object events read that attachment and send yields with the same output schema:

```ts
async sendEvent(ws: WebSocket, event: z.input<typeof EventSchema>) {
  const { id } = ws.deserializeAttachment() as { id: string };
  ws.send(await encodeAbilityHibernationEvent(EventSchema, id, event));
}
```

Use `{ event: 'error' }` or `{ event: 'close' }` for protocol errors and completion. Ordinary
`ability.stream()` methods validate yielded values as the handler is consumed. A hibernating
handler has already returned before an awakened Durable Object produces a value, so
`encodeAbilityHibernationEvent()` is the validation boundary instead. Raw engine encoding is not
exported because it would bypass that output-schema check.

Hibernating methods use the WebSocket transport and are never placed in a finite Fetch batch.

A forwarded request deadline bounds creation of the hibernating subscription, not its lifetime. The
Durable Object may sleep past an in-memory timer, so store any subscription expiry in durable state
and check it when sending a later event.

## High-Frequency Streams

Message count usually dominates schema-validation cost. For LLM tokens or change feeds, make a small
array the yielded item and flush on a byte or time limit:

```ts
streamCompletion: ability
  .stream(z.array(z.object({ delta: z.string() })), { scopes: ['llm.call'] })
  .input(z.object({ prompt: z.string() }))
  .handler(async function* ({ context, input }) {
    let batch: Array<{ delta: string }> = [];
    let bytes = 0;
    let flushAt = 0;

    for await (const delta of context.env.LLM.tokens(input.prompt)) {
      if (batch.length === 0) flushAt = Date.now() + 50;
      batch.push(delta);
      bytes += JSON.stringify(delta).length;
      if (bytes >= 2048 || Date.now() >= flushAt) {
        yield batch;
        batch = [];
        bytes = 0;
      }
    }

    if (batch.length > 0) yield batch;
  }),
```

## MCP Streaming Tools

Published streaming methods with `mcp` metadata answer `tools/call` over MCP streamable HTTP.
Progress notifications may be emitted while items arrive; the final response aggregates
`structuredContent: { items }`. MCP limits protect the control plane from unbounded aggregation; use
the typed Service Plane client for a truly unbounded stream.

Next: [Choosing A Transport](transports.md), [Cloudflare](cloudflare.md), and the
[reference](reference.md#streaming-methods).
