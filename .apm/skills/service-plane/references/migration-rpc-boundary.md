# Migrate To The Stable Ability API

This release removes the public Cap'n Web surface and the temporary public oRPC surface. The wire
engine is now private. Typed methods, capabilities, discovery, OpenAPI, MCP, streaming, batching,
compression, and Cloudflare native RPC remain available through Service Plane APIs.

This guide covers only breaking changes. Use the [API reference](reference.md) for current options,
[transports](transports.md) for topology and performance choices, and [streaming](streaming.md) for
stream lifecycle and hibernation.

## Update Dependencies And Both Ends

```sh
npm remove capnweb @hono/capnweb @orpc/client @orpc/contract @orpc/server
npm install hono@^4.13.5
```

Hono `>=4.13.5 <5.0.0` and Node.js 22+ are now required. Node 20 reached end of life before this
release. Remove every application import from `capnweb`, `@hono/capnweb`, and `@orpc/*`; Service
Plane owns and pins its private RPC packages.

Deploy migrated clients and servers together. The private wire format is not a compatibility
contract with the previous release.

## Define Contracts And Handlers

Before (Cap'n Web):

```ts
const tasks = defineAbility({
  id: 'tasks',
  scopes: ['tasks.read'],
  methods: {
    get: abilityMethod({ input: GetTask, output: Task, scopes: ['tasks.read'] }),
  },
  handler: ({ context }) => new TasksTarget(context.env),
});

class TasksTarget extends RpcTarget {
  get(input) {
    return this.env.TASKS.get(input.id);
  }
}
```

After:

```ts
const ability = createAbilityBuilder<{ Bindings: Env }>();

export const tasksContract = defineAbility({
  id: 'tasks',
  scopes: ['tasks.read'],
  methods: {
    get: ability.method({ input: GetTask, output: Task, scopes: ['tasks.read'] }),
  },
});

export const tasks = implementAbility(tasksContract, {
  get: ({ context, input }) => context.env.TASKS.get(input.id),
});
```

`ServicePlaneService` receives the implementation; clients receive the contract. A service-local
contract may instead put `handler` directly inside `ability.method({ ... })`.

Rename methods called `then`, `toJSON`, or `__proto__`. These names are now reserved because Promise
and JSON machinery can invoke the first two implicitly, while an ordinary `__proto__` object literal
changes the method record's prototype instead of defining a callable own property.

Replace temporary `.procedure(...)` calls with `ability.method({ input, output, ... })`. Collapse
`ability.method({ scopes }).input(Input).output(Output).handler(handler)` into the single options
object `ability.method({ input: Input, output: Output, scopes, handler })`.

Remove `RpcTarget`, the ability-level handler factory, `bindCapabilityIdentity`,
`capabilityIdentity`, and `requireScopes`. Every handler now receives `{ context, input }`;
`context` contains the verified identity, runtime bindings, method name, idempotency key, and abort
signal. Declared scopes are enforced before handler creation.

Low-level engine extensions have owned replacements:

| Removed API | Migration path |
| --- | --- |
| `customRpcTransport`, `RpcTransport`, `CapabilityRpcTransport` | Use a built-in Fetch, WebSocket, or `service-binding` transport; inject `fetch` or `createWebSocket` for adapters |
| `createValidatingAbilityHandler`, `verifyAbilityAccess` | Mount `implementAbility(...)` in `ServicePlaneService`; the shell owns authorization and validation |
| `createControlPlaneRpcBroker` and broker types | Configure `ServicePlaneControlPlane({ broker: ... })`; use `createBrokeredAbilityClient` or `plane.abilityClient` |
| `memoryRpcTransportPair` | Use `memoryWebSocketPair()` or inject an in-process `fetch` |
| Raw procedures, routers, middleware, plugins, links, and framework errors | Use Service Plane contracts, wire options, middleware boundaries, and errors |

There is no raw-engine escape hatch.

## Replace Sessions And Transport Names

| Before | After |
| --- | --- |
| `abilitySession<AbilityRpc<T>>()` | `createAbilityClient({ ability: contract, ... })` |
| `httpBatchRpc(url)` | Fetch transport with `batch` when batching is still needed |
| `websocketRpc(url)` | `{ type: 'websocket', url }` |
| `cloudflareServiceBindingRpc(binding)` | `{ type: 'service-binding', binding }` |
| `cloudflareNativeRpc(binding)` | The same `service-binding` transport; unary selection is automatic |
| `disposeAbilitySession(session)` | `disposeAbilityClient(client)` for a long-lived WebSocket client |
| Discovery transport `http-batch` | `fetch` |
| Discovery transport `cloudflare-binding-rpc` | `service-binding` |

Client construction is synchronous and lazy. Required scopes come from the contract; `scopes`
adds only extra ability-level scopes. Public callers use `createBrokeredAbilityClient` and connect
only to the control plane.

`BrokeredAbilityTransport.headers` is Fetch-only. Authenticate a broker WebSocket's physical
upgrade with a secure cookie, short-lived URL ticket, or runtime-specific `createWebSocket`
closure. Request ID, idempotency key, timeout, and signal remain logical per-call options.

See [transports](transports.md) for complete client shapes and [streaming](streaming.md) for cleanup.

## Update Native Ability And Token Bindings

Replace Cap'n Web targets such as `connectAbility` with the service's unary entrypoint:

```ts
invokeAbility(input) {
  return service.invokeAbility(input, env);
}
```

Register it with `cloudflareServiceBinding({ abilityRpc: true })`. Unary calls use native RPC;
ordinary streams use the binding's Fetch method.

`invokeAbility(input, bindings)` and manual `webSocketMessage(..., bindings)` now require the
bindings argument when the service's typed environment requires bindings. This turns a previous
runtime failure from an empty synthetic environment into a compile-time error. Environment-neutral
services may still omit it.

The complete ability declaration graph is now readonly: method schemas, kind, metadata and nested
projection arrays; ability access, RPC, transports and scopes; service input and normalized
definitions; capability catalogs; and the structural discovery DTO collections. Service Plane snapshots and
freezes the live contract and normalized service graph, including caller JWKS, normalized
projections, and generated JSON Schema fragments projected into OpenAPI, while leaving
application-owned Standard Schema validator objects untouched. Code that programmatically extends
a definition must create a new object or array with spread syntax instead of mutating an existing
value. `serviceDiscoveryDocument()` returns fresh defensive payload copies—including caller keys
and schema fragments—so consumers may transform a document without changing the mounted service.
Scope-taking client, token and grant options accept readonly arrays, so values can pass directly
from a contract without a copy. These boundaries prevent mounted routes, authorization policy and
discovery from drifting apart and keep a broader environment view from injecting a handler that
needs unavailable bindings.

Low-level MCP shells now receive `ControlPlaneMcpInvocation` in `onInvocation`. Its `scopes` are a
readonly observation copy; replace in-place edits such as `scopes.sort()` with
`const sortedScopes = [...scopes].sort()`. Observer changes can no longer alter downstream token
issuance.

Generic helpers should no longer read `method['~types']['env']` directly. The phantom field now uses
a contravariant function shape; use the stable helper instead:

```ts
import type { AbilityMethodEnvironment } from 'service-plane/service';

type MethodEnv = AbilityMethodEnvironment<typeof tasksContract.methods.get>;
```

Native token bindings now pin caller identity in the deployed binding. Remove the requester-side
`callerServiceId`:

Before: `controlPlaneRpcTokenRequester({ binding, callerServiceId: 'workflow-service' })`.

After: `controlPlaneRpcTokenRequester({ binding })`, with the caller binding typed as
`ControlPlaneRpcTokenBinding` and backed by a dedicated entrypoint exposed only to that caller:

```ts
import type { PinnedCapabilityTokenInput } from 'service-plane/control-plane';

issueCapabilityToken(input: PinnedCapabilityTokenInput) {
  return plane
    .capabilityTokenBinding('workflow-service', this.env)
    .issueCapabilityToken(input);
}
```

`createAbilityClient` still declares its local `callerServiceId`; the native STS binding no longer
accepts or trusts it. The requester checks that the returned token is non-delegated, has service
access, and has a `sub` matching that local caller ID; a binding pinned to the wrong service fails
before the ability call. A shared native binding whose caller chooses an identity is not safe. See
the [Cloudflare binding example](cloudflare.md#direct-service-to-service-calls).

## Partition Sender-Constrained Token Caches

`controlPlaneJwkTokenRequester` now partitions cached tokens by the current public-key thumbprint
and rotates the partition when its key changes. No application change is needed when using that
requester.

For a custom proof-capable `CapabilityTokenRequester`, add a stable public discriminator through
`cacheBinding`. This prevents one key or replica from reusing a token bound to another:

```ts
const requestToken: CapabilityTokenRequester = async (input) => issueToken(input);
requestToken.proveTokenPossession = (input) => signProof(input, currentPrivateKey());
requestToken.cacheBinding = () => currentPublicKeyThumbprint();
```

Return a public fingerprint, never private key material. Update the value when the proof key
rotates. This partitions both the provider's in-memory entry and any supplied shared
`CapabilityTokenCache`.

## Update The Control Plane

Breaking route and configuration changes:

- top-level `rpc` becomes opt-in `broker`; service-side `rpc` remains;
- the broker defaults to `/rpc/broker` and `/rpc/broker/ws`;
- MCP is no longer implicit—add `mcp: {}` to mount `/mcp`;
- published REST routes remain enabled; `rest: false` removes the facade and catch-all;
- OpenAPI remains enabled by default;
- generated OpenAPI now defaults `info.version` to `1.0.0` instead of `0.2.0`, which also changes
  `controlPlaneOpenApiCacheKey`; set `openapi.version: '0.2.0'` to retain the previous document and
  cache identity;
- REST catch-all requests and enabled MCP/broker calls share `invocationMiddleware`, which must
  authenticate and set `servicePlaneCaller`; REST now authenticates before discovery, including
  route misses, while later application routes still bypass the catch-all;
- `broker.caller`, `mcp.caller`, and raw framework handler options are removed;
- replace log filters for `service_plane.broker.connect.completed|failed` with
  `service_plane.broker.call.completed|failed`. The new events describe each ability invocation,
  not the lifetime of a transport connection. The obsolete event names are removed from
  `ServicePlaneBrokerLogEvent`, so exhaustive TypeScript sinks fail visibly during migration
  instead of compiling while silently missing broker traffic.

Trusted plane code now calls `plane.abilityClient({ ability: contract, targetServiceId, ... }, env)`.
Remove manual API generics, `abilityId`, and required method scopes. Construction is synchronous;
the endpoint, grant, and issuer are resolved again on every call. See
[control-plane creation](plane-creation.md#trusted-in-process-calls).

## Replace Plugin Configuration

Raw batching, compression, and hibernation plugins are no longer public:

| Location | Stable replacement |
| --- | --- |
| Service | `rpc.batch`, `rpc.compression`, `rpc.maxRequestBodyBytes` |
| Control-plane broker | `broker.batch`, `broker.compression`, `broker.maxRequestBodyBytes` |
| Fetch client | `transport.batch`, `transport.compression` |

Batching combines concurrent unary calls on one Fetch hop only. Broker batches do not combine
downstream service calls. Streams and WebSockets are never batched. See [transports](transports.md).

## Update Streams And Hibernation

| Before | After |
| --- | --- |
| Raw iterator procedures or classes | `ability.stream(...)` with an async iterator, iterable, or `ReadableStream` handler source |
| Raw hibernation plugin/types | `ability.hibernationStream`, `AbilityHibernationStream`, and `encodeAbilityHibernationEvent` |
| `ReadableStream` client reader | Typed async iteration with `for await` |

Hibernating methods require a direct service WebSocket; batching, brokering, and
`plane.abilityClient` now fail fast. Follow the [streaming guide](streaming.md) for the stable setup.

Client-call `timeoutMs` is no longer discarded: invalid values reject, `0` is already expired, and
values above the package maximum clamp. Method metadata keeps a separate meaning:
`timeoutMs: 0` disables that method's service-side execution ceiling.

The budget now begins before client token, proof, or caller-header resolution; only the remaining
milliseconds are forwarded. Ordinary streams keep that local deadline across iterator pulls,
including streams returned by `plane.abilityClient`. Public control-plane middleware is inside the
same budget, and a late `next()` no longer starts background discovery or dispatch after a timeout.

Fetch request decoding is no longer unbounded before authorization. The service applies its
service-wide method default as a preparation ceiling, while the public broker applies a 10-second
ceiling even when a physical batch carries its deadlines only inside the unread body. A slower body
now receives status 504 and is cancelled. The service does so before capability authentication or
handler dispatch; the broker ceiling includes product-authentication middleware and stops before
service resolution or downstream ability dispatch.

## Update Errors And TanStack Callbacks

Catch `ServicePlaneClientError` or use `servicePlaneErrorInfo(error)` instead of inspecting
framework error data. Caller aborts now surface as `code: 'cancelled'`, status `499`, and
`retryable: false`; they are distinct from deadline timeouts.

TanStack needs no RPC adapter, but replace direct callbacks with wrappers such as
`mutationFn: (input) => tasks.create(input)` and `queryFn: () => tasks.get({ id: taskId })` so its
context is not interpreted as Service Plane call options.

## Account For Bounded Remote Responses

Remote metadata and credential responses now have explicit byte limits. A response that previously
loaded without a bound may now fail before JSON parsing:

| Response | Default | Override |
| --- | --- | --- |
| One service discovery document | 1 MiB | `ServicePlaneControlPlane.discoveryMaxResponseBytes` or `createServiceRegistry({ maxResponseBytes })` |
| JWKS from URL or service binding | 256 KiB | `jwksFromUrl(..., { maxResponseBytes })` or `jwksFromServiceBinding(..., { maxResponseBytes })` |
| HTTP capability-token response | 64 KiB | `controlPlaneHmacTokenRequester({ maxResponseBytes })` or `controlPlaneJwkTokenRequester({ maxResponseBytes })` |

Keep the defaults unless a known document requires more. These response limits are separate from
the token endpoint's `tokenMaxBodyBytes` request limit.

## Final Checks

- No application imports Cap'n Web or oRPC, Hono is `>=4.13.5`, and Node.js is 22+.
- Native STS bindings pin the caller; custom proof requesters partition caches with `cacheBinding`.
- The plane uses `broker` and `invocationMiddleware`; MCP is enabled explicitly when required.
- WebSocket auth moved to the upgrade, and stream/error/TanStack consumers use stable APIs.
- Response bounds are intentional, and both sides deploy together.
