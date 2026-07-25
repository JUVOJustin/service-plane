# Reference

Goal: quickly look up the main Service Plane API pieces and wire shapes.

For a guided walkthrough, start with [Create A Service](service-creation.md) and [Create A Control Plane](plane-creation.md).

## Ability Definition

```ts
defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
  description: 'Task operations for Asana',
  exposure: 'private' | 'published',
  access: 'plane' | 'service',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: abilityMethod({
      input,
      output,
      scopes: ['asana.tasks.write'],
      rest: { method: 'post', path: '/asana/tasks' },
      mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
    }),
  },
  rpc: {
    path: '/rpc/asana.tasks',
    transports: ['http-batch', 'websocket'],
  },
  handler: ({ context, identity }) => new AsanaTasksHandler(context.env, identity),
});
```

Defaults:

- `exposure: 'private'`
- `access: 'plane'`
- `rpc.path: /rpc/<abilityId>`
- `rpc.transports: ['http-batch']`

`access: 'plane'` means the control plane or gateway owns any upstream product auth decision before calling the service. `access: 'service'` restricts broker access to authenticated service callers.

## Ability Method

```ts
abilityMethod({
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  scopes: ['asana.tasks.write'],
});
```

Each method accepts one input object and returns one output value. The wrapper validates both with Zod.

## Streaming Methods

Some methods produce many results over time — large file transfers, long exports. Declare them with `stream: true`; the `output` schema then validates **each streamed item**, and the handler returns an async iterable (usually an async generator), a sync iterable, or a `ReadableStream`:

```ts
abilityMethod({
  input: z.object({ path: z.string() }),
  output: z.object({ chunk: z.string() }), // validates each streamed item
  scopes: ['hub.files.read'],
  stream: true,
});
```

There is no custom wire protocol: the wrapper returns the items as a **native Cap'n Web `ReadableStream`** with built-in flow control, so callers receive them exactly like any other RPC value:

```ts
const api = await abilitySession<AbilityRpc<typeof hubFiles>>({ ... });
const stream = await api.readFile({ path: '/big.bin' }); // ReadableStream<{ chunk: string }>
for await (const item of stream) {
  // ...
}
```

Cap'n Web streams ride the ongoing session, so streaming methods require a **session transport**: WebSocket (`websocketRpc`), the Cloudflare native binding (`cloudflareNativeRpc`), or a custom bidirectional transport. The one-round-trip HTTP-batch transport cannot carry them — calling a streaming method over HTTP-batch fails with a 405, and an ability that declares streaming methods must enable `websocket` or `cloudflare-binding-rpc` in `rpc.transports` (checked at setup). Unary methods on the same ability keep working over HTTP-batch.

Through the broker, streams proxy transparently: connect to `/rpc/broker` over WebSocket, and the plane reaches the service over its own session transport — preferring the endpoint's native ability RPC binding (`ServiceEndpoint.abilityRpc`, set explicitly via `cloudflareServiceBinding({ abilityRpc })` — a Workers stub answers any property with a callable proxy, so it cannot be detected), then WebSocket. When the caller's own leg cannot carry a stream (HTTP-batch), the ability's streaming methods are rejected with a 405 and the plane leg stays on HTTP-batch — no socket is opened for a stream that could never be returned. Streaming methods cannot project MCP prompts, resources, or REST operations (single-response surfaces); MCP tools are supported.

For high-frequency streams (LLM token deltas), batch deltas in the handler and declare the batch as the item (`output: z.array(...)`) — see the coalescing recipe in [Streaming](streaming.md#high-frequency-streams).

Full guide, including per-runtime WebSocket wiring and performance guidance: [Streaming](streaming.md).

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
ALL /rpc/<abilityId>
```

`ingress` is optional. When configured, ability RPC routes require a capability token with a signed broker claim from the configured control-plane service id. Non-brokered tokens are rejected before handler execution.

`httpCache` is optional. When set (`true` or `{ maxAgeSeconds, staleWhileRevalidateSeconds, tags }`), the discovery route emits `Cache-Control` and `Cache-Tag` headers so an edge cache (e.g. Cloudflare Workers Cache) can serve it without executing the Worker. See [Cloudflare](cloudflare.md#caching-metadata-at-the-edge).

## Control Plane

```ts
new ServicePlaneControlPlane({
  signingSecret,
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
ALL  /rpc/broker
```

The plane serves the OpenAPI document only. Mount a documentation UI yourself on `plane.app` (e.g. `@hono/swagger-ui` or `@scalar/hono-api-reference`) pointed at `/openapi.json`.

The JWKS route is served from the signing authority (`signingSecret`, `issuer`, `keyId`) and never
resolves `services` or fetches discovery documents, so key publication survives a service-discovery
outage. The capability-token, broker, and MCP routes additionally need the authorization catalog
(discovered capabilities and grants) and fail closed when it cannot be built. See
[auth.md](auth.md#signing-authority-and-authorization-catalog).

`httpCache` is optional and mirrors the service option: when set, the OpenAPI and JWKS routes emit `Cache-Control` and `Cache-Tag` headers. The capability-token endpoint always responds with `Cache-Control: no-store` and `Pragma: no-cache`. Broker and MCP RPC responses are never cache-eligible.

`broker.cache` and `mcp.cache` cache the discovery snapshots used by those surfaces. `openapi.cache` caches the generated document; set its TTL with `openapi.cacheTtlSeconds`. Keep discovery and OpenAPI caches separate.

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
const api = await abilitySession<AbilityRpc<typeof asanaTasks>>({
  abilityId: 'asana.tasks',
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken,
  transport,
});
```

Persistent WebSocket/custom sessions and native binding targets are disposable. Prefer `using` so
the transport closes at the end of the block:

```ts
{
  using api = await abilitySession<AbilityRpc<typeof asanaTasks>>({ ... });
  await api.createTask(input);
}
```

Otherwise, call `await disposeAbilitySession(api)` from `finally`. Disposal is idempotent. For a
stateless transport there is no connection to release, but disposal still permanently closes the
session object so accidental reuse fails consistently.

Transports:

- `cloudflareServiceBindingRpc(binding)`
- `cloudflareNativeRpc(binding)`
- `httpBatchRpc(url)`
- `websocketRpc(url, { createWebSocket? })` — the optional factory receives the final URL after
  `request_id` propagation, allowing Node runtimes without a global `WebSocket` to inject a
  standards-compatible client without requiring the application to install a persistent global;
  the Cap'n Web 0.10 compatibility path uses a temporary synchronous shim that is restored
  immediately.
- `customRpcTransport(transport)`

`cloudflareNativeRpc(...)` can call ingress-protected services only with brokered capability tokens. Normal direct caller tokens are rejected.

Control-plane endpoints may additionally provide `ServiceEndpoint.createWebSocket`. Configure it
with `httpsService({ createWebSocket })` (or `cloudflareServiceBinding({ createWebSocket })`) so
broker and MCP calls can reach WebSocket-only abilities on runtimes without a global client.

`ServiceEndpoint.abilityRpc` is likewise explicit: pass `cloudflareServiceBinding({ abilityRpc: env.ASANA })`
for a binding whose target forwards `connectAbility(...)`. It is never inferred from the binding,
because a Workers service-binding stub returns a callable RPC proxy for every property name.

Which transport fits which pair of services — by environment, performance, and cost — is covered in [Choosing A Transport](transports.md).

Token requesters:

- `controlPlaneRpcTokenRequester(...)`
- `controlPlaneJwkTokenRequester(...)`
- `controlPlaneHmacTokenRequester(...)`

## Capability Token Claims

Capability tokens are ES256 JWS tokens with a closed claim set. Unknown claims are dropped at verification.

Tokens come in two shapes, and `sub` always answers the same question: who is this token about. A plain service-to-service token is about the calling service. A delegated token uses RFC 8693's `act` actor-claim semantics: it is about the end user, while the calling service moves into `act.sub`. The presence of `act` is what switches the interpretation, and the verifier resolves it for you: `identity.serviceId` is always the calling service, and `identity.subject` is set only when a user is delegated.

Plain service token:

```json
{ "iss": "control-plane", "sub": "workflow-runner", "aud": "asana", "scp": ["asana.tasks.write"] }
```

→ `identity.serviceId = 'workflow-runner'`, no `identity.subject`.

Delegated (user-brokered) token:

```json
{ "iss": "control-plane", "sub": "user-7", "act": { "sub": "control-plane" }, "spo": "org-42", "aud": "asana", "scp": ["asana.tasks.write"] }
```

→ `identity.serviceId = 'control-plane'` (from `act.sub`), `identity.subject = { id: 'user-7', orgId: 'org-42' }`.

| Claim | Plain service token | Delegated token (`act` present) |
| --- | --- | --- |
| `sub` | calling service → `identity.serviceId` | end user → `identity.subject.id` |
| `act` | absent | acting service, `{ sub }` → `identity.serviceId` |
| `spo` | rejected at verification | subject's org → `identity.subject.orgId` |
| `iss` | control-plane issuer → `identity.issuer` | same |
| `aud` | target service id → `identity.audience` | same |
| `scp` | granted scopes → `identity.scopes` | same |
| `spb` | broker service id on brokered (ingress) tokens → `identity.brokerServiceId` | same |
| `jti` | token id → `identity.tokenId` | same |
| `exp` | expiry → `identity.expiresAt`; `iat`/`nbf` are also enforced | same |

Only the `act` delegation relationship comes from RFC 8693. `scp`, `spo`, and `spb` are Service Plane-specific claims, and `/.well-known/service-plane/capability-token` is the package's JSON capability endpoint, not an RFC 8693 token-exchange endpoint.

Delegated subjects are minted only by control-plane code — the broker/MCP caller resolver (a `BrokerCaller` with `kind: 'user'` and optional `orgId`) or a direct `issueCapabilityToken({ subject, ... })` call. The capability-token endpoint and `issueCapabilityTokenForCaller` reject caller-supplied subjects with 403, and the shipped token requesters fail fast locally instead of transmitting one. Direct issue mints a non-brokered token, so ingress-required targets must be reached through the broker, which selects `issueBrokeredCapabilityToken` automatically. See [auth](auth.md#subject-delegation).

## Logging And Request Correlation

Every request that enters a `ServicePlaneControlPlane` gets an `X-Request-Id` (incoming header value or a generated UUID, via `hono/request-id`). The broker and MCP endpoints forward that id on every outbound call to a service: as the `X-Request-Id` header for HTTP-batch and service-binding transports, as the `request_id` query parameter for WebSocket transports (`SERVICE_PLANE_REQUEST_ID_QUERY_PARAM`), and as the `requestId` field on `connectAbility(...)` for Cloudflare native RPC. `ServicePlaneService` adopts the propagated id into its own `requestId` context variable and echoes it on responses, so one id correlates plane and service logs end to end.

Connection info about the original client rides the same three channels when `broker.connInfo` / `mcp.connInfo` are configured: the `X-Service-Plane-Conn-Info` header, the `conn_info` query parameter (`SERVICE_PLANE_CONN_INFO_QUERY_PARAM`), and the `connInfo` field on `connectAbility(...)`. Services expose it to handlers as `connInfo` only for brokered calls with ingress enabled — see [Forwarded Connection Info](auth.md#forwarded-connection-info).

Both shells log structured JSON events to the console by default. Every event carries `event`, `level`, and (when known) `requestId`.

Service events (`ServicePlaneLogEvent`):

- `service_plane.discovery.served`
- `service_plane.request.completed`
- `service_plane.request.failed`

Control-plane events:

- `service_plane.broker.connect.completed` / `service_plane.broker.connect.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.mcp.tool.completed` / `service_plane.mcp.tool.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.mcp.resource.completed` / `service_plane.mcp.resource.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.mcp.prompt.completed` / `service_plane.mcp.prompt.failed` (`ServicePlaneBrokerLogEvent`)
- `service_plane.caller_auth.not_configured` (`ServicePlaneControlPlaneLogEvent`)
- `service_plane.caller_auth.hmac_unauthorized` / `service_plane.caller_auth.jwk_unauthorized` (caller-auth middleware, own `log` option)

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
- HMAC or JWK replay protection

Token cache keys include caller id, target service id, ability id, normalized scopes, optional TTL, and the delegated subject when present — a token minted for one end user is never served for another.

HTTP edge caching of the metadata GET routes (discovery, OpenAPI, JWKS) is separate from these data caches and is controlled by the `httpCache` option on `ServicePlaneService` and `ServicePlaneControlPlane`:

```ts
type ServicePlaneHttpCacheOptions = {
  maxAgeSeconds?: number; // default 30 (DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS)
  staleWhileRevalidateSeconds?: number; // default 300
  tags?: string[]; // appended to the built-in service-plane:* Cache-Tag values
};
```

Built-in tags: `service-plane` on every cached route, plus `service-plane:discovery` and `service-plane:service:<id>` on discovery, `service-plane:openapi` on OpenAPI, and `service-plane:jwks` on JWKS.

## Errors

- Missing or invalid token: `CapabilityAuthError` with 401-style status.
- Missing scope: `CapabilityAuthError` with 403-style status.
- Invalid caller input: `AbilityValidationError` with 422-style status.
- Invalid service output: `AbilityValidationError` with 500-style status.

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [Cloudflare](cloudflare.md).
