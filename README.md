# service-plane

Ability-first service APIs for TypeScript services.

`service-plane` gives independently deployed services one shared model:

- Services define schema-backed abilities.
- The control plane issues short-lived capability tokens.
- Cap'n Web carries RPC method calls over HTTP-batch, WebSocket, or Cloudflare bindings.
- Schemas validate inputs and outputs, using the validation library you already use.
- Published abilities can become OpenAPI or MCP tools from the control plane.
- Request ids and structured JSON logs correlate plane and service calls out of the box.

Service authors define abilities. Hono stays the HTTP shell for middleware, discovery, and adapter routes.

The library is written against web-standard globals only (`crypto.subtle`, `fetch`/`Request`, `TextEncoder`, timers) and runs on Node 20+, Cloudflare Workers, Deno, and Bun. That claim is exercised in CI: the full test suite runs on Node 20/22/24, and a bundled smoke — HTTP-batch end to end, streaming over a session transport, token verification accepting and rejecting — runs on real workerd (via miniflare), Deno, and Bun on every push.

## Install

```sh
npm install service-plane hono @hono/capnweb capnweb
```

Ability schemas come from a validation library you choose; `service-plane` does not bundle or require any particular one. Add whichever you already use — anything implementing [Standard Schema](https://standardschema.dev) and its [Standard JSON Schema](https://standardschema.dev/json-schema) companion:

```sh
npm install arktype     # or zod, or @vinejs/vine, or valibot + @valibot/to-json-schema
```

See [Choosing A Validation Library](docs/service-creation.md#choosing-a-validation-library) for versions and the one wrapper Valibot needs. Code samples in this README and the docs use Zod so they stay concrete — that is an arbitrary choice, not a default.

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
  access: 'plane',
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
    private readonly identity: { serviceId: string },
  ) {
    super();
  }

  async createTask(input: { connectionId: string; name: string; projectId: string }) {
    const id = this.env.ASANA_CONNECTIONS.idFromName(`${this.identity.serviceId}:${input.connectionId}`);
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
  signingKeys: (env) => [{ kid: '2026-07', secret: env.STS_SIGNING_SECRET }],
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
POST /rpc/mcp                                    (MCP streamable HTTP)
```

The plane serves the OpenAPI document; to render it, mount a Hono UI extension (e.g. `@hono/swagger-ui` or `@scalar/hono-api-reference`) on `plane.app` pointed at `/openapi.json`.

For this compact local-development walkthrough, the service above leaves `ingress` disabled so the caller below can connect directly. Do not use this direct topology as the production boundary. Production services should enable `ingress: {}` and route ability calls through the control-plane broker; direct non-brokered tokens are then rejected with `403` before handler creation. See [Service-Plane Ingress](docs/plane-creation.md#service-plane-ingress).

## Minimal Local Caller

```ts
import {
  abilitySession,
  cloudflareServiceBindingRpc,
  controlPlaneHmacTokenRequester,
  type AbilityRpc,
} from 'service-plane/service';

declare const env: {
  ASANA: Fetcher;
  CONTROL_PLANE: Fetcher;
  WORKFLOW_RUNNER_SECRET: string;
};

const asana = await abilitySession<AbilityRpc<typeof asanaTasks>>({
  abilityId: 'asana.tasks',
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken: controlPlaneHmacTokenRequester({
    clientId: 'workflow-runner',
    clientSecret: env.WORKFLOW_RUNNER_SECRET,
    controlPlaneUrl: 'https://control-plane.internal',
    fetch: env.CONTROL_PLANE,
  }),
  transport: cloudflareServiceBindingRpc(env.ASANA),
});

await asana.createTask({
  connectionId: 'conn_123',
  name: 'Follow up',
  projectId: 'proj_456',
});
```

## Agent Skill

The repo ships an [APM](https://microsoft.github.io/apm/) package with a
`service-plane` skill that teaches coding agents the ability model, the
security boundaries, and where to find deeper reference material. It is
distributed through this Git repo by the APM CLI, independently of npm.

Install the APM CLI once ([instructions](https://microsoft.github.io/apm/quickstart/)), then install the skill into a consumer project:

```sh
apm install JUVOJustin/service-plane
```

Or pin it as a dependency so every teammate gets the same version. Minimal
`apm.yml` in the consumer repo:

```yaml
name: my-project
version: 1.0.0
dependencies:
  apm:
    - JUVOJustin/service-plane
```

```sh
apm install
```

Either way the skill deploys to your agent's native location
(`.claude/skills/` for Claude Code, `.agents/skills/` for Copilot, Cursor,
and others; commit `apm.lock.yaml` to keep installs reproducible). From
there the agent activates it automatically whenever a task touches
service-plane code — no prompting needed. The skill source lives in
[`.apm/skills/service-plane/`](.apm/skills/service-plane/SKILL.md); its
references are synced copies of [`docs/`](docs/).

## Docs

- [Architecture](docs/architecture.md)
- [Create A Service](docs/service-creation.md)
- [Create A Control Plane](docs/plane-creation.md)
- [Streaming](docs/streaming.md)
- [Choosing A Transport](docs/transports.md)
- [Auth](docs/auth.md)
- [Cloudflare](docs/cloudflare.md)
- [Node.js And Self-Hosted Services](docs/nodejs.md)
- [OpenAPI And MCP](docs/openapi-mcp.md)
- [Reference](docs/reference.md)
