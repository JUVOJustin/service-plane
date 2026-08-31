# Create A Service

Goal: create one service that exposes schema-backed abilities through Service Plane.

The smallest useful service defines capabilities, abilities, handlers, and `ServicePlaneService`.

## 1. Define Scopes

Scopes belong to one service. They are the names the control plane grants and the service enforces.

```ts
import { defineCapabilities } from 'service-plane/service';

export const capabilities = defineCapabilities({
  serviceId: 'asana',
  scopes: [{ id: 'asana.tasks.write', title: 'Create Asana tasks' }],
});
```

If an ability or method references an unknown scope, the service fails during setup.

## 2. Define Schemas

Schemas are the source of truth for input and output. Pick any validation library that implements [Standard Schema](https://standardschema.dev) and its [Standard JSON Schema](https://standardschema.dev/json-schema) companion — see [Choosing A Validation Library](#choosing-a-validation-library) below. The snippets here use Zod to stay concrete; every one of them works the same written in ArkType, Valibot, or VineJS.

```ts
import * as z from 'zod';

export const CreateTaskInput = z.object({
  connectionId: z.string(),
  name: z.string().min(1),
  projectId: z.string(),
});

export const CreateTaskOutput = z.object({
  id: z.string(),
  url: z.string().url(),
});
```

The same schemas are used for RPC validation, discovery, OpenAPI, and MCP metadata.

Besides `mcp` (an MCP tool), a published method can declare `mcpResource` (a static or `{variable}`-templated MCP resource) and `mcpPrompt` (an MCP prompt). See [OpenAPI and MCP](openapi-mcp.md#mcp) for how the control plane projects and serves them.

### Choosing A Validation Library

`service-plane` has no validation library of its own and no validation peer dependency. An `input` or `output` schema is anything that implements two companion specs:

- [Standard Schema](https://standardschema.dev) — the `~standard.validate()` contract used to validate one RPC call's input, one return value, or one streamed item.
- [Standard JSON Schema](https://standardschema.dev/json-schema) — the `~standard.jsonSchema` contract used to render the discovery document, OpenAPI, and MCP tool metadata.

Both halves are required, because every ability method appears in the discovery document. Service Plane always asks for the `draft-2020-12` target, so every service publishes the same JSON Schema dialect no matter which library produced it.

Known implementations, alphabetically — none is preferred by this package, and the list is not exhaustive:

| Library | Supported from | Note |
| --- | --- | --- |
| [ArkType](https://arktype.io) | 2.1.28 | Works directly. |
| [Valibot](https://valibot.dev) | 1.2 | Wrap with `toStandardJsonSchema()` from `@valibot/to-json-schema` 1.5+. |
| [VineJS](https://vinejs.dev) | 4.3 | Works directly. |
| [Zod](https://zod.dev) | 4.2 | Works directly. |

There is nothing to configure. You do not register a library, pass an adapter, or set an option — you import the library you want and pass its schemas as `input` and `output`. Service Plane reads the contract off each schema it is handed.

That means the choice is per schema, not per service. Two services in one plane can use different libraries, one ability can mix them across methods, and a single method can take its `input` from one library and its `output` from another. Each schema is projected on its own, so mixing is invisible to callers.

```ts
// Valibot schemas carry validation, but JSON Schema comes from the wrapper.
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

export const CreateTaskInput = toStandardJsonSchema(
  v.object({
    connectionId: v.string(),
    name: v.pipe(v.string(), v.minLength(1)),
    projectId: v.string(),
  }),
);
```

Both halves of the contract are checked when the service is defined, not on the first call: a schema missing `~standard.validate` or `~standard.jsonSchema`, or one JSON Schema cannot represent — a Zod `.transform()` on the output side, for example — fails while the service boots, with the offending ability and method named. Because there is no validation peer dependency, an outdated library installs cleanly and only fails here, so the error names the version floor.

## 3. Define An Ability

An ability is the service API surface. Each method is a transport-neutral Service Plane contract.

```ts
import { createAbilityBuilder, defineAbility } from 'service-plane/service';
import { CreateTaskInput, CreateTaskOutput } from './schemas';

type Env = {
  Bindings: {
    ASANA_CONNECTIONS: DurableObjectNamespace;
  };
};

const ability = createAbilityBuilder<Env>();

export const asanaTasks = defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
  exposure: 'published',
  access: 'plane',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: ability
      .method({
        scopes: ['asana.tasks.write'],
        rest: { method: 'post', path: '/asana/tasks', summary: 'Create an Asana task' },
        mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
      })
      .input(CreateTaskInput)
      .output(CreateTaskOutput)
      .handler(async ({ context, input }) => {
        const connectionName = `${context.identity.serviceId}:${input.connectionId}`;
        const id = context.env.ASANA_CONNECTIONS.idFromName(connectionName);
        return context.env.ASANA_CONNECTIONS.get(id).createTask(input);
      }),
  },
  rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
});
```

The method is the implementation. Its metadata also drives discovery, REST/OpenAPI, and MCP, so
there is no second handler class or method map to keep synchronized. The RPC engine is private; add
cross-cutting HTTP concerns through Hono middleware and shape intentional application failures with
`AbilityHandlerError`.

`access: 'plane'` is the default Service Plane path: the control plane or gateway decides whether an upstream product user, API key, or anonymous request may invoke the ability. Use `access: 'service'` only for abilities that should be brokered for authenticated service callers.

The service enforces this itself. Every capability token names the access class the control plane authenticated for the caller ([`identity.callerAccess`](auth.md#context-and-identity)), and an `access: 'service'` ability rejects a `plane` caller with 403 before the handler is created. The check reads the ability definition in front of you, not the plane's discovered catalog, so tightening an ability takes effect the moment the service deploys.

## 4. Use The Authorized Context

The handler receives validated input only after Service Plane has verified the token, ingress claim,
access class, and method scopes. Its output is validated before it crosses the RPC boundary.

```ts
.handler(async ({ context, input }) => {
  context.signal?.throwIfAborted();
  const remaining = context.remainingTimeoutMs?.();

  return context.env.ASANA_CONNECTIONS.get(
    context.env.ASANA_CONNECTIONS.idFromName(input.connectionId),
  ).createTask(input, { signal: context.signal, timeoutMs: remaining });
})
```

Use `context.env` for runtime bindings and `context.request` for headers. The verified caller is in
`context.identity`. `context.context` exposes the underlying Hono context when a method genuinely
needs a middleware variable or another Hono-specific feature; ordinary domain code need not import
Hono.

### Streaming Methods

Some operations produce many results over time. Start them with `ability.stream(itemSchema, metadata)`;
the item schema validates each value yielded by the async iterator:

```ts
readFile: ability
  .stream(z.object({ chunk: z.string() }), { scopes: ['hub.files.read'] })
  .input(z.object({ path: z.string() }))
  .handler(async function* ({ context, input }) {
    for await (const chunk of context.env.STORAGE.read(input.path)) {
      yield { chunk };
    }
  }),
```

Callers receive a typed async iterator. Fetch and WebSocket carry it directly. A Cloudflare
service-binding client uses native RPC for unary methods and `binding.fetch` for streams. See
[Streaming](streaming.md).

`context` is runtime access, such as Hono context, environment bindings, storage, and execution context.

`identity` is the verified Service Plane caller and granted scopes. When the control plane brokers a call for an authenticated plane principal, `identity.subject` carries its id, optional org, and optional principal kind as an RFC 8693 delegated subject (see [auth](auth.md#subject-delegation)). Any other product-level connection context is application-owned; pass it in validated method input if the service needs it. Do not put provider OAuth tokens in identity. Store credentials in a service-owned store such as a Durable Object.

`connInfo` is the original client's connection (`{ remote: { address?, addressType?, port?, transport? } }`, Hono's `ConnInfo`), forwarded by the control plane when it is configured to do so. It is present only for brokered calls into an ingress-protected service, and it is **advisory**: unlike `identity` it is not signature-verified. Use it for audit records and logs, never to decide access. See [Forwarded Connection Info](auth.md#forwarded-connection-info).

```ts
handler: ({ connInfo, identity }) => new AsanaTasksHandler(identity, connInfo?.remote.address),
```

## 5. Mount The Service

```ts
import {
  ServicePlaneService,
  jwksFromServiceBinding,
} from 'service-plane/service';
import { asanaTasks } from './abilities';
import { capabilities } from './capabilities';

type Env = {
  ASANA_CONNECTIONS: DurableObjectNamespace;
  CONTROL_PLANE: Fetcher;
};

export default new ServicePlaneService<{ Bindings: Env }>({
  id: 'asana',
  title: 'Asana Service',
  version: '0.2.0',
  auth: {
    issuer: 'control-plane',
    jwks: (c) => jwksFromServiceBinding(c.env.CONTROL_PLANE),
  },
  ingress: {},
  capabilities,
  abilities: [asanaTasks],
});
```

This mounts discovery and an ingress-protected RPC endpoint:

```txt
GET /.well-known/service-plane/service.json
ALL /rpc/asana.tasks/createTask
```

When `ingress` is configured, ability RPC requests must use a brokered capability token issued by the control plane. Normal capability tokens still verify cryptographically, but they are rejected before input validation or handler creation.

The service shell also mounts `hono/request-id` and a structured JSON request logger by default. Request ids propagated by the control-plane broker are adopted and echoed on responses, so service logs correlate with plane logs. Pass `logger: { log: (event) => ... }` to forward events to your own logger, or `logger: false` to disable request logging; request-id assignment is always on because brokered-call correlation depends on it.

Next: [create a control plane](plane-creation.md) and [configure auth](auth.md).
