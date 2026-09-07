# Cloudflare Workers

Use one public control-plane Worker and private service Workers connected by service bindings. Unary
downstream calls use native RPC; streams use binding Fetch.

## Bind The Workers

```jsonc
// control-plane/wrangler.jsonc
{
  "services": [
    { "binding": "TASKS", "service": "tasks-service" }
  ]
}
```

Give service Workers a `CONTROL_PLANE` binding so they can load JWKS. Disable public service routes
when the platform topology permits it. Service ingress requires a brokered token by default, even
when a service must remain reachable over HTTPS from another runtime.

## Expose Fetch And Native RPC

Wrap the service in a `WorkerEntrypoint`:

```ts
import { WorkerEntrypoint } from 'cloudflare:workers';

const service = new ServicePlaneService<{ Bindings: Env }>({
  // abilities, auth, ingress, ...
});

export default class TasksService extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return service.fetch(request, this.env, this.ctx);
  }

  invokeAbility(input: Parameters<typeof service.invokeAbility>[0]) {
    return service.invokeAbility(input, this.env);
  }
}
```

Register native RPC explicitly at the plane:

```ts
cloudflareServiceBinding({
  id: 'tasks-service',
  binding: c.env.TASKS,
  abilityRpc: true,
  grants,
})
```

The ability contract must also opt in with `rpc: { transports: ['fetch', 'service-binding'] }`.
Without that declaration, the broker uses Fetch even when the binding exposes `invokeAbility`.

The explicit `abilityRpc` matters: a service-binding proxy returns a callable property for any
name, so runtime feature probing would produce false positives. Set it to `true` only when that same
binding exposes `invokeAbility`; a separate `ServiceAbilityNativeRpcBinding` adapter also remains
available.

Native RPC skips Service Plane's HTTP/JSON codec and Hono middleware, but still runs token, ingress,
access, scope, deadline, input, and output checks. Handlers receive runtime bindings and a synthetic
request context. Put security invariants in Service Plane policy, not only in Hono middleware.

Cloudflare permits at most 32 Worker invocations from one originating request. A broker batch saves
the public Fetch hop but each downstream service-binding call still counts, so size batches below
the remaining fan-out budget. Native RPC values are capped at 32 MiB. See the platform's
[service-binding limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits)
and [RPC serialization rules](https://developers.cloudflare.com/workers/runtime-apis/rpc/).

## Direct Service-To-Service Calls

A trusted Worker may use a direct client only when the target explicitly sets `ingress: false`:

```ts
const tasks = createAbilityClient({
  ability: tasksContract,
  callerServiceId: 'workflow-service',
  targetServiceId: 'tasks-service',
  requestToken: controlPlaneRpcTokenRequester({
    binding: env.CONTROL_PLANE,
  }),
  transport: {
    type: 'service-binding',
    binding: env.TASKS,
  },
});
```

Prefer a caller-pinned binding method on the plane. Do not trust a caller ID supplied over native
RPC merely because the transport is private:

```ts
import type { PinnedCapabilityTokenInput } from 'service-plane/control-plane';

export default class WorkflowPlaneBinding extends WorkerEntrypoint<Env> {
  fetch(request: Request) {
    return plane.fetch(request, this.env, this.ctx);
  }

  issueCapabilityToken(input: PinnedCapabilityTokenInput) {
    return plane
      .capabilityTokenBinding('workflow-service', this.env)
      .issueCapabilityToken(input);
  }
}
```

The requester therefore has no `callerServiceId` option. Type `env.CONTROL_PLANE` as
`ControlPlaneRpcTokenBinding`. `createAbilityClient` still declares its local caller identity for
token caching and checks the trusted binding response's decoded claims against it; the dedicated
binding must pin the same identity at the trust boundary.

Expose that entrypoint only to the pinned service. Production product traffic should call the
public broker instead; ingress-protected services reject ordinary direct capabilities.

## Store Connector State In Durable Objects

A common connector topology is one stateless ability service plus one Durable Object per external
connection:

```mermaid
flowchart LR
  Plane -->|service binding| Service
  Service -->|validated connectionId| DO[Connection Durable Object]
  DO --> Provider
```

The Durable Object owns OAuth tokens, cursors, rate-limit state, and webhook deduplication. The
ability receives a validated connection ID and verified delegated subject, then resolves the object.
Never put provider credentials in a capability token, workflow payload, or browser bundle.

Use a Durable Object as the service endpoint itself only when it must own a hibernating WebSocket.
See [streaming](streaming.md#experimental-direct-durable-object-hibernation).

## Cache Discovery Deliberately

The default registry cache is per isolate. That already changes service discovery from one fan-out
per request to roughly one fan-out per isolate per 30 seconds.

Use KV or a Durable Object-backed `RegistryCache` only when cold-isolate fan-out is significant. If
you add a shared store, place a small in-memory cache in front so every hot request does not become a
remote cache call. Service Plane exposes the `RegistryCache` interface but does not ship a tiering
helper. Put the read-through memory layer inside your application-owned cache adapter, then pass
that adapter as `discoveryCache`.

Do not put a single Durable Object directly on every hot token or broker call; it becomes a
serialized global bottleneck.

## Cache Public Metadata

`httpCache: true` adds cache headers and tags to discovery, OpenAPI, and JWKS. RPC, broker, REST
responses, and MCP are never marked as metadata cache entries.

```ts
const service = new ServicePlaneService({ httpCache: true, /* ... */ });
const plane = new ServicePlaneControlPlane({
  httpCache: { maxAgeSeconds: 60, tags: ['environment:production'] },
  // ...
});
```

After a service deploy, convergence is bounded by the edge discovery cache plus the plane registry
cache. Staleness fails closed at the service, but removed projections may remain visible until the
caches refresh. Purge service discovery and OpenAPI tags when immediate convergence matters.

JWKS rotation needs a longer overlap: include `max-age`, `stale-while-revalidate`, the service JWKS
cache, token lifetime, and clock skew. See [authentication](auth.md#rotate-a-signing-key).

## WebSocket Guidance

Use service bindings for normal Worker-to-Worker calls. Use WebSocket for long-lived public streams,
and Durable Object hibernation only when sleeping between events materially reduces duration cost.
Every public broker socket authenticates its HTTP upgrade through control-plane middleware. Browser
clients can use a secure cookie or short-lived URL ticket; `BrokeredAbilityTransport.headers` is
Fetch-only. Hibernation stays on the direct Durable Object service socket—the broker and
`plane.abilityClient` reject it.

Use `setWebSocketAutoResponse` for fixed application heartbeats that should not wake the object;
Cloudflare already handles protocol ping/pong. Auto-response messages are limited to 2,048
characters. Keep hibernation attachments small as described in [streaming](streaming.md).

See [transports](transports.md) and [the Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
