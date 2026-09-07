# Authentication And Authorization

Service Plane uses short-lived capability tokens between the control plane and services. Product
authentication remains application-owned.

## The Three Boundaries

1. **Product caller → control plane:** `invocationMiddleware` verifies a session, API key, OAuth
   token, or other application credential and sets `servicePlaneCaller`.
2. **Service caller → token endpoint:** `authenticateCaller` verifies a service binding, JWK
   assertion, or HMAC signature before issuing a capability token.
3. **Control plane → service:** the service verifies issuer, audience, signature, expiry, ingress,
   caller access, proof of possession, and method scopes before validating input.

The control plane alone signs tokens. Services receive only public JWKS. Never copy the signing
secret into services or callers.

The token endpoint first reads the physical request into an exact, bounded byte snapshot. It exposes
only that bounded request to `authenticateCaller`, then parses the same bytes before resolving the
catalog-backed issuer. Custom body-signature authenticators can therefore consume the request
without an unread cloned stream buffering beyond the STS limit. Oversized input never reaches
authentication; malformed or unauthorized input never starts issuer discovery or signing-key derivation. The
default body limit is one MiB; configure `tokenMaxBodyBytes` on `ServicePlaneControlPlane` or
`maxBodyBytes` on `mountCapabilityTokenEndpoint`.

## Configure Signing

Generate a secret once:

```sh
node --input-type=module -e "import { generateCapabilitySigningSecret } from 'service-plane/control-plane'; console.log(await generateCapabilitySigningSecret())"
```

Store it as a control-plane secret:

```ts
new ServicePlaneControlPlane({
  issuer: 'control-plane',
  signingKeys: (env) => [
    { kid: '2026-08', secret: env.STS_SIGNING_SECRET },
  ],
  // ...
});
```

`signingKeys[0]` signs new tokens; every listed key is published at
`/.well-known/service-plane/jwks.json`. Capability responses are non-cacheable bearer credentials.
Use TLS outside private runtime bindings and never place tokens in URLs, cookies, or logs.

## Rotate A Signing Key

Rotation takes three deployments:

1. Append the new key. The old key still signs; both are published.
2. After the overlap window, move the new key to index `0`. Both remain published.
3. After another overlap window, remove the old key.

```ts
// Prepare
[oldKey, newKey]

// Activate
[newKey, oldKey]

// Complete
[newKey]
```

The overlap must cover the maximum token lifetime, HTTP/CDN JWKS cache lifetime including
`stale-while-revalidate`, service JWKS cache lifetime, and clock skew. Never reuse a `kid` with new
key material. For emergency revocation, remove the compromised key immediately and purge every
JWKS cache; outstanding tokens signed by it will fail, by design.

## Authenticate Service Callers

Every caller accepted by `authenticateCaller` is service-class and may reach `access: 'service'`
abilities when grants permit. Do not connect end-user credentials to this endpoint.

For a same-account Cloudflare service binding, use the native requester:

```ts
const requestToken = controlPlaneRpcTokenRequester({
  binding: env.CONTROL_PLANE,
});
```

`CONTROL_PLANE` must be a per-service binding whose `issueCapabilityToken(input)` implementation
pins `workflow-service` on the plane. Native RPC arguments do not prove caller identity, so the
requester intentionally has no `callerServiceId` option. Type the caller's binding as
`ControlPlaneRpcTokenBinding`. The requester checks the trusted binding response's decoded claims:
the token must be non-delegated, service-class, and have a `sub` matching the
`createAbilityClient` caller ID. A miswired binding therefore fails before the service call.

```ts
import type { PinnedCapabilityTokenInput } from 'service-plane/control-plane';

issueCapabilityToken(input: PinnedCapabilityTokenInput) {
  return plane
    .capabilityTokenBinding('workflow-service', this.env)
    .issueCapabilityToken(input);
}
```

For an external service that can protect a private key, prefer JWK authentication:

```ts
// Caller
const requestToken = controlPlaneJwkTokenRequester({
  clientId: 'workflow-service',
  controlPlaneUrl: 'https://plane.example.com',
  keyId: 'workflow-2026-08',
  privateJwk,
});

// Plane
authenticateCaller: jwkServiceClientAuth({
  clients: [{ clientId: 'workflow-service', jwks: publicJwks }],
}),
```

With `services` instead of explicit `clients`, JWK authentication discovers only the configured
endpoint matching the caller ID. Unknown caller IDs and malformed assertion encodings or headers
trigger no discovery.
Selected keys are cached and concurrent lookups coalesced per authenticator for 30 seconds by
default (`registryCacheTtlSeconds`); allow this overlap when rotating caller keys. Discovery has a
10-second timeout and failed lookups retry after one second. Explicit `clients` still take precedence.

Use HMAC only when asymmetric keys are impractical:

```ts
// Caller
const requestToken = controlPlaneHmacTokenRequester({
  clientId: 'workflow-service',
  clientSecret: env.WORKFLOW_SECRET,
  controlPlaneUrl: 'https://plane.example.com',
});

// Plane
authenticateCaller: hmacServiceClientAuth({
  clients: [{ clientId: 'workflow-service', secret: env.WORKFLOW_SECRET }],
}),
```

JWK and HMAC signatures bind method, path, body, client ID, timestamp, and request ID. The short
freshness window limits replay without placing a shared nonce store on every token request. Tighten
`maxSkewSeconds` to match your clock discipline.

HTTP token responses are limited to 64 KiB by default; set requester `maxResponseBytes` when a
known response needs more. Remote JWKS responses are limited to 256 KiB; configure
`jwksFromUrl(..., { maxResponseBytes })` or `jwksFromServiceBinding(..., { maxResponseBytes })`.

## Create A Direct Service Client

```ts
const tasks = createAbilityClient({
  ability: tasksContract,
  callerServiceId: 'workflow-service',
  targetServiceId: 'tasks-service',
  requestToken,
  transport: {
    type: 'service-binding',
    binding: env.TASKS,
  },
});
```

The client derives required scopes from each contract method, caches tokens until the refresh
window, and sends per-call metadata. Add `scopes` only for ability-level scopes beyond the method's
minimum.

Services are ingress-protected by default and refuse ordinary direct tokens. Route calls through the control
plane broker, which mints a token containing a signed broker claim.

`ingress: false` explicitly permits direct capability holders. Hosting on Node, Bun, or Deno does
not require that opt-out; the default protected service works over HTTPS as well as bound Workers.

## Authenticate Product Invocations

REST, MCP, and the optional public broker share `invocationMiddleware`:

```ts
invocationMiddleware: async (c, next) => {
  const user = await verifyProductToken(c.req.header('authorization'));
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401, {
      'WWW-Authenticate': 'Bearer realm="service-plane"',
    });
  }

  c.set('servicePlaneCaller', {
    id: user.id,
    kind: 'user',
    orgId: user.orgId,
    principalKind: 'user',
  });
  await next();
},
```

For REST, authentication runs before catalog discovery, including requests that eventually miss
the generated REST routes. This prevents an unauthenticated wildcard request from triggering
service-wide discovery fan-out. After `next()`, `servicePlaneInvocation` is present only when a
published route matched; a later application route registered on the Hono app bypasses the REST
catch-all entirely.

For broker Fetch, `transport.headers` carries the application credential on each request. A broker
WebSocket instead authenticates the physical HTTP upgrade: use a secure browser cookie, a
short-lived URL ticket, or a runtime-specific `createWebSocket` closure whose implementation can
set upgrade headers. Logical calls over the accepted socket carry request metadata, not a second
set of transport-auth headers.

`BrokerCaller.kind` is security-sensitive:

| Value | Meaning | Can reach `access: 'service'` |
| --- | --- | --- |
| `service` | Middleware authenticated another service | Yes, when scopes and grants permit |
| `user` | Anything fronted by the plane: user, API key, automation, anonymous | No |

Use `principalKind` to distinguish `api-key`, `automation`, or `anonymous` without promoting that
principal to service access. Anonymous access is an explicit authenticated application decision,
never a fallback.

## Authorize Individual Methods

Authentication alone does not define product permissions. Without an `authorizeInvocation` hook,
authenticated product callers may reach plane-callable methods permitted by the control plane's
service grants. Those grants are service permissions, not per-user roles.

Use one policy across RPC, REST, MCP, and trusted `plane.abilityClient` calls:

```ts
authorizeInvocation: async (invocation, c) => {
  if (!invocation.caller) return false;
  return permissionStore(c.env).mayInvoke({
    caller: invocation.caller,
    serviceId: invocation.serviceId,
    abilityId: invocation.abilityId,
    method: invocation.method,
    scopes: invocation.scopes,
  });
},
```

When configured, only `true` allows a call. `false`, missing returns, and exceptions all deny with
403 before token signing or service dispatch. Every batch item is checked independently; a
WebSocket's authenticated caller is checked again for each logical call. Service grants and the
service's own ingress, access, and scope checks still apply.

The invocation and its caller/scopes are immutable snapshots. Scopes are the exact token scopes,
including requested extras. No unvalidated method input reaches this hook. Enforce tenant ownership,
resource access, and business rules in the service handler after schema validation. An absent caller
means a trusted plane-owned invocation; handle that case explicitly in your policy.

## Identity In A Handler

```ts
handler: ({ context, input }) => {
  audit({
    actorService: context.identity.serviceId,
    principal: context.identity.subject?.id,
    scopes: context.identity.scopes,
  });
  return updateTask(input);
},
```

`identity.serviceId` is the acting service. On a brokered product call, `identity.subject` contains
the delegated principal and optional organization/principal kind. `identity.callerAccess` is the
signed `plane` or `service` class. Method scopes have already been enforced; handlers add only
domain-specific checks such as ownership or tenant membership.

Do not place provider OAuth tokens or large application state in identity. Store credentials with
the owning service and route to them using validated IDs.

## Sender-Constrained Tokens

JWK-authenticated service callers automatically receive a token bound to the key that authenticated
them. The shipped requester carries the proof signer, so `createAbilityClient` sends a fresh proof
for each logical call without extra configuration. It also partitions in-memory and shared token
caches by public-key thumbprint, including across key rotation.

A custom proof-capable `CapabilityTokenRequester` must expose `cacheBinding` when its key can rotate
or callers with different keys share a `CapabilityTokenCache`. Return a stable public-key
fingerprint and update it with the proof key; never use private key material. Without that partition,
a replica can reuse a token constrained to another key and fail until the entry expires.

HMAC tokens remain bearer tokens because a shared secret has no distinct presenter key. Brokered
callers never receive the service token, and same-account service bindings already pin the calling
Worker at the platform boundary.

## Forwarded Connection Information

The plane terminates the public connection. If audit logs need the original connection, trusted
middleware may set it:

```ts
import { getConnInfo } from 'hono/cloudflare-workers';

invocationMiddleware: async (c, next) => {
  const caller = await authenticate(c);
  if (!caller) return c.json({ error: 'Unauthorized' }, 401);
  c.set('servicePlaneCaller', caller);
  c.set('servicePlaneConnInfo', getConnInfo(c));
  await next();
},
```

Handlers receive normalized data as `context.connInfo` only for brokered calls into an
ingress-protected service. It is request-scoped and advisory, not signed. Use it for observability,
never access control or per-client rate limiting; those decisions belong where the connection
terminates.

## Fail-Closed Checklist

- Keep the default broker-protected ingress on private services.
- Authenticate before setting `servicePlaneCaller`.
- Set `kind: 'service'` only for a proven service identity.
- Declare every ability and method scope; do not repeat scope checks in handlers.
- Keep signing keys only on the plane and verification JWKS on services.
- Treat capability tokens and application credentials as secrets.

See [the reference](reference.md) for token claims and errors.
