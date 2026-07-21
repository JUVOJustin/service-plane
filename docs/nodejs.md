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
  ingress: {},
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

## Caller Over HTTP-Batch

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

If the service enables `ingress`, direct HTTP-batch callers must not be used. Send calls through the control-plane broker so the token carries the signed broker claim.

## HMAC Fallback

Use HMAC caller auth when a private JWK is not practical.

```ts
controlPlaneHmacTokenRequester({
  clientId: 'workflow-runner',
  controlPlaneUrl: 'https://plane.example.com',
  secret: process.env.WORKFLOW_RUNNER_SECRET,
});
```

JWK is preferable for distributed services because the private key stays with the caller and the public key can be discovered or configured by the plane.

## WebSocket Sessions

Use WebSocket only when the session is long-lived, interactive, or chatty.

```ts
transport: websocketRpc('wss://asana.example.com/rpc/asana.tasks')
```

For normal request/response calls, prefer HTTP-batch. It is easier to deploy, cache, observe, and retry.

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [reference](reference.md).
