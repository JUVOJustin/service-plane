# OpenAPI And MCP

Goal: expose user-facing documentation and tools from the same ability metadata used by RPC.

Services do not generate full OpenAPI documents. Services define abilities and expose discovery. The control plane builds the OpenAPI document and MCP tool metadata from that ability metadata. Rendering a documentation UI is left to the consumer (see [Docs UI](#docs-ui)).

## Published Abilities

Only published abilities can become user-facing projections.

```ts
const asanaTasks = defineAbility({
  id: 'asana.tasks',
  exposure: 'published',
  access: 'plane',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: abilityMethod({
      input: CreateTaskInput,
      output: CreateTaskOutput,
      scopes: ['asana.tasks.write'],
      rest: { method: 'post', path: '/asana/tasks', summary: 'Create an Asana task' },
      mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
    }),
  },
  handler: ({ context, identity }) => new AsanaTasksHandler(context.env, identity),
});
```

Private abilities are still discovered by the control plane for routing and grants, but they never appear in OpenAPI or MCP listings.

Published projection is separate from `access`. `access: 'plane'` leaves upstream product auth to the control plane or gateway. `access: 'service'` keeps an ability available only to authenticated service callers.

## OpenAPI

The control plane serves the generated document:

```txt
GET /openapi.json
```

The document is OpenAPI **3.2.0**. It includes methods when both are true:

- the ability has `exposure: 'published'`
- the method has `rest` metadata

`rest.method` accepts `get`, `post`, `put`, `patch`, `delete`, and `query`. QUERY (RFC 10008) is the safe, idempotent method whose parameters travel in the request body — the natural fit for search-shaped abilities whose input is too structured for a query string. OpenAPI 3.2 models it as a fixed `query` field on the path item. `rest.status` optionally declares the exact 2xx success status and defaults to `200`; statuses are never inferred from the HTTP verb.

The request and response schemas come from the method's input and output schemas, rendered as JSON Schema at service setup through [Standard JSON Schema](https://standardschema.dev/json-schema). Service Plane always requests the `draft-2020-12` target, so every service publishes the same dialect; the exact keywords are still the converter's own — Zod, for example, adds `additionalProperties: false` on the output side. Every `{name}` in `rest.path` must name a top-level input field; inconsistent definitions and discovery documents are rejected, and empty request segments do not bind variables. Path-template fields become required OpenAPI path parameters and are removed from the JSON body schema. Remaining top-level string and string-array fields are also described as optional query fallbacks; the body keeps those fields because its values take precedence. Non-string fields stay body-only. The control plane does not bundle a documentation UI.

Public authentication belongs to `invocationMiddleware`, so the generator cannot infer whether the
application uses Bearer tokens, API keys, cookies, or an intentionally anonymous caller. OpenAPI
therefore declares no security scheme by default. Describe the middleware's real contract explicitly:

```ts
new ServicePlaneControlPlane({
  openapi: {
    security: [{ ProductApiKey: [] }],
    securitySchemes: {
      ProductApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
  },
  // ...
});
```

Schemas containing local `$ref`s — recursive types, or converters that root at `$ref` into `$defs` the way ArkType and Valibot do — are anchored with a generated `$id` (`urn:service-plane:<service>/<ability>/<method>/<input|output>`) at service setup. Per JSON Schema 2020-12 that makes each schema its own resource, so its internal pointers keep resolving after the schema is embedded into the OpenAPI document, and vendor output never needs rewriting. Schemas without local refs are published byte-identical, and a vendor-declared `$id` is kept.

Streaming methods (`stream: true`) cannot declare `rest` metadata — the generated OpenAPI documents request/response operations only.

## Docs UI

`service-plane` produces the OpenAPI document but does not render it. The control plane exposes its Hono app as `plane.app`, so you mount whichever OpenAPI viewer you prefer against `/openapi.json`. Two ready-made Hono extensions cover the common choices — neither is a dependency of `service-plane`, so install the one you want.

Both accept the 3.2 document, with one gap each (verified against `@hono/swagger-ui` 0.6.1 and `@scalar/hono-api-reference` 0.11.12): Swagger UI renders `query` operations fully but its resolver does not implement embedded `$id` resources, so a recursive or `$defs`-referencing schema shows a non-blocking "resolver error" banner while the rest of the page keeps working. Scalar resolves `$id`-anchored schemas correctly but does not yet display `query` operations at all — they are silently absent from the sidebar. If your API uses both features, prefer Swagger UI until Scalar adds QUERY support.

### Swagger UI

```sh
npm install @hono/swagger-ui
```

```ts
import { swaggerUI } from '@hono/swagger-ui';

// plane is your ServicePlaneControlPlane instance.
plane.app.get('/ui', swaggerUI({ url: '/openapi.json' }));
```

Reference: [Hono example — Swagger UI](https://hono.dev/examples/swagger-ui).

### Scalar

```sh
npm install @scalar/hono-api-reference
```

```ts
import { Scalar } from '@scalar/hono-api-reference';

plane.app.get('/scalar', Scalar({ url: '/openapi.json' }));
```

`Scalar` also accepts options such as `theme` and `pageTitle`, or a function `Scalar((c) => ({ url: '/openapi.json' }))` for per-request configuration. Reference: [Hono example — Scalar](https://hono.dev/examples/scalar).

Because the UI is not baked into the library, there is no bundled CDN dependency, and you are free to switch renderers, self-host assets, or apply your own CSP. If you pass a custom `app` to `ServicePlaneControlPlane`, mount these routes on that same app instead of `plane.app`.

## REST Facade

The control plane always mounts published `rest` projections as live routes. The same metadata now
has two consumers:

- OpenAPI describes the operation.
- The REST facade matches the request, mints the method's scopes, and invokes the ability.

```mermaid
flowchart LR
  HTTP["POST /asana/tasks"] --> Edge["Control plane REST facade"]
  Edge --> Token["Mint scoped token"]
  Token --> RPC["Call asana.tasks.createTask"]
  RPC --> Service["Service-side schema validation"]
```

Before this facade, the declaration below appeared in `/openapi.json`, but an HTTP request to its
path received `404` unless the application separately wrote a matching Hono route. Now the
declaration is the route:

```ts
rest: {
  method: 'post',
  path: '/connections/{connectionId}/snapshots',
  status: 202,
}
```

```http
POST /connections/conn-7/snapshots?dryRun=true
Content-Type: application/json

{"name":"Nightly"}
```

The ability receives `{ connectionId: 'conn-7', dryRun: 'true', name: 'Nightly' }`, and a successful
call returns HTTP `202`. Inputs are merged in the fixed order **query, then body, then path**, so path
variables win. A JSON body cannot replace the `connectionId` that was matched and authorized in the
URL. Matching also requires the exact number of path segments; `/connections/{connectionId}` never
captures `/connections/{connectionId}/snapshots`.

The generated OpenAPI operation mirrors that contract: `connectionId` is a required path parameter,
string-shaped fields such as `dryRun` are optional query fallbacks, and the JSON body schema omits
`connectionId`. When a required string can arrive through either query or body, neither location is
marked required on its own; the backing ability schema remains the final validator of the combined
input.

Only published, non-streaming methods with `rest` metadata are routable. Unknown paths return `404`,
a known path with the wrong verb returns `405` plus `Allow`, JSON bodies are bounded to one MiB by
default (`rest.maxBodyBytes` changes the bound), and ambiguous equally specific templates fail
closed. Paths mounted by the control plane are reserved and cannot also be used by REST projections:
the capability-token and JWKS routes are always reserved, and enabled OpenAPI, MCP, and RPC routes
reserve their configured paths. Explicit application routes registered on `plane.app` after the
plane is constructed take precedence over matching REST projections, so documentation UIs, OAuth
callbacks, and other application-owned endpoints remain authoritative. The service remains the
authoritative schema validator: every facade call still passes through the generated ability
wrapper before its handler runs. A matched invocation reuses one discovery snapshot for routing and
token issuance, including when discovery caching is disabled.

## MCP

The control plane exposes MCP tools, resources, and prompts from published methods carrying `mcp`,
`mcpResource`, or `mcpPrompt` metadata. The developer decides per method which MCP surface (if any)
it becomes — one method can back a tool, a resource, and a prompt at the same time. When the current
discovery snapshot contains none of these published projections, `/mcp` behaves as an unmounted route
and returns `404` without resolving a caller or signing key.

```txt
POST /mcp
```

The endpoint implements the stateless portion of MCP Streamable HTTP (JSON-RPC 2.0), so stock MCP clients — Claude, Cursor, the MCP inspector — connect to it directly. Each POST carries one JSON-RPC message and the response is plain JSON, except calls to streaming tools, which answer over SSE (see [Tools](#tools)). No session id is issued, `GET` returns `405`, and notifications are acknowledged with `202`. Implemented methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, and `prompts/get`. `initialize` declares the `tools`, `resources`, and `prompts` capabilities (no `listChanged`, no `subscribe` — the endpoint is stateless).

Every projected entry carries its Service Plane routing metadata (service, ability, method, scopes) under `_meta.servicePlane`, and every invocation — tool call, resource read, or prompt get — mints a scoped (or ingress-brokered) capability token and calls the backing ability through Service Plane.

### Tools

`mcp: { name, description? }` projects a method as a tool. The tool's input schema comes from the method's input schema; if the converter rooted it at a local `$ref` (ArkType and Valibot do this for referenced or recursive types), the referenced content is inlined at the root so clients that read `type` and `properties` without a resolver still see the object shape, with `$defs` kept for internal refs. Object-shaped outputs — including ref-rooted ones — also advertise `outputSchema` and return the validated object as `structuredContent`, with serialized JSON in a `text` block for compatibility. Primitive and array outputs omit `outputSchema` and return serialized text only. Handler failures are reported in-band with `isError: true`; unknown tools and authorization failures are JSON-RPC errors.

Streaming methods (`stream: true`) can project tools too. Because SSE is the only shape such a call can answer in, the request must accept it: an explicit `Accept` header that excludes `text/event-stream` (and `text/*`/`*/*`) gets `406` before any ability session is opened, while a missing `Accept` is treated as accepting anything. Unary tools, resources, and prompts stay usable for JSON-only clients. The plane opens the backing ability over a session transport (the endpoint's native ability RPC binding, then WebSocket) and answers `tools/call` over SSE per MCP streamable HTTP: while items arrive, it emits `notifications/progress` events (when the client sent `_meta.progressToken`), and the final response aggregates the items as `structuredContent: { items }` — MCP defines exactly one response per request, so the tool schema advertises the aggregated `{ items }` shape and `_meta.servicePlane.stream` marks the tool. Unbuffered transfer of very large streams belongs on a direct or brokered Cap'n Web session, not on MCP: the plane aggregates at most 10,000 items / 1 MiB of serialized items per streaming tool call (configurable via `mcp.streamLimits`) and fails the call in-band beyond that. `maxBytes` also gives optional progress notifications an independent cumulative byte budget; because every notification consumes that budget, it bounds how many can be emitted during a call. When that progress budget is exhausted, the plane stops sending notifications but continues building the separately bounded final result. Streaming methods cannot project resources or prompts (single-response surfaces); the service rejects such definitions at setup. See [Streaming](streaming.md).

This endpoint is request-scoped and non-resumable. If its SSE response delivery is abandoned, it
aborts the backing stream and disposes the request's ability session to bound serverless resource
lifetime. This is an intentional tradeoff from MCP's recommendation that disconnect alone should
not imply cancellation. `notifications/cancelled` is acknowledged but not correlated across
requests or isolates. Use a direct/brokered Cap'n Web session or a stateful MCP adapter for work
that must survive reconnects or requires protocol-level cancellation.

### Resources

`mcpResource: { uri, name, title?, description?, mimeType? }` projects a method as a resource. A literal URI lists under `resources/list`; a URI with `{variable}` template expressions lists under `resources/templates/list`, and on `resources/read` the matched variables (one path segment each, URI-decoded) become the method's input. Only simple `{name}` expressions are supported.

The read result is derived from the method output: a string is served as text (`mimeType` defaults to `text/plain`), an object with a string `blob` property passes through as binary (`mimeType` from the result, then the declaration, then `application/octet-stream`), and anything else is serialized as JSON text (`application/json`). Unknown URIs return the MCP resource-not-found error `-32002`.

```ts
readDocument: abilityMethod({
  input: z.object({ documentId: z.string() }),
  mcpResource: { name: 'document', uri: 'docs://documents/{documentId}', mimeType: 'text/markdown' },
  output: z.string(),
  scopes: ['docs.read'],
}),
```

### Prompts

`mcpPrompt: { name, title?, description?, arguments? }` projects a method as a prompt. When `arguments` is omitted, it is derived from the method input schema's top-level properties (respecting `required`). On `prompts/get` the client arguments become the method input; the method returns either `{ messages, description? }` (passed through) or a plain string (wrapped as a single user text message).

The MCP endpoint is enabled by default but **fail closed**: configure the plane's shared top-level
`invocationMiddleware` to authenticate REST, MCP, and optional broker requests, or set `mcp: false`
to disable MCP. The middleware must set `servicePlaneCaller` before calling `next()`; it may instead
return a Hono `401` response carrying the appropriate `WWW-Authenticate` challenge. See the
[invocation caller](plane-creation.md#invocation-caller-and-optional-rpc-broker).

```ts
new ServicePlaneControlPlane({
  invocationMiddleware: async (c, next) => {
    const token = c.req.header('authorization');
    if (token !== `Bearer ${c.env.MCP_GATEWAY_TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer realm="service-plane-mcp"',
      });
    }
    c.set('servicePlaneCaller', { id: 'mcp-gateway', kind: 'user' });
    await next();
  },
  mcp: {
    // Incoming browser Origin headers must match the endpoint origin by default.
    // Add exact cross-origin clients only when the deployment intentionally needs them.
    allowedOrigins: ['https://app.example.com'],
    serverInfo: { name: 'my-plane', version: '2026.7.0' }, // optional; defaults to the control-plane service id
  },
  // ...
});
```

The stateless endpoint implements the current `2025-11-25` revision and also accepts the compatible
`2025-06-18` and `2025-03-26` revisions. A missing `MCP-Protocol-Version` header is treated as
`2025-03-26`; an unsupported value returns HTTP `400`. Browser requests with an `Origin` header must
be same-origin unless listed in `mcp.allowedOrigins`; invalid or unlisted origins return `403`
before invocation middleware and service discovery.

A stock client then connects with whatever credentials the invocation middleware expects:

```json
{
  "mcpServers": {
    "service-plane": {
      "type": "http",
      "url": "https://plane.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Caching

Cache service discovery and generated OpenAPI separately.

```txt
discovery:asana -> service discovery document
openapi:bundle -> generated OpenAPI document
```

Discovery cache keeps service metadata fresh without refetching every service on every request. OpenAPI cache avoids rebuilding the merged document for each docs request.

The derived OpenAPI document cache key includes the configured service endpoints, document options,
and reserved control-plane routes, so one shared cache can safely serve plane instances with
different MCP or RPC paths. An explicit `openapi.cacheKey` overrides that derivation; applications
using it must namespace the key across every configuration that changes the projected document.

Next: [create a control plane](plane-creation.md), [reference](reference.md), and [architecture](architecture.md).
