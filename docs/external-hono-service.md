# External Hono Services

External services use the same Hono route and discovery model as Cloudflare Worker services.

## Service

Run a normal Hono app on Node.js, Bun, Deno, or another Fetch-compatible runtime. Expose the discovery document and protect internal routes with `machineAuth`.

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { defineNamespace, defineService, machineAuth, mountDiscovery } from 'service-plane/service';

const internal = new Hono().post(
  '/providers/example/v1/sync',
  machineAuth({
    resolveSecret: (keyId) => (keyId === 'default' ? process.env.SERVICE_PLANE_SECRET : undefined),
  }),
  (c) => c.json({ ok: true }),
);

const service = defineService({
  id: 'example',
  title: 'Example',
  version: '0.0.1',
  namespaces: [defineNamespace({ app: internal, prefix: '/', visibility: 'internal' })],
});

const app = new Hono().route('/', internal);
mountDiscovery(app, service);

serve(app);
```

## Control Plane

```ts
import { createServiceRegistry, httpsService } from 'service-plane/control-plane';

const registry = createServiceRegistry({
  services: [
    httpsService({
      id: 'example',
      baseUrl: 'https://example-service.internal',
    }),
  ],
});
```

External services should always verify HMAC signatures. Do not trust forwarded identity headers from public traffic unless the machine signature has already been verified.
