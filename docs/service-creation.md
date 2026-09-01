# Create A Service

This guide creates a schema-validated service with one ability.

## 1. Define Capabilities

Scopes are part of the service's public security contract. Declare them once, then reference them
from abilities and methods.

```ts
// capabilities.ts
import { defineCapabilities } from 'service-plane/service';

export const capabilities = defineCapabilities({
  serviceId: 'tasks-service',
  scopes: [
    { id: 'tasks.read', title: 'Read tasks' },
    { id: 'tasks.write', title: 'Write tasks' },
  ],
});
```

Service Plane rejects unknown, missing, or duplicated scopes during setup. This is intentional:
configuration errors should fail a deployment, not a request.

## 2. Define A Portable Contract

```ts
// tasks.contract.ts
import * as z from 'zod';
import { createAbilityBuilder, defineAbility } from 'service-plane/service';

export type TasksEnv = {
  Bindings: {
    TASKS: TaskRepository;
  };
};

const ability = createAbilityBuilder<TasksEnv>();

export const tasksContract = defineAbility({
  id: 'tasks',
  title: 'Tasks',
  description: 'Read and create tasks',
  exposure: 'published',
  access: 'plane',
  scopes: ['tasks.read', 'tasks.write'],
  methods: {
    get: ability.method({
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), title: z.string() }),
      scopes: ['tasks.read'],
      idempotent: true,
      rest: { method: 'get', path: '/tasks/{id}' },
      mcp: { name: 'tasks_get', description: 'Get a task by id' },
    }),
    create: ability.method({
      input: z.object({ title: z.string().min(1) }),
      output: z.object({ id: z.string(), title: z.string() }),
      scopes: ['tasks.write'],
      rest: { method: 'post', path: '/tasks', status: 201 },
    }),
  },
  rpc: { transports: ['fetch', 'service-binding'] },
});
```

Keep `TasksEnv` limited to portable TypeScript interfaces used by handlers. It is compile-time
context, not client runtime state; avoid Cloudflare `Fetcher`, database-driver, or RPC-engine types
in a contract that browser packages import.

`private` is the default exposure; use `published` only for a deliberate product surface. `plane`
is the normal access mode. Use `service` only for authenticated service-to-service abilities.

### Choosing A Validation Library

An ability schema must provide both `~standard.validate` and `~standard.jsonSchema`; Standard Schema
support alone is not enough. The current
[compatibility table](https://standardschema.dev/json-schema#what-schema-libraries-support-this-spec)
lists Zod 4.2+, ArkType 2.1.28 or later, and VineJS 4.3.0+ as direct implementations. Valibot 1.2
needs `toStandardJsonSchema` from `@valibot/to-json-schema` 1.5+. The library does not depend on any
of them; these examples are tested with Zod 4.5.4.

The generated JSON Schema is not decorative: discovery, OpenAPI, REST input mapping, and MCP all
read it. Test custom schemas for both runtime validation and JSON Schema generation.

## 3. Add Handlers

Keep service-only code out of the shared contract:

```ts
// tasks.implementation.ts
import { AbilityHandlerError, implementAbility } from 'service-plane/service';
import { tasksContract } from './tasks.contract';

export const tasks = implementAbility(tasksContract, {
  get: async ({ context, input }) => {
    const task = await context.env.TASKS.get(input.id);
    if (!task) {
      throw new AbilityHandlerError('Task not found', {
        reason: 'task_not_found',
        status: 404,
      });
    }
    return task;
  },
  create: ({ context, input }) => context.env.TASKS.create(input),
});
```

Handlers receive validated `input` and an authorized `context`. Their return value is validated
before it leaves the service. An arbitrary thrown error becomes an opaque internal error; use
`AbilityHandlerError` only for messages deliberately safe for callers.

For a small, service-local contract, an inline handler is equivalent:

```ts
create: ability.method({
  input: CreateTask,
  output: Task,
  scopes: ['tasks.write'],
  handler: ({ context, input }) => context.env.TASKS.create(input),
}),
```

The options object is the only method declaration form, keeping schemas, policy, projections, and
an optional inline implementation together.

## 4. Mount The Hono Shell

```ts
import {
  ServicePlaneService,
  jwksFromUrl,
} from 'service-plane/service';
import { capabilities } from './capabilities';
import { tasks } from './tasks.implementation';
import type { TasksEnv } from './tasks.contract';

export default new ServicePlaneService<TasksEnv>({
  id: 'tasks-service',
  title: 'Tasks Service',
  version: '1.0.0',
  capabilities,
  abilities: [tasks],
  auth: {
    issuer: 'control-plane',
    jwks: jwksFromUrl(
      'https://plane.example.com/.well-known/service-plane/jwks.json',
    ),
  },
  ingress: {},
});
```

The service exposes discovery at `/.well-known/service-plane/service.json` and one private RPC path
per ability, `/rpc/<ability-id>` by default. `ingress: {}` requires the signed broker claim; an
ordinary valid capability token cannot bypass the control plane.

## Handler Context

`AbilityMethodContext` contains:

| Field | Use |
| --- | --- |
| `abilityId`, `methodName` | Metrics and correctly scoped deduplication keys |
| `env` | Runtime bindings without importing Hono |
| `request` | Request-local headers and URL, including the propagated request ID |
| `identity` | Verified caller, delegated subject, and granted scopes |
| `idempotencyKey` | Caller-owned key for recognizing the same logical attempt across retries |
| `signal`, `remainingTimeoutMs()` | Cancellation and remaining deadline budget |
| `connInfo` | Advisory original-client connection data from a trusted broker |
| `context` | Advanced Hono escape hatch |

Never authorize from `connInfo` or a caller-provided header. Authorization decisions come from the
verified identity and the service's method definition.

## Add Existing Hono Middleware

Pass an existing app or middleware array:

```ts
const app = new Hono<MyEnv>();
app.use('*', cors());

const service = new ServicePlaneService({
  app,
  middleware: [rateLimiter],
  // ...
});
```

Hono middleware wraps Fetch and WebSocket upgrade requests. Cloudflare native RPC does not traverse
Hono, so put method security and invariants in Service Plane policy or the handler, not solely in
HTTP middleware.

Next: [create the control plane](plane-creation.md), [configure auth](auth.md), or add
[streaming](streaming.md).
