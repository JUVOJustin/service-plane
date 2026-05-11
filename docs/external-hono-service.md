# External Hono Services

External services use the same Hono route, discovery, and STS capability model as Cloudflare Worker services.

## Service

Run a normal Hono app on Node.js, Bun, Deno, or another Fetch-compatible runtime. Expose the discovery document and protect actual service routes with `capabilityAuth` plus route-level `capability(...)` annotations.

```ts
import { serve } from '@hono/node-server';
import { createFactory } from 'hono/factory';
import { capability, capabilityAuth, defineCapabilities, defineNamespace, defineService, jwksFromUrl, mountDiscovery } from 'service-plane/service';

const factory = createFactory();
const publicRoutes = factory.createApp().post('/events/example/:target', capability('example.events.ingest'), (c) => c.text('ok'));
const internalRoutes = factory.createApp().post('/providers/example/v1/sync', capability('example.sync.run'), (c) => c.json({ ok: true }));

const capabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [
    { id: 'example.events.ingest', title: 'Ingest example events' },
    { id: 'example.sync.run', title: 'Run example sync' },
  ],
});

const service = defineService(
  {
    capabilities,
    id: 'example',
    title: 'Example',
    version: '0.1.0',
    namespaces: [
      defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
      defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
    ],
  },
  { requireRouteScopes: true },
);

const app = factory.createApp();
mountDiscovery(app, service);
app.use(
  '*',
  capabilityAuth({
    expectedAudience: 'example',
    issuer: 'control-plane',
    jwks: jwksFromUrl('https://control-plane.example.com/.well-known/service-plane/jwks.json'),
  }),
);
app.route('/', publicRoutes);
app.route('/', internalRoutes);

serve(app);
```

## Control Plane

```ts
import { serve } from '@hono/node-server';
import { createFactory } from 'hono/factory';
import {
  createCapabilityIssuerFromPrivateJwk,
  defineServiceGrants,
  mountCapabilityEndpoints,
} from 'service-plane/control-plane';
import { defineCapabilities } from 'service-plane/service';

const exampleCapabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [
    { id: 'example.events.ingest', title: 'Ingest example events' },
    { id: 'example.sync.run', title: 'Run example sync' },
  ],
});

const factory = createFactory();
const controlPlane = factory.createApp();

mountCapabilityEndpoints(
  controlPlane,
  async () =>
    createCapabilityIssuerFromPrivateJwk({
      capabilities: [exampleCapabilities],
      grants: defineServiceGrants({
        grants: [
          { caller: 'control-plane', target: 'example', scopes: ['example.events.ingest'] },
          { caller: 'moco', target: 'example', scopes: ['example.sync.run'] },
        ],
      }),
      issuer: 'control-plane',
      keyId: 'default',
      privateJwk: await loadPrivateJwk(),
    }),
  {
    authenticateCaller: (c) => c.req.header('x-service-id') ?? c.json({ error: 'Unauthorized' }, 401),
  },
);

controlPlane.get('/health', (c) => c.json({ ok: true }));

serve({ fetch: controlPlane.fetch, port: 3000 });
```

Generate the signing key once and store it in the control plane secret system for your runtime:

```sh
node --input-type=module -e "import { generateCapabilitySigningJwk } from 'service-plane/control-plane'; console.log(JSON.stringify(await generateCapabilitySigningJwk({ keyId: 'default' })))"
```

`loadPrivateJwk()` should return that JSON value parsed as a JWK. Do not copy it into the service processes; services only need the public JWKS URL.

## Client

```ts
import { hc } from 'hono/client';
import { capabilityFetch } from 'service-plane/service';

const client = hc<ExampleRoutes>('https://example-service.internal', {
  fetch: capabilityFetch({
    callerServiceId: 'moco',
    targetServiceId: 'example',
    scopes: ['example.sync.run'],
    requestToken: async (input) => {
      const response = await fetch('https://control-plane.internal/.well-known/service-plane/capability-token', {
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json', 'x-service-id': 'moco' },
        method: 'POST',
      });
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as { expiresAt: string; token: string };
    },
  }),
});
```

External services should always verify STS capability tokens. Do not trust forwarded identity headers from public traffic unless the token has already been verified.

The `x-service-id` examples are placeholders for service-to-plane authentication. In production, authenticate the caller before issuing tokens, then use the authenticated service id as the token subject.
