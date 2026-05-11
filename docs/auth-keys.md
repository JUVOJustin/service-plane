# Auth Keys

`service-plane` uses one asymmetric ES256 key pair for STS capability tokens.

The private key signs tokens. It belongs only to the control plane. The public key verifies tokens. Services receive it through the control plane JWKS endpoint, not through config.

## Generate The Key

Run this once after installing `service-plane`:

```sh
node --input-type=module -e "import { generateCapabilitySigningJwk } from 'service-plane/control-plane'; console.log(JSON.stringify(await generateCapabilitySigningJwk({ keyId: 'default' })))"
```

The output is one JSON object. Store the whole value as `STS_PRIVATE_KEY_JWK`.

## Cloudflare Workers

For a deployed Worker, set the secret on the control plane:

```sh
npx wrangler secret put STS_PRIVATE_KEY_JWK
```

For local development, put the same value in the control plane `.dev.vars` file:

```txt
STS_PRIVATE_KEY_JWK='{"kty":"EC","crv":"P-256",...}'
```

Cloudflare supports `.dev.vars` or `.env` for local secrets. Use one format consistently. This project’s examples use `.dev.vars`.

## What Each Service Gets

Control plane:

- `STS_PRIVATE_KEY_JWK`
- Service bindings or HTTPS URLs for the services it discovers
- Grant policy code via `defineServiceGrants(...)`

Service Worker:

- A binding or URL to fetch the control plane JWKS
- Its own `defineCapabilities(...)` catalog
- No STS private key

Caller service:

- A way to authenticate to the control plane token endpoint
- `capabilityFetch(...)` or `createCapabilityTokenProvider(...)` to request and reuse short-lived tokens
- No STS private key

If a service had the private key, it could mint arbitrary tokens. Keeping the private key control-plane-only is what makes grants enforceable.
