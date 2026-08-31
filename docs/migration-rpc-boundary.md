# Migrate To The Engine-Neutral API

Goal: update code that used the former public oRPC surface to Service Plane-owned contracts.

This is an intentionally breaking change. Ability definitions, clients, errors, wire options, and
hibernation now belong to Service Plane. oRPC remains the current private Fetch/WebSocket engine,
but consumers neither import it nor configure its plugins.

## Ability Definitions

Before:

```ts
const tasks = defineAbility({
  id: 'tasks.items',
  scopes: ['tasks.read'],
  methods: {
    get: ability
      .procedure({ scopes: ['tasks.read'] })
      .input(z.object({ id: z.string() }))
      .output(z.object({ id: z.string() }))
      .handler(({ input }) => input),
  },
});
```

After:

```ts
const tasks = defineAbility({
  id: 'tasks.items',
  scopes: ['tasks.read'],
  methods: {
    get: ability
      .method({ scopes: ['tasks.read'] })
      .input(z.object({ id: z.string() }))
      .output(z.object({ id: z.string() }))
      .handler(({ input }) => input),
  },
});
```

The method still owns its schemas, metadata, policy, and handler. `.method()` states what the public
value is: a Service Plane method contract, not a framework procedure.

Renamed public types:

| Before | After |
| --- | --- |
| `AbilityProcedureContext` | `AbilityMethodContext` |
| `AbilityProcedureDefinitions` | `AbilityMethodDefinitions` |
| `OrpcServiceAbilityDefinition` | `ServiceAbilityDefinition` |
| `AbilityRpc<TAbility>` | `AbilityClient<TAbility>` |
| `NormalizedAbilityMethodDefinition.procedure` | `NormalizedAbilityMethodDefinition.method` |

The engine-facing `ControlPlaneBrokerProcedureInput` and
`ControlPlaneBrokerProcedureContext` exports were removed. Configure the broker through
`ServicePlaneControlPlaneOptions` or call the framework-neutral `ControlPlaneRpcBroker` instead.
The package also no longer re-exports `ORPCError`, `safe`, `isDefinedError`, engine plugin classes,
or engine option types.

## Client Errors

Before, callers caught an `ORPCError` and read `error.data.servicePlane`:

```ts
try {
  await tasksClient.get({ id: '' });
} catch (error) {
  if (error instanceof ORPCError) {
    console.log(error.data?.servicePlane?.status);
  }
}
```

After, every shipped ability client translates its transport error:

```ts
try {
  await tasksClient.get({ id: '' });
} catch (error) {
  if (error instanceof ServicePlaneClientError) {
    console.log(error.code, error.status, error.issues);
  }
}
```

`servicePlaneErrorInfo(error)` remains useful when the same branch also handles errors thrown inside
a service or control plane.

## Batch And Compression

Before:

```ts
new ServicePlaneService({
  // ...
  rpc: { plugins: [new BatchHandlerPlugin(), new ResponseCompressionHandlerPlugin()] },
});

createAbilityClient({
  // ...
  transport: {
    type: 'fetch',
    plugins: [new BatchLinkPlugin({ groups: [{ condition: true, context: {} }] })],
  },
});
```

After:

```ts
new ServicePlaneService({
  // ...
  rpc: { batch: { maxSize: 20 }, compression: true },
});

createAbilityClient({
  // ...
  transport: { type: 'fetch', batch: { maxSize: 20 }, compression: true },
});
```

The same stable server options are available on `ServicePlaneControlPlane.broker`. Arbitrary oRPC
plugins and custom client links are no longer accepted. Add HTTP-wide behavior through Hono
middleware; request a Service Plane option when a wire feature should become part of the supported
contract.

## Hibernation

Before, a service installed `HibernationHandlerPlugin` and returned
`HibernationAsyncIteratorClass`. After, define the hibernating method and return
`AbilityHibernationStream`:

```ts
const service = new ServicePlaneService({
  // ...
  rpc: { manualWebSocket: true },
});

const events = ability
  .hibernationStream(EventSchema, { scopes: ['events.read'] })
  .input(z.object({ channel: z.string() }))
  .handler(({ context }) =>
    new AbilityHibernationStream((id) => {
      context.webSocket?.serializeAttachment?.({ id });
    }),
  );
```

The private handler support is installed automatically. Continue emitting awakened values through
`encodeAbilityHibernationEvent()` so the output schema remains enforced.

## TanStack Query

The client is no longer advertised as an oRPC router, so `@orpc/tanstack-query` is not a supported
integration. Pass typed methods directly to TanStack Query:

```ts
useMutation({ mutationFn: tasksClient.create });
```

## What Did Not Change

- Ability ids, discovery documents, route defaults, and current Fetch/WebSocket wire behavior.
- Standard Schema validation and OpenAPI/MCP projections.
- Hono apps and middleware composition.
- Capability tokens, ingress, access, scopes, proof-of-possession, and auth-before-validation.
- Cloudflare native RPC for unary service-binding calls and binding Fetch for streams.
- Typed unary, streaming, brokered, and WebSocket clients.

The removed surface is framework control, not the product functionality above. Retry and
deduplication remain application policies: use method `idempotent` metadata, forwarded
`idempotencyKey`, and the retry/store implementation appropriate to the caller.
