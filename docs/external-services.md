# External (Non-Cloudflare) Services

The Cap'n Web RPC contract works over plain HTTPS, so a service hosted outside Cloudflare can join the same control plane.

## Service

Any runtime with `fetch`/`Request`/`Response` (Bun, Deno, Node 20+, Hono on any host) can serve `serveCapabilityRpc(service)`:

```ts
// node 20 example
import { createServer } from 'node:http';
import { serveCapabilityRpc } from 'service-plane';
import { service } from './service';

const handler = serveCapabilityRpc(service);
createServer(async (req, res) => {
  const url = `http://${req.headers.host}${req.url}`;
  const request = new Request(url, {
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await streamToBuffer(req),
    headers: req.headers as HeadersInit,
    method: req.method,
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}).listen(8080);
```

Hono / Bun / Deno users can mount the handler directly:

```ts
// hono example
import { Hono } from 'hono';
import { serveCapabilityRpc } from 'service-plane';

const app = new Hono();
const handler = serveCapabilityRpc(service);
app.all('*', (c) => handler(c.req.raw));
```

The handler responds on:

- `GET  /.well-known/service-plane/services.json` — discovery document
- `POST /rpc/<capabilityId>` — HTTP-batch RPC (default `rpcTransports`)
- `GET  /rpc/<capabilityId>` with `Upgrade: websocket` — WebSocket RPC (when enabled)

## JWKS

External services verify tokens against the control plane public JWKS. Use `jwksFromUrl(...)` instead of `jwksFromServiceBinding(...)`:

```ts
const verifier = {
  expectedAudience: 'example',
  issuer: 'control-plane',
  jwks: jwksFromUrl('https://control-plane.example.com/.well-known/service-plane/jwks.json'),
};
```

The resolver caches the JWKS in memory for `DEFAULT_CAPABILITY_JWKS_CACHE_TTL_SECONDS` (300s).

## Caller

Open a session against the external service the same way as for a Cloudflare service:

```ts
const api = await capabilityRpcSession<ExampleScopedApi>({
  callerServiceId: 'moco',
  targetServiceId: 'example',
  scopes: ['example.sync.run'],
  transport: { kind: 'http-batch', url: 'https://example.com/rpc/public' },
  requestToken: async (input) => fetchTokenFromControlPlane(input),
});
```

For services that need to call into a Cloudflare Service Binding from outside the Workers runtime, fall back to a public HTTPS endpoint. The contract is identical — only the URL changes.
