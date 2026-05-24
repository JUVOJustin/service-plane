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

`handler` returns the implementation object. The object can implement many methods, but only methods declared in `ability.methods` are callable through Service Plane.

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
    const connectionName = `${this.identity.tenantId}:${input.connectionId}`;
    const id = this.env.ASANA_CONNECTIONS.idFromName(connectionName);
    const connection = this.env.ASANA_CONNECTIONS.get(id);

    return connection.createTask(input);
  }
}
```

`context` is runtime access, such as Hono context, environment bindings, storage, and execution context.

`identity` is the verified caller and authorization data, such as service id, tenant id, user id, connection id, and granted scopes. Do not put provider OAuth tokens in identity. Store credentials in a service-owned store such as a Durable Object.

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
  capabilities,
  abilities: [asanaTasks],
});
```

This mounts:

```txt
GET /.well-known/service-plane/service.json
ALL /rpc/asana.tasks
```

Next: [create a control plane](plane-creation.md) and [configure auth](auth.md).
