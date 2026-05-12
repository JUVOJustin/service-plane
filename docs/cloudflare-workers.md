# Cloudflare Workers

Cloudflare Workers are a first-class target for `service-plane`.

Use Cloudflare Service Bindings or [Worker RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) when Workers live in the same Cloudflare account. Cloudflare service bindings are the deployment-level trust boundary for Worker-to-plane and plane-to-Worker calls; STS tokens remain the application-level authorization mechanism for Worker-to-Worker calls.

Prefer Worker RPC for Cloudflare-native internal APIs. Use Hono `fetch` routes when you want the exact same contract to run over public HTTPS for external services.

## Service Worker

```ts
import { Hono } from 'hono';
import { capability, defineCapabilities, ServicePlaneService } from 'service-plane/service';

type Env = {
  CONTROL_PLANE: Fetcher;
};

const capabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [{ id: 'example.sync.run', title: 'Run example sync' }],
});

const routes = new Hono<{ Bindings: Env }>().post('/providers/example/v1/sync', capability('example.sync.run'), (c) => c.json({ ok: true }));

const service = new ServicePlaneService<{ Bindings: Env }>({
  auth: {
    controlPlaneBinding: (env) => env.CONTROL_PLANE,
  },
  capabilities,
  id: 'example',
  title: 'Example',
  version: '0.1.0',
  namespaces: [{ app: routes, visibility: 'internal' }],
});

export default service.app;
```

## Control Plane Worker

```ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  cloudflareServiceBinding,
  type ServiceDiscoveryDocument,
  type IssueCapabilityTokenForCallerInput,
  ServicePlaneControlPlane,
} from 'service-plane/control-plane';

type Env = {
  EXAMPLE_SERVICE: Fetcher;
  STS_SIGNING_SECRET: string;
};

const exampleServiceDiscovery = {
  capabilities: {
    serviceId: 'example',
    scopes: [{ id: 'example.sync.run', title: 'Run example sync' }],
  },
  id: 'example',
  routes: [{ method: 'POST', path: '/providers/example/v1/sync', requiredScopes: ['example.sync.run'], visibility: 'internal' }],
  title: 'Example',
  version: '0.1.0',
} satisfies ServiceDiscoveryDocument;

const controlPlane = new ServicePlaneControlPlane<{ Bindings: Env }>({
  proxy: false,
  services: (c) => [
    cloudflareServiceBinding({
      binding: c.env.EXAMPLE_SERVICE,
      discovery: exampleServiceDiscovery,
      grants: [{ caller: 'moco', scopes: ['example.sync.run'] }],
      id: 'example',
    }),
  ],
  signingSecret: (env) => env.STS_SIGNING_SECRET,
});

export class MocoTokens extends WorkerEntrypoint<Env> {
  async issueCapabilityToken(input: IssueCapabilityTokenForCallerInput) {
    return controlPlane.issueCapabilityTokenForCaller('moco', input, this.env);
  }
}

export default controlPlane.app;
```

This setup does not configure HMAC caller auth because token issuance happens through the private `MocoTokens` RPC entrypoint. If you expose the HTTP token endpoint to non-Cloudflare callers, configure `hmacServiceClientAuth(...)` for that endpoint.

The `discovery` property skips runtime service-discovery fetches. For same-account Cloudflare Workers, this is usually faster and simpler than asking each service for `/.well-known/service-plane/service.json` at startup. HTTPS services can omit `discovery` and keep dynamic discovery by URL.

## STS Key Setup

Only the control plane stores the private STS signing key. Services fetch the public JWKS from the control plane and do not need this secret.

```sh
node --input-type=module -e "import { generateCapabilitySigningSecret } from 'service-plane/control-plane'; console.log(await generateCapabilitySigningSecret())"
npx wrangler secret put STS_SIGNING_SECRET
```

For local development, place the same value in the control plane `.dev.vars` file:

```txt
STS_SIGNING_SECRET='nYb0v...43_base64url_chars'
```

## Request IDs

`ServicePlaneControlPlane` installs Hono's `requestId()` middleware with the default `X-Request-Id` header. A caller-provided ID is reused. If the control plane generates a new ID, proxying writes that value into `X-Request-Id` before forwarding to the service Worker.

`ServicePlaneService` only reads an incoming `X-Request-Id` for logs. Service Workers do not generate request IDs because public ingress is expected to enter through the control plane.

## Worker RPC Calls

Pass the capability token explicitly to Worker RPC methods:

```ts
export class ExampleEntrypoint extends WorkerEntrypoint<Env> {
  async sync(token: string, payload: SyncPayload) {
    const identity = await verifyCapabilityToken(token, {
      expectedAudience: 'example',
      issuer: 'control-plane',
      jwks: jwksFromServiceBinding(this.env.CONTROL_PLANE),
      requiredScopes: ['example.sync.run'],
    });

    return runSync(identity.serviceId, payload);
  }
}
```

For Hono RPC or Service Binding `fetch`, use `capabilityFetch({ callerServiceId, targetServiceId, scopes, requestToken })` so the token is sent as `Authorization: ServicePlane <token>`.

## Control Plane RPC Token Issuance

Cloudflare WorkerEntrypoint service bindings let one Worker call public methods on another Worker without a public URL. Cloudflare describes these RPC calls as direct method calls over service bindings, declared in `wrangler` config.

For private Cloudflare-only token issuance, avoid HTTP and HMAC overhead by exposing a WorkerEntrypoint method whose caller id is fixed by deployment code:

```ts
// control-plane/src/index.ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import { type IssueCapabilityTokenForCallerInput, ServicePlaneControlPlane } from 'service-plane/control-plane';

const controlPlane = new ServicePlaneControlPlane<{ Bindings: Env }>({
  // same services/signingSecret setup as the HTTP app
});

export class MocoTokenEntrypoint extends WorkerEntrypoint<Env> {
  async issueCapabilityToken(input: IssueCapabilityTokenForCallerInput) {
    return controlPlane.issueCapabilityTokenForCaller('moco', input, this.env);
  }
}
```

Bind the caller Worker to that named entrypoint:

```jsonc
{
  "services": [
    {
      "binding": "CONTROL_PLANE_TOKENS",
      "service": "control-plane",
      "entrypoint": "MocoTokenEntrypoint"
    }
  ]
}
```

Then the caller uses the RPC binding as its token requester:

```ts
import { capabilityFetch, controlPlaneRpcTokenRequester } from 'service-plane/service';

const fetchWithCapability = capabilityFetch({
  callerServiceId: 'moco',
  targetServiceId: 'example',
  scopes: ['example.sync.run'],
  requestToken: controlPlaneRpcTokenRequester(env.CONTROL_PLANE_TOKENS),
});
```

Do not expose one generic RPC method that trusts a caller-supplied `callerServiceId`. Use a named entrypoint, separate binding, or deployment-local method that fixes the caller id before issuing the token.

## Capability Token Cache

`capabilityFetch(...)` and `createCapabilityTokenProvider(...)` cache tokens in memory, but Cloudflare may run requests in different isolates. If that causes repeated STS calls, pass an adapter backed by Cache API:

```ts
import type { CapabilityTokenCache, CapabilityTokenCacheEntry } from 'service-plane/service';

function cloudflareCacheApiTokenCache(cache: Cache, origin: string): CapabilityTokenCache {
  const requestFor = (key: string) => new Request(`${origin}/__service-plane/token-cache/${encodeURIComponent(key)}`);

  return {
    async get(key) {
      const response = await cache.match(requestFor(key));
      if (!response) return undefined;
      return (await response.json()) as CapabilityTokenCacheEntry;
    },
    async set(key, value, ttlSeconds) {
      await cache.put(
        requestFor(key),
        new Response(JSON.stringify(value), {
          headers: {
            'cache-control': `max-age=${ttlSeconds}`,
            'content-type': 'application/json',
          },
        }),
      );
    },
  };
}
```

Then use it in the caller Worker:

```ts
import { capabilityFetch, controlPlaneRpcTokenRequester } from 'service-plane/service';

const fetchWithCapability = capabilityFetch({
  cache: cloudflareCacheApiTokenCache(caches.default, 'https://moco.example.com'),
  callerServiceId: 'moco',
  targetServiceId: 'example',
  scopes: ['example.sync.run'],
  requestToken: controlPlaneRpcTokenRequester(env.CONTROL_PLANE_TOKENS),
});
```

Cache API entries are local to the data center that wrote them. A miss is safe: the caller asks the control plane for a fresh short-lived token.

## Registry KV Cache

Minimal KV cache adapter:

```ts
import type { RegistryCache, ServiceDiscoverySnapshot } from 'service-plane/control-plane';

function kvRegistryCache(kv: KVNamespace): RegistryCache {
  return {
    async get(key) {
      const value = await kv.get(key, 'json');
      return value as ServiceDiscoverySnapshot | undefined;
    },
    async set(key, value, ttlSeconds) {
      await kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
    },
  };
}
```

## Control-Plane Proxying

Control-plane proxying can attach STS tokens for discovered routes that declare `requiredScopes`:

```ts
const registry = createServiceRegistry({
  cache: kvRegistryCache(c.env.SERVICE_REGISTRY_CACHE),
  services: [cloudflareServiceBinding({ id: 'example', binding: c.env.EXAMPLE_SERVICE })],
});

return createControlPlaneProxy({
  capabilityToken: async (_c, route) =>
    (
      await issuer.issueCapabilityToken({
        callerServiceId: 'control-plane',
        scopes: route.requiredScopes ?? [],
        targetServiceId: route.serviceId,
      })
    ).token,
  registry,
})(c, next);
```

## Notes

- Keep STS private keys in Worker secrets, not source code or wrangler config.
- Let the control plane publish JWKS via `mountCapabilityEndpoints(...)`; services normally consume it with `jwksFromServiceBinding(...)` or `jwksFromUrl(...)`.
- `createCapabilityIssuerFromSigningSecret(...)` derives the ES256 private JWK and public JWKS from `STS_SIGNING_SECRET` by default and validates that the derived key can verify issued tokens.
- Run `wrangler types` after binding changes in your application.
- Service Bindings are private, but STS tokens keep one authorization model across Worker RPC, Service Binding fetch, and external Hono HTTPS services.
