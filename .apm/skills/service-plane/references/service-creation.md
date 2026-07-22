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

Use Zod as the source of truth for input and output.

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

Streaming methods are served on `POST {rpc.path}/stream` (NDJSON) instead of the Cap'n Web session, with the same token, ingress, scope, and input validation. Callers use `abilityStream(...)` rather than `abilitySession(...)`. See [reference](reference.md#streaming-methods) for the wire protocol.

`context` is runtime access, such as Hono context, environment bindings, storage, and execution context.

`identity` is the verified Service Plane caller and granted scopes. When the control plane brokers a call for an authenticated end user, `identity.subject` carries that user's id and org as an RFC 8693 delegated subject (see [auth](auth.md#subject-delegation)). Any other product-level connection context is application-owned; pass it in validated method input if the service needs it. Do not put provider OAuth tokens in identity. Store credentials in a service-owned store such as a Durable Object.

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
