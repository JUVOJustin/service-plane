# Cloudflare Workers

`service-plane` is built for Cloudflare Workers. Cap'n Web ships a Workers entrypoint, and this library uses it directly via `serveCapabilityRpc(...)`.

## Service Worker

```ts
// services/example/src/index.ts
import { defineSecrets, jwksFromServiceBinding, serveCapabilityRpc } from 'service-plane';
import { service } from './service'; // your defineService(...) result

const secrets = defineSecrets({});
type Env = typeof secrets.Bindings & { CONTROL_PLANE: Fetcher };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    secrets.validate(env);
    // Threading env into the factory: the simplest pattern is to attach it
    // to a per-request context. Two clean options:
    //   (a) pass `env` into the `factory` closure when you `defineService(...)`;
    //   (b) wrap `serveCapabilityRpc(service)` in a custom router that
    //       re-builds the service definition with closures that capture env.
    return serveCapabilityRpc(service)(request);
  },
};
```

Bind the control plane:

```jsonc
// wrangler.jsonc
{
  "name": "example-service",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-09",
  "services": [
    { "binding": "CONTROL_PLANE", "service": "control-plane" }
  ]
}
```

`jwksFromServiceBinding(env.CONTROL_PLANE)` fetches `https://service-plane-control-plane.internal/.well-known/service-plane/jwks.json` through the Service Binding (no public DNS, no extra auth). The response is cached in memory for `DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS` (300s).

## Control-Plane Worker

```ts
// apps/control-plane/src/index.ts
import {
  capabilityEndpointsHandler,
  cloudflareServiceBinding,
  createCapabilityIssuerFromJwks,
  createControlPlaneRpcBroker,
  defineSecrets,
  defineServiceGrants,
} from 'service-plane';
import { exampleCapabilities } from '../../packages/service-contracts/src/example';

const secrets = defineSecrets({ STS_PRIVATE_KEY_JWK: 'jwk' });
type Env = typeof secrets.Bindings & { EXAMPLE: Fetcher };

export default {
  async fetch(request: Request, env: Env) {
    const { STS_PRIVATE_KEY_JWK } = secrets.validate(env);
    const issuer = await createCapabilityIssuerFromJwks({
      capabilities: [exampleCapabilities],
      grants: defineServiceGrants({
        grants: [{ caller: 'moco', target: 'example', scopes: ['example.sync.run'] }],
      }),
      issuer: 'control-plane',
      keyId: 'default',
      privateJwk: STS_PRIVATE_KEY_JWK,
    });

    const httpEndpoints = capabilityEndpointsHandler(issuer, {
      authenticateCaller: (req) => req.headers.get('x-service-id') ?? Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const httpResponse = await httpEndpoints(request);
    if (httpResponse) return httpResponse;

    const broker = createControlPlaneRpcBroker({
      controlPlaneServiceId: 'control-plane',
      issuer,
      services: [{ endpoint: cloudflareServiceBinding({ binding: env.EXAMPLE, id: 'example' }) }],
    });
    // Expose `broker.rootCapability(caller)` via your preferred RPC entry
    // point. For service-to-service traffic, derive `caller` from the
    // verified Service Binding caller; for end-user `auth` traffic, derive
    // it from your session middleware.
    return new Response('OK');
  },
};
```

Set the signing key:

```sh
npx wrangler secret put STS_PRIVATE_KEY_JWK
```

The control plane never returns the raw private JWK to a service or caller — it is read on every request from the secret store via `secrets.validate(env)` and lives only in the issuer's closure.

## Local Development

For `wrangler dev`, mirror Worker secrets in `.dev.vars`:

```txt
STS_PRIVATE_KEY_JWK='{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}'
```

`secrets.validate(env)` works identically in dev and prod, so a missing or malformed value in `.dev.vars` produces the same descriptive 500 error you would see in production.

## Service Bindings + RPC

Cloudflare Service Bindings are HTTP-shaped. `cloudflareServiceBinding({ binding, id })` adapts them into a `ServiceRpcEndpoint` that the broker uses to open Cap'n Web HTTP-batch sessions. The broker's HTTP-batch transport sends the entire batch as one POST through the binding — there is no extra round trip vs. a plain HTTP call.

For long-lived browser-facing sessions, expose a public WebSocket route (`rpcTransports: ['websocket']`) and let Cap'n Web upgrade the request via `newWorkersWebSocketRpcResponse` (already wired in `serveCapabilityRpc`).
