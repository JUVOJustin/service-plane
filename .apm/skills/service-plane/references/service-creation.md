# Create A Service

Goal: create one service that exposes schema-backed abilities through Service Plane.

The smallest useful service defines capabilities, abilities, handler classes, and `ServicePlaneService`.

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

An ability is the service API surface. A method is one callable operation.

```ts
import { abilityMethod, defineAbility } from 'service-plane/service';
import { CreateTaskInput, CreateTaskOutput } from './schemas';
import { AsanaTasksHandler } from './tasks.handler';

export const asanaTasks = defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
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

`handler` returns the implementation object. The object can implement many methods, but only methods declared in `ability.methods` are callable through Service Plane.

`access: 'plane'` is the default Service Plane path: the control plane or gateway decides whether an upstream product user, API key, or anonymous request may invoke the ability. Use `access: 'service'` only for abilities that should be brokered for authenticated service callers.

## 4. Implement The Handler

The handler receives already-validated input. Service Plane validates input before the method call and validates output after the method returns.

```ts
import { RpcTarget } from 'capnweb';
import type { CapabilityIdentity } from 'service-plane/service';

type Env = {
  ASANA_CONNECTIONS: DurableObjectNamespace;
};

export class AsanaTasksHandler extends RpcTarget {
  constructor(
    private readonly env: Env,
    private readonly identity: CapabilityIdentity,
  ) {
    super();
  }

  async createTask(input: { connectionId: string; name: string; projectId: string }) {
    const connectionName = `${this.identity.serviceId}:${input.connectionId}`;
    const id = this.env.ASANA_CONNECTIONS.idFromName(connectionName);
    const connection = this.env.ASANA_CONNECTIONS.get(id);

    return connection.createTask(input);
  }
}
```

### Streaming Methods

Some operations produce many results over time — large file transfers, long exports. Declare them with `stream: true`; the `output` schema then validates each streamed item and the handler method returns an async generator (or any iterable / `ReadableStream`):

```ts
readFile: abilityMethod({
  input: z.object({ path: z.string() }),
  output: z.object({ chunk: z.string() }),
  scopes: ['hub.files.read'],
  stream: true,
}),
```

```ts
async *readFile(input: { path: string }) {
  for await (const chunk of this.storage.read(input.path)) {
    yield { chunk };
  }
}
```

Callers receive a native Cap'n Web `ReadableStream` of validated items from the ordinary `abilitySession` call. Streams need an ongoing session, so the ability must enable a session transport (`websocket` or `cloudflare-binding-rpc`); HTTP-batch calls to streaming methods fail with 405. See [Streaming](streaming.md).

`context` is runtime access, such as Hono context, environment bindings, storage, and execution context.

`identity` is the verified Service Plane caller and granted scopes. When the control plane brokers a call for an authenticated end user, `identity.subject` carries that user's id and org as an RFC 8693 delegated subject (see [auth](auth.md#subject-delegation)). Any other product-level connection context is application-owned; pass it in validated method input if the service needs it. Do not put provider OAuth tokens in identity. Store credentials in a service-owned store such as a Durable Object.

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
ALL /rpc/asana.tasks
```

When `ingress` is configured, ability RPC requests must use a brokered capability token issued by the control plane. Normal capability tokens still verify cryptographically, but they are rejected before input validation or handler creation.

The service shell also mounts `hono/request-id` and a structured JSON request logger by default. Request ids propagated by the control-plane broker are adopted and echoed on responses, so service logs correlate with plane logs. Pass `logger: { log: (event) => ... }` to forward events to your own logger, or `logger: false` to disable request logging; request-id assignment is always on because brokered-call correlation depends on it.

Next: [create a control plane](plane-creation.md) and [configure auth](auth.md).
