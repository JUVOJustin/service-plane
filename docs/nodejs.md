# Node.js And Self-Hosted Services

Goal: run Service Plane across normal HTTPS services outside Cloudflare.

Use the same ability definitions as Cloudflare services. The main difference is transport and caller auth.

## Service

A self-hosted Hono service exposes discovery and one RPC endpoint per ability.

```ts
import { serve } from '@hono/node-server';
import { ServicePlaneService, jwksFromUrl } from 'service-plane/service';
import { asanaTasks } from './abilities';
import { capabilities } from './capabilities';

const service = new ServicePlaneService({
  id: 'asana',
  title: 'Asana Service',
  version: '0.2.0',
  auth: {
    issuer: 'control-plane',
    jwks: jwksFromUrl('https://plane.example.com/.well-known/service-plane/jwks.json'),
  },
  capabilities,
  abilities: [asanaTasks],
});

serve({ fetch: service.fetch, port: 8787 });
```

The service exposes:

```txt
GET  /.well-known/service-plane/service.json
POST /rpc/asana.tasks
```

## Local Caller Over HTTP-Batch

HTTP-batch is the default self-hosted request/response transport.

```ts
import {
  abilitySession,
  controlPlaneJwkTokenRequester,
  httpBatchRpc,
  type AbilityRpc,
} from 'service-plane/service';
import { asanaTasks } from './abilities';

const asana = await abilitySession<AbilityRpc<typeof asanaTasks>>({
  abilityId: 'asana.tasks',
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken: controlPlaneJwkTokenRequester({
    clientId: 'workflow-runner',
    controlPlaneUrl: 'https://plane.example.com',
    keyId: 'workflow-runner-2026-01',
    privateJwk,
  }),
  transport: httpBatchRpc('https://asana.example.com'),
});

await asana.createTask({
  connectionId: 'conn_123',
  name: 'Follow up',
  projectId: 'proj_456',
});
```

This local-development example deliberately leaves `ingress` disabled. Production services should
enable `ingress: {}` and expose the ability through the control-plane broker instead of calling the
service URL directly. Direct HTTP-batch calls with ordinary tokens are rejected when ingress is
enabled.

## HMAC Fallback

Use HMAC caller auth when a private JWK is not practical.

```ts
controlPlaneHmacTokenRequester({
  clientId: 'workflow-runner',
  controlPlaneUrl: 'https://plane.example.com',
  clientSecret: process.env.WORKFLOW_RUNNER_SECRET,
});
```

JWK is preferable for distributed services because the private key stays with the caller and the public key can be discovered or configured by the plane.

## WebSocket Sessions

Use WebSocket only when the session is long-lived, interactive, or chatty.

```ts
transport: websocketRpc('wss://asana.example.com/rpc/asana.tasks')
```

If the Node runtime does not provide a global `WebSocket`, inject the standards-compatible client
you already use. The factory receives the final URL, including Service Plane's propagated request
id:

```ts
transport: websocketRpc('wss://asana.example.com/rpc/asana.tasks', {
  createWebSocket, // (url: string) => WebSocket from your client adapter
});
```

The control-plane broker and MCP projection use the same factory through the service endpoint:

```ts
import { httpsService } from 'service-plane/control-plane';

httpsService({
  id: 'asana',
  baseUrl: 'https://asana.example.com',
  createWebSocket,
});
```

This keeps WebSocket construction runtime-owned and does not require application code to install a
persistent global. With Cap'n Web 0.10, Service Plane temporarily supplies
`WebSocket.CONNECTING` only during synchronous session construction and restores the previous
global immediately.

For normal request/response calls, prefer HTTP-batch. It is easier to deploy, cache, observe, and retry. Streaming ability methods require a session transport; wire `upgradeWebSocket` from `@hono/node-ws` into the service shell as shown in [Streaming](streaming.md#serve-websocket-sessions). On long-running Node processes WebSockets are essentially free, so chatty service pairs should hold a session — the full decision guide is [Choosing A Transport](transports.md).

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [reference](reference.md).
