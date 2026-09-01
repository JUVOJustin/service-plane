# API Reference

Use this page for option shapes and defaults. Start with [Create a service](service-creation.md) for
a guided path.

## Package Entries

| Entry | Intended use |
| --- | --- |
| `service-plane/service` | Contracts, service runtime, typed clients, token requesters |
| `service-plane/control-plane` | Plane, endpoints, grants, token authority, projections |
| `service-plane/testing` | In-memory token cache and WebSocket pair for tests |
| `service-plane` | Combined convenience entry |

The private RPC engine is not exported.

## Ability Contract

```ts
const ability = createAbilityBuilder<{ Bindings: Env }>();

const contract = defineAbility({
  id: 'tasks',
  title: 'Tasks',
  description: 'Task operations',
  exposure: 'published',
  access: 'plane',
  scopes: ['tasks.read'],
  methods: {
    get: ability.method({
      input: GetTaskInput,
      output: Task,
      scopes: ['tasks.read'],
      idempotent: true,
      timeoutMs: 2_000,
      rest: { method: 'get', path: '/tasks/{id}' },
      mcp: { name: 'tasks_get' },
    }),
  },
  rpc: {
    path: '/rpc/tasks',
    transports: ['fetch', 'service-binding'],
  },
});
```

Ability defaults:

| Field | Default |
| --- | --- |
| `exposure` | `private` |
| `access` | `plane` |
| `rpc.path` | `/rpc/<abilityId>` |
| `rpc.transports` | `['fetch']` |

`scopes` is the maximum scope surface. By default, every ability and method needs at least one
scope, and every referenced scope must exist in the service capability catalog.

Method forms:

```ts
ability.method({ input, output, scopes, handler? })
ability.stream({ input, output: ItemSchema, scopes, handler? })
ability.hibernationStream({ input, output: ItemSchema, scopes, handler? })
```

Each method uses exactly one options object. Omit `handler` for a portable contract and attach its
service implementation with `implementAbility`.

Optional metadata is `idempotent`, `timeoutMs`, `rest`, `mcp`, `mcpResource`, and `mcpPrompt`.
`stream` and `hibernationStream` output schemas describe one yielded item. Natural JavaScript names
such as `call`, `apply`, `name`, `constructor`, and `toString` are valid method names. Only `then`
and `toJSON` are reserved because Promise and JSON machinery invoke them implicitly.

An ordinary stream handler may return an async iterator, pure `AsyncIterable`, synchronous iterable
object, or `ReadableStream`. `AbilityStreamSource<T>` names that union; `toAbilityStream(source)`
normalizes it when application code needs the client-style iterator explicitly.

An ability method's `timeoutMs` must be a valid millisecond value. Invalid values are rejected;
`0` disables that method's service-side execution ceiling. This definition-time ceiling is separate
from the per-call deadline described below.

Keep handlers out of a shared contract with:

```ts
const implementation = implementAbility(contract, {
  get: ({ context, input }) => context.env.TASKS.get(input.id),
});
```

## Method Context

```ts
type AbilityMethodContext = {
  abilityId: string;
  methodName: string;
  env: Bindings;
  request: Request;
  context: HonoContext;
  identity: CapabilityIdentity;
  connInfo?: ConnInfo;
  idempotencyKey?: string;
  remainingTimeoutMs?: () => number;
  signal?: AbortSignal;
  webSocket?: ServiceAbilityWebSocket;
};
```

`input` is validated before the handler; the returned value or every yielded item is validated
afterward. `connInfo` is advisory. `context.context` is the Hono escape hatch; use `env` and
`request` for portable code.

## ServicePlaneService

```ts
new ServicePlaneService({
  id,
  title,
  version,
  abilities: [implementation],
  capabilities,
  auth: { issuer?, expectedAudience?, now?, jwks } |
        { issuer?, expectedAudience?, now?, controlPlaneBinding },
  ingress: {},
  rpc: { upgradeWebSocket?, manualWebSocket?, batch?, compression?, maxRequestBodyBytes? },
  timeout: { methodMs?, defaultMs?, maxMs? },
  app?, middleware?, logger?, requestId?, discoveryPath?, httpCache?,
});
```

Routes:

```text
GET /.well-known/service-plane/service.json
ALL /rpc/<abilityId>/*
ALL /rpc/<abilityId>       # WebSocket upgrade when declared and configured
```

`ingress: {}` requires a signed broker claim. `rpc.maxRequestBodyBytes` defaults to 1 MiB for decoded
Fetch bodies and individual WebSocket messages. `rpc.upgradeWebSocket` lets Hono own upgrades;
`manualWebSocket` enables the Durable Object event-forwarding methods.

Service authentication must supply either `jwks` or `controlPlaneBinding`; supplying both is
allowed and the explicit `jwks` resolver wins. A missing trust source is therefore a type error.

Every unary method has a 10-second service ceiling by default. Override one method with
`timeoutMs`; `0` disables that method's ceiling. `timeout.methodMs` changes the service default, and
`false` disables the service-wide default. Streams have no method ceiling.

## ServicePlaneControlPlane

```ts
new ServicePlaneControlPlane({
  signingKeys,
  services,
  authenticateCaller?,
  invocationMiddleware?,
  broker?,
  mcp?,
  openapi?,
  rest?,
  discoveryCache?,
  discoveryMaxResponseBytes?,
  timeout?,
  issuer?, controlPlaneServiceId?, ttlSeconds?, tokenMaxBodyBytes?,
  app?, log?, requestId?, httpCache?,
});
```

Routes and defaults:

```text
POST /.well-known/service-plane/capability-token     always
GET  /.well-known/service-plane/jwks.json            always
GET  /openapi.json                                   default; `openapi: false` disables
*    <published rest.path>                           default; `rest: false` disables catch-all
ALL  /rpc/broker/*                                   `broker: {}` enables
ALL  /rpc/broker/ws                                  when broker WebSocket upgrade is configured
POST /mcp                                            `mcp: {}` enables
```

`broker.path`, `mcp.path`, and `openapi.path` override defaults. `tokenMaxBodyBytes`,
`rest.maxBodyBytes`, and `mcp.maxBodyBytes` each default to one MiB. `rest: false` removes the live
REST facade and its wildcard dispatcher without removing REST metadata from OpenAPI.
Broker paths are normalized, and their complete subtree is reserved; a published REST method cannot
occupy a route that broker dispatch owns.
`broker.maxRequestBodyBytes` also covers each broker WebSocket message. `mcp.streamLimits` defaults
to 10,000 items and one MiB of aggregated serialized data.
Each fetched service discovery document is capped at one MiB; change
`discoveryMaxResponseBytes` only for a known larger catalog.

`invocationMiddleware` runs before REST catch-all discovery, and for valid-boundary MCP and enabled
broker traffic. REST misses therefore authenticate without causing unauthenticated discovery
fan-out; `servicePlaneInvocation` remains absent when no published route matched. Later application
routes bypass the catch-all. MCP method, protocol, origin, and declared-size failures are rejected
first; middleware registered on the supplied Hono app is the hook for audit or rate limiting that
must observe every request. The invocation middleware must set:

```ts
c.set('servicePlaneCaller', {
  id: string,
  kind: 'service' | 'user',
  orgId?: string,
  principalKind?: string,
});
```

`hmacServiceClientAuth<TEnv>(...)` and `jwkServiceClientAuth<TEnv>(...)` carry the plane's Hono
environment into their client/service resolver callbacks, so construct the authenticator once and
read runtime bindings from its typed `Context<TEnv>`.

It may also set `servicePlaneConnInfo`. After `next()`, inspect `servicePlaneInvocation` for audit
metadata. Calling `next()` without a caller is a configuration error; middleware may instead return
its own authenticated `401` or authorized `403`. Invocation middleware is inside the request-entry
deadline: a late `next()` is refused before parsing, discovery, or dispatch can start background
work after the caller has already received a timeout.

For a broker WebSocket, this middleware authenticates the physical HTTP upgrade. Browser clients
use a secure cookie or short-lived URL ticket; server runtimes may supply upgrade headers inside a
custom `createWebSocket` closure. Logical call metadata remains per call.

`abilityClient({ ability, targetServiceId, caller?, scopes? }, bindings)` creates a trusted,
contract-inferred in-process client. Required method scopes come from `ability`; `scopes` is
additive. Each method accepts optional `requestId`, `idempotencyKey`, and `timeoutMs`. Endpoint,
grants, issuer, and an automatic request ID resolve for every call instead of being pinned to the
facade lifetime. Construction is synchronous and performs no I/O. Hibernating methods fail before
resolving a downstream endpoint because they require a direct service WebSocket.

### Low-level projection helpers

Most applications use `ServicePlaneControlPlane`. Custom shells may call
`handleControlPlaneRestRequest` or `handleControlPlaneMcpRequest` with a request-scoped registry and
`ControlPlaneInvocationOptions`; the REST middleware hook must authenticate before invoking its
`next` callback. `generateControlPlaneOpenApi` and `generateMcpDiscovery` project an already
discovered snapshot without mounting routes.

## Service Endpoints

```ts
cloudflareServiceBinding({
  id,
  binding,
  abilityRpc?: true | ServiceAbilityNativeRpcBinding,
  grants?,
  discovery?,
  origin?,
})

httpsService({ id, baseUrl, fetch?, grants?, discovery? })
```

`abilityRpc: true` explicitly enables native unary calls on the same binding. A separate
`ServiceAbilityNativeRpcBinding` can be supplied for custom adapters. The endpoint's `fetch` path
handles discovery and streams. Endpoint identity must match the discovery document's service ID.

For native STS, expose one `ControlPlaneRpcTokenBinding` per caller. Build it with
`plane.capabilityTokenBinding(callerServiceId, bindings)` and consume it with
`controlPlaneRpcTokenRequester({ binding })`. The RPC input is `PinnedCapabilityTokenInput` and
cannot select its caller identity.

## Clients

Public broker client:

```ts
createBrokeredAbilityClient({
  ability: contract,
  targetServiceId,
  scopes?,
  requestId?, idempotencyKey?, timeoutMs?,
  transport: {
    type?: 'fetch',
    origin?, fetch?, headers?, path?, batch?, compression?,
  },
});
```

Use `{ type: 'websocket', url, createWebSocket?, reconnect?, path? }` for the broker socket. The
physical default is `/rpc/broker/ws`; the logical prefix is `/rpc/broker`. `headers` exists only on
the Fetch variant. Authenticate WebSocket on its HTTP upgrade with a browser cookie, short-lived
URL ticket, or a runtime-specific `createWebSocket` closure that can set headers.

Direct service client with an existing token provider:

```ts
createAbilityClient({
  ability: contract,
  targetServiceId,
  tokenProvider,
  proveTokenPossession?,
  scopes?,
  requestId?, idempotencyKey?, connInfo?, timeoutMs?,
  transport,
});
```

Or let the client build and cache a provider around a token requester:

```ts
createAbilityClient({
  ability: contract,
  callerServiceId,
  targetServiceId,
  requestToken,
  cache?, refreshSkewSeconds?, subject?, ttlSeconds?,
  proveTokenPossession?,
  transport,
});
```

Direct transports:

- `{ type: 'fetch', origin?, fetch?, batch?, compression? }`
- `{ type: 'service-binding', binding, origin?, compression? }` — native unary, binding Fetch for streams
- `{ type: 'websocket', url, createWebSocket?, reconnect? }`

Methods accept `(input, options?)`. Per-call `requestId`, `idempotencyKey`, `timeoutMs`, and `signal`
override client defaults. A direct client also permits `connInfo`; a brokered client does not,
because public connection information is trusted-middleware-owned.

Required method scopes are automatic. `scopes` adds ability-level scopes when needed. Client
construction is synchronous and performs no network work until the first call.

Call `disposeAbilityClient(client)` when a WebSocket client's owner shuts down. It cancels active
streams, closes its sockets, prevents reconnect, and rejects later calls as `cancelled`. Repeated
disposal is safe. Fetch and `service-binding` clients own no persistent connection, so disposal is
an idempotent no-op and does not disable them.

## Wire Features

```ts
type ServicePlaneClientWireOptions = {
  batch?: boolean | { maxSize?: number };
  compression?: boolean | {
    request?: boolean | { encoding?: 'gzip' | 'deflate' | 'deflate-raw'; threshold?: number };
    response?: boolean | { encodings?: Array<'gzip' | 'deflate' | 'deflate-raw'> };
  };
};
```

Server compression reverses the request/response direction and adds a response threshold. Batching
combines only concurrent unary Fetch calls; streams and WebSockets never enter a batch.
Hibernating streams reject the broker, in-process `abilityClient`, batching, and every transport
except a direct service WebSocket. See [transports](transports.md).

## Discovery

`ServiceDiscoveryDocument` contains service identity, optional capability catalog and caller JWKS,
and ability discovery. Every method includes scopes plus input/output JSON Schema, and may include
REST/MCP metadata, `idempotent`, `timeoutMs`, or `stream: true`.

The plane validates endpoint identity, duplicate paths/names/operation IDs, scope references, and
projection shapes before using a snapshot.

## Capability Token Claims

Tokens are ES256 JWS values.

| Claim | Meaning |
| --- | --- |
| `iss` | Control-plane issuer |
| `aud` | Target service ID |
| `sub` | Calling service, or delegated principal when `act` is present |
| `act.sub` | Acting control-plane service for a delegated principal |
| `scp` | Granted scopes |
| `spa` | Authenticated caller access: `plane` or `service` |
| `spb` | Broker service ID for ingress-qualified calls |
| `spo`, `spk` | Delegated organization and principal kind |
| `cnf.jkt` | Sender-constrained caller-key thumbprint |
| `iat`, `nbf`, `exp`, `jti` | Issued-at, not-before, expiry, and token ID |

Handlers should read normalized `context.identity`, not decode claims themselves. A missing legacy
`spa` is interpreted as `plane`, the less-privileged class. Unknown or malformed claims fail closed
or are discarded according to their role.

## Deadlines

The caller sends relative milliseconds remaining. One request-entry budget covers control-plane
middleware, route and service discovery, issuer/token work, downstream transport, service JWKS and
authorization, and the handler. The service races the forwarded remainder against its unary method
ceiling. Values are capped at 10 minutes. Client local waits include a 250 ms grace so the service's
classified timeout can arrive first.

For client defaults and per-call `timeoutMs`, invalid values are rejected, `0` fails immediately,
and values above the ten-minute wire maximum are clamped. Ability method metadata is definition
policy instead: `0` disables that method ceiling and values above the JavaScript timer-safe maximum
are rejected. `timeout.methodMs` uses `false` as its explicit opt-out.

`timeout: { defaultMs, maxMs }` supplies or clamps forwarded budgets at each shell.
`context.remainingTimeoutMs()` lets a handler forward what remains to its own downstream client.
Failing to forward it starts a fresh downstream budget.

Method ceilings bound unary calls only. A forwarded caller deadline bounds ordinary stream setup and
each pull, but not a physical WebSocket or hibernating subscription lifetime. A timed-out handler
must observe `context.signal` to stop external work promptly.

Typed clients start the budget before token, proof, or caller-header resolution and forward only
what remains. The control plane continues the same budget across discovery and issuance; its
in-process client also keeps the local timer active for every ordinary stream pull.

## Idempotency

`idempotent: true` declares that repeating the same logical operation is safe. Service Plane never
retries automatically.

`idempotencyKey` identifies one caller attempt and reaches `context.idempotencyKey`. Service Plane
forwards and validates it but does not deduplicate. Store dedupe results under at least
`abilityId + methodName + key`; the same key can legitimately be used for different methods.

Retry only when both are true:

- the method is idempotent; and
- the error's `retryable` field says the failure is transient.

## Caches

Separate interfaces exist for registry snapshots, generated OpenAPI documents, service-side JWKS,
and caller tokens. Default registry and token caches are process-local where provided. Shared cache
implementations belong to the application because storage, consistency, and tenancy requirements
vary by deployment.

Registry and generated-OpenAPI cache failures are treated as misses; an external cache operation
that does not settle is abandoned after one second. The caller that creates a shared discovery fill
owns its lease: the fill stops accepting new waiters at that caller's deadline, or after ten seconds
without one. Shorter later callers may time out while waiting, but cannot release the shared fill
and create a discovery stampede. Remote discovery responses default to a one-MiB bound, JWKS to 256
KiB, and HTTP token responses to 64 KiB; each corresponding option exposes `maxResponseBytes`. The
shipped JWK requester automatically partitions token caches by proof-key thumbprint. A custom
proof-capable requester that can rotate keys must expose `cacheBinding()` with a stable public
fingerprint.

## Testing Helpers

`memoryCapabilityTokenCache()` provides a process-local token cache with injectable time.
`memoryWebSocketPair()` returns two connected, initially open `MemoryWebSocket` peers. The client
peer is accepted directly by `createWebSocket`; attach the server peer to the service or broker
WebSocket event methods under test. Closing either peer closes both, making lifecycle and reconnect
assertions deterministic without binding a port.

## Logging And Request IDs

Both shells adopt or generate `X-Request-Id` and forward it across Fetch, WebSocket logical calls,
and native RPC. Structured events cover requests, broker calls, REST, MCP, caller-auth refusals, and
opaque handler failures.

`ServicePlaneService.logger.log` and `ServicePlaneControlPlane.log` receive typed events and an
optional Hono context. Set the corresponding option to `false` to silence package logging. Log sinks
are best-effort: a logger failure never changes the API result.

## Errors

Ability clients throw `ServicePlaneClientError`. Branch on `servicePlaneErrorInfo(error)` when code
also handles local failures.

| `code` | Meaning |
| --- | --- |
| `capability_auth` | Token, ingress, access, scope, or proof refused the call |
| `ability_validation` | Input, output, or stream item failed its schema |
| `cancelled` | The caller aborted; status 499 and never retryable |
| `timeout` | A deadline elapsed |
| `handler` | Handler deliberately exposed a safe application failure |
| `internal` | Transport or unshaped implementation failure |

The info also contains HTTP-style `status`, `retryable`, optional validation `issues`, and optional
handler `reason`. Wire fields are validated before use.

Arbitrary handler errors are replaced with an opaque internal failure and logged service-side. To
expose an intentional message:

```ts
throw new AbilityHandlerError('Task not found', {
  status: 404,
  reason: 'task_not_found',
  retryable: false,
});
```

`retryable` means the same call may succeed later; it does not mean repeating a non-idempotent
operation is safe.
