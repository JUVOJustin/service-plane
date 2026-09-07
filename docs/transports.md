# Choosing A Transport

Start with the topology, then optimize measured bottlenecks. The public API stays the same across
transports.

## Decision Table

| Hop | Recommended transport | Why |
| --- | --- | --- |
| Cloudflare Worker → bound Worker, unary | `service-binding` native RPC | No Service Plane HTTP/JSON codec; platform-owned routing |
| Cloudflare Worker → bound Worker, stream | Service-binding Fetch | Streaming codec and backpressure |
| Node, another account, or another runtime | Fetch | Universal, stateless, easy to observe |
| Browser/headless client → control plane | Broker Fetch, REST, or MCP | Keeps services and capability tokens private |
| Interactive, long-lived session | WebSocket | Reuses one connection and supports streams |
| Separate, directly reachable Durable Object | Experimental hibernating WebSocket | Outside the central-plane topology |

Do not expose private services merely to avoid one control-plane hop. On Cloudflare, keep the plane
public and use service bindings for its downstream calls.

## Fetch

Fetch is the default ability transport and the baseline for cross-runtime deployments. Most callers
use the public broker, which chooses the downstream service transport from discovery:

```ts
const client = createBrokeredAbilityClient({
  ability: tasksContract,
  targetServiceId: 'tasks-service',
  transport: {
    type: 'fetch',
    origin: 'https://api.example.com',
    headers: () => ({ authorization: `Bearer ${readProductToken()}` }),
  },
});
```

It is request-scoped, works across runtimes, and carries unary results and ordinary streams. It also
supports Service Plane batching and compression.

## Cloudflare Service Bindings

Declare the fast path on the ability and endpoint:

```ts
// Service contract
rpc: { transports: ['fetch', 'service-binding'] }

// Control-plane endpoint
cloudflareServiceBinding({
  id: 'tasks-service',
  binding: c.env.TASKS,
  abilityRpc: true,
  grants,
})
```

Unary calls use `invokeAbility` without Service Plane's HTTP/JSON codec. Ordinary streams
automatically use `binding.fetch`. Cloudflare RPC can carry `ReadableStream` values, but Service
Plane does not yet use that path: the Fetch stream adapter already owns validation, cancellation,
backpressure, and connection cleanup consistently across runtimes. A native stream path should be
added only with the same lifecycle guarantees and a measured gain. Native calls bypass Hono
middleware, so security and invariants must live in the ability policy or handler. Service Plane
still verifies tokens, scopes, ingress, schemas, and deadlines on this path.

Cloudflare allows at most 32 Worker invocations from one originating request. Every downstream
service-binding call still counts, including calls unpacked from a public batch. Native RPC values
are limited to 32 MiB; larger byte streams use ownership-transferring `ReadableStream` values, which
is a different lifecycle from Service Plane's typed item streams. See Cloudflare's
[service-binding limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits)
and [RPC stream rules](https://developers.cloudflare.com/workers/runtime-apis/rpc/#readablestream-writablestream-request-and-response).

## WebSocket

Use WebSocket when a session is genuinely long-lived or interactive:

```ts
const client = createBrokeredAbilityClient({
  ability: eventsContract,
  targetServiceId: 'events-service',
  transport: {
    type: 'websocket',
    url: 'wss://api.example.com/rpc/v1/broker/ws',
    reconnect: { enabled: true, maxAttempt: 5 },
  },
});
```

The server needs a runtime-specific `upgradeWebSocket`. A socket saves repeated connection setup,
but adds connection ownership, reconnect policy, idle lifecycle, and deploy behavior. Fetch is
usually simpler for sporadic calls.

A broker socket authenticates its physical HTTP upgrade, not each logical call. Browser clients
normally use a secure cookie or short-lived URL ticket. Server runtimes may close over a WebSocket
implementation that adds upgrade headers in `createWebSocket`. `transport.headers` is available on
broker Fetch only. Request ID, idempotency key, and timeout remain per-call metadata after the
socket is accepted.

Hibernation is an experimental direct-service WebSocket mode; see [streaming](streaming.md). It is never
brokered, opened by `plane.abilityClient`, or batched; those clients fail fast.

## Batch Concurrent Fetch Calls

Enable batching on both ends:

```ts
// Service or public broker
rpc: {
  batch: { maxSize: 20 },
}

// Client transport
transport: {
  type: 'fetch',
  origin: 'https://api.example.com',
  batch: { maxSize: 20 },
}
```

Batching combines only concurrent unary logical calls into one physical Fetch request. Streams and
WebSocket calls never enter a batch. Every subrequest retains its own method scopes, request ID,
idempotency key, and timeout.

The largest win is usually a high-latency public or HTTP/1.1 hop. HTTP/2 and HTTP/3 already
multiplex concurrent requests on one connection, so batching saves less there; measure before
accepting batch-wide latency coupling.

For a brokered client, batching removes caller-to-plane round trips only. The plane still performs
authorization, token handling, and one downstream service invocation per logical call. It is not a
distributed fan-in protocol. `servicePlaneConnInfo` also remains owned by trusted invocation
middleware, not by individual public calls.

Use a bounded `maxSize`; an unbounded batch turns one request into unbounded service work. On
Cloudflare, leave room below the 32-invocation request limit for any other Workers called by the
plane or target services. The example size of 20 is a starting point, not a universal default.

## Compress Fetch Payloads

```ts
// Server
rpc: {
  compression: {
    request: true,
    response: { encodings: ['gzip', 'deflate'], threshold: 1_024 },
  },
}

// Client
transport: {
  type: 'fetch',
  origin: 'https://api.example.com',
  compression: {
    request: { encoding: 'gzip', threshold: 1_024 },
    response: true,
  },
}
```

Supported Service Plane encodings are `gzip`, `deflate`, and `deflate-raw`; choose only values
available in the target runtime. Requests may use one encoding; stacked, malformed, and unsupported
encodings are rejected with 415 before allocating a decoder, on Fetch and WebSocket alike.
Compression helps large JSON or text payloads and usually hurts
small requests through extra CPU and latency. Measure with realistic payloads.

Compression applies to request bodies, including batches, and ordinary unary responses. Framed
batch responses and streamed responses stay uncompressed. They intentionally avoid the buffering
and Node-specific compression dependencies that would otherwise change portability or latency.

Every RPC server rejects decoded request bodies and individual WebSocket messages larger than one
MiB by default, including compressed and batched requests. Change `maxRequestBodyBytes`
deliberately; `false` disables the byte limit, not the compression depth limit.

## Performance Expectations

The useful ordering is stable even when absolute numbers change by machine:

1. A direct in-process method call is cheapest.
2. Cloudflare native binding RPC avoids Service Plane's HTTP/JSON codec for unary calls.
3. Fetch adds encoding and request dispatch.
4. A public broker adds discovery/grant/token work plus a second hop.
5. Batching amortizes the first Fetch hop; it does not erase downstream work.

`npm run bench` measures the current engine, Service Plane middleware, token signing, discovery,
REST matching, local JS binding adapters, in-process Fetch, broker calls, batching, and streams.
The binding measurements do not exercise Cloudflare scheduling or cross-isolate serialization.
These are regression benchmarks; deployment latency also depends on placement, network, payloads,
schemas, cold starts, and storage. Ten-call batch measurements count groups; multiply by ten for
logical calls per second and compare against the matching ten-call unbatched workload.

A Node 22 loopback HTTP comparison on 2026-09-05 found similar unary median latency for oRPC
beta.33 and Cap'n Web 0.12 (about 0.4 ms). Ten-call batches took 1.891 versus 0.331 ms for 16-byte
values, and 2.665 versus 1.121 ms for 8 KiB values: Cap'n Web won both. Five alternating rounds used
200 samples after 100 warmups, identical validation, one HTTP request per sample, and no compression
or TLS. This excludes Service Plane authorization, distributed network latency, and deployed
Cloudflare behavior. Reproduce with an independently unpacked Cap'n Web package:

```sh
node scripts/compare-rpc.mjs /absolute/path/to/capnweb/package
```

The migration is not a general speed improvement: portable typed Fetch streams are its main
transport benefit. Even the local Service Plane benchmark runs faster without batching; opt in only
when measured network/request savings justify its scheduling and framing overhead.

## Practical Defaults

- Keep Fetch enabled on every ordinary ability.
- Add `service-binding` for unary calls between bound Workers.
- Add WebSocket only for a stream or session that benefits from it.
- Enable batching for measured bursts of concurrent unary calls.
- Enable compression above a measured payload threshold.
- Preserve the one-MiB decoded request limit unless the API requires more.

See [Cloudflare](cloudflare.md), [Node.js](nodejs.md), and [streaming](streaming.md).
