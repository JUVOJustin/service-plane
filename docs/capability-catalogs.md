# Capability Catalogs

A capability catalog is the source of truth for the operation-level scopes a service exports. Catalogs are owned by the *target* service.

```ts
import { defineCapabilities } from 'service-plane';

export const exampleCapabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [
    { id: 'example.sync.run', title: 'Run example sync' },
    { id: 'example.events.ingest', title: 'Ingest example events' },
    { id: 'example.users.read', title: 'Read example users' },
  ],
});
```

The catalog is consumed in three places:

1. The control-plane issuer (`createCapabilityIssuer({ capabilities: [...] })`) uses it to validate that grant entries reference real scopes.
2. `defineService({ capabilities, exports: [{ scopes: [...] }] })` rejects any exported capability whose declared scopes are not in the catalog.
3. The discovery document (`/.well-known/service-plane/services.json`) embeds the catalog so tooling can reason about the service's surface.

## Naming

Use a stable `<serviceId>.<resource>.<action>` convention. Wildcards are not supported — denying `example.users.*` requires enumerating the exact scopes you want to revoke. This keeps grant validation straightforward and audit-friendly.

## Grants

Grants tell the issuer which callers may request which scopes against which targets. They live in the control plane:

```ts
defineServiceGrants({
  grants: [
    { caller: 'moco', target: 'example', scopes: ['example.sync.run'] },
    { caller: 'control-plane', target: 'example', scopes: ['example.sync.run', 'example.events.ingest'] },
  ],
});
```

A token request that asks for an un-granted scope returns `403 Service-Plane capability grant denied`.

## Per-Method Scopes

`requireScopes(this, 'example.sync.run')` runs *inside* the method. Different methods on the same `RpcTarget` may require different scopes. The `scopes` array passed to `defineService(..., exports: [{ scopes }])` is the *union* of scopes any method on that capability could need; it surfaces in discovery so the broker and grant tooling know what tokens to mint.

For a stricter contract, set `defineService(input, { requireRouteScopes: true })`. Any non-internal capability that does not declare scopes will throw at startup, catching accidentally-public surfaces.
