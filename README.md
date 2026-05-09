# service-plane

Opinionated Hono primitives for service-oriented applications with a public control plane and independently owned service routers.

`service-plane` is intentionally small. It does not replace Hono, Zod, Hono RPC, or OpenAPI tooling. It standardizes the missing parts around service discovery, explicit route visibility, control-plane proxying, and HMAC-SHA-256 machine-to-machine auth.

## Install

```sh
npm install service-plane hono
```

## Modules

```ts
import { defineService, defineNamespace, mountDiscovery, machineAuth } from 'service-plane/service';
import { createServiceRegistry, createControlPlaneProxy, signMachineRequest } from 'service-plane/control-plane';
```

## Service

```ts
import { Hono } from 'hono';
import { defineNamespace, defineService, machineAuth, mountDiscovery } from 'service-plane/service';

const publicRoutes = new Hono().post('/events/example/:target', (c) => c.text('ok'));

const internalRoutes = new Hono().post(
  '/providers/example/v1/sync',
  machineAuth({
    resolveSecret: (keyId) => (keyId === 'default' ? process.env.SERVICE_PLANE_SECRET : undefined),
  }),
  (c) => c.json({ ok: true }),
);

export const service = defineService({
  id: 'example',
  title: 'Example',
  version: '0.0.1',
  namespaces: [
    defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
    defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
  ],
});

const app = new Hono();
mountDiscovery(app, service);
app.use(
  '*',
  machineAuth({
    resolveSecret: (keyId) => (keyId === 'default' ? process.env.SERVICE_PLANE_SECRET : undefined),
  }),
);
app.route('/', publicRoutes);
app.route('/', internalRoutes);

export default app;
```

## Control Plane

```ts
import { Hono } from 'hono';
import {
  cloudflareServiceBinding,
  createControlPlaneProxy,
  createServiceRegistry,
  signMachineRequest,
} from 'service-plane/control-plane';

type Env = {
  EXAMPLE_SERVICE: Fetcher;
  SERVICE_PLANE_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) =>
  createControlPlaneProxy({
    registry: createServiceRegistry({
      services: [
        cloudflareServiceBinding({
          id: 'example',
          binding: c.env.EXAMPLE_SERVICE,
        }),
      ],
    }),
    authorizeAuthRoute: async (c) => {
      if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    },
    signer: (request) =>
      signMachineRequest(request, {
        secret: c.env.SERVICE_PLANE_SECRET,
      }),
  })(c, next),
);

export default app;
```

## Route Visibility

Services expose Hono routers through explicit namespaces:

- `public`: control planes may proxy these routes without user auth. Use for webhooks and public ingest. The service still owns provider-specific validation.
- `auth`: control planes may proxy these routes after application-level auth.
- `internal`: control planes must not publicly proxy these routes. Use for service-to-service APIs.

Visibility is not inferred from the path. This avoids accidentally exposing internal APIs because a route happens to exist in a Hono app.

## Machine Auth

`service-plane` uses HMAC-SHA-256 signed requests for machine-to-machine calls.

The shared secret is never sent over the wire. The signer sends a key id, timestamp, body hash, and signature. The verifier recomputes the signature from the request method, path/query, timestamp, and body hash. Requests outside the timestamp window are rejected.

Static bearer tokens are intentionally not included in v0.0.1.

Define the same HMAC secret for every control plane and service that trust each other. The package accepts the secret as an argument, but the examples use this secret name:

```txt
SERVICE_PLANE_SECRET
```

For Cloudflare Workers, set it on the control plane and every service Worker:

```sh
npx wrangler secret put SERVICE_PLANE_SECRET
```

For Node.js or other Hono runtimes, provide the same value through your normal secret manager or environment, for example `process.env.SERVICE_PLANE_SECRET`.

## Caching

The registry has an optional callback cache:

```ts
createServiceRegistry({
  cache: {
    get: async (key) => undefined,
    set: async (key, value, ttlSeconds) => {},
  },
  services: [],
});
```

This keeps Redis, D1, Workers KV, and database dependencies out of the package. Use the storage system that fits your runtime.

## Documentation

- [Architecture](docs/architecture.md)
- [Cloudflare Workers](docs/cloudflare-workers.md)
- [External Hono Services](docs/external-hono-service.md)
- [Security](docs/security.md)
- [Caching](docs/caching.md)
