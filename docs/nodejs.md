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
POST /rpc/asana.tasks/createTask
```

## Local Caller Over Fetch

Fetch is the default self-hosted transport and supports both unary and streaming procedures.

```ts
import { createAbilityClient, controlPlaneJwkTokenRequester } from 'service-plane/service';
import { asanaTasks } from './abilities';

const asana = createAbilityClient({
  ability: asanaTasks,
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken: controlPlaneJwkTokenRequester({
    clientId: 'workflow-runner',
    controlPlaneUrl: 'https://plane.example.com',
    keyId: 'workflow-runner-2026-01',
    privateJwk,
  }),
  transport: { type: 'fetch', origin: 'https://asana.example.com' },
});

await asana.createTask({
  connectionId: 'conn_123',
  name: 'Follow up',
  projectId: 'proj_456',
});
```

This local-development example deliberately leaves `ingress` disabled. Production services should
enable `ingress: {}` and expose the ability through the control-plane broker instead of calling the
service URL directly. Direct Fetch calls with ordinary tokens are rejected when ingress is
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

## WebSocket Clients

Use WebSocket only when the connection is long-lived, interactive, or chatty.

```ts
const api = createAbilityClient({
  // ...
  transport: {
    type: 'websocket',
    url: 'wss://asana.example.com/rpc/asana.tasks',
    createWebSocket,
  },
});
```

If the Node runtime does not provide a global `WebSocket`, inject the standards-compatible client
you already use through `createWebSocket`. The same option exists on
`createBrokeredAbilityClient`, whose public URL normally ends in `/rpc/broker/ws`. This keeps
WebSocket construction runtime-owned and does not require a persistent global.

For ordinary calls and streams, prefer Fetch. It is easier to deploy, observe, and retry. Wire
`upgradeWebSocket` from `@hono/node-ws` when an interactive or high-frequency client benefits from
a persistent connection. The full decision guide is [Choosing A Transport](transports.md).

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [reference](reference.md).
