# service-plane

Opinionated Hono primitives for service-oriented applications with a public control plane and independently owned service routers.

`service-plane` is intentionally small. It does not replace Hono, Zod, Hono RPC, or OpenAPI tooling. It standardizes the missing parts around service discovery, explicit route visibility, STS capability tokens, route-level scope annotations, and control-plane proxying.

## Install

```sh
npm install service-plane hono
```

## Minimal App

The examples below form one real setup: one service Worker, one control-plane Worker, and one caller client.

Use this file layout:

```txt
apps/control-plane/src/index.ts
apps/control-plane/wrangler.jsonc
packages/service-contracts/src/capabilities.ts
services/example-service/src/index.ts
services/example-service/wrangler.jsonc
services/moco/src/example-client.ts
```

### Shared Capability Catalog

In a monorepo, a small shared package is a convenient place for capability catalogs and Hono RPC route types. It is optional: independently deployed services can keep the catalog service-local and let the control plane read it from service discovery instead.

```ts
// packages/service-contracts/src/capabilities.ts
import { defineCapabilities } from 'service-plane/service';

export const exampleCapabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [
    { id: 'example.sync.run', title: 'Run example sync' },
    { id: 'example.events.ingest', title: 'Ingest example events' },
  ],
});
```

### Service Worker

The service owns its scopes and annotates the routes that need them. It verifies STS tokens with the control plane public JWKS.

```ts
// services/example-service/src/index.ts
import { Hono } from 'hono';
import {
  type CapabilityJwks,
  capability,
  capabilityAuth,
  capabilityIdentity,
  defineNamespace,
  defineService,
  mountDiscovery,
} from 'service-plane/service';
import { exampleCapabilities } from '../../../packages/service-contracts/src/capabilities';

const publicRoutes = new Hono().post(
  '/events/example/:target',
  capability('example.events.ingest'),
  (c) =>
    c.json({
      caller: capabilityIdentity(c)?.serviceId,
      target: c.req.param('target'),
    }),
);

const internalRoutes = new Hono().post(
  '/providers/example/v1/sync',
  capability('example.sync.run'),
  (c) =>
    c.json({
      caller: capabilityIdentity(c)?.serviceId,
      ok: true,
    }),
);

export type ExampleRoutes = typeof internalRoutes;

export const service = defineService(
  {
    capabilities: exampleCapabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
    namespaces: [
      defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
      defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
    ],
  },
  { requireRouteScopes: true },
);

type Env = {
  STS_JWKS: CapabilityJwks;
};

const app = new Hono<{ Bindings: Env }>();
mountDiscovery(app, service);
app.use('*', (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/.well-known/service-plane/')) return next();

  return capabilityAuth({
    expectedAudience: 'example',
    issuer: 'control-plane',
    jwks: c.env.STS_JWKS,
  })(c, next);
});
app.route('/', publicRoutes);
app.route('/', internalRoutes);

export default app;
```

Configure the service Worker with:

```jsonc
// services/example-service/wrangler.jsonc
{
  "name": "example-service",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-09",
  "vars": {
    "STS_JWKS": {
      "keys": [
        {
          "kty": "EC",
          "crv": "P-256",
          "kid": "default",
          "x": "...",
          "y": "..."
        }
      ]
    }
  }
}
```

The `public` namespace above means the control plane may expose the route. The service route still requires a valid `ServicePlane` token when called directly.

`capabilityAuth(...)` only configures token verification for the app. Route authorization comes from `capability(...)` on each protected route, or from calling `verifyCapabilityToken(...)` with `requiredScopes` in a non-Hono entrypoint.

### Control Plane Worker

The control plane owns grants and signs short-lived tokens. It may also proxy public/auth routes and attach an STS token when the target route declares `requiredScopes`.

```ts
// apps/control-plane/src/index.ts
import { Hono } from 'hono';
import {
  cloudflareServiceBinding,
  createCapabilityIssuerFromJwks,
  createControlPlaneProxy,
  createServiceRegistry,
  defineServiceGrants,
  mountCapabilityEndpoints,
} from 'service-plane/control-plane';
import { exampleCapabilities } from '../../../packages/service-contracts/src/capabilities';
import type { CapabilityJwks } from 'service-plane/control-plane';

type Env = {
  EXAMPLE_SERVICE: Fetcher;
  STS_PRIVATE_KEY_JWK: string;
  STS_JWKS: CapabilityJwks;
};

const app = new Hono<{ Bindings: Env }>();

async function issuerFor(env: Env) {
  return createCapabilityIssuerFromJwks({
    capabilities: [exampleCapabilities],
    grants: defineServiceGrants({
      grants: [
        {
          caller: 'moco',
          target: 'example',
          scopes: ['example.sync.run'],
        },
        {
          caller: 'control-plane',
          target: 'example',
          scopes: ['example.events.ingest', 'example.sync.run'],
        },
      ],
    }),
    issuer: 'control-plane',
    keyId: 'default',
    privateJwk: JSON.parse(env.STS_PRIVATE_KEY_JWK),
    publicJwks: env.STS_JWKS,
  });
}

mountCapabilityEndpoints(
  app,
  (c) => issuerFor(c.env),
  {
    authenticateCaller: (c) => {
      const serviceId = c.req.header('x-service-id');
      if (!serviceId) return c.json({ error: 'Unauthorized' }, 401);
      return serviceId;
    },
  },
);

app.use('*', async (c, next) => {
  const registry = createServiceRegistry({
    services: [
      cloudflareServiceBinding({
        binding: c.env.EXAMPLE_SERVICE,
        id: 'example',
      }),
    ],
  });

  return createControlPlaneProxy({
    capabilityToken: async (_c, route) => {
      const issuer = await issuerFor(c.env);
      const issued = await issuer.issueCapabilityToken({
        callerServiceId: 'control-plane',
        scopes: route.requiredScopes ?? [],
        targetServiceId: route.serviceId,
      });
      return issued.token;
    },
    registry,
  })(c, next);
});

export default app;
```

Configure the control-plane Worker with:

```jsonc
// apps/control-plane/wrangler.jsonc
{
  "name": "control-plane",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-09",
  "secrets": {
    "required": ["STS_PRIVATE_KEY_JWK"]
  },
  "vars": {
    "STS_JWKS": {
      "keys": [
        {
          "kty": "EC",
          "crv": "P-256",
          "kid": "default",
          "x": "...",
          "y": "..."
        }
      ]
    }
  },
  "services": [
    {
      "binding": "EXAMPLE_SERVICE",
      "service": "example-service"
    }
  ]
}
```

Store the private signing key as a secret:

```sh
npx wrangler secret put STS_PRIVATE_KEY_JWK
```

For local development, put the same value in `apps/control-plane/.dev.vars`:

```txt
STS_PRIVATE_KEY_JWK='{"kty":"EC","crv":"P-256",...}'
```

`STS_JWKS` is not secret. It is the public verification key set published by the control plane and consumed by services. The JWKS entry with `kid: "default"` must match `STS_PRIVATE_KEY_JWK`; providing it explicitly keeps the private key non-extractable at runtime.

Run the control plane and service together:

```sh
npx wrangler dev -c apps/control-plane/wrangler.jsonc -c services/example-service/wrangler.jsonc
```

The first config is the primary local Worker exposed over HTTP. The second Worker is available to the primary Worker through the `EXAMPLE_SERVICE` binding.

For the small example above, `x-service-id` authenticates the caller to the token endpoint. Replace that with your real service-to-plane authentication before exposing the endpoint outside a trusted local or internal environment.

### Caller Service Client

Callers request a token for `caller + target + scopes` and use it for direct Hono RPC or Service Binding `fetch` calls.

```ts
// services/moco/src/example-client.ts
import { hc } from 'hono/client';
import { capabilityFetch } from 'service-plane/service';
import type { ExampleRoutes } from '../../example-service/src';

export const exampleClient = hc<ExampleRoutes>('https://example.internal', {
  fetch: capabilityFetch({
    callerServiceId: 'moco',
    targetServiceId: 'example',
    scopes: ['example.sync.run'],
    requestToken: async (input) => {
      const response = await fetch('https://control-plane.internal/.well-known/service-plane/capability-token', {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json', 'x-service-id': 'moco' },
        method: 'POST',
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as { expiresAt: string; token: string };
    },
  }),
});
```

Token caching is an optional performance optimization, not a correctness requirement. `capabilityFetch(...)` creates a token provider with a best-effort in-memory cache and refreshes shortly before expiry, so warm isolates do not need to hit the control plane. The default token TTL is 120 seconds. If the cache is empty, the caller requests a new token and continues.

Cloudflare can run requests in different isolates. For high-throughput services, add a shared cache adapter instead of adding a dedicated cache service:

```ts
import type {
  CapabilityTokenCache,
  CapabilityTokenCacheEntry,
  IssueCapabilityTokenInput,
} from 'service-plane/service';

function cloudflareCacheApiTokenCache(cache: Cache, origin: string): CapabilityTokenCache {
  const requestFor = (key: string) => new Request(`${origin}/__service-plane/token-cache/${encodeURIComponent(key)}`);

  return {
    async get(key) {
      const response = await cache.match(requestFor(key));
      if (!response) return undefined;
      return (await response.json()) as CapabilityTokenCacheEntry;
    },
    async set(key, value, ttlSeconds) {
      await cache.put(
        requestFor(key),
        new Response(JSON.stringify(value), {
          headers: {
            'cache-control': `max-age=${ttlSeconds}`,
            'content-type': 'application/json',
          },
        }),
      );
    },
  };
}

async function requestTokenFromControlPlane(input: IssueCapabilityTokenInput) {
  const response = await fetch('https://control-plane.internal/.well-known/service-plane/capability-token', {
    body: JSON.stringify(input),
    headers: { 'content-type': 'application/json', 'x-service-id': 'moco' },
    method: 'POST',
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as { expiresAt: string; token: string };
}

const fizzyFetch = capabilityFetch({
  cache: cloudflareCacheApiTokenCache(caches.default, 'https://moco.example.com'),
  callerServiceId: 'moco',
  targetServiceId: 'example',
  scopes: ['example.sync.run'],
  requestToken: requestTokenFromControlPlane,
});
```

## Route Visibility

Services expose Hono routers through explicit namespaces:

- `public`: control planes may proxy these routes without user auth. Use for webhooks and public ingest. The service still owns provider-specific validation.
- `auth`: control planes may proxy these routes after application-level auth.
- `internal`: control planes must not publicly proxy these routes. Use for service-to-service APIs.

Visibility is not inferred from the path. This avoids accidentally exposing internal APIs because a route happens to exist in a Hono app.

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
- [Service-To-Service Authorization](docs/service-to-service.md)
- [Capability Catalogs](docs/capability-catalogs.md)
- [Cloudflare Workers](docs/cloudflare-workers.md)
- [External Hono Services](docs/external-hono-service.md)
- [Security](docs/security.md)
- [Caching](docs/caching.md)
