---
name: service-plane
description: >-
  Activate when building, extending, reviewing, or debugging code that uses the
  service-plane TypeScript library: defining abilities or capability scopes,
  wiring a ServicePlaneService or ServicePlaneControlPlane, opening ability
  sessions, issuing or verifying capability tokens, configuring ingress or the
  broker, or projecting abilities to OpenAPI, Swagger, or MCP. Also activate
  when a repo depends on the service-plane npm package and the task touches
  service-to-service auth, Cap'n Web RPC, service discovery, or tool metadata,
  even if the user does not name the library explicitly.
---

# service-plane

`service-plane` is a TypeScript library for **ability-first service APIs**. It
replaces the usual sprawl of REST routes, internal RPC, hand-written OpenAPI
files, ad hoc auth checks, and separate AI-tool metadata with one source of
truth: the **ability**.

An ability is a schema-backed RPC surface owned by a service. Each method
declares one Zod input schema, one Zod output schema, required scopes, and
optional REST and MCP metadata. Those schemas drive runtime validation,
service discovery, OpenAPI generation, and MCP tool metadata — define once,
project everywhere.

## Mental model

Three roles, three responsibilities. Keep them separate; most mistakes with
this library come from blurring them.

| Role | Owns | Package entry |
| --- | --- | --- |
| **Service** | Defines abilities, verifies tokens, validates input/output, enforces scopes | `service-plane/service` |
| **Control plane** | Discovers services, checks grants, issues short-lived capability tokens, brokers calls, projects OpenAPI/MCP | `service-plane/control-plane` |
| **Caller** | Requests a token, opens an ability session, invokes methods | `service-plane/service` (session + transports) |

The control plane is the **only** component that issues capability tokens
(short-lived ES256 JWS). Services verify issuer, audience, expiry, signature,
and scopes against the plane's JWKS before any handler runs. Only the control
plane should call services — no direct ingress.

Hono is the HTTP shell (middleware, discovery, request ids); Cap'n Web is the
RPC engine (HTTP-batch, WebSocket, Cloudflare bindings). Method auth and
validation live in the Service Plane ability wrapper, **not** in Hono
middleware — Hono sees the HTTP request, Cap'n Web sees the logical method
call.

## The four knobs

Every ability decision reduces to four independent settings. Never conflate
them:

- **`exposure`** — discoverability in user-facing projections.
  `'private'` (default) keeps the ability out of OpenAPI/Swagger/MCP;
  `'published'` makes methods with `rest`/`mcp` metadata projectable.
- **`access`** — who the broker serves. `'plane'` (default): the control
  plane or gateway owns any product-level user/API-key/anonymous decision.
  `'service'`: brokered only for authenticated service callers
  (service-to-service). Never use it to model end-user authentication.
- **`scopes`** — what a signed token may do once the service receives it.
  Declared in the service capability catalog (`defineCapabilities`),
  referenced at ability level (maximum surface) and method level (minimum for
  one operation). A method must not require a scope its ability does not
  declare.
- **`ingress`** — whether the service accepts only brokered Service Plane
  calls. With `ingress: {}`, a valid but non-brokered token is rejected with
  403 *before* input validation or handler creation.

## Dos

- **Do** define Zod schemas once and let them drive validation, discovery,
  OpenAPI, and MCP. Never hand-maintain a parallel JSON Schema or OpenAPI file.
- **Do** declare every scope in `defineCapabilities` first; the service fails
  at setup if an ability or method references an unknown scope — that is a
  feature, not a bug to route around.
- **Do** keep `exposure: 'private'` as the default and publish only abilities
  meant to become product or integration surfaces.
- **Do** let the ability wrapper do its job: handlers receive
  already-validated input, and output is validated after return. Add
  `requireScopes(...)` inside a handler only when custom logic needs the
  identity object.
- **Do** enable `ingress: {}` on services that must only process brokered
  traffic, and route their callers through the control-plane broker.
- **Do** pass product context (tenant, user, connection) through validated
  input or project-specific token claims — identity stays small: caller
  service id, audience, scopes, token id.
- **Do** use the simplest caller auth that matches the boundary: service
  bindings on same-account Cloudflare, JWK for external callers holding a
  private key, HMAC only as a shared-secret fallback.
- **Do** configure a `caller` resolver for the broker and MCP endpoints. They
  fail closed: no resolver → 500, resolver returns nothing → 401. Anonymous
  access is only ever an explicit fixed caller, never a default.
- **Do** keep code runtime-agnostic: the same ability definitions run on
  Cloudflare Workers and Node 20+ (`@hono/node-server`); only transports and
  JWKS sourcing differ.

## Don'ts

- **Don't** put provider OAuth tokens or credentials in Service Plane
  identity or workflow metadata. Store them in service-owned storage (e.g. a
  Durable Object per connection) and route to it via validated input claims.
- **Don't** share the STS signing secret beyond the control plane. Services
  verify via JWKS; callers only ever hold short-lived tokens.
- **Don't** use `access: 'service'` to model end-user authentication — it
  restricts the broker to service callers, nothing more.
- **Don't** weaken scope checks, grant checks, token validation, replay
  protection, or ingress protection to make tests pass. The security model is
  core package behavior.
- **Don't** call an ingress-protected service directly (HTTP-batch or native
  binding RPC) with an ordinary token — it will 403 by design. Go through the
  broker so the token carries the signed broker claim.
- **Don't** generate OpenAPI in services. Services expose discovery at
  `/.well-known/service-plane/service.json`; the plane builds `/openapi.json`
  and the MCP tool list from published metadata.
- **Don't** default to WebSocket for worker-to-worker calls. Prefer bindings
  on Cloudflare and HTTP-batch elsewhere; reserve WebSocket for long-lived,
  interactive sessions.
- **Don't** invent new secrets when an existing signed token claim or
  caller-auth mechanism can express the boundary safely.

## Going deeper

The bundled references are the library's full documentation set. Load the
one that matches the task; they cross-link with relative links, so follow
those within `references/` as needed.

- Concept, request flow, where auth and validation live, core terms:
  LOAD references/architecture.md
- Creating or changing a service (capabilities, abilities, handlers,
  mounting the shell): LOAD references/service-creation.md
- Creating or changing a control plane (grants, broker, ingress, caches):
  LOAD references/plane-creation.md
- Token flow, caller auth options, identity vs. context, scope checks:
  LOAD references/auth.md
- Streaming ability methods, session transports, broker/MCP streaming:
  LOAD references/streaming.md
- API lookup: option shapes, routes, transports, logging events, errors:
  LOAD references/reference.md
- OpenAPI, Swagger UI/Scalar, MCP tools and their fail-closed callers:
  LOAD references/openapi-mcp.md
- Cloudflare Workers, bindings, Durable Objects, edge caching:
  LOAD references/cloudflare.md
- Node.js and self-hosted services: LOAD references/nodejs.md

When working inside the service-plane repository itself (not a consumer),
`docs/` is the source of truth for these files (synced via
`npm run sync:skill-docs`), and `AGENTS.md` defines the package boundaries.

## Verifying changes

In a consumer repo, run its normal checks. In the service-plane repo itself:

```sh
npm run check && npm run typecheck && npm run test && npm run build
```
