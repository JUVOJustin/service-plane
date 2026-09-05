# Node.js And Self-Hosted Services

Contracts and handlers are runtime-neutral. Outside Cloudflare, use Fetch for normal calls and HTTPS
for discovery/JWKS.

## Serve A Service

```ts
import { serve } from '@hono/node-server';
import { ServicePlaneService, jwksFromUrl } from 'service-plane/service';
import { tasks } from './tasks.implementation';
import { capabilities } from './capabilities';
import { taskRepository } from './task-repository';
import type { TasksEnv } from './tasks.contract';

const service = new ServicePlaneService<TasksEnv>({
  id: 'tasks-service',
  title: 'Tasks Service',
  version: '1.0.0',
  abilities: [tasks],
  capabilities,
  auth: {
    issuer: 'control-plane',
    jwks: jwksFromUrl(
      'https://plane.example.com/.well-known/service-plane/jwks.json',
    ),
  },
});

const fetch = (request: Request) =>
  service.fetch(request, { TASKS: taskRepository });

serve({ fetch, port: 8787 });
```

Put TLS and any network-level allowlist in the reverse proxy or platform. Protected ingress is the
default application-level guarantee that only a brokered capability reaches handlers. The Node adapter does
not create Hono bindings: the `fetch` wrapper supplies the same `TASKS` repository declared by
`TasksEnv` on every request.

Bun and Deno serve the same wrapper without a Node adapter:

```ts
Bun.serve({ fetch, port: 8787 });
// Or in Deno:
Deno.serve({ port: 8787 }, fetch);
```

Only the control plane needs a public URL. A Cloudflare plane can reach the self-hosted service
through HTTPS, mTLS, or a private tunnel; register it alongside bound Workers in the same `services`
array. All targets use the same capability verification and ability contract.

## Register It At The Plane

```ts
httpsService({
  id: 'tasks-service',
  baseUrl: 'https://tasks.internal.example',
  grants: [{ caller: 'control-plane', scopes: ['tasks.read'] }],
});
```

The plane fetches discovery and invokes methods through the supplied Fetch implementation. Inject a
custom `fetch` in `httpsService` for mTLS, an internal DNS client, or test transport.

## Direct Fetch Client

Use a direct client only for a separately secured service explicitly configured with `ingress: false`:

```ts
const tasks = createAbilityClient({
  ability: tasksContract,
  callerServiceId: 'workflow-service',
  targetServiceId: 'tasks-service',
  requestToken: controlPlaneJwkTokenRequester({
    clientId: 'workflow-service',
    controlPlaneUrl: 'https://plane.example.com',
    keyId: 'workflow-2026-08',
    privateJwk,
  }),
  transport: {
    type: 'fetch',
    origin: 'https://tasks.internal.example',
  },
});
```

For ingress-protected production services, use `createBrokeredAbilityClient` against the plane
instead. The caller never receives the private service URL or service capability token.

JWK authentication is preferable for external services because only the public key reaches the
plane and tokens are sender-constrained automatically. HMAC is available as a shared-secret
fallback.

## WebSocket

Current [`@hono/node-server`](https://github.com/honojs/node-server#websocket) ships the upgrade
adapter directly. Install `ws` and give the same `WebSocketServer` to the Node server:

```ts
import { serve, upgradeWebSocket } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { ServicePlaneService } from 'service-plane/service';
import { taskRepository } from './task-repository';
import type { TasksEnv } from './tasks.contract';

const service = new ServicePlaneService<TasksEnv>({
  // ...identity, abilities, capabilities, and auth
  rpc: { upgradeWebSocket },
});

const webSocketServer = new WebSocketServer({ noServer: true });

serve({
  fetch: (request) => service.fetch(request, { TASKS: taskRepository }),
  port: 3000,
  websocket: { server: webSocketServer },
});
```

Inject a standards-compatible client when the Node version or WebSocket package you use does not
provide one globally:

```ts
const client = createAbilityClient({
  // ...
  transport: {
    type: 'websocket',
    url: 'wss://tasks.internal.example/rpc/v1/tasks',
    createWebSocket,
  },
});
```

Prefer Fetch for sporadic calls and ordinary streams. WebSocket is valuable when a persistent,
interactive session amortizes its lifecycle cost.

For a broker WebSocket, authenticate the physical upgrade in the `createWebSocket` closure using a
standards-compatible client that supports upgrade headers, or pass a short-lived URL ticket.
`BrokeredAbilityTransport.headers` configures Fetch requests only; logical request IDs,
idempotency keys, and timeouts remain per method call.

Service Plane requires Node.js 22 or later and web-standard `fetch`, `Request`, Web Crypto, streams,
and timers. See [transports](transports.md) and [auth](auth.md).
