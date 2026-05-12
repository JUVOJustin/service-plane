# service-plane

Opinionated Hono primitives for service-oriented apps with a public control plane and independently owned service routers.

`service-plane` does not replace Hono, Hono RPC, Zod, or OpenAPI tooling. It gives you a small default setup for:

- service discovery
- explicit route visibility
- route-level capability scopes
- short-lived service-to-service tokens
- control-plane proxying
- request IDs and token-safe service logs

## Quickstart

This guide sets up one control plane and one service as separate HTTP deployments. The control plane reaches services by URL, services fetch the control plane JWKS by URL, and caller services authenticate to the control plane with per-service client secrets.

The snippets use `process.env` for brevity. Use your runtime's environment or secret API if you are not on Node.js.

### 1. Install

```sh
npm install service-plane hono
```

### 2. Define The Service Capabilities

Capabilities belong to the service that owns the routes. Keep this file next to the service. If your control plane is deployed from another repo, keep an equivalent public definition there or discover it from the service.

```ts
// services/resource-service/src/capabilities.ts
import { defineCapabilities } from 'service-plane/service';

export const resourceCapabilities = defineCapabilities({
  serviceId: 'resource',
  scopes: [
    { id: 'resource.events.ingest', title: 'Ingest resource events' },
    { id: 'resource.sync.run', title: 'Run resource sync' },
  ],
});
```

### 3. Create The Service

The service defines Hono routes, marks each protected route with `capability(...)`, and hands the routers to `ServicePlaneService`.

```ts
// services/resource-service/src/index.ts
import { Hono } from 'hono';
import { capability, capabilityIdentity, jwksFromUrl, ServicePlaneService } from 'service-plane/service';
import { resourceCapabilities } from './capabilities';

const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? 'https://plane.example.com';

const publicRoutes = new Hono().post('/events/resource/:id', capability('resource.events.ingest'), (c) =>
  c.json({
    caller: capabilityIdentity(c)?.serviceId,
    id: c.req.param('id'),
    ok: true,
  }),
);

const internalRoutes = new Hono().post('/internal/resource/sync', capability('resource.sync.run'), (c) =>
  c.json({
    caller: capabilityIdentity(c)?.serviceId,
    ok: true,
  }),
);

export type ResourceRoutes = typeof internalRoutes;

const service = new ServicePlaneService({
  auth: {
    jwks: jwksFromUrl(new URL('/.well-known/service-plane/jwks.json', controlPlaneUrl)),
  },
  capabilities: resourceCapabilities,
  id: 'resource',
  title: 'Resource Service',
  version: '0.1.0',
  namespaces: [
    { app: publicRoutes, visibility: 'public' },
    { app: internalRoutes, visibility: 'internal' },
  ],
});

export default service.app;
```

Deploy this service at a stable internal or public URL, for example:

```txt
RESOURCE_SERVICE_URL=https://resource.example.com
CONTROL_PLANE_URL=https://plane.example.com
```

### 4. Create The Control Plane

The control plane grants scopes, publishes the token/JWKS endpoints, discovers services, authenticates caller services before issuing tokens, and proxies `public` and `auth` routes.

```ts
// apps/control-plane/src/index.ts
import { hmacServiceClientAuth, httpsService, ServicePlaneControlPlane } from 'service-plane/control-plane';

const resourceServiceUrl = requiredEnv('RESOURCE_SERVICE_URL');
const stsSigningSecret = requiredEnv('STS_SIGNING_SECRET');
const workerAHmacSecret = requiredEnv('WORKER_A_HMAC_SECRET');

const controlPlane = new ServicePlaneControlPlane({
  authenticateCaller: hmacServiceClientAuth({
    clients: [{ clientId: 'worker-a', secret: workerAHmacSecret }],
  }),
  services: () => [
    httpsService({
      baseUrl: resourceServiceUrl,
      id: 'resource',
      grants: [
        {
          caller: 'control-plane',
          scopes: ['resource.events.ingest'],
        },
        {
          caller: 'worker-a',
          scopes: ['resource.sync.run'],
        },
      ],
    }),
  ],
  signingSecret: () => stsSigningSecret,
});

// The control-plane app is a normal Hono app. Add frontend auth,
// dashboards, API routes, or any other middleware around service-plane.
controlPlane.app.use('/dashboard/*', async (c, next) => {
  const session = c.req.header('authorization');
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

controlPlane.app.get('/dashboard', (c) => c.html('<h1>Control Plane</h1>'));

export default controlPlane.app;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
```

If middleware must run before the service-plane endpoints or proxy, create a Hono app first and pass it as `app`:

```ts
const app = new Hono();
app.use('/admin/*', requireAdminSession);

const controlPlane = new ServicePlaneControlPlane({
  app,
  // ...
});
```

### 5. Generate The Control-Plane Secrets

Only the control plane gets this secret. Services fetch the public JWKS from the control plane.

```sh
node --input-type=module -e "import { generateCapabilitySigningSecret } from 'service-plane/control-plane'; console.log(await generateCapabilitySigningSecret())"
```

Store the output as `STS_SIGNING_SECRET`:

```sh
export STS_SIGNING_SECRET='nYb0v...43_base64url_chars'
```

Caller services also need credentials for the control-plane token endpoint. For HMAC, store the same high-entropy secret in the caller service and the control plane.

```sh
node --input-type=module -e "import { generateServiceClientSecret } from 'service-plane/control-plane'; console.log('WORKER_A_HMAC_SECRET=' + generateServiceClientSecret())"
```

Use your platform's secret manager in production:

- control plane: `STS_SIGNING_SECRET`, `WORKER_A_HMAC_SECRET`
- worker-a: `WORKER_A_HMAC_SECRET`

### 6. Run The Plane And Service

Run each deployment with its own environment:

- service: `CONTROL_PLANE_URL=https://plane.example.com`
- control plane: `RESOURCE_SERVICE_URL=https://resource.example.com`, `STS_SIGNING_SECRET=...`, and `WORKER_A_HMAC_SECRET=...`
- worker-a: `CONTROL_PLANE_URL=https://plane.example.com`, `RESOURCE_SERVICE_URL=https://resource.example.com`, and `WORKER_A_HMAC_SECRET=...`

### 7. Call A Public Route Through The Control Plane

```sh
curl -X POST http://localhost:8787/events/resource/123
```

The control plane:

1. discovers the service route
2. sees that it is `public`
3. mints a short-lived `ServicePlane` token for `resource.events.ingest`
4. forwards the request to the service with `Authorization: ServicePlane <token>`
5. preserves or generates `X-Request-Id` and passes it through

Direct calls to the service route still require a valid `ServicePlane` token.

## Service-To-Service Client

Use `capabilityFetch(...)` when one service calls another service directly through Hono RPC or normal `fetch`.

```ts
// services/worker-a/src/resource-client.ts
import { hc } from 'hono/client';
import { capabilityFetch, controlPlaneHmacTokenRequester } from 'service-plane/service';
import type { ResourceRoutes } from '../../resource-service/src';

const controlPlaneUrl = process.env.CONTROL_PLANE_URL ?? 'https://plane.example.com';
const resourceServiceUrl = process.env.RESOURCE_SERVICE_URL ?? 'https://resource.example.com';
const workerAHmacSecret = requiredEnv('WORKER_A_HMAC_SECRET');

export const resourceClient = hc<ResourceRoutes>(resourceServiceUrl, {
  fetch: capabilityFetch({
    callerServiceId: 'worker-a',
    targetServiceId: 'resource',
    scopes: ['resource.sync.run'],
    requestToken: controlPlaneHmacTokenRequester({
      clientId: 'worker-a',
      clientSecret: workerAHmacSecret,
      controlPlaneUrl,
    }),
  }),
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
```

`capabilityFetch(...)` keeps a best-effort in-memory token cache and refreshes shortly before expiry. The default token TTL is 120 seconds.

`capabilityFetch(...)` preserves existing request headers. If a service handles a request and calls another service, pass the incoming `X-Request-Id` on the outgoing request so the same ID appears in plane, caller, and target logs.

## Defaults

`ServicePlaneService` installs:

- service discovery at `/.well-known/service-plane/service.json`
- capability-token verification, using the control plane JWKS
- `X-Request-Id` reading for logs; services do not generate request IDs
- structured token-safe service logs
- `requireRouteScopes: true`

`ServicePlaneControlPlane` installs:

- token issuance at `/.well-known/service-plane/capability-token`
- public JWKS at `/.well-known/service-plane/jwks.json`
- service discovery and proxying
- inline service discovery support on service endpoints, useful for private Cloudflare bindings
- Hono `requestId()` generation and forwarding with `X-Request-Id`
- automatic control-plane STS tokens for proxied scoped routes

## Route Visibility

Each service namespace must declare visibility:

- `public`: the control plane may proxy the route without app-user auth. Use for webhooks and public ingest.
- `auth`: the control plane may proxy the route after your app-user auth check.
- `internal`: the control plane does not publicly proxy the route. Use for service-to-service APIs.

Visibility is explicit. It is not inferred from URL paths.

## More

- [Architecture](docs/architecture.md)
- [Service-To-Service Authorization](docs/service-to-service.md)
- [Auth Keys](docs/auth-keys.md)
- [Capability Catalogs](docs/capability-catalogs.md)
- [Cloudflare Workers](docs/cloudflare-workers.md)
- [External Hono Services](docs/external-hono-service.md)
- [Security](docs/security.md)
- [Caching](docs/caching.md)
