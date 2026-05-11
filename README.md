# service-plane

Opinionated [Cap'n Web](https://github.com/cloudflare/capnweb) primitives for service-oriented applications with a control-plane STS and independently owned RPC services.

`service-plane` is intentionally small. It does not replace Cap'n Web. It adds the missing parts around STS capability tokens, scope-gated `RpcTarget` methods, control-plane brokering, easy secrets, and service discovery.

## Why Cap'n Web

`service-plane` 0.2 dropped Hono RPC for Cap'n Web. The reasons:

- **Object-capability RPC** instead of HTTP routes. Auth is a method on a target object, not a header on a URL. The verified identity travels with the capability stub.
- **Promise pipelining**. `api.authenticate(token).sync.run()` is a single network round trip on HTTP-batch transport.
- **Bidirectional, transport-agnostic**. The same RPC works over HTTP-batch, WebSocket, MessagePort, or any custom `RpcTransport` (great for tests).
- **Cloudflare Workers native**. `newWorkersRpcResponse` and Service Bindings work out of the box.

## Install

```sh
npm install service-plane
```

The only required runtime dependency is `capnweb`. Cap'n Web ships its own runtime adapters; you do not need Hono, Express, or any HTTP framework. The two control-plane HTTP endpoints (token issuance and JWKS) are pure `Request → Response` handlers and slot into any runtime.

## Minimal App

The example below forms one real setup: one service Worker, one control-plane Worker, one caller. Layout:

```txt
apps/control-plane/src/index.ts
apps/control-plane/wrangler.jsonc
packages/service-contracts/src/example.ts
services/example/src/index.ts
services/example/wrangler.jsonc
services/moco/src/example-client.ts
```

### Shared Capability Catalog

```ts
// packages/service-contracts/src/example.ts
import { defineCapabilities } from 'service-plane/service';
import type { RpcTarget } from 'service-plane/service';

export const exampleCapabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [
    { id: 'example.sync.run', title: 'Run example sync' },
    { id: 'example.events.ingest', title: 'Ingest example events' },
  ],
});

// Shape of the scoped capability returned by `authenticate(token)`.
// Service authors export this as the public RPC contract.
export interface ExampleScopedApi extends RpcTarget {
  runSync(input: { since?: string }): Promise<{ ok: true }>;
  ingestEvent(input: { type: string; payload: unknown }): Promise<{ id: string }>;
}

export interface ExampleRoot {
  authenticate(token: string): ExampleScopedApi;
}
```

### Service Worker

A service exposes one or more `RpcTarget` capabilities, each tagged with a visibility (`public`, `auth`, or `internal`). The standard handshake is `authenticate(token)` — it verifies the STS token against the control-plane JWKS, binds the resulting identity to the scoped target, and returns it.

```ts
// services/example/src/index.ts
import {
  RpcTarget,
  bindCapabilityIdentity,
  defineSecrets,
  defineService,
  jwksFromServiceBinding,
  requireScopes,
  serveCapabilityRpc,
  verifyAuthenticationToken,
} from 'service-plane';
import { exampleCapabilities, type ExampleScopedApi } from '../../../packages/service-contracts/src/example';

const secrets = defineSecrets({});
type Env = typeof secrets.Bindings & { CONTROL_PLANE: Fetcher };

class Scoped extends RpcTarget implements ExampleScopedApi {
  async runSync(input: { since?: string }) {
    const me = requireScopes(this, 'example.sync.run');
    console.log(`sync requested by ${me.serviceId} (since ${input.since ?? 'now'})`);
    return { ok: true as const };
  }
  async ingestEvent(input: { type: string; payload: unknown }) {
    requireScopes(this, 'example.events.ingest');
    return { id: crypto.randomUUID() };
  }
}

class Public extends RpcTarget {
  constructor(private readonly env: Env) { super(); }
  async authenticate(token: string) {
    const identity = await verifyAuthenticationToken(token, {
      expectedAudience: 'example',
      issuer: 'control-plane',
      jwks: jwksFromServiceBinding(this.env.CONTROL_PLANE),
    });
    return bindCapabilityIdentity(new Scoped(), identity);
  }
}

const service = defineService(
  {
    capabilities: exampleCapabilities,
    exports: [
      {
        factory: ({}) => new Public((globalThis as { __env?: Env }).__env!),
        id: 'public',
        scopes: ['example.sync.run', 'example.events.ingest'],
        visibility: 'public',
      },
    ],
    id: 'example',
    rpcTransports: ['http-batch'],
    title: 'Example',
    version: '0.1.0',
  },
  { requireRouteScopes: true },
);

export default {
  fetch(request: Request, env: Env) {
    secrets.validate(env);
    (globalThis as { __env?: Env }).__env = env;
    return serveCapabilityRpc(service)(request);
  },
};
```

```jsonc
// services/example/wrangler.jsonc
{
  "name": "example-service",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-09",
  "services": [
    { "binding": "CONTROL_PLANE", "service": "control-plane" }
  ]
}
```

`jwksFromServiceBinding(...)` fetches the control plane public JWKS through a Cloudflare Service Binding and caches it in memory. For non-Cloudflare runtimes use `jwksFromUrl('https://control-plane.example.com/.well-known/service-plane/jwks.json')`.

### Control Plane Worker

The control plane signs short-lived ES256 capability tokens, publishes its JWKS, and (optionally) exposes an RPC broker that hands out authenticated stubs to each registered service.

```ts
// apps/control-plane/src/index.ts
import {
  capabilityEndpointsHandler,
  cloudflareServiceBinding,
  createCapabilityIssuerFromJwks,
  createControlPlaneRpcBroker,
  defineSecrets,
  defineServiceGrants,
  serveCapabilityRpc,
  RpcTarget,
} from 'service-plane';
import { exampleCapabilities } from '../../../packages/service-contracts/src/example';

const secrets = defineSecrets({
  STS_PRIVATE_KEY_JWK: 'jwk',
});
type Env = typeof secrets.Bindings & { EXAMPLE: Fetcher };

async function makeIssuer(env: Env) {
  return createCapabilityIssuerFromJwks({
    capabilities: [exampleCapabilities],
    grants: defineServiceGrants({
      grants: [
        { caller: 'moco', target: 'example', scopes: ['example.sync.run'] },
        { caller: 'control-plane', target: 'example', scopes: ['example.sync.run', 'example.events.ingest'] },
      ],
    }),
    issuer: 'control-plane',
    keyId: 'default',
    privateJwk: secrets.validate(env).STS_PRIVATE_KEY_JWK,
  });
}

export default {
  async fetch(request: Request, env: Env) {
    const issuer = await makeIssuer(env);

    // 1. HTTP endpoints: token issuance + JWKS publication.
    const endpoints = capabilityEndpointsHandler(issuer, {
      authenticateCaller: (req) => {
        const id = req.headers.get('x-service-id');
        if (!id) return Response.json({ error: 'Unauthorized' }, { status: 401 });
        return id;
      },
    });
    const endpointResponse = await endpoints(request);
    if (endpointResponse) return endpointResponse;

    // 2. Optional RPC broker for callers that prefer to talk to the
    //    control plane instead of the service directly.
    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [{ endpoint: cloudflareServiceBinding({ binding: env.EXAMPLE, id: 'example' }) }],
    });
    const brokerService = {
      capabilities: undefined,
      exports: [{ factory: () => broker.rootCapability(), id: 'broker', scopes: [], visibility: 'public' as const }],
      id: 'control-plane',
      rpcTransports: ['http-batch' as const],
      title: 'Control Plane',
      version: '0.1.0',
    };
    return serveCapabilityRpc(brokerService as unknown as Parameters<typeof serveCapabilityRpc>[0])(request);
  },
};
```

```jsonc
// apps/control-plane/wrangler.jsonc
{
  "name": "control-plane",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-09",
  "services": [
    { "binding": "EXAMPLE", "service": "example-service" }
  ]
}
```

Set the signing key as a secret:

```sh
npx wrangler secret put STS_PRIVATE_KEY_JWK
```

For local development put the same value in `apps/control-plane/.dev.vars`:

```txt
STS_PRIVATE_KEY_JWK='{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}'
```

`defineSecrets({...})` validates that every required secret is present and well-formed on the *first* request. Missing or malformed secrets produce a single, descriptive 500 error instead of an obscure crash deep in business logic.

### Caller Service Client

Callers ask the control plane for a token, then open a Cap'n Web session against the target service. `capabilityRpcSession` does both in one call and returns the authenticated stub.

```ts
// services/moco/src/example-client.ts
import { capabilityRpcSession } from 'service-plane';
import type { ExampleScopedApi } from '../../../packages/service-contracts/src/example';

export async function callExample() {
  const api = await capabilityRpcSession<ExampleScopedApi>({
    callerServiceId: 'moco',
    targetServiceId: 'example',
    scopes: ['example.sync.run'],
    transport: { kind: 'http-batch', url: 'https://example.internal/rpc/public' },
    requestToken: async (input) => {
      const response = await fetch('https://control-plane.internal/.well-known/service-plane/capability-token', {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json', 'x-service-id': 'moco' },
        method: 'POST',
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as { expiresAt: string; token: string };
    },
  });

  return api.runSync({ since: new Date().toISOString() });
}
```

`capabilityRpcSession` mints a token (using `createCapabilityTokenProvider` under the hood), opens an HTTP-batch session, calls `authenticate(token)` and returns the pipelined `ExampleScopedApi` stub. The bootstrap and the first user call ride the same network round trip.

For long-lived browser sessions or push-style flows, use `transport: { kind: 'websocket', url: 'wss://example.internal/rpc/public' }` instead.

For high-throughput Workers that want to share token issuance across isolates, pass a shared `CapabilityTokenCache` (Cache API, KV, Redis — anything that matches the small interface). See [docs/caching.md](docs/caching.md).

## Visibility

Services classify each exported capability:

- `public`: callers may obtain a brokered stub from the control plane without user authentication. Use for webhooks and public ingest. The service still verifies the STS token attached by the broker.
- `auth`: the broker may hand out a stub after application-level authentication of the end user.
- `internal`: only registered service callers may obtain a brokered stub. The broker refuses internal access for non-service callers.

Visibility is on the *capability*, not the path. A service may export the same `RpcTarget` class under two different ids if it wants different scopes per visibility.

## Secrets

`defineSecrets({...})` lets services declare every secret they need in one place:

```ts
const secrets = defineSecrets({
  STS_PRIVATE_KEY_JWK: 'jwk',
  WEBHOOK_SHARED_SECRET: 'string',
  OPTIONAL_FEATURE_FLAG: { kind: 'json', optional: true },
});
type Env = typeof secrets.Bindings; // { STS_PRIVATE_KEY_JWK: string; ... }
```

`secrets.validate(env)` returns the parsed values (JWK and JSON kinds are auto-parsed). Call it at the top of your `fetch(request, env)` to fail fast with a helpful error message that lists every missing or malformed secret. The `secrets.schema` is a plain object that future tooling (e.g. a `wrangler.jsonc` sync command) can inspect.

## Documentation

- [Architecture](docs/architecture.md)
- [Service-To-Service Authorization](docs/service-to-service.md)
- [Capability Catalogs](docs/capability-catalogs.md)
- [Cloudflare Workers](docs/cloudflare-workers.md)
- [External Services](docs/external-services.md)
- [Secrets](docs/secrets.md)
- [Security](docs/security.md)
- [Caching](docs/caching.md)
