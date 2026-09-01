# OpenAPI, REST, And MCP

The control plane projects service-owned ability metadata. Services do not maintain parallel route,
OpenAPI, or tool definitions.

## Publish A Method

Projection requires `exposure: 'published'` on the ability and metadata on the method:

```ts
export const tasksContract = defineAbility({
  id: 'tasks',
  exposure: 'published',
  scopes: ['tasks.read'],
  methods: {
    get: ability.method({
      input: z.object({ id: z.string() }),
      output: TaskSchema,
      scopes: ['tasks.read'],
      rest: {
        method: 'get',
        path: '/tasks/{id}',
        summary: 'Get a task',
        tags: ['Tasks'],
      },
      mcp: {
        name: 'tasks_get',
        description: 'Get a task by id',
      },
    }),
  },
});
```

`private` abilities never appear, even when a method accidentally carries projection metadata.
`access` and scopes still apply to projected calls.

## REST Facade

Published unary methods with `rest` metadata become live Hono routes automatically. The plane maps:

- `{name}` path segments to same-named input properties;
- simple query values to remaining scalar or string-array properties; and
- a JSON body to the remaining input.

Path values take precedence over body values; body values take precedence over query values. The
complete object is then validated by the original ability input schema. Request bodies are limited
to one MiB by default; configure `rest.maxBodyBytes` when needed.

Streaming methods cannot be REST operations. A REST route miss continues through the supplied Hono
app, so custom routes can coexist with projections. Duplicate or ambiguous published routes fail
closed.

Set `rest: false` on `ServicePlaneControlPlane` to remove both the live facade and its catch-all.
This does not remove REST metadata from discovery or OpenAPI; disable `openapi` separately when the
document should also be absent.

## OpenAPI

`GET /openapi.json` is enabled by default and returns OpenAPI 3.2. Disable it with
`openapi: false` or customize it:

```ts
new ServicePlaneControlPlane({
  openapi: {
    path: '/docs/openapi.json',
    title: 'Product API',
    version: '1.0.0',
    servers: [{ url: 'https://api.example.com' }],
    securitySchemes: {
      ProductBearer: { type: 'http', scheme: 'bearer' },
    },
    security: [{ ProductBearer: [] }],
  },
  // ...
});
```

Security declarations are explicit because `invocationMiddleware` is application-owned. Describe
what that middleware really accepts; Service Plane cannot infer it.

The generated `info.version` defaults to the neutral placeholder `1.0.0`. Set it explicitly to the
deployed product API version whenever clients use the document for compatibility decisions.

Mount any Hono-compatible UI against the JSON document:

```ts
import { swaggerUI } from '@hono/swagger-ui';

plane.app.get('/docs', swaggerUI({ url: '/openapi.json' }));
```

The generated document includes method schemas, successful response status, tags, and an
`x-service-plane` block with service, ability, access, method, and scopes.

## MCP

MCP is opt-in:

```ts
new ServicePlaneControlPlane({
  mcp: {
    path: '/mcp',
    allowedOrigins: ['https://app.example.com'],
    maxBodyBytes: 1_000_000,
    serverInfo: { name: 'product-tools', version: '1.0.0' },
    streamLimits: { maxItems: 1_000, maxBytes: 4_000_000 },
  },
  // ...
});
```

`POST /mcp` uses streamable HTTP. Cheap method, protocol, origin, and declared `Content-Length`
checks run first. For a valid-size POST, `invocationMiddleware` receives the untouched request, so
authentication may safely bind a signature to its body; JSON-RPC parsing then reads a clone. Use
Hono middleware on the supplied app for audit or rate-limit policy that must also observe rejected
boundary requests. Browser origins are checked against `allowedOrigins`; configure the exact
origins you serve. JSON-RPC request bodies are read with a streaming one-MiB limit by default;
`maxBodyBytes` changes that limit.

### Tools

`mcp: { name, description? }` projects a method as a tool. Input and output come from the ability
schemas. Streaming tools may emit progress while items arrive; the final result aggregates them and
obeys `streamLimits`. Use the typed client for truly unbounded streams.

### Resources

```ts
mcpResource: {
  name: 'task',
  title: 'Task',
  uri: 'tasks://{id}',
  mimeType: 'application/json',
},
```

URI template variables must exist in the method's object input schema. Resources use a unary method
result as their content.

### Prompts

```ts
mcpPrompt: {
  name: 'summarize_task',
  title: 'Summarize task',
  arguments: [{ name: 'id', required: true }],
},
```

Prompt arguments default to top-level input properties when omitted. Tool names, prompt names, and
resource URIs must each be unique across the aggregated catalog.

## One Authorization Path

REST and MCP do not call handlers directly. They resolve the published method, authenticate the
plane caller, check access and grants, mint a brokered capability, and invoke the service through
the same validated method runtime as a typed client.

This keeps projections descriptive rather than privileged. Removing a scope or tightening an
ability at the service takes effect at the service even while a control-plane discovery cache is
stale.

See [control-plane creation](plane-creation.md), [auth](auth.md), and [reference](reference.md).
