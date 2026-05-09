# External Hono Services

External services use the same Hono route and discovery model as Cloudflare Worker services.

## Service

Run a normal Hono app on Node.js, Bun, Deno, or another Fetch-compatible runtime. Expose the discovery document and protect actual service routes with `machineAuth`, including routes marked `public`.

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { defineNamespace, defineService, machineAuth, mountDiscovery } from 'service-plane/service';

const publicRoutes = new Hono().post('/events/example/:target', (c) => c.text('ok'));
const internalRoutes = new Hono().post('/providers/example/v1/sync', (c) => c.json({ ok: true }));

const service = defineService({
  id: 'example',
  title: 'Example',
  version: '0.0.1',
  namespaces: [
    defineNamespace({ app: publicRoutes, prefix: '/', visibility: 'public' }),
    defineNamespace({ app: internalRoutes, prefix: '/', visibility: 'internal' }),
  ],
});

const app = new Hono();
mountDiscovery(app, service);
app.use(
  '*',
  machineAuth({
    resolveSecret: (keyId) => (keyId === 'default' ? process.env.SERVICE_PLANE_SECRET : undefined),
  }),
);
app.route('/', publicRoutes);
app.route('/', internalRoutes);

serve(app);
```

## Control Plane

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createControlPlaneProxy,
  createServiceRegistry,
  httpsService,
  signMachineRequest,
} from 'service-plane/control-plane';

const registry = createServiceRegistry({
  services: [
    httpsService({
      id: 'example',
      baseUrl: 'https://example-service.internal',
    }),
  ],
});

const controlPlane = new Hono();

controlPlane.use(
  '*',
  createControlPlaneProxy({
    registry,
    authorizeAuthRoute: (c) => {
      if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    },
    signer: (request) =>
      signMachineRequest(request, {
        secret: mustEnv('SERVICE_PLANE_SECRET'),
      }),
  }),
);

controlPlane.get('/health', (c) => c.json({ ok: true }));

serve({ fetch: controlPlane.fetch, port: 3000 });

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
```

External services should always verify HMAC signatures. Do not trust forwarded identity headers from public traffic unless the machine signature has already been verified.
