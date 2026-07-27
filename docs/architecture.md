# Architecture

Goal: understand what Service Plane adds, where Cap'n Web fits, and which layer owns auth and validation.

The smallest useful setup has three pieces:

- A service defines abilities.
- A control plane issues short-lived tokens and aggregates discovery metadata.
- A caller opens an ability session and invokes methods.

## Why Service Plane Exists

Normal service APIs often split into REST routes, internal RPC, OpenAPI files, custom auth checks, and separate tool metadata. Service Plane keeps those concerns tied to one source of truth: the ability.

An ability is a schema-backed RPC surface owned by a service. Each method declares:

- one Zod input schema
- one Zod output schema
- required scopes
- optional REST metadata
- optional MCP metadata

The schemas power runtime validation, service discovery, OpenAPI generation, and MCP tool metadata.

## Request Flow

```mermaid
sequenceDiagram
  participant Caller as Caller
  participant Plane as Control Plane
  participant Service as Service
  participant Handler as Ability Handler

  Caller->>Plane: Request token<br/>caller, service, scopes
  Plane->>Plane: Check grants
  Plane-->>Caller: Short-lived ServicePlane token
  Caller->>Service: Open /rpc/asana.tasks
  Caller->>Service: authenticate(token)
  Service->>Service: Verify issuer, audience, expiry, signature
  Service-->>Caller: Validating ability RPC object
  Caller->>Service: createTask(input)
  Service->>Service: Validate input and scopes
  Service->>Handler: createTask(validInput)
  Handler-->>Service: output
  Service->>Service: Validate output
  Service-->>Caller: result
```

## What Cap'n Web Does

Cap'n Web is the RPC engine. It lets callers invoke methods on remote objects through HTTP-batch, WebSocket, or Cloudflare RPC-style bindings.

Service Plane uses Cap'n Web for the method call transport, then adds the service model around it:

```mermaid
flowchart TD
  Hono["Hono shell"] --> Middleware["HTTP middleware<br/>CORS, request ids, logging, rate limits"]
  Middleware --> Endpoint["/rpc/<abilityId>"]
  Endpoint --> CapnWeb["Cap'n Web RPC"]
  CapnWeb --> Auth["authenticate(token)"]
  Auth --> Wrapper["Service Plane ability wrapper"]
  Wrapper --> ZodIn["Zod input validation"]
  ZodIn --> Scopes["Scope check"]
  Scopes --> Handler["Handler method"]
  Handler --> ZodOut["Zod output validation"]
```

Hono middleware sees the HTTP or WebSocket request. Cap'n Web sees the logical method call. That is why method auth and validation live in the Service Plane RPC wrapper, not in Hono middleware.

Production services should enable service-plane ingress protection so only brokered traffic reaches ability handlers. In that mode, `/rpc/<abilityId>` rejects valid but non-brokered capability tokens before input validation or handler creation. The broker mints a signed broker claim with the same capability issuer and JWKS trust chain the service already uses.

Methods that return many results over time (`stream: true`) use Cap'n Web's native stream support: the validating wrapper returns a `ReadableStream` of per-item-validated results with built-in flow control. Streams ride the ongoing RPC session, so they work over WebSocket, native Workers RPC bindings, and custom bidirectional transports — but not over the one-round-trip HTTP-batch transport, where streaming calls fail with a clear 405. The broker proxies these streams transparently, and MCP tools backed by streaming methods answer over SSE. The security model is unchanged — only the return shape differs. See [Streaming](streaming.md).

## Observability

One request id follows a call across the whole plane. The control plane assigns or adopts `X-Request-Id` on every inbound request, and its broker and MCP surfaces forward that id on every outbound service call (header for HTTP transports, `request_id` query parameter for WebSocket upgrades, `requestId` field for native bindings). The service shell adopts the propagated id into its Hono `requestId` variable, echoes it on responses, and includes it in its log events, so plane and service logs correlate without extra plumbing.

Both shells emit typed, token-safe JSON log events (requests, broker connects, MCP tool calls, caller-auth rejections) to the console by default. The package never owns the application logger: every surface accepts a `log` callback that forwards events to whatever logger the app uses, and events are also exposed on the Hono context for app middleware. See the logging section in [the reference](reference.md).

## Horizontal Scaling

A control plane is designed to run as several independent replicas behind a load balancer — an
autoscaled Cloudflare deployment, or a set of on-premises instances. Replicas share **configuration
only**: the signing keys, the issuer, the service list, and the grants. They share no runtime state.

What that buys, and what it costs:

- **Any replica can verify any replica's tokens.** JWKS is derived from `signingKeys` alone, so two
  replicas on the same configuration publish byte-identical documents. A token issued by one replica
  verifies against JWKS served by another.
- **Authorization is identical on every replica.** Grants and scope checks come from configuration,
  not from a local cache. A replica holding a stale registry or OpenAPI snapshot cannot authorize
  anything the fleet would refuse — projections are descriptive, and the service remains the only
  authority on what it currently exposes.
- **Replicas may disagree about the active signing key.** That is the normal state during a rolling
  key rotation and needs no coordination, because both configurations publish both keys. See
  [Rotate The Signing Key](auth.md#rotate-the-signing-key).
- **Replay protection needs no shared store.** Sender-constrained tokens make a captured request
  unusable without the caller's key, so there is deliberately nothing for replicas to agree on. See
  [Replay Protection](auth.md#replay-protection).
- **Sessions are bound to the replica that serves them.** HTTP-batch carries no cross-request state,
  which is what makes the fleet safe to load-balance. A long-lived WebSocket session, by contrast,
  lives on one replica: if that replica goes away the session fails and the caller must reconnect.
  There is no session failover, and none is planned — reconnect logic belongs to the caller.

Misconfiguration fails closed rather than silently. A replica with a divergent issuer produces tokens
every service rejects, and a replica signing with a key the fleet does not publish is refused with
`Unknown Service-Plane capability key id`.

## Discovery And Projections

Services publish metadata at `/.well-known/service-plane/service.json`. The control plane fetches that metadata, validates grants, and builds projections.

```mermaid
flowchart LR
  Asana["Asana service<br/>abilities + schemas"] --> Registry["Control plane registry"]
  ClickUp["ClickUp service<br/>abilities + schemas"] --> Registry
  Moco["Moco service<br/>abilities + schemas"] --> Registry
  Registry --> OpenAPI["/openapi.json"]
  Registry --> MCP["/rpc/mcp<br/>MCP tools"]
  Registry --> Grants["STS grants<br/>scope checks"]
```

Only `exposure: 'published'` methods with REST metadata enter OpenAPI. Only published methods with MCP metadata enter MCP. Private abilities remain available for broker routing and grant validation, but they are not user-facing projections.

## Core Terms

- Ability: schema-backed API surface owned by a service.
- Method: one callable operation on an ability.
- Handler: implementation object returned by the ability factory.
- Context: runtime access such as Hono context, env, bindings, and execution context.
- Identity: verified Service Plane caller and scope claims, plus the delegated end-user subject on user-brokered calls.
- Subject: the end user (and optional org) a delegated call is made on behalf of. The `sub` user
  and `act.sub` acting-service relationship follows RFC 8693 actor semantics; `spo` is a
  Service Plane-specific organization claim.
- Access: whether an ability is plane-callable or restricted to service callers.
- Private: ability excluded from OpenAPI and MCP.
- Published: ability eligible for OpenAPI, MCP, or user-facing transports.

Next: [create a service](service-creation.md), [create a control plane](plane-creation.md), and [choosing a transport](transports.md).
