# Reference

Goal: quickly look up the main Service Plane API pieces and wire shapes.

For a guided walkthrough, start with [Create A Service](service-creation.md) and [Create A Control Plane](plane-creation.md).

## Ability Definition

```ts
const ability = createAbilityBuilder<{ Bindings: Env }>();

defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
  description: 'Task operations for Asana',
  exposure: 'private' | 'published',
  access: 'plane' | 'service',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: ability
      .procedure({
        scopes: ['asana.tasks.write'],
        rest: { method: 'post', path: '/asana/tasks' },
        mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
      })
      .input(input)
      .output(output)
      .handler(({ context, input }) => context.env.ASANA.createTask(input)),
  },
  rpc: {
    path: '/rpc/asana.tasks',
    transports: ['fetch', 'cloudflare-service-binding', 'websocket'],
  },
});
```

Defaults:

- `exposure: 'private'`
- `access: 'plane'`
- `rpc.path: /rpc/<abilityId>`
- `rpc.transports: ['fetch']` for procedure-first abilities

`access: 'plane'` means the control plane or gateway owns any upstream product auth decision before calling the service. `access: 'service'` restricts the ability to authenticated service callers, and is enforced at both ends: the broker refuses it for a non-service caller from the discovered catalog, and the service refuses it from its own definition using the token's [`spa` claim](#capability-token-claims). Tightening an ability therefore takes effect when the service deploys, not when the plane's [discovery cache](plane-creation.md#discovery-cache) catches up.

## Ability Method

```ts
ability
  .procedure({ scopes: ['asana.tasks.write'] })
  .input(z.object({ name: z.string() }))
  .output(z.object({ id: z.string() }))
  .handler(({ input }) => ({ id: createId(input.name) }));
```

Each method accepts one input object and returns one output value. The wrapper validates both.

`input` and `output` accept any [Standard Schema](https://standardschema.dev) value that also implements [Standard JSON Schema](https://standardschema.dev/json-schema) — ArkType 2.1.28+, Valibot 1.2+ via `@valibot/to-json-schema`, VineJS 4.3+, Zod 4.2+, or anything else meeting both contracts. The choice is per schema: one method may take its `input` from one library and its `output` from another. See [Choosing A Validation Library](service-creation.md#choosing-a-validation-library).

Validation failures raise `AbilityValidationError` carrying the issues the schema library reported. See [Errors](#errors).

Optional `rest` metadata projects the method into the generated OpenAPI 3.2 document; `rest.method` accepts `get`, `post`, `put`, `patch`, `delete`, and `query` (HTTP QUERY per RFC 10008 — request parameters in the body, safe and idempotent). See [OpenAPI and MCP](openapi-mcp.md#openapi).

Optional `idempotent: true` declares that calling the method again with the same input cannot double its effect, so a caller may safely retry an ambiguous failure. See [Idempotency](#idempotency).

## Streaming Methods

Some methods produce many results over time. `ability.stream()` takes the yielded-item schema, and
the handler returns an async iterator:

```ts
ability
  .stream(z.object({ chunk: z.string() }), { scopes: ['hub.files.read'] })
  .input(z.object({ path: z.string() }))
  .handler(async function* ({ context, input }) {
    for await (const chunk of context.env.STORAGE.read(input.path)) yield { chunk };
  });
```

The typed client returns an async iterator with oRPC flow control:

```ts
const api = createBrokeredAbilityClient({ ability: hubFiles, /* ... */ });
const stream = await api.readFile({ path: '/big.bin' });
for await (const item of stream) {
  // ...
}
```

Fetch and WebSocket carry streams. A Cloudflare service-binding transport uses native RPC for unary
procedures and binding Fetch for streams. Through the broker, the iterator crosses both hops while
the application still connects only to the control plane. Streaming methods cannot project MCP
prompts, resources, or REST operations; MCP tools are supported.

For high-frequency streams (LLM token deltas), batch deltas in the handler and declare the batch as the item (`output: z.array(...)`) — see the coalescing recipe in [Streaming](streaming.md#high-frequency-streams).

Durable Object hibernation uses `ability.hibernationStream(itemSchema)`,
`HibernationAsyncIteratorClass`, and `HibernationHandlerPlugin`. Because later values are produced
after the original procedure has returned, send them with
`encodeAbilityHibernationEvent(itemSchema, iteratorId, value)` so the item schema remains enforced.
Do not include a hibernating procedure in an oRPC batch.

Full guide, including per-runtime WebSocket and hibernation wiring: [Streaming](streaming.md).

## Discovery Document

```ts
type ServiceDiscoveryDocument = {
  id: string;
  title: string;
  version: string;
  capabilities?: CapabilityCatalog;
  abilities: ServiceAbilityDiscovery[];
};
```

Ability discovery includes exposure, access, scopes, RPC path, transports, method names, method scopes, JSON Schemas, optional REST metadata, and optional MCP metadata. Streaming methods carry `stream: true`, with their `outputSchema` describing one streamed item.

The control-plane registry accepts a discovery document only when its `id`, and its optional `capabilities.serviceId`, match the configured endpoint `id`. The endpoint configuration is the identity authority; a service cannot publish metadata for another configured service.

## Service

```ts
new ServicePlaneService({
  id,
  title,
  version,
  auth,
  ingress,
  capabilities,
  abilities,
});
```

Mounted routes:

```txt
GET /.well-known/service-plane/service.json
ALL /rpc/<abilityId>/<procedure>
ALL /rpc/<abilityId>                              (WebSocket upgrade)
```

`ingress` is optional. When configured, ability RPC routes require a capability token with a signed broker claim from the configured control-plane service id. Non-brokered tokens are rejected before handler execution.

`httpCache` is optional. When set (`true` or `{ maxAgeSeconds, staleWhileRevalidateSeconds, tags }`), the discovery route emits `Cache-Control` and `Cache-Tag` headers so an edge cache (e.g. Cloudflare Workers Cache) can serve it without executing the Worker. See [Cloudflare](cloudflare.md#caching-metadata-at-the-edge).

## Control Plane

```ts
new ServicePlaneControlPlane({
  signingKeys,
  authenticateCaller,
  services,
  openapi,
  broker,
  mcp,
});
```

Mounted routes:

```txt
POST /.well-known/service-plane/capability-token
GET  /.well-known/service-plane/jwks.json
GET  /openapi.json
POST /rpc/mcp                                    (MCP streamable HTTP)
POST /rpc/broker/call                            (oRPC unary broker)
POST /rpc/broker/stream                          (oRPC streaming broker)
ALL  /rpc/broker/ws                              (oRPC WebSocket, when configured)
```

The plane serves the OpenAPI document only. Mount a documentation UI yourself on `plane.app` (e.g. `@hono/swagger-ui` or `@scalar/hono-api-reference`) pointed at `/openapi.json`.

The JWKS route is served from the signing authority (`signingKeys`, `issuer`) and never
resolves `services` or fetches discovery documents, so key publication survives a service-discovery
outage. The capability-token, broker, and MCP routes additionally need the authorization catalog
(discovered capabilities and grants) and fail closed when it cannot be built. See
[auth.md](auth.md#signing-authority-and-authorization-catalog).

`httpCache` is optional and mirrors the service option: when set, the OpenAPI and JWKS routes emit `Cache-Control` and `Cache-Tag` headers. The capability-token endpoint always responds with `Cache-Control: no-store` and `Pragma: no-cache`. Broker and MCP RPC responses are never cache-eligible.

`discoveryCache` caches the discovered service catalog for every route that needs it — token issuance, broker, MCP, and OpenAPI. It defaults to a process-local cache; pass a `RegistryCache` to share one across a fleet, `false` to resolve fresh every time, or an object keyed by `token` (issuance, broker and MCP), `openapi`, and `default` to give either path its own store. `openapi.cache` is separate and caches the generated document rather than the catalog behind it; set its TTL with `openapi.cacheTtlSeconds`.

`services(context)` resolves runtime bindings and deployment configuration for one logical service
catalog. Its endpoint set and discovery metadata must not vary by caller or organization. Services
own organization-specific data scoping behind their stable ability definitions; applications that
need genuinely different catalogs should use separate control-plane instances and discovery caches.

`broker.caller` and `mcp.caller` use `BrokerCallerResolver`. The resolver may return a
`BrokerCaller`, an application-owned `Response`, or `undefined`. A returned response passes through
unchanged, which lets existing Hono auth middleware or the resolver emit the correct
`WWW-Authenticate` challenge with a `401`. Returning `undefined` is a generic `403` refusal; an
omitted resolver is a configuration error and returns `500`.

`mcp.streamLimits` accepts `maxItems` and `maxBytes` for streaming tools (defaults: 10,000 items and 1 MiB). `maxBytes` independently caps serialized item aggregation and cumulative optional progress-notification bytes. Exhausting the item aggregation budget fails the tool call in-band; exhausting only the progress budget stops further notifications while the bounded final result continues.

The MCP endpoint accepts protocol revisions `2025-11-25`, `2025-06-18`, and `2025-03-26`; missing
`MCP-Protocol-Version` means `2025-03-26`, while unsupported values return `400`. Incoming browser
`Origin` headers must match the endpoint origin. `mcp.allowedOrigins` adds exact trusted origins for
intentional cross-origin clients; other origins return `403` before caller resolution.

## Caller

```ts
const api = createBrokeredAbilityClient({
  ability: asanaTasks,
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  transport: {
    origin: 'https://api.example.com',
    headers: () => applicationAuthHeaders(),
  },
});
```

This is the application-facing client. It is synchronous to create, resolves transport work lazily,
and connects only to the control plane. The control plane authenticates the application caller,
discovers the ability, checks grants, issues a brokered token, and routes the call.

For a trusted service-to-service or local-development caller that intentionally connects directly:

```ts
const api = createAbilityClient({
  ability: asanaTasks,
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken,
  transport: { type: 'fetch', origin: 'https://asana.internal' },
});
```

Transports:

- `{ type: 'fetch', fetch?, origin?, plugins? }`
- `{ type: 'service-binding', binding, plugins? }` — native unary plus binding Fetch streams
- `{ type: 'websocket', url, createWebSocket?, reconnect?, plugins? }`
- `{ type: 'custom', link }`

`createBrokeredAbilityClient` accepts Fetch or WebSocket. Its WebSocket endpoint is
`/rpc/broker/ws`; `path` remains the logical `/rpc/broker` oRPC prefix.

`ServiceEndpoint.abilityRpc` is likewise explicit: pass an object forwarding `invokeAbility(...)`
for the native unary fast path. The endpoint's binding still supplies `fetch` for streams. Native
RPC is never inferred because a Workers service-binding stub returns a callable proxy for every
property name.

Which transport fits which pair of services — by environment, performance, and cost — is covered in [Choosing A Transport](transports.md).

Token requesters:

- `controlPlaneRpcTokenRequester(...)`
- `controlPlaneJwkTokenRequester(...)`
- `controlPlaneHmacTokenRequester(...)`

These token requesters are needed by direct `createAbilityClient` calls. A brokered application
client uses `transport.headers` for the application's own authentication scheme and never receives
the service capability token.

## Capability Token Claims

Capability tokens are ES256 JWS tokens with a closed claim set. Unknown claims are dropped at verification.

Tokens come in two shapes, and `sub` always answers the same question: who is this token about. A plain service-to-service token is about the calling service. A delegated token uses RFC 8693's `act` actor-claim semantics: it is about the plane-class principal, while the calling service moves into `act.sub`. The presence of `act` is what switches the interpretation, and the verifier resolves it for you: `identity.serviceId` is always the calling service, and `identity.subject` is set only when a principal is delegated.

Plain service token:

```json
{ "iss": "control-plane", "sub": "workflow-runner", "aud": "asana", "scp": ["asana.tasks.write"], "spa": "service" }
```

→ `identity.serviceId = 'workflow-runner'`, no `identity.subject`.

Delegated (plane-principal) token:

```json
{ "iss": "control-plane", "sub": "key-123", "act": { "sub": "control-plane" }, "spk": "api-key", "spo": "org-42", "aud": "asana", "scp": ["asana.tasks.write"], "spa": "plane" }
```

→ `identity.serviceId = 'control-plane'` (from `act.sub`), `identity.subject = { id: 'key-123', kind: 'api-key', orgId: 'org-42' }`.

| Claim | Plain service token | Delegated token (`act` present) |
| --- | --- | --- |
| `sub` | calling service → `identity.serviceId` | delegated principal → `identity.subject.id` |
| `act` | absent | acting service, `{ sub }` → `identity.serviceId` |
| `spk` | rejected at verification | optional principal kind → `identity.subject.kind` |
| `spo` | rejected at verification | subject's org → `identity.subject.orgId` |
| `iss` | control-plane issuer → `identity.issuer` | same |
| `aud` | target service id → `identity.audience` | same |
| `scp` | granted scopes → `identity.scopes` | same |
| `spa` | caller access class → `identity.callerAccess`; `'service'` in the example above, `'plane'` when the plane calls without a service caller (e.g. an anonymous broker) | always `'plane'` — a delegated subject is a fronted caller, and the issuer refuses the other pairing |
| `spb` | broker service id on brokered (ingress) tokens → `identity.brokerServiceId` | same |
| `cnf` | `{ jkt }` on tokens bound to a caller key (always, for JWK callers) → `identity.confirmation`, only after a matching proof verified | same |
| `jti` | token id → `identity.tokenId` | same |
| `exp` | expiry → `identity.expiresAt`; `iat`/`nbf` are also enforced | same |

The `act` delegation relationship comes from RFC 8693 and `cnf` from RFC 7800 (with the `jkt` confirmation method registered by RFC 9449). `scp`, `spa`, `spk`, `spo`, and `spb` are Service Plane-specific claims, and `/.well-known/service-plane/capability-token` is the package's JSON capability endpoint, not an RFC 8693 token-exchange endpoint. `spk` is an optional application-owned string; its absence preserves the legacy user-subject shape, and it never influences `spa` or service access.

`spa` is the access class the control plane authenticated for the caller. It is `service` for a caller the plane proved to be another service — the capability-token endpoint, `issueCapabilityTokenForCaller`, and a broker or MCP caller resolver returning `kind: 'service'` — and `plane` for every caller the plane fronts itself: users, API keys, anonymous traffic. Services compare it against the ability's own `access` and reject a mismatch with 403 before the handler is created. A token carrying no `spa` reads as `plane`, so a control plane that predates the claim can only reach `access: 'plane'` abilities.

That default dictates the rollout order: **upgrade the control plane before any service declares `access: 'service'`.** A service on this version behind an older plane refuses every caller of its service-only abilities — legitimate service callers included — until the plane mints the claim. The reverse mix is the transitional gap, not a hole in the new guarantee: a *service* still on an older package version never checks `spa`, so for that service tightening `access` keeps depending on the plane's catalog refresh until the service upgrades.

Delegated subjects are minted only by control-plane code — the broker/MCP caller resolver (a `BrokerCaller` with `kind: 'user'` and optional `orgId` / `principalKind`) or a low-level direct `issueCapabilityToken({ subject, ... })` call. The capability-token endpoint and `issueCapabilityTokenForCaller` reject caller-supplied subjects with 403, and shipped token requesters fail fast locally. Direct issue mints a non-brokered token; the broker selects `issueBrokeredCapabilityToken` automatically for ingress-required targets. See [auth](auth.md#subject-delegation).

## Logging And Request Correlation

Every request that enters a `ServicePlaneControlPlane` gets an `X-Request-Id` (incoming header value
or a generated UUID, via `hono/request-id`). Fetch and logical WebSocket calls carry it as a
per-call header; Cloudflare native RPC carries it as `requestId` on `invokeAbility(...)`. The service
adopts that value into its Hono `requestId` context variable, so one id correlates plane and service
logs end to end.

Connection info follows the same split when `broker.connInfo` / `mcp.connInfo` are configured:
`X-Service-Plane-Conn-Info` on Fetch and logical WebSocket calls, and `connInfo` on
`invokeAbility(...)`. Services expose it to handlers only for brokered calls with ingress enabled — see
[Forwarded Connection Info](auth.md#forwarded-connection-info).

## Deadlines

Two bounds, layered. A **service-side ceiling** that always exists, and an **end-to-end budget** a caller may set on top of it. Whichever expires first wins.

### The ceiling you get for free

Every unary ability method is bounded at `DEFAULT_ABILITY_TIMEOUT_MS` — 10 seconds — without anyone configuring anything.

That default is deliberate. gRPC and [Connect](https://connectrpc.com/docs/node/timeouts/) leave deadlines entirely to the caller, and the standing advice in [gRPC's own guidance](https://grpc.io/blog/deadlines/) is to *"always set a deadline"* — a rule that only needs stating because the unset case is unbounded. Systems that own a default do not need the reminder: [Envoy routes time out at 15s](https://www.envoyproxy.io/docs/envoy/latest/faq/configuration/timeouts), and [Armeria's server request timeout is 10s](https://armeria.dev/docs/server/timeouts/). 10s matches the closest analogue — a server bounding its own request handling.

Tune it where it belongs:

```ts
new ServicePlaneService({
  timeout: { methodMs: 2_500 },     // service-wide ceiling; `false` removes it
});

bigExport: ability.procedure({ timeoutMs: 120_000, ... });  // the one slow method
bigMigration: ability.procedure({ timeoutMs: 0, ... });     // opt this one out entirely
```

Method values are validated at definition time — a negative, fractional, or absurdly large value refuses the service instead of silently dropping or clamping the ceiling — and a method's own ceiling is deliberately **not** clamped to the 10-minute wire limit: that limit bounds what a *caller* may ask for, not how long a service allows its own export to run.

Raise the exception, not the ceiling. **Streaming methods are never bounded this way** — for the reason Envoy documents about its own route timeout, a bound that suits a request is wrong for a stream. Stream lifetime is untouched either way.

The effective ceiling is advertised per method in the discovery document, so a gateway can size its own wait against it.

### The budget a caller sets

A caller states how long it is willing to wait; every hop spends from that budget rather than granting a new one.

```ts
const api = createBrokeredAbilityClient({
  ability: syncAbility,
  // ...other routing options
  timeoutMs: 5_000,
});
```

The value travels as `X-Service-Plane-Timeout` on Fetch and WebSocket logical requests, and as
`timeoutMs` on native `invokeAbility(...)`. It is **relative milliseconds remaining**, not an
absolute timestamp. Each hop measures its own elapsed time and forwards what remains.

What each participant does with it:

- **The caller** bounds its own wait per method call and rejects with `ServicePlaneTimeoutError` when the budget elapses.
- **The control plane** reads an inbound `X-Service-Plane-Timeout` on broker and MCP requests and forwards *what is left* after its own work — resolving the catalog, minting a token. If nothing is left, the broker fails before calling the service.
- **The service** turns it into the `signal` its ability handlers receive, and the validating wrapper fails the method if the handler outlives it. A handler that ignores `signal` therefore loses the work, not correctness.

```ts
.handler(({ context, input }) => run(input, { signal: context.signal }))
```

### Chains

A budget only survives a chain if each service passes on what is left of its own. Handlers get `remainingTimeoutMs()` for exactly that:

```ts
.handler(({ context, input }) => {
  const downstream = createAbilityClient({
    ...opts,
    timeoutMs: context.remainingTimeoutMs?.(),
  });
  return downstream.doWork(input, { signal: context.signal });
})
```

Skip it and the next hop starts a **fresh** budget: `A(5s) → B` where B calls C with its own 5s means the end-to-end bound A asked for is gone. Nothing enforces this for you — a service that calls onward has to opt in.

At exhaustion the pattern stays safe: `remainingTimeoutMs()` returns `0` once the budget is gone, and a downstream client configured with `timeoutMs: 0` fails the call immediately instead of running unbounded — the same fail-fast the broker applies before opening a service leg.

### What This Does And Does Not Bound

Three of the four mechanisms are plain timers over a duration, so they do not read a clock and cannot drift:

- the caller's own wait (`setTimeout`),
- the `signal` handed to handlers (`AbortSignal.timeout`),
- the wrapper's refusal to resolve a method past the deadline.

Only the plane's decrement does clock arithmetic — `Date.now()` at request entry versus at the moment it opens the service leg. Both readings are on the same machine, so there is no cross-host skew to worry about.

It does **not**:

- **guarantee transport cancellation from the local timeout race.** The forwarded budget is what
  guarantees the service stops. An explicit oRPC call `signal` can additionally abort supported transports.
- **close a WebSocket.** The deadline fails a *procedure call*. A WebSocket stays open, so on Cloudflare a Durable Object holding one keeps billing duration — see [Transports](transports.md). Use an idle timeout to bound that, not a deadline.
- **bound a stream's lifetime.** It bounds the call that returns the stream, not consumption of its items.

### On Cloudflare

Workers freeze `Date.now()` during synchronous execution and advance it on I/O (a Spectre mitigation). That suits this design rather than breaking it: the plane's decrement measures *waiting* — the discovery fan-out, the token mint — and waiting is I/O, which is exactly when the clock moves. What stays invisible is pure CPU time, which the Workers CPU limit already bounds and which is small next to a network hop. The effect is that a plane's decrement can slightly under-count, never over-count, so a service is handed a budget that is generous rather than short.

Two caveats worth stating:

- The runtime matrix in [#11](https://github.com/JUVOJustin/service-plane/issues/11) does not run yet, so the above reflects documented workerd behavior, not a test result on workerd.
- A hibernating iterator cannot rely on an in-memory deadline surviving sleep. Store subscription
  expiry in Durable Object state and check it when emitting a later event.

Values are clamped to `MAX_SERVICE_PLANE_TIMEOUT_MS` (10 minutes) and anything that is not a positive integer count of milliseconds is ignored. A caller that sends nothing forwards nothing — the service-side ceiling above is what still bounds the call.

Both shells take a policy for what they will accept:

```ts
new ServicePlaneControlPlane({ timeout: { defaultMs: 10_000, maxMs: 60_000 } });
new ServicePlaneService({ timeout: { defaultMs: 5_000, maxMs: 30_000 } });
```

`defaultMs` supplies a budget when the caller sent none. It is resolved for each logical oRPC call,
including calls carried over a WebSocket. `maxMs` clamps an explicit or defaulted budget. The plane
has no built-in default; the service's unary ceiling is the always-present bound.

A caller's own local wait is set slightly **above** the budget it forwards (`SERVICE_PLANE_TIMEOUT_GRACE_MS`, 250ms). [Armeria does the same thing](https://armeria.dev/docs/advanced/understanding-timeouts/) — its client response timeout of 15s sits above its 10s server request timeout — so that the service's own enforcement fires first and the caller gets the error the service actually raised instead of a bare local abort that says nothing about what happened downstream.

### When a deadline fires

| | This package | gRPC | Envoy | Armeria |
| --- | --- | --- | --- | --- |
| Caller sees | `ORPCError` plus Service Plane `code: 'timeout'`, `status: 504` data | `DEADLINE_EXCEEDED` (maps to 504) | 504 Gateway Timeout | `ResponseTimeoutException` |
| Service sees | The method rejects; `signal` is aborted | Context cancelled (`CANCELLED`) | Upstream stream reset | `RequestTimeoutException`, work cancelled |
| Peer is told | Forwarded deadline; explicit call signals may also abort transport | Yes | Yes | Yes (RST_STREAM / close) |

The forwarded deadline remains authoritative because a local timeout race cannot promise that every
runtime propagated transport cancellation before the service began work.

`retryable` is `true` for a timeout, matching Envoy's treatment of 504 as a `gateway-error` worth retrying — but only retry when the method is also `idempotent`. See [Idempotency](#idempotency).

**`status` is a classification, not necessarily the outer HTTP status.** oRPC carries the typed error
inside its protocol response. Read the Service Plane classification with `servicePlaneErrorInfo`.

Unlike forwarded connection info, a deadline is honoured from **any** caller without requiring ingress. It is not an authorization input: a caller shortening its own budget can only cut itself off, and a long one is clamped.

The budget is per logical procedure call on Fetch, WebSocket, and native service-binding RPC.

## Idempotency

Deadlines create ambiguous failures — a call that timed out may or may not have run — so a caller needs two things to retry correctly: whether the method is safe to call again, and a way for the service to recognize the retry.

**The method says whether it is safe.** Mark it in the ability definition, the same way `stream` is marked:

```ts
lookupTask: ability
  .procedure({ idempotent: true, scopes: ['asana.tasks.read'] })
  .input(TaskQuery)
  .output(Task)
  .handler(lookupTask);
```

It is projected into the discovery document so callers and gateways can read it. An unmarked method is **absent** from the projection rather than `false`: it makes no claim, which is the safe reading. Note that this package never retries on its own — retry policy is the caller's, and mesh-level retry belongs to your platform.

Combined with `retryable` from the error taxonomy, the decision is: retry only when the failure was transient **and** the method is idempotent.

**The caller says which attempt this is.** Pass a key and it travels as an oRPC header or the
`idempotencyKey` field on native `invokeAbility(...)`, reaching the procedure context:

```ts
const api = createBrokeredAbilityClient({ /* ... */ idempotencyKey: 'attempt-7f3a' });

// service side
.handler(({ context, input }) => runOnce(context.idempotencyKey, input));
```

The package forwards the key and nothing else. Deduplicating means storing a result and expiring it, which needs a store and a retention policy — the same reason discovery snapshots and token caches are yours to supply.

Two things to get right when you build that store:

- **Scope the key by method name.** The key identifies the caller's *attempt*, not one method call, because it rides the transport rather than the RPC payload. Two different methods using the same configured key would otherwise collide. Store under `${idempotencyKey}:${methodName}`.
- Keys are validated on both send and receive: word characters, `-`, and `=` only, up to 255 characters. Anything else is dropped rather than forwarded, so a key can never smuggle a separator into a log line or a store key.

Both shells log structured JSON events to the console by default. Every event carries `event`, `level`, and (when known) `requestId`.

Service events (`ServicePlaneLogEvent`):

- `service_plane.discovery.served`
- `service_plane.request.completed`
- `service_plane.request.failed`
- `service_plane.ability.handler_failed` — a handler throw the wrapper replaced with an opaque error; carries the original name and message

Control-plane events:

- `service_plane.broker.connect.completed` / `service_plane.broker.connect.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.broker.call.completed` / `service_plane.broker.call.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.mcp.tool.completed` / `service_plane.mcp.tool.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.mcp.resource.completed` / `service_plane.mcp.resource.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.mcp.prompt.completed` / `service_plane.mcp.prompt.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.caller_auth.not_configured` (`ServicePlaneControlPlaneLogEvent`)
- `service_plane.caller_auth.hmac_unauthorized` / `service_plane.caller_auth.jwk_unauthorized` (caller-auth middleware, own `log` option). The `reason` field names the check that failed.

Where the events go is up to the app. Each surface takes a `log` callback that is invoked once per event; when it is omitted, the package writes the event as one JSON line to the console. The package never talks to a logging framework itself — you forward events to whatever logger the app uses:

```ts
new ServicePlaneService({
  // ...
  logger: { log: (event, context) => appLogger.info(event) }, // or false to disable request logging
  requestId: { generator: myIdGenerator }, // customize hono/request-id; the middleware itself is always on
});

new ServicePlaneControlPlane({
  // ...
  log: (event, context) => appLogger.info(event), // or false to silence broker/MCP/config events
});
```

The `log` callback receives the Hono `Context` as a second argument when the event was emitted inside a request, so a request-scoped logger stored on the context by your own Hono middleware (e.g. `c.set('logger', child)`) is reachable from it. On the service, middleware mounted via the `middleware` option can also read the emitted events after `await next()` with `servicePlaneLogEvents(context)` — useful when you prefer to do all log shipping in one place in your own middleware.

## Caches

Use separate caches for:

- service discovery snapshots
- generated OpenAPI document
- control-plane JWKS fetched by services
- caller capability tokens

Token cache keys include caller id, target service id, ability id, normalized scopes, optional TTL, and the complete delegated subject when present — including principal kind — so tokens cannot collide across principals or principal categories.

## Errors

- Missing or invalid token: `CapabilityAuthError` with 401-style status.
- Missing scope: `CapabilityAuthError` with 403-style status.
- Invalid caller input: `AbilityValidationError` with 422-style status.
- Invalid service output or streamed item: `AbilityValidationError` with 500-style status — the handler broke its own declared contract.
- Deadline elapsed: `ServicePlaneTimeoutError` with 504-style status, thrown by whichever hop notices first. See [Deadlines](#deadlines).

Validation details are carried under the Service Plane data nested in the received `ORPCError`. Use
`servicePlaneErrorInfo` for a transport-independent view:

```ts
import { servicePlaneErrorInfo } from 'service-plane/service';

try {
  await asana.createTask(input);
} catch (error) {
  const info = servicePlaneErrorInfo(error);
  if (info?.code === 'ability_validation') {
    return Response.json({ errors: info.issues }, { status: info.status });
  }
  throw error;
}
```

### Reading An Error A Caller Received

oRPC callers receive `ORPCError`. Service Plane keeps its cross-transport taxonomy under
`error.data.servicePlane`; `servicePlaneErrorInfo` reads that shape as well as an in-process Service
Plane error:

```ts
import { servicePlaneErrorInfo } from 'service-plane/service';

const info = servicePlaneErrorInfo(error);
if (info?.retryable) return retryLater();
if (info?.code === 'capability_auth') return refreshTokenAndRetry();
```

| `code` | Meaning |
| --- | --- |
| `capability_auth` | Token, scope, ingress, or proof-of-possession check refused the call |
| `ability_validation` | Input or output did not satisfy the method's schema |
| `timeout` | The caller's deadline elapsed |
| `handler` | The handler failed deliberately and chose what the caller sees |
| `internal` | Anything else, including a handler failure the service did not shape |

`retryable` means the failure is transient — the same call may succeed later. It does **not** mean retrying is safe: for a non-idempotent method a retry can still double an effect. It defaults from the status (408, 429, 502, 503, 504) and can be set explicitly. A 500 is deliberately not retryable by default: a handler that broke once usually breaks again, and saying otherwise invites a retry storm against a service already failing.

Every field is re-validated when read, so a hostile or buggy peer cannot make a refusal look retryable.

### What An Ability Handler May Throw

Errors this package raises are already shaped for callers and pass through untouched. Everything else a handler throws is **replaced** with an opaque 500 before it leaves the service:

```
Service-Plane ability handler failed: <methodName>
```

That is deliberate. A database driver error or a `TypeError` was written for an operator, not a caller, and routinely carries connection strings, internal hostnames, SQL, or row data. The same replacement applies to a streaming method that fails mid-stream.

The replacement also holds across chains: an error that already carries the taxonomy — thrown by a downstream service and rebuilt as a plain `Error` on the way through — passes intermediate hops untouched instead of being re-replaced, so the original `code`/`status`/`retryable`/`reason` reach the first caller.

Every replacement is logged service-side as a `service_plane.ability.handler_failed` event carrying the original error's name and message (the RPC response is a 200 batch, so `request.failed` never fires for it). The original object also stays reachable in-process via `handlerFailureCause(error)`.

To choose what the caller sees, throw `AbilityHandlerError`:

```ts
import { AbilityHandlerError } from 'service-plane/service';

throw new AbilityHandlerError('Monthly export quota is used up', {
  reason: 'quota_exhausted', // your own discriminator, carried alongside code: 'handler'
  retryable: false,
  status: 429,
});
```

The original failure is not lost — it is held beside the replacement in-process and sent to the
service logger. It is deliberately not exposed as the oRPC error cause.

A schema that deviates from the Standard Schema contract fails closed: a validator that throws, or returns neither a value nor issues, raises `AbilityValidationError` rather than letting the value through. A schema missing `~standard.validate` or `~standard.jsonSchema` is rejected when the service is defined, not on the first call.

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [Cloudflare](cloudflare.md).
