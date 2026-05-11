# Security

`service-plane` makes a small set of explicit security trade-offs.

## ES256 JWS Capability Tokens

The control plane signs short-lived JWS tokens with ECDSA P-256 (`ES256`):

- 120-second default TTL. Configurable per issuer (`ttlSeconds`) and per request, clamped to the issuer max.
- Audience-bound (`aud = targetServiceId`). A token issued for one service cannot be replayed against another.
- Issuer-bound (`iss = controlPlaneServiceId`). Services must match `issuer` in their verifier.
- Scoped (`scp` claim) to the explicit operation set requested. The verifier and `requireScopes(...)` enforce scope membership at call time.
- `nbf` / `exp` enforced server-side.

Only the control plane holds the private signing key. Services hold only the public JWKS, fetched via `jwksFromServiceBinding(...)` (Cloudflare) or `jwksFromUrl(...)` (HTTPS) and cached for `DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS` (300s).

## Bootstrap Token Path

Cap'n Web carries the bootstrap token in-band on the `authenticate(token)` call rather than as an HTTP header. This:

- Keeps the token out of HTTP intermediary logs that strip Authorization for replay protection.
- Binds the token to the specific RPC session, not to a long-lived header that could be reused.
- Avoids the legacy `Authorization: ServicePlane <token>` cross-origin gotchas.

The HTTP-batch transport uses a single POST per batch, so the token still rides one request. WebSocket sessions perform `authenticate(token)` once at session start; subsequent pipelined calls inherit the bound identity from the scoped capability stub returned by `authenticate`.

## Identity Binding

`bindCapabilityIdentity(target, identity)` associates the verified `CapabilityIdentity` with the *specific scoped target instance* returned to the caller. Two safety properties follow:

1. The bound identity cannot be elevated by a method on the target — it is set once, before the target is exposed.
2. Different sessions get different target instances, so identities cannot leak across sessions even when the underlying class is shared.

`requireScopes(this, ...)` reads the bound identity from a `WeakMap` keyed by the target instance. Calling `requireScopes` on an un-bound target raises `CapabilityAuthError(401)`.

## Grant Manifest

Grants live in code under the control plane:

```ts
defineServiceGrants({
  grants: [
    { caller: 'moco', target: 'example', scopes: ['example.sync.run'] },
  ],
});
```

The issuer rejects token requests whose scopes are not granted. Grants are validated against the registered capability catalogs at issuer construction; a typo in a scope name fails at startup.

## Caller Authentication on the Token Endpoint

The control plane is responsible for authenticating the caller of `POST /.well-known/service-plane/capability-token`. The library does not bake in a particular scheme — `capabilityTokenHandler({ authenticateCaller })` accepts a function that returns the verified `callerServiceId` (or a `Response` to short-circuit). Typical implementations:

- A Cloudflare Service Binding header pinned by the platform.
- mTLS with a per-service client certificate.
- An HMAC over the request body using a per-service shared secret loaded via `defineSecrets({ ... })`.

Whatever the scheme, the body's `callerServiceId` (if present) must equal the authenticated id. The handler returns `403 Caller service mismatch` otherwise.

## Visibility

- `internal` capabilities are *only* exposed via the broker to callers registered as `kind: 'service'`. The broker refuses internal access for users.
- `auth` capabilities require an authenticated `BrokerCaller` of either kind. The broker propagates the caller id as token subject so the target service can attribute the call.
- `public` capabilities can be brokered without a caller. The control plane mints tokens with itself as caller; the target still verifies the token and enforces scopes.

These rules are enforced inside `BrokerRoot.public/auth/internal` and cannot be bypassed by passing a different `serviceId` — visibility is a property of the *capability id* the broker hands out, not of the target service.

## Replay & Revocation

Tokens are short-lived; revocation is handled by reducing the TTL and by removing grants in the control plane. There is no central allow/deny list — a deployed grant change takes effect on the next token issuance and propagates within one TTL. For instant revocation of a compromised caller, rotate the issuer key (`keyId` change) and republish the JWKS.
