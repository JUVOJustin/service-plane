# service-plane

Ability-first service APIs for TypeScript services.

`service-plane` gives independently deployed services one shared model:

- Services define schema-backed abilities.
- The control plane issues short-lived capability tokens.
- oRPC carries typed procedure calls over Fetch, WebSocket, or Cloudflare service bindings.
- Schemas validate inputs and outputs, using the validation library you already use.
- Published abilities can become OpenAPI or MCP tools from the control plane.
- Request ids and structured JSON logs correlate plane and service calls out of the box.

Service authors define oRPC procedures. Hono remains the composition shell for middleware,
discovery, STS/JWKS, MCP, OpenAPI, and adapter routes; procedure code can normally use the
transport-neutral `context.env` and `context.request` fields without importing Hono.

The library is written against web-standard globals only (`crypto.subtle`, `fetch`/`Request`,
`TextEncoder`, timers) and runs on Node 20+, Cloudflare Workers, Deno, and Bun. The procedure-first
runtime is currently built on the pinned oRPC 2.0 beta line; see [Architecture](docs/architecture.md#why-orpc-and-what-it-costs)
for the maturity trade-off.

## Install

```sh
npm install service-plane hono
```

Ability schemas come from a validation library you choose; `service-plane` does not bundle or require any particular one. Add whichever you already use — anything implementing [Standard Schema](https://standardschema.dev) and its [Standard JSON Schema](https://standardschema.dev/json-schema) companion:

```sh
npm install arktype     # or zod, or @vinejs/vine, or valibot + @valibot/to-json-schema
```

See [Choosing A Validation Library](docs/service-creation.md#choosing-a-validation-library) for versions and the one wrapper Valibot needs. Code samples in this README and the docs use Zod so they stay concrete — that is an arbitrary choice, not a default.

## Minimal Service

```ts
import * as z from 'zod';
import {
  ServicePlaneService,
  createAbilityBuilder,
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

const ability = createAbilityBuilder<{ Bindings: Env }>();

const asanaTasks = defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
  exposure: 'published',
  access: 'plane',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: ability
      .procedure({
        scopes: ['asana.tasks.write'],
        rest: { method: 'post', path: '/asana/tasks', summary: 'Create an Asana task' },
        mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
      })
      .input(z.object({
        connectionId: z.string(),
        name: z.string().min(1),
        projectId: z.string(),
      }))
      .output(z.object({
        id: z.string(),
        url: z.string().url(),
      }))
      .handler(async ({ context, input }) => {
        const name = `${context.identity.serviceId}:${input.connectionId}`;
        const id = context.env.ASANA_CONNECTIONS.idFromName(name);
        return context.env.ASANA_CONNECTIONS.get(id).createTask(input);
      }),
  },
  rpc: { transports: ['fetch', 'cloudflare-service-binding'] },
});

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
  ingress: {},
});
```

This service mounts:

```txt
GET /.well-known/service-plane/service.json
ALL /rpc/asana.tasks/createTask
```

## Minimal Control Plane

```ts
import {
  ServicePlaneControlPlane,
  cloudflareServiceBinding,
  hmacServiceClientAuth,
} from 'service-plane/control-plane';

export default new ServicePlaneControlPlane({
  broker: {
    caller: (c) => ({ id: c.req.header('x-service-id') ?? 'headless-front', kind: 'service' }),
  },
  signingKeys: (env) => [{ kid: '2026-07', secret: env.STS_SIGNING_SECRET }],
  authenticateCaller: (c) =>
    hmacServiceClientAuth({
      clients: [{ clientId: 'workflow-runner', secret: c.env.WORKFLOW_RUNNER_SECRET }],
    })(c),
  services: (c) => [
    cloudflareServiceBinding({
      id: 'asana',
      binding: c.env.ASANA,
      abilityRpc: {
        invokeAbility: (input) => c.env.ASANA.invokeAbility(input),
      },
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
POST /rpc/broker/call                           (typed unary broker)
POST /rpc/broker/stream                         (typed streaming broker)
POST /rpc/mcp                                    (MCP streamable HTTP)
```

The plane serves the OpenAPI document; to render it, mount a Hono UI extension (e.g. `@hono/swagger-ui` or `@scalar/hono-api-reference`) on `plane.app` pointed at `/openapi.json`.

The caller below knows the ability contract but only connects to the control plane. It never receives
a service capability token or private service address.

## Minimal Caller

```ts
import { createBrokeredAbilityClient } from 'service-plane/service';
import { asanaTasks } from './asana-tasks';

const asana = createBrokeredAbilityClient({
  ability: asanaTasks,
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  transport: {
    origin: 'https://api.example.com',
    headers: { 'x-service-id': 'workflow-runner' },
  },
});

await asana.createTask({
  connectionId: 'conn_123',
  name: 'Follow up',
  projectId: 'proj_456',
});
```

The returned value is an ordinary typed oRPC client. It therefore works directly with oRPC's
TanStack Query integration:

```ts
import { createTanstackQueryUtils } from '@orpc/tanstack-query';

const queries = createTanstackQueryUtils(asana);
const options = queries.createTask.mutationOptions();
```

Install `@orpc/tanstack-query` at the same pinned oRPC version and the TanStack adapter for your UI
framework. The public topology does not change: TanStack Query still calls the control plane, and
the control plane discovers, authorizes, mints, and routes to the private service.

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
