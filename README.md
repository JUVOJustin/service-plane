# service-plane

Ability-first service APIs for TypeScript services.

`service-plane` gives independently deployed services one shared model:

- Services define schema-backed abilities.
- The control plane issues short-lived capability tokens.
- Cap'n Web carries RPC method calls over HTTP-batch, WebSocket, or Cloudflare bindings.
- Zod schemas validate inputs and outputs.
- Published abilities can become OpenAPI, Swagger, or MCP tools from the control plane.

Service authors define abilities. Hono stays the HTTP shell for middleware, discovery, and adapter routes.

## Install

```sh
npm install service-plane hono @hono/capnweb capnweb zod
```

## Minimal Service

```ts
import { RpcTarget } from 'capnweb';
import * as z from 'zod';
import {
  ServicePlaneService,
  abilityMethod,
  defineAbility,
  defineCapabilities,
  jwksFromServiceBinding,
} from 'service-plane/service';

type Env = {
  ASANA_CONNECTIONS: DurableObjectNamespace;
  CONTROL_PLANE: Fetcher;
};

const capabilities = defineCapabilities({
  serviceId: 'asana',
  scopes: [{ id: 'asana.tasks.write', title: 'Create Asana tasks' }],
});

const asanaTasks = defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
  exposure: 'published',
  auth: 'user',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: abilityMethod({
      input: z.object({
        connectionId: z.string(),
        name: z.string().min(1),
        projectId: z.string(),
      }),
      output: z.object({
        id: z.string(),
        url: z.string().url(),
      }),
      scopes: ['asana.tasks.write'],
      rest: { method: 'post', path: '/asana/tasks', summary: 'Create an Asana task' },
      mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
    }),
  },
  handler: ({ context, identity }) => new AsanaTasksHandler(context.env, identity),
});

class AsanaTasksHandler extends RpcTarget {
  constructor(
    private readonly env: Env,
    private readonly identity: { tenantId?: string; userId?: string },
  ) {
    super();
  }

  async createTask(input: { connectionId: string; name: string; projectId: string }) {
    const id = this.env.ASANA_CONNECTIONS.idFromName(`${this.identity.tenantId}:${input.connectionId}`);
    const connection = this.env.ASANA_CONNECTIONS.get(id);
    return connection.createTask(input);
  }
}

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

This service mounts:

```txt
GET /.well-known/service-plane/service.json
ALL /rpc/asana.tasks
```

## Minimal Control Plane

```ts
import {
  ServicePlaneControlPlane,
  cloudflareServiceBinding,
  hmacServiceClientAuth,
} from 'service-plane/control-plane';

export default new ServicePlaneControlPlane({
  signingSecret: (env) => env.STS_SIGNING_SECRET,
  authenticateCaller: (c) =>
    hmacServiceClientAuth({
      clients: [{ clientId: 'workflow-runner', secret: c.env.WORKFLOW_RUNNER_SECRET }],
    })(c),
  services: (c) => [
    cloudflareServiceBinding({
      id: 'asana',
      binding: c.env.ASANA,
      grants: [{ caller: 'workflow-runner', scopes: ['asana.tasks.write'] }],
    }),
  ],
});
```

The control plane mounts:

```txt
POST /.well-known/service-plane/capability-token
GET  /.well-known/service-plane/jwks.json
GET  /openapi.json
GET  /swagger
ALL  /rpc/mcp
```

## Minimal Caller

```ts
import {
  abilitySession,
  cloudflareServiceBindingRpc,
  controlPlaneRpcTokenRequester,
  type AbilityRpc,
} from 'service-plane/service';

const asana = await abilitySession<AbilityRpc<typeof asanaTasks>>({
  abilityId: 'asana.tasks',
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken: controlPlaneRpcTokenRequester({
    binding: env.CONTROL_PLANE,
    callerServiceId: 'workflow-runner',
  }),
  transport: cloudflareServiceBindingRpc(env.ASANA),
});

await asana.createTask({
  connectionId: 'conn_123',
  name: 'Follow up',
  projectId: 'proj_456',
});
```

## Docs

- [Architecture](docs/architecture.md)
- [Create A Service](docs/service-creation.md)
- [Create A Control Plane](docs/plane-creation.md)
- [Auth](docs/auth.md)
- [Cloudflare](docs/cloudflare.md)
- [Node.js And Self-Hosted Services](docs/nodejs.md)
- [OpenAPI And MCP](docs/openapi-mcp.md)
- [Reference](docs/reference.md)
