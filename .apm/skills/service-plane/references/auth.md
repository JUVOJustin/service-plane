# Auth

Goal: understand how callers are authenticated, how tokens are issued, and where authorization is enforced.

Service Plane uses three layers:

- Hono middleware handles HTTP policy: CORS, logging, request ids, rate limits, and deployment-specific sessions.
- `authenticate(token)` verifies a ServicePlane token inside Cap'n Web.
- The ability wrapper validates method input, checks scopes, calls the handler, and validates output.

## Token Flow

```mermaid
sequenceDiagram
  participant Caller
  participant Plane as Control Plane
  participant Service

  Caller->>Plane: Request token<br/>caller, targetServiceId, scopes
  Plane->>Plane: Authenticate caller and check grants
  Plane-->>Caller: ServicePlane token
  Caller->>Service: authenticate(token)
  Service->>Service: Verify token against JWKS
  Caller->>Service: ability method(input)
  Service->>Service: Validate input and scopes
```

Tokens are short-lived ES256 JWS tokens. The control plane signs them. Services verify them with the control-plane JWKS.

Treat an issued capability token as a bearer credential: use TLS outside private runtime bindings,
never put it in URLs, cookies, or logs, and honor the token endpoint's `Cache-Control: no-store` and
`Pragma: no-cache` response headers. These are the credential-handling principles from
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750), not a claim that Service Plane implements the
OAuth Bearer protocol.

## Generate The STS Signing Secret

Run once:

```sh
node --input-type=module -e "import { generateCapabilitySigningSecret } from 'service-plane/control-plane'; console.log(await generateCapabilitySigningSecret())"
```

Store the output as `STS_SIGNING_SECRET` on the control plane only. Services and callers must not receive this secret.

## Caller Authentication Options

Use the simplest option that matches the deployment boundary.

Cloudflare same-account callers should use private RPC token requests through a service binding:

```ts
controlPlaneRpcTokenRequester({
  binding: env.CONTROL_PLANE,
  callerServiceId: 'workflow-runner',
});
```

External callers that can hold a private key should use JWK caller auth:

```ts
controlPlaneJwkTokenRequester({
  clientId: 'workflow-runner',
  controlPlaneUrl: 'https://plane.example.com',
  keyId: 'workflow-runner-2026-01',
  privateJwk,
});
```

Use HMAC caller auth as a shared-secret fallback:

```ts
controlPlaneHmacTokenRequester({
  clientId: 'workflow-runner',
  controlPlaneUrl: 'https://plane.example.com',
  clientSecret: env.WORKFLOW_RUNNER_SECRET,
});
```

The built-in HTTP authenticators follow HTTP authentication grammar: scheme names are
case-insensitive, credentials must contain exactly one scheme and one value, and a `401` response
includes the corresponding `WWW-Authenticate` challenge. The JWK assertion remains a Service
Plane request-bound format rather than an OAuth client assertion.

## Context And Identity

`context` is runtime access. It includes the Hono context and environment bindings.

```ts
context.env.ASANA_CONNECTIONS
context.env.CONTROL_PLANE
```

`identity` is who the service is acting for.

```ts
{
  serviceId: 'workflow-runner',
  audience: 'asana',
  scopes: ['asana.tasks.write'],
  tokenId: 'cap_123',
  subject: { id: 'user-7', orgId: 'org-42' }, // only on delegated (user-brokered) calls
}
```

Keep identity small. It carries Service Plane caller and authorization claims, plus the delegated end-user subject on user-brokered calls. Any other product-level connection context is application-owned; pass it through validated method input if the service needs it. Store provider credentials in the service's own storage.

## Subject Delegation

When the control plane brokers a call for an authenticated end user, the token uses RFC 8693's `act` actor-claim semantics: `sub` carries the end user and `act.sub` names the acting service. The `spo` organization claim is Service Plane-specific. Services read the user as `identity.subject`, while `identity.serviceId` stays the acting service.

Service Plane does not expose the RFC 8693 token-exchange protocol. `/.well-known/service-plane/capability-token` is a package-specific JSON capability endpoint, and `scp`, `spo`, and `spb` are Service Plane-specific claims. The established claim names stay the same; only `act` borrows RFC 8693's delegation relationship.

The flow with an application identity provider such as Supabase:

```mermaid
sequenceDiagram
  participant App
  participant Plane as Control Plane
  participant Service

  App->>Plane: Request with Supabase JWT
  Plane->>Plane: Verify JWT, resolve user + org
  Plane->>Plane: Mint token: sub = user, act = plane, spo = org
  Plane->>Service: Brokered ability call
  Service->>Service: Verify token, read identity.subject
```

Return the resolved user from the broker (or MCP) caller resolver:

```ts
const plane = new ServicePlaneControlPlane({
  broker: {
    caller: async (context) => {
      const user = await verifySupabaseJwt(context); // application-owned verification
      if (!user) {
        return context.json({ error: 'Unauthorized' }, 401, {
          'WWW-Authenticate': 'Bearer realm="service-plane"',
        });
      }
      return { id: user.id, kind: 'user', orgId: user.orgId };
    },
  },
  // ...
});
```

Every capability token brokered for that caller then carries `sub: 'user-7'`, `act: { sub: 'control-plane' }`, and `spo: 'org-42'`, and handlers see the user on the verified identity:

```ts
async createTask(input: CreateTaskInput) {
  const identity = requireScopes(this, 'asana.tasks.write');
  if (identity.subject) audit.log({ userId: identity.subject.id, orgId: identity.subject.orgId });
}
```

Boundaries to keep in mind:

- The subject is delegation the control plane vouches for. It rides the same issuer/JWKS trust chain as every other claim, so services may rely on it for auditing and per-user decisions.
- The subject does not replace scope or grant checks. Ability authorization stays with scopes, grants, and ingress. Tenancy authorization stays with the service that owns the data.
- Only control-plane code asserts subjects: the broker caller resolver or direct `issueCapabilityToken({ subject, ... })` calls. The HTTP token endpoint rejects caller-supplied `subject` fields, and the shipped token requesters (`controlPlaneHmacTokenRequester`, `controlPlaneJwkTokenRequester`, `controlPlaneRpcTokenRequester`) refuse to send one, so an authenticated service cannot claim it acts for an arbitrary user. The `subject` option on `createCapabilityTokenProvider` therefore only works with a `requestToken` that calls the issuer in-process.
- Direct `issueCapabilityToken({ subject, ... })` mints a non-brokered token. For a target with `ingress` required, delegate through the broker instead — it selects `issueBrokeredCapabilityToken` automatically; a directly issued token is rejected by the ingress check.
- Tokens delegated to a subject are cached per subject. `capabilityTokenCacheKey` includes the subject, so a token minted for one user is never served for another.

## Forwarded Connection Info

The plane terminates the client connection; the service only ever sees the plane. A service can therefore learn where a call came from only if the plane forwards it — and forwarding is opt-in, because it is an unsigned assertion.

Wire the resolver on the broker and MCP mounts. `getConnInfo` is runtime-specific in Hono, so the application supplies the right one:

```ts
import { getConnInfo } from 'hono/cloudflare-workers'; // or 'hono/deno', '@hono/node-server/conninfo', ...

new ServicePlaneControlPlane({
  broker: { caller: resolveCaller, connInfo: (c) => getConnInfo(c) },
  mcp: { caller: resolveCaller, connInfo: (c) => getConnInfo(c) },
  // ...
});
```

The plane then forwards it on every outbound call, exactly where it forwards the request id: the `X-Service-Plane-Conn-Info` header for HTTP-batch and service-binding transports, the `conn_info` query parameter for WebSocket, and the `connInfo` field on `connectAbility(...)` for native binding RPC.

Services receive it as `connInfo` on the ability handler factory input:

```ts
handler: ({ connInfo, identity }) => new TasksHandler(identity, connInfo?.remote.address),
```

Rules the package enforces:

- **Ingress is required.** Handlers see `connInfo` only when the service is configured with `ingress` **and** the token is brokered (`brokerServiceId` is a signed claim only the control plane can mint). Without ingress the service has no proof its peer is the plane, so a forwarded value would be indistinguishable from one a direct caller invented — it is dropped.
- **The shape is validated on both ends.** Only Hono's `ConnInfo` fields survive, with a bounded address charset, a port in range, and the `tcp`/`udp` and `IPv4`/`IPv6` enumerations. Anything else is dropped rather than passed through.
- **It is not in the token.** Connection info is request-scoped while capability tokens are cached and reused; putting an address in a claim would partition the token cache per client and write client PII into it.

Treat it as advisory, for audit records and logs. It is not signature-verified, so it must never gate access — authorization stays with scopes, grants, and ingress. Per-client rate limiting belongs at the plane, which is where the connection actually terminates.

## Scope Checks

Method scopes are enforced automatically by the generated ability wrapper.

```ts
abilityMethod({
  input: CreateTaskInput,
  output: CreateTaskOutput,
  scopes: ['asana.tasks.write'],
});
```

Handlers may still call `requireScopes(...)` when they need the identity object inside custom logic.

```ts
import { requireScopes } from 'service-plane/service';

async createTask(input: CreateTaskInput) {
  const identity = requireScopes(this, 'asana.tasks.write');
  // use identity.serviceId or identity.scopes for Service Plane decisions
}
```

Next: [create a service](service-creation.md), [create a control plane](plane-creation.md), and [reference](reference.md).
