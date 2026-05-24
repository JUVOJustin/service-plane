# OpenAPI And MCP

Goal: expose user-facing documentation and tools from the same ability metadata used by RPC.

Services do not generate full OpenAPI documents. Services define abilities and expose discovery. The control plane builds the bundled OpenAPI, Swagger UI, and MCP tool metadata.

## Published Abilities

Only published abilities can become user-facing projections.

```ts
const asanaTasks = defineAbility({
  id: 'asana.tasks',
  exposure: 'published',
  auth: 'user',
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

Private abilities are still discovered by the control plane for routing and grants, but they never appear in OpenAPI, Swagger, or MCP listings.

## OpenAPI

The control plane serves:

```txt
GET /openapi.json
GET /swagger
```

OpenAPI includes methods when both are true:

- the ability has `exposure: 'published'`
- the method has `rest` metadata

The request and response schemas come from the method's Zod input and output schemas through generated JSON Schema.

## Edge Validation

The service remains the authoritative validator. Every RPC call still goes through Zod validation in the ability wrapper.

The control plane can also use the discovered JSON Schemas for HTTP edge validation on REST facades:

```mermaid
flowchart LR
  HTTP["POST /asana/tasks"] --> Edge["Control plane REST facade"]
  Edge --> Validate["JSON Schema validation"]
  Validate --> Token["Mint scoped token"]
  Token --> RPC["Call asana.tasks.createTask"]
  RPC --> Service["Service-side Zod validation"]
```

Edge validation is a user-facing guardrail. It should not replace service-side validation.

## MCP

The control plane exposes MCP tools from published methods with `mcp` metadata.

```txt
ALL /rpc/mcp
```

Each MCP tool uses:

- tool name and description from `mcp`
- input schema from the method input schema
- output schema from the method output schema
- scopes from the method scopes

Tool calls mint scoped tokens and invoke the backing ability through Service Plane.

## Caching

Cache service discovery and generated OpenAPI separately.

```txt
discovery:asana -> service discovery document
openapi:bundle -> generated OpenAPI document
```

Discovery cache keeps service metadata fresh without refetching every service on every request. OpenAPI cache avoids rebuilding the merged document for each Swagger or docs request.

Next: [create a control plane](plane-creation.md), [reference](reference.md), and [architecture](architecture.md).
