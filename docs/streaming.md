# Streaming

Streaming methods return typed async iterators. Service Plane validates every yielded item and
preserves cancellation across supported transports.

## Define A Stream

```ts
const ability = createAbilityBuilder<{ Bindings: Env }>();

export const filesContract = defineAbility({
  id: 'files',
  scopes: ['files.read'],
  methods: {
    read: ability.stream({
      input: z.object({ path: z.string() }),
      output: z.object({ chunk: z.string() }),
      scopes: ['files.read'],
      mcp: { name: 'files_read', description: 'Read a file' },
    }),
  },
  rpc: { transports: ['fetch', 'service-binding', 'websocket'] },
});

export const files = implementAbility(filesContract, {
  read: async function* ({ context, input }) {
    for await (const chunk of context.env.STORAGE.read(input.path)) {
      context.signal?.throwIfAborted();
      yield { chunk };
    }
  },
});
```

The output schema describes one item, not an array or stream wrapper. Streaming methods may be MCP
tools, but cannot be REST operations, MCP resources, or MCP prompts.

## Consume A Stream

```ts
const files = createBrokeredAbilityClient({
  ability: filesContract,
  targetServiceId: 'files-service',
  transport: { origin: 'https://api.example.com' },
});

const stream = await files.read({ path: '/events.ndjson' }, { signal });
for await (const item of stream) {
  console.log(item.chunk);
}
```

Breaking out of the loop calls iterator cleanup. An `AbortSignal` also cancels the local call and is
combined with the forwarded deadline at the service. Upstream work should observe
`context.signal`, especially around long waits. A caller-side abort is reported as
`ServicePlaneClientError` with `code: 'cancelled'`, status `499`, and `retryable: false`.

## Choose A Transport

| Hop | Normal choice |
| --- | --- |
| Browser/headless client → plane | Fetch streaming; WebSocket for an interactive session |
| Plane → same-account Worker | Service-binding Fetch |
| Plane → HTTPS service | Fetch streaming |
| Direct long-lived session | WebSocket |
| Durable Object that must sleep | Hibernating WebSocket |

Cloudflare native RPC is unary-only in Service Plane. A `service-binding` client automatically uses
native `invokeAbility` for unary methods and `binding.fetch` for ordinary streams.
Batching is also unary Fetch-only; streaming calls are never placed into a batch.

## Enable WebSocket

Add the runtime's Hono upgrade helper and declare the transport on the ability:

```ts
import { upgradeWebSocket } from 'hono/cloudflare-workers';

const service = new ServicePlaneService({
  // ...
  rpc: { upgradeWebSocket },
});
```

For the public plane, use `broker: { upgradeWebSocket }`; clients connect to
`wss://<plane>/rpc/broker/ws`. Caller authentication still runs in `invocationMiddleware`, and
logical calls carry their own request ID, idempotency key, and deadline.

The middleware authenticates the physical HTTP upgrade once. In a browser, use a secure cookie or
a short-lived ticket in the URL. In a server runtime, a custom `createWebSocket` closure may use a
WebSocket implementation that sets upgrade headers. The `headers` option on a broker transport is
Fetch-only and does not authenticate a WebSocket.

`rpc.maxRequestBodyBytes` and `broker.maxRequestBodyBytes` limit each decoded message to one MiB by
default. Automatically managed sockets close with WebSocket code `1009` when a message is too
large. A Durable Object forwarding the event manually receives a rejected promise with status
`413`, so its own socket policy stays explicit.

Client reconnect is explicit:

```ts
transport: {
  type: 'websocket',
  url: 'wss://api.example.com/rpc/broker/ws',
  reconnect: { enabled: true, maxAttempt: 5 },
},
```

Retries remain an application decision. Reconnecting a socket does not make a non-idempotent
method safe to repeat.

Dispose a long-lived client when its owner shuts down:

```ts
disposeAbilityClient(client);
```

This cancels its active iterators, closes every physical socket, and prevents configured reconnect
from opening another one. Disposal is idempotent. Breaking out of a stream remains the prompt way
to release that individual iterator; client disposal owns the physical WebSocket lifetime.

## Durable Object Hibernation

A hibernating method is a direct service WebSocket feature. It cannot use Fetch, native unary RPC,
batching, the control-plane broker, or `plane.abilityClient`. Brokered and in-process clients
fail before opening a downstream call; only the Durable Object that owns the direct service socket
can restore the subscription.

Declare the contract:

```ts
const eventsContract = defineAbility({
  id: 'events',
  scopes: ['events.read'],
  methods: {
    subscribe: ability.hibernationStream({
      input: z.object({ channel: z.string() }),
      output: EventSchema,
      scopes: ['events.read'],
    }),
  },
  rpc: { transports: ['websocket'] },
});
```

Attach the subscription ID to the accepted socket:

```ts
const events = implementAbility(eventsContract, {
  subscribe: ({ context }) =>
    new AbilityHibernationStream((id) => {
      context.webSocket?.serializeAttachment?.({ id });
    }),
});

const service = new ServicePlaneService({
  abilities: [events],
  rpc: { manualWebSocket: true },
  // ...
});
```

Cloudflare limits a serialized WebSocket attachment to 16,384 bytes. Persist larger state in
Durable Object storage and attach only its lookup key. Fixed heartbeats can use
`state.setWebSocketAutoResponse(...)` so they do not wake the object; request and response are each
limited to 2,048 characters. See Cloudflare's
[hibernation guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#websocketserializeattachment).

The Durable Object accepts the socket and forwards platform events:

```ts
export class EventSocket extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return service.fetch(request, this.env);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    return service.webSocketMessage('events', ws, message, this.env);
  }

  webSocketClose(ws: WebSocket) {
    return service.webSocketClose('events', ws);
  }
}
```

Forward each event as soon as the runtime delivers it and return the promise. Service Plane
normalizes frames and enters them into the private peer in arrival order per socket, including when
binary conversion is asynchronous. `webSocketClose` waits for queued frames to reach that peer;
independent RPC executions remain concurrent after delivery.

When the object wakes, validate and encode each event before sending it:

```ts
const { id } = ws.deserializeAttachment() as { id: string };
ws.send(await encodeAbilityHibernationEvent(EventSchema, id, event));
```

Terminal events use the fourth argument; the third argument remains their payload:

```ts
ws.send(await encodeAbilityHibernationEvent(EventSchema, id, error, { event: 'error' }));
ws.send(await encodeAbilityHibernationEvent(EventSchema, id, undefined, { event: 'close' }));
```

A hibernating subscription can outlive an in-memory deadline; persist its expiry and check it after
wake-up.

## High-Frequency Streams

For token streams or change feeds, batching items can reduce serialization, validation, and
transport overhead. Batching changes the yielded item type, so declare it in the contract:

```ts
const EventBatch = z.array(EventSchema).max(100);

watch: ability.stream({ input: WatchInput, output: EventBatch, scopes: ['events.read'] })

watch: async function* ({ input }) {
  for await (const batch of readEventBatches(input, { maxItems: 100, maxWaitMs: 25 })) {
    yield batch;
  }
}
```

The client then iterates `Event[]`. If the output schema remains `EventSchema`, yield one event at a
time; every yielded value is validated against that schema.

MCP streaming tools aggregate items into a final structured response and enforce configured item
and byte limits. Use the typed client for an unbounded stream.

See [transports](transports.md) for topology guidance and [Cloudflare](cloudflare.md) for deployment
details.
