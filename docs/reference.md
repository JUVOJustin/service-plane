# Reference

Goal: quickly look up the main Service Plane API pieces and wire shapes.

For a guided walkthrough, start with [Create A Service](service-creation.md) and [Create A Control Plane](plane-creation.md).

## Ability Definition

```ts
defineAbility({
  id: 'asana.tasks',
  title: 'Asana Tasks',
  description: 'Task operations for Asana',
  exposure: 'private' | 'published',
  auth: 'anonymous' | 'user' | 'service',
  scopes: ['asana.tasks.write'],
  methods: {
    createTask: abilityMethod({
      input,
      output,
      scopes: ['asana.tasks.write'],
      rest: { method: 'post', path: '/asana/tasks' },
      mcp: { name: 'asana_create_task', description: 'Create a task in Asana' },
    }),
  },
  rpc: {
    path: '/rpc/asana.tasks',
    transports: ['http-batch', 'websocket'],
  },
  handler: ({ context, identity }) => new AsanaTasksHandler(context.env, identity),
});
```

Defaults:

- `exposure: 'private'`
- `auth: 'service'`
- `rpc.path: /rpc/<abilityId>`
- `rpc.transports: ['http-batch']`

## Ability Method

```ts
abilityMethod({
  input: z.object({ name: z.string() }),
  output: z.object({ id: z.string() }),
  scopes: ['asana.tasks.write'],
});
```

Each method accepts one input object and returns one output value. The wrapper validates both with Zod.

## Discovery Document

```ts
type ServiceDiscoveryDocument = {
  id: string;
  title: string;
  version: string;
  capabilities?: CapabilityCatalog;
  abilities: ServiceAbilityDiscovery[];
};
```

Ability discovery includes exposure, auth, scopes, RPC path, transports, method names, method scopes, JSON Schemas, optional REST metadata, and optional MCP metadata.

## Service

```ts
new ServicePlaneService({
  id,
  title,
  version,
  auth,
  capabilities,
  abilities,
});
```

Mounted routes:

```txt
GET /.well-known/service-plane/service.json
ALL /rpc/<abilityId>
```

## Control Plane

```ts
new ServicePlaneControlPlane({
  signingSecret,
  authenticateCaller,
  services,
  registry,
  openapi,
  broker,
});
```

Mounted routes:

```txt
POST /.well-known/service-plane/capability-token
GET  /.well-known/service-plane/jwks.json
GET  /openapi.json
GET  /swagger
ALL  /rpc/mcp
ALL  /rpc/broker
```

## Caller

```ts
const api = await abilitySession<AbilityRpc<typeof asanaTasks>>({
  abilityId: 'asana.tasks',
  callerServiceId: 'workflow-runner',
  targetServiceId: 'asana',
  scopes: ['asana.tasks.write'],
  requestToken,
  transport,
});
```

Transports:

- `cloudflareServiceBindingRpc(binding)`
- `cloudflareNativeRpc(binding)`
- `httpBatchRpc(url)`
- `websocketRpc(url)`
- `customRpcTransport(transport)`

Token requesters:

- `controlPlaneRpcTokenRequester(...)`
- `controlPlaneJwkTokenRequester(...)`
- `controlPlaneHmacTokenRequester(...)`

## Caches

Use separate caches for:

- service discovery snapshots
- generated OpenAPI document
- control-plane JWKS fetched by services
- caller capability tokens
- HMAC or JWK replay protection

Token cache keys include caller id, target service id, ability id, normalized scopes, and optional TTL.

## Errors

- Missing or invalid token: `CapabilityAuthError` with 401-style status.
- Missing scope: `CapabilityAuthError` with 403-style status.
- Invalid caller input: `AbilityValidationError` with 422-style status.
- Invalid service output: `AbilityValidationError` with 500-style status.

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [Cloudflare](cloudflare.md).
