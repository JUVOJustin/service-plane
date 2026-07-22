# Create A Control Plane

Goal: create the service that issues tokens, discovers services, and builds user-facing projections.

The smallest useful control plane knows which services exist, which callers may use which scopes, and how to sign capability tokens.

## Minimal Plane

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

This mounts:

```txt
POST /.well-known/service-plane/capability-token
GET  /.well-known/service-plane/jwks.json
GET  /openapi.json
POST /rpc/mcp                                    (MCP streamable HTTP)
```

To serve a documentation UI, mount a Hono renderer on `plane.app` against `/openapi.json` — see [OpenAPI and MCP: Docs UI](openapi-mcp.md#docs-ui).

## What The Plane Does

```mermaid
flowchart TD
  Services["Configured services"] --> Discovery["Fetch service discovery"]
  Discovery --> Catalog["Build ability + scope catalog"]
  Catalog --> STS["Issue scoped capability tokens"]
  Catalog --> OpenAPI["Build /openapi.json"]
  Catalog --> MCP["Build /rpc/mcp tool list"]
```

The plane does not implement Asana, ClickUp, or Moco logic. It only knows how to discover those services, validate grants, issue tokens, and project published metadata.

Every inbound request gets an `X-Request-Id` (adopted from the caller or generated), and the broker and MCP surfaces forward it to services on every brokered call. Broker connects, MCP tool calls, and configuration errors are logged as structured JSON events; pass `log` to redirect them to your own sink or `log: false` to silence them. See the logging section in [the reference](reference.md).

## Service-Plane Ingress

If services must reject direct application calls, configure `ServicePlaneService` with `ingress: {}` and send callers through the control-plane broker.

```ts
cloudflareServiceBinding({
  id: 'asana',
  binding: c.env.ASANA,
  grants: [{ caller: 'workflow-runner', scopes: ['asana.tasks.write'] }],
});
```

The broker uses the existing capability issuer to mint a signed brokered token. A caller that sends a valid non-brokered capability token directly to `/rpc/<abilityId>` gets `403` before any ability handler is created.

## Grants

Grants decide which caller can request which scopes for a service.

```ts
cloudflareServiceBinding({
  id: 'asana',
  binding: c.env.ASANA,
  grants: [
    { caller: 'workflow-runner', scopes: ['asana.tasks.write'] },
    { caller: 'admin-worker', scopes: ['asana.tasks.write'] },
  ],
});
```

If a caller asks for an unknown service, unknown scope, or ungranted scope, the token endpoint rejects the request.

## Discovery Cache

The registry can cache service discovery documents. Cache discovery separately from generated OpenAPI.

```ts
const plane = new ServicePlaneControlPlane({
  registry: {
    cache: env.SERVICE_DISCOVERY_CACHE,
    ttlSeconds: 60,
  },
  // ...
});
```

Use discovery caching to avoid repeatedly fetching `/.well-known/service-plane/service.json` from every service.

## OpenAPI Cache

The control plane can cache the bundled OpenAPI document.

```ts
const plane = new ServicePlaneControlPlane({
  openapi: {
    cache: env.OPENAPI_CACHE,
    ttlSeconds: 300,
  },
  // ...
});
```

The document is derived from published ability metadata. Individual services do not serve OpenAPI files.

## Optional Broker

The broker lets a caller discover and connect to abilities through the plane. The broker and MCP endpoints are **fail closed**: you must supply a `caller` resolver that authenticates the request and returns the caller identity. A request with no configured resolver returns `500`; a resolver that returns no caller returns `401`. Nothing is brokered without an authenticated caller.

```ts
new ServicePlaneControlPlane({
  broker: {
    path: '/rpc/broker',
    // Authenticate the request however your deployment does (gateway header, session,
    // mTLS, service binding). Return undefined to reject with 401.
    caller: (c) => {
      const serviceId = c.req.header('x-authenticated-service');
      return serviceId ? { id: serviceId, kind: 'service' } : undefined;
    },
  },
  // ...
});
```

`caller` returns a `BrokerCaller` — `{ id, kind: 'service' | 'user' }`. Service callers (`kind: 'service'`) can reach `access: 'service'` abilities and are brokered under their own service id; other callers are brokered under the control-plane identity for `access: 'plane'` abilities. To intentionally allow anonymous access, return a fixed caller from the resolver — it is always an explicit choice, never a default.

The broker connects by ability:

```ts
broker.ability('asana', 'asana.tasks').connect(['asana.tasks.write']);
```

When service-plane ingress protection is enabled, callers must use the broker or another approved service-plane component that can mint brokered capability tokens.

Streaming ability methods proxy through the broker as native Cap'n Web `ReadableStream`s: connect to the broker over WebSocket (`upgradeWebSocket`), and the plane reaches the service over its own session transport — the endpoint's native ability RPC binding when available (a binding exposing `connectAbility` is picked up automatically by `cloudflareServiceBinding`), otherwise WebSocket. See [Streaming](streaming.md).

Next: [auth](auth.md), [OpenAPI and MCP](openapi-mcp.md), and [Cloudflare](cloudflare.md).
