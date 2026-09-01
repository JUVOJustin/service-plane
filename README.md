# service-plane

Ability-first APIs for TypeScript services.

Define a method once, then use the same contract for runtime validation, typed clients, service
discovery, REST/OpenAPI, and MCP. Hono remains the HTTP shell. Fetch, WebSocket, batching,
compression, and the underlying RPC engine stay implementation details of `service-plane`.

## Install

```sh
npm install service-plane hono
```

`service-plane` requires Hono `>=4.13.5 <5.0.0`.

Schemas must implement [Standard Schema](https://standardschema.dev) and
[Standard JSON Schema](https://standardschema.dev/json-schema). Use the validation library you
already have; the examples use Zod 4.

## 1. Share A Contract

```ts
// tasks.contract.ts
import * as z from 'zod';
import { createAbilityBuilder, defineAbility } from 'service-plane/service';

const ability = createAbilityBuilder();

export const tasksContract = defineAbility({
  id: 'tasks',
  title: 'Tasks',
  exposure: 'published',
  scopes: ['tasks.read'],
  methods: {
    get: ability.method({
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), title: z.string() }),
      scopes: ['tasks.read'],
      rest: { method: 'get', path: '/tasks/{id}', summary: 'Get a task' },
      mcp: { name: 'tasks_get', description: 'Get a task by id' },
    }),
  },
});
```

The shared module contains schemas and metadata, but no handler and no private RPC type.

## 2. Implement The Service

```ts
// service.ts
import {
  ServicePlaneService,
  defineCapabilities,
  implementAbility,
  jwksFromServiceBinding,
} from 'service-plane/service';
import { tasksContract } from './tasks.contract';

type Env = { CONTROL_PLANE: Fetcher };

const tasks = implementAbility(tasksContract, {
  get: ({ input }) => loadTask(input.id),
});

export default new ServicePlaneService<{ Bindings: Env }>({
  id: 'tasks-service',
  title: 'Tasks Service',
  version: '1.0.0',
  capabilities: defineCapabilities({
    serviceId: 'tasks-service',
    scopes: [{ id: 'tasks.read', title: 'Read tasks' }],
  }),
  abilities: [tasks],
  auth: {
    issuer: 'control-plane',
    jwks: (c) => jwksFromServiceBinding(c.env.CONTROL_PLANE),
  },
  ingress: {},
});
```

For a small service, put `handler` directly in `ability.method({ ... })` and skip
`implementAbility`. Keeping the contract separate is preferable when browsers or other packages
import it.

## 3. Mount The Control Plane

```ts
import type { AbilityNativeBinding } from 'service-plane/service';
import {
  type FetchLike,
  ServicePlaneControlPlane,
  cloudflareServiceBinding,
} from 'service-plane/control-plane';

type ControlPlaneEnv = {
  Bindings: {
    STS_SIGNING_SECRET: string;
    TASKS: FetchLike & AbilityNativeBinding;
  };
};

export default new ServicePlaneControlPlane<ControlPlaneEnv>({
  signingKeys: (env) => [{ kid: '2026-08', secret: env.STS_SIGNING_SECRET }],
  services: (c) => [
    cloudflareServiceBinding({
      id: 'tasks-service',
      binding: c.env.TASKS,
      abilityRpc: true,
      grants: [{ caller: 'control-plane', scopes: ['tasks.read'] }],
    }),
  ],
  invocationMiddleware: async (c, next) => {
    const caller = await authenticateProductRequest(c.req.raw);
    if (!caller) return c.json({ error: 'Unauthorized' }, 401);
    c.set('servicePlaneCaller', { id: caller.id, kind: 'user' });
    await next();
  },
  broker: {},
  mcp: {},
});
```

The plane always mounts capability-token/JWKS endpoints and OpenAPI unless disabled. Published REST
routes are on by default; `rest: false` removes their catch-all. `broker: {}` adds `/rpc/broker` and
`mcp: {}` adds `/mcp`. Every product-facing surface fails closed unless trusted middleware sets
`servicePlaneCaller`.

## 4. Call Through The Plane

```ts
import { createBrokeredAbilityClient } from 'service-plane/service';
import { tasksContract } from './tasks.contract';

const tasks = createBrokeredAbilityClient({
  ability: tasksContract,
  targetServiceId: 'tasks-service',
  transport: {
    origin: 'https://api.example.com',
    headers: () => ({ authorization: `Bearer ${readProductToken()}` }),
  },
});

const task = await tasks.get({ id: 'task_123' }, { timeoutMs: 2_000 });
```

Required method scopes are inferred from the contract. Each call can override `requestId`,
`idempotencyKey`, `timeoutMs`, and `signal`. TanStack Query needs only explicit one-line wrappers:
`mutationFn: (input) => tasks.create(input)` and `queryFn: () => tasks.get({ id })`. The wrappers
keep TanStack's own query and mutation contexts out of Service Plane call options.

`transport.headers` authenticates Fetch only. Authenticate a broker WebSocket's HTTP upgrade with a
secure cookie, short-lived URL ticket, or runtime-specific `createWebSocket` closure.

## Runtime Choices

- Cloudflare Worker to Worker: native service-binding RPC for unary calls; binding Fetch for streams.
- Cross-runtime or cross-account: Fetch by default.
- Long-lived interactive streams: WebSocket.
- Public browser or headless client: the control-plane broker, REST, or MCP; do not expose services.

The package runs on Cloudflare Workers and supported Node.js releases (22+) and uses web-standard
APIs. oRPC is a pinned, private dependency: consumers import only Service Plane contracts, clients,
errors, and wire options.

## Documentation

- [Architecture](docs/architecture.md)
- [Create a service](docs/service-creation.md)
- [Create a control plane](docs/plane-creation.md)
- [Authentication and authorization](docs/auth.md)
- [Transports](docs/transports.md) and [streaming](docs/streaming.md)
- [OpenAPI and MCP](docs/openapi-mcp.md); deploy on [Cloudflare](docs/cloudflare.md) or [Node.js](docs/nodejs.md)
- [API reference](docs/reference.md)
- [Migration guide](docs/migration-rpc-boundary.md)

## Releases

Update `package.json` and `package-lock.json` to the intended version in a reviewed release PR, then
publish a GitHub release with the matching SemVer tag, such as `v0.5.0` or `v0.5.0-beta.1`. The
release workflow checks that the tag and package version agree, reruns the complete verification,
and publishes with npm provenance: stable versions to `latest`, prereleases to `next`. A standalone
pushed tag does not publish anything.
