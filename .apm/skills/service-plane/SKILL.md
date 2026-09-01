---
name: service-plane
description: >-
  Activate when building, reviewing, or debugging the service-plane TypeScript
  library: abilities, typed clients, capability tokens, service discovery,
  control-plane brokering, REST/OpenAPI/MCP projections, Cloudflare bindings,
  or Fetch/WebSocket transports.
---

# Service Plane

Service Plane is an ability-first TypeScript library. One Standard Schema contract drives runtime
validation, typed clients, discovery, REST/OpenAPI, and MCP.

## Boundaries

| Role | Owns | Import |
| --- | --- | --- |
| Service | Contracts, handlers, token/scope enforcement | `service-plane/service` |
| Control plane | Discovery, grants, token issuance, routing, projections | `service-plane/control-plane` |
| Caller | Authentication, typed invocation, per-call metadata | `service-plane/service` |

Hono is the HTTP shell. Fetch/WebSocket serialization uses a private engine; never import or expose
its procedures, plugins, clients, or errors. Cloudflare native RPC is the unary service-binding fast
path, with binding Fetch for streams.

## Preferred Ability Shape

```ts
const ability = createAbilityBuilder<{ Bindings: Env }>();

export const contract = defineAbility({
  id: 'tasks',
  scopes: ['tasks.read'],
  methods: {
    get: ability.method({ input: GetTask, output: Task, scopes: ['tasks.read'] }),
    watch: ability.stream({ input: Watch, output: Event, scopes: ['tasks.read'] }),
  },
});

export const implementation = implementAbility(contract, {
  get: ({ context, input }) => context.env.TASKS.get(input.id),
  watch: async function* ({ context, input }) { /* yield validated items */ },
});
```

Clients import `contract`; `ServicePlaneService` receives `implementation`. An inline `handler` in
the method options is fine when the contract is service-local. Every method uses a single options
object; omit `handler` for a portable contract.

Schemas must implement both Standard Schema validation and Standard JSON Schema. Use the consumer's
existing schema library; never add one to Service Plane itself.

## Security Rules

- The control plane alone signs capabilities; services verify issuer, audience, expiry, signature,
  ingress, access, proof, and method scopes before input validation.
- Enable `ingress: {}` when only the broker may reach a service.
- `exposure` controls projection; `access` controls caller class; `scopes` control capability
  authorization. Do not substitute one for another.
- `access: 'service'` means an authenticated service caller, not an end user.
- Product REST/MCP/broker auth belongs in `invocationMiddleware`. It must authenticate and set
  `servicePlaneCaller`, or return its own refusal before `next()`.
- `BrokeredAbilityTransport.headers` authenticates Fetch only. Authenticate a broker WebSocket's
  physical HTTP upgrade with a browser cookie, short-lived URL ticket, or runtime-owned
  `createWebSocket` closure that sets headers.
- Set caller `kind: 'service'` only for a proven service. Users, API keys, automation, and anonymous
  sessions are `kind: 'user'`; use `principalKind` for their application category.
- Never authorize from `connInfo` or an unverified header. Forwarded connection data is advisory.
- Never put provider credentials in capability identity or workflow metadata. Keep them in
  service-owned storage and route with validated IDs.
- Never weaken validation, grants, scope checks, replay bounds, or ingress to make tests pass.

Handlers receive authorized `context.identity` and validated `input`; declared scopes need no
second manual check. Arbitrary handler errors are opaque to callers. Use `AbilityHandlerError` only
for an intentional, caller-safe message.

## Runtime Choices

- Same-account/bound Workers, unary: service-binding native RPC.
- Bound Worker stream or cross-runtime call: Fetch.
- Long-lived interactive stream: WebSocket.
- Sleeping Durable Object subscription: direct hibernating WebSocket.
- Public browser/headless caller: broker, REST, or MCP through the control plane.

Batching combines only concurrent unary calls on one Fetch hop. For broker clients it reduces only
caller-to-plane round trips; downstream calls remain individual. Streams and WebSockets are never
batched. Hibernation requires a direct service WebSocket/Durable Object; broker and in-process
ability clients fail fast.

`plane.abilityClient({ ability, targetServiceId, caller?, scopes? }, bindings)` infers methods and
required scopes from the contract. Extra `scopes` are additive. Endpoint, grants, and issuer resolve
per call; method calls may override request ID, idempotency key, and timeout.

Defined `timeoutMs` values fail on invalid input, expire immediately at `0`, and clamp above the
maximum. Caller aborts surface as `ServicePlaneClientError` with `code: 'cancelled'`, status 499,
and `retryable: false`. `rest: false` disables the control-plane REST facade and catch-all only.

## References

Load only the document needed for the task:

- Model and ownership: `references/architecture.md`
- Define and implement abilities: `references/service-creation.md`
- Configure the plane, grants, and caches: `references/plane-creation.md`
- Auth, delegation, keys, ingress: `references/auth.md`
- Streams and hibernation: `references/streaming.md`
- Transport and performance choices: `references/transports.md`
- REST, OpenAPI, MCP: `references/openapi-mcp.md`
- Cloudflare or Node deployment: `references/cloudflare.md`, `references/nodejs.md`
- Exact API/default lookup: `references/reference.md`
- Breaking migration: `references/migration-rpc-boundary.md`

Inside the Service Plane repository, edit `docs/`, never `references/`, then run
`npm run sync:skill-docs`.

## Verification

```sh
npm run check
npm run typecheck
npm run test
npm run build
```

## Releases

Releases are repository-owned. Update `package.json` and `package-lock.json` to the intended version
in a reviewed release PR, then create a GitHub release with the matching SemVer `v*` tag. The
release workflow verifies that the tag and committed package version agree, reruns the complete
package verification, and publishes stable versions to npm `latest` or prereleases to `next` with
provenance. Never publish from a standalone local tag.
