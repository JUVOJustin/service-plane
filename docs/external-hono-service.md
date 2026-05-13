# External Hono Services

External services use the same Hono route, discovery, and STS capability model as Cloudflare Worker services.

## Service

Run a normal Hono app on Node.js, Bun, Deno, or another Fetch-compatible runtime. Expose the discovery document and protect actual service routes with `ServicePlaneService` plus route-level `capability(...)` annotations.

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { capability, defineCapabilities, jwksFromUrl, ServicePlaneService } from 'service-plane/service';

const publicRoutes = new Hono().post('/events/example/:target', capability('example.events.ingest'), (c) => c.text('ok'));
const internalRoutes = new Hono().post('/providers/example/v1/sync', capability('example.sync.run'), (c) => c.json({ ok: true }));

const capabilities = defineCapabilities({
  serviceId: 'example',
  scopes: [
    { id: 'example.events.ingest', title: 'Ingest example events' },
    { id: 'example.sync.run', title: 'Run example sync' },
  ],
});

const service = new ServicePlaneService({
  auth: {
    jwks: jwksFromUrl('https://control-plane.example.com/.well-known/service-plane/jwks.json'),
  },
  capabilities,
  id: 'example',
  title: 'Example',
  version: '0.1.0',
  namespaces: [
    { app: publicRoutes, visibility: 'public' },
    { app: internalRoutes, visibility: 'internal' },
  ],
});

serve(service.app);
```

## Control Plane

```ts
import { serve } from '@hono/node-server';
import { hmacServiceClientAuth, httpsService, ServicePlaneControlPlane } from 'service-plane/control-plane';

const mocoHmacSecret = requiredEnv('MOCO_HMAC_SECRET');

const controlPlane = new ServicePlaneControlPlane({
  authenticateCaller: hmacServiceClientAuth({
    clients: [{ clientId: 'moco', secret: mocoHmacSecret }],
  }),
  proxy: false,
  services: () => [
    httpsService({
      grants: [
        { caller: 'control-plane', scopes: ['example.events.ingest'] },
        { caller: 'moco', scopes: ['example.sync.run'] },
      ],
      baseUrl: 'https://example-service.internal',
      id: 'example',
    }),
  ],
  signingSecret: () => loadSigningSecret(),
});

controlPlane.app.get('/health', (c) => c.json({ ok: true }));

serve({ fetch: controlPlane.app.fetch, port: 3000 });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
```

Generate the signing key once and store it in the control plane secret system for your runtime:

```sh
node --input-type=module -e "import { generateCapabilitySigningSecret } from 'service-plane/control-plane'; console.log(await generateCapabilitySigningSecret())"
```

`loadSigningSecret()` should return that base64url value. Do not copy it into the service processes; services only need the public JWKS URL.

Generate one HMAC secret for each caller that may request tokens:

```sh
node --input-type=module -e "import { generateServiceClientSecret } from 'service-plane/control-plane'; console.log('MOCO_HMAC_SECRET=' + generateServiceClientSecret())"
```

Store the HMAC secret in the caller service and the control plane.

## Client

```ts
import { hc } from 'hono/client';
import { capabilityFetch, controlPlaneHmacTokenRequester } from 'service-plane/service';

const mocoHmacSecret = requiredEnv('MOCO_HMAC_SECRET');

const client = hc<ExampleRoutes>('https://example-service.internal', {
  fetch: capabilityFetch({
    callerServiceId: 'moco',
    targetServiceId: 'example',
    scopes: ['example.sync.run'],
    requestToken: controlPlaneHmacTokenRequester({
      clientId: 'moco',
      clientSecret: mocoHmacSecret,
      controlPlaneUrl: 'https://control-plane.internal',
    }),
  }),
});
```

External services should always verify STS capability tokens. Do not trust forwarded identity headers from public traffic unless the token has already been verified.
