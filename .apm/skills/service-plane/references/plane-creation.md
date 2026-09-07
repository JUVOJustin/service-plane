# Create A Control Plane

The control plane discovers services, checks grants, issues short-lived capabilities, routes public
calls, and builds projections. It does not contain product-service handlers.

## Minimal Plane

```ts
import type { AbilityNativeBinding } from 'service-plane/service';
import {
  type FetchLike,
  ServicePlaneControlPlane,
  cloudflareServiceBinding,
  hmacServiceClientAuth,
} from 'service-plane/control-plane';

type ControlPlaneEnv = {
  Bindings: {
    STS_SIGNING_SECRET: string;
    TASKS: FetchLike & AbilityNativeBinding;
    WORKFLOW_SERVICE_SECRET: string;
  };
};

export default new ServicePlaneControlPlane<ControlPlaneEnv>({
  signingKeys: (env) => [{ kid: '2026-08', secret: env.STS_SIGNING_SECRET }],

  authenticateCaller: hmacServiceClientAuth<ControlPlaneEnv>({
    clients: (c) => [{
      clientId: 'workflow-service',
      secret: c.env.WORKFLOW_SERVICE_SECRET,
    }],
  }),

  services: (c) => [
    cloudflareServiceBinding({
      id: 'tasks-service',
      binding: c.env.TASKS,
      abilityRpc: true,
      grants: [
        { caller: 'workflow-service', scopes: ['tasks.read', 'tasks.write'] },
        { caller: 'control-plane', scopes: ['tasks.read'] },
      ],
    }),
  ],

  invocationMiddleware: async (c, next) => {
    const principal = await authenticateProductRequest(c.req.raw);
    if (!principal) return c.json({ error: 'Unauthorized' }, 401);
    c.set('servicePlaneCaller', { id: principal.id, kind: 'user' });
    await next();
  },

  broker: {},
  mcp: {},
});
```

The two authentication hooks serve different boundaries:

- `authenticateCaller` protects the capability-token endpoint for services requesting tokens.
- `invocationMiddleware` protects product-facing REST, MCP, and broker routes.

For per-user method permissions, add `authorizeInvocation(invocation, context)`. It covers RPC,
REST, MCP, and in-process clients before issuing a capability; only `true` permits the call when
configured. It complements service grants rather than replacing them. See [method authorization](auth.md#authorize-individual-methods).

The auth helpers carry the plane's Hono environment generic, so a resolver can read `c.env` while
the authenticator itself is constructed only once.

Do not infer either identity from an unverified header. Authenticate first, then set the typed
context value. Token request bodies are independently bounded to one MiB; set
`tokenMaxBodyBytes` when a different STS limit is required. Body-signing authenticators may consume
the request because Service Plane gives them an exact package-owned snapshot only after enforcing
that limit.

## Routes And Defaults

| Route | Default |
| --- | --- |
| `POST /.well-known/service-plane/capability-token` | On |
| `GET /.well-known/service-plane/jwks.json` | On |
| `GET /openapi.json` | On; disable with `openapi: false` |
| Published `rest.path` routes | On; `rest: false` removes the facade and catch-all |
| `/rpc/v1/broker` and `/rpc/v1/broker/ws` | Off; enable with `broker: {}` |
| `POST /mcp` | Off; enable with `mcp: {}` |

Only methods on `exposure: 'published'` abilities become REST/OpenAPI or MCP surfaces. Streaming
methods are not projected to REST.

## Configure Service Endpoints

Use a Cloudflare binding in the same account:

```ts
cloudflareServiceBinding({
  id: 'tasks-service',
  binding: c.env.TASKS,
  abilityRpc: true,
  grants,
});
```

`abilityRpc` is explicit because a Workers binding proxy cannot be feature-detected safely. Set it
to `true` when that same binding exposes `invokeAbility`, or pass a separate native RPC adapter.
Unary calls then use native RPC; streams use `binding.fetch`.

Use HTTPS for another runtime or account:

```ts
httpsService({
  id: 'search-service',
  baseUrl: 'https://search.internal.example',
  grants,
});
```

The logical endpoint set must not vary by user or tenant. Tenant-level data access belongs behind a
stable service contract, enforced from the delegated subject or validated input.

## Grants

A grant is an upper bound on scopes a caller may receive for one target service. Issuance fails if
the target, scope, or grant is unknown. The service checks the scopes again before its handler runs.

```ts
grants: [
  { caller: 'workflow-service', scopes: ['tasks.read'] },
  { caller: 'admin-service', scopes: ['tasks.read', 'tasks.write'] },
],
```

Direct service token requests use the authenticated service id as `caller`. Product-facing REST,
MCP, and broker calls use `controlPlaneServiceId` (default `control-plane`) as the downstream token
actor; the authenticated product user is preserved separately as the delegated subject. Grant the
plane for product traffic, not each end-user id.

`access: 'service'` adds a caller-class requirement; it does not replace scopes. Set
`kind: 'service'` only after authenticating a real service identity. Product users, API keys, and
anonymous sessions use `kind: 'user'` plus an application-owned `principalKind` when useful.

## Invocation Middleware

Middleware must either return its own `401`/`403`, or set `servicePlaneCaller` before `next()`.
Calling `next()` without it produces a configuration error instead of anonymous access.

```ts
invocationMiddleware: async (c, next) => {
  const caller = await authenticate(c.req.raw);
  if (!caller) return c.json({ error: 'Unauthorized' }, 401);

  c.set('servicePlaneCaller', { id: caller.id, kind: caller.kind });
  c.set('servicePlaneConnInfo', trustedConnInfo(c));
  await next();

  audit(c.get('servicePlaneInvocation'), c.res.status);
},
```

`servicePlaneConnInfo` is optional, trusted-middleware-owned, and advisory. It is forwarded only to
brokered, ingress-protected services. Never use it for authorization.

REST runs this middleware before catalog discovery, including requests that later return 404. That
keeps unauthenticated wildcard traffic from causing discovery fan-out. After `next()`,
`servicePlaneInvocation` identifies a matched REST or MCP operation for audit logs and is undefined
for a REST miss. A broker connection exposes only `surface: 'broker'` because one session can call
several methods. The request-entry deadline also bounds invocation middleware; if middleware calls
`next()` after that budget has expired, the plane refuses the continuation before parsing,
discovery, or dispatch begins.

For a broker WebSocket, this middleware authenticates the physical HTTP upgrade. Browser clients
can use a secure cookie or a short-lived URL ticket. A server runtime may provide a
`createWebSocket` closure whose WebSocket implementation sets upgrade headers. Per-call request ID,
idempotency key, and timeout travel as logical call metadata; `BrokeredAbilityTransport.headers`
applies only to Fetch.

## Discovery Cache

Discovery fans out to every configured service. A process-local 30-second cache is enabled by
default. Keep it unless you need immediate convergence or fleet-wide cache sharing.

```ts
new ServicePlaneControlPlane({
  discoveryCache: env.REGISTRY_CACHE,
  // ...
});
```

For different storage needs, split the hot call path from OpenAPI:

```ts
discoveryCache: {
  token: redisCache,
  openapi: kvCache,
},
```

`token` also covers broker and MCP calls. Separate stores warm separately. Stale discovery can
delay newly deployed metadata, but the target service's own checks prevent it from loosening
authorization.

Each remote discovery document is limited to one MiB by default. Set
`discoveryMaxResponseBytes` only when a known service document requires more.

## Trusted In-Process Calls

Control-plane code can create a typed, in-process ability client without entering the public
broker route:

```ts
const tasks = plane.abilityClient({
  ability: tasksContract,
  targetServiceId: 'tasks-service',
}, env);

await tasks.get(
  { id: 'task_123' },
  { requestId: 'request_123', idempotencyKey: 'attempt_123', timeoutMs: 2_000 },
);
```

The contract infers the method signatures and required method scopes. Optional `scopes` only adds
ability-level scopes. This is a trusted server-side helper, not a public authentication bypass.
Omitting `caller` uses the plane's own grant. An explicit service caller needs its own matching grant;
the configured `authorizeInvocation` policy also runs for in-process calls.
Construction performs no I/O. Every call resolves the current endpoint, grants, and issuer, then
repeats token, service authorization, and schema checks; the facade does not pin security state.
Hibernating methods fail before a downstream call because they require a direct service WebSocket.

Next: [authentication](auth.md), [OpenAPI and MCP](openapi-mcp.md), or
[transport selection](transports.md).
