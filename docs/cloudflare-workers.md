# Cloudflare Workers

Cloudflare Workers are a first-class target for `service-plane`.

Use Cloudflare Service Bindings for Worker-to-Worker calls when both services live in the same Cloudflare account. The package uses the HTTP `fetch` side of Service Bindings so the same service contract can also run over public HTTPS for external services.

## Service Worker

```ts
import { Hono } from 'hono';
import { defineNamespace, defineService, mountDiscovery } from 'service-plane/service';

const routes = new Hono().post('/events/example/:target', (c) => c.text('ok'));

const service = defineService({
  id: 'example',
  title: 'Example',
  version: '0.0.1',
  namespaces: [defineNamespace({ app: routes, prefix: '/', visibility: 'public' })],
});

const app = new Hono().route('/', routes);
mountDiscovery(app, service);

export default app;
```

## Control Plane Worker

```ts
import { Hono } from 'hono';
import {
  cloudflareServiceBinding,
  createControlPlaneProxy,
  createServiceRegistry,
  signMachineRequest,
} from 'service-plane/control-plane';

type Env = {
  EXAMPLE_SERVICE: Fetcher;
  SERVICE_PLANE_SECRET: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const registry = createServiceRegistry({
    services: [cloudflareServiceBinding({ id: 'example', binding: c.env.EXAMPLE_SERVICE })],
  });

  return createControlPlaneProxy({
    registry,
    signer: (request) => signMachineRequest(request, { secret: c.env.SERVICE_PLANE_SECRET }),
  })(c, next);
});
```

## Notes

- Keep service secrets in Worker secrets, not source code or wrangler config.
- Run `wrangler types` after binding changes in your application.
- Service Bindings are private, but signing internal calls still gives one consistent contract for external Hono services.
