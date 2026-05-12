# Capability Catalogs

Capability catalogs are owned by the target service. They describe the operation-level scopes that callers may request, for example `fizzy.users.lookup`.

## Default: Service-Local Catalog

Keep the catalog next to the service that owns the scopes:

```txt
services/fizzy/src/capabilities.ts
services/fizzy/src/index.ts
```

```ts
// services/fizzy/src/capabilities.ts
import { defineCapabilities } from 'service-plane/service';

export const fizzyCapabilities = defineCapabilities({
  serviceId: 'fizzy',
  scopes: [
    { id: 'fizzy.users.lookup', title: 'Lookup Fizzy users' },
    { id: 'fizzy.users.update', title: 'Update Fizzy users' },
  ],
});
```

```ts
const service = new ServicePlaneService({
  capabilities: fizzyCapabilities,
  id: 'fizzy',
  namespaces,
  title: 'Fizzy',
  version: '0.1.0',
});
```

The control plane can import this definition in a local demo, load the same data from deployment config, or discover it through `/.well-known/service-plane/service.json`. Discovery avoids coupling independently deployed services to an npm package.

If the service and control plane are wired by a private platform binding, you can skip runtime discovery and pass the discovery document directly:

```ts
const service = new ServicePlaneService({
  capabilities: fizzyCapabilities,
  id: 'fizzy',
  namespaces,
  title: 'Fizzy',
  version: '0.1.0',
});

cloudflareServiceBinding({
  binding: env.FIZZY_SERVICE,
  discovery: service.discovery,
  id: 'fizzy',
});
```

For independently deployed services, publish the same discovery JSON as a small generated artifact or config file and pass it as `discovery`. If you omit it, the registry falls back to fetching `/.well-known/service-plane/service.json`.

## Optional: Shared Contracts Package

A shared package can still be useful when services and the control plane are released together, or when you want compile-time imports for Hono RPC route types:

```txt
packages/service-contracts/src/fizzy.ts
services/fizzy/src/index.ts
services/moco/src/fizzy-client.ts
apps/control-plane/src/grants.ts
```

Do not put runtime credentials, private keys, tenant configuration, or service URLs in the contracts package. Keep it to public contracts: capability catalogs, route types, request/response schemas, and shared Zod schemas.

Use a shared package only when it matches the release topology. It is not the default assumption.

## Recommendation

Prefer service-local catalogs and runtime discovery for independently deployed teams and external Hono services. Use shared contracts only for tightly coordinated deployments.

Both patterns are compatible. A control plane can import first-party catalogs from a package and still discover external service catalogs at runtime.
