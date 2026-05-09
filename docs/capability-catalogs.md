# Capability Catalogs

Capability catalogs are owned by the target service. They describe the operation-level scopes that callers may request, for example `fizzy.users.lookup`.

## Option 1: Shared Contracts Package

A shared package is useful in a monorepo or coordinated deployment setup:

```txt
packages/service-contracts/src/fizzy.ts
services/fizzy/src/index.ts
services/moco/src/fizzy-client.ts
apps/control-plane/src/grants.ts
```

```ts
// packages/service-contracts/src/fizzy.ts
import { defineCapabilities } from 'service-plane/service';

export const fizzyCapabilities = defineCapabilities({
  serviceId: 'fizzy',
  scopes: [
    { id: 'fizzy.users.lookup', title: 'Lookup Fizzy users' },
    { id: 'fizzy.users.update', title: 'Update Fizzy users' },
  ],
});
```

Use this when services and the control plane are released together, or when you want compile-time imports for Hono RPC route types.

Do not put runtime credentials, private keys, tenant configuration, or service URLs in the contracts package. Keep it to public contracts: capability catalogs, route types, request/response schemas, and shared Zod schemas.

## Option 2: Runtime Discovery

Independently deployed services can keep capabilities service-local:

```ts
export const service = defineService({
  capabilities: fizzyCapabilities,
  id: 'fizzy',
  namespaces,
  title: 'Fizzy',
  version: '0.1.0',
});
```

The control plane can then discover capabilities through `/.well-known/service-plane/service.json`. This avoids coupling external services to an npm package.

Use this when services can deploy independently, when third-party services are onboarded over HTTPS, or when the control plane should rely on live service discovery.

## Recommendation

Prefer a shared contracts package for first-party monorepos and Cloudflare Worker service bindings. Prefer runtime discovery for external Hono services or independently deployed teams.

Both patterns are compatible. A control plane can import first-party catalogs from a package and still discover external service catalogs at runtime.
