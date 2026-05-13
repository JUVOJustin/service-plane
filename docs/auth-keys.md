# Auth Keys

`service-plane` uses one asymmetric ES256 key pair for STS capability tokens.

The private key signs tokens. It belongs only to the control plane. The public key verifies tokens. Services receive it through the control plane JWKS endpoint, not through config.

## Generate The Key

Run this once after installing `service-plane`:

```sh
node --input-type=module -e "import { generateCapabilitySigningSecret } from 'service-plane/control-plane'; console.log(await generateCapabilitySigningSecret())"
```

The output is one base64url string containing only the P-256 private scalar. Store that value as `STS_SIGNING_SECRET`. The library supplies the default issuer (`control-plane`), key id (`default`), algorithm (`ES256`), curve (`P-256`), and public JWKS shape.

## Cloudflare Workers

For a deployed Worker, set the secret on the control plane:

```sh
npx wrangler secret put STS_SIGNING_SECRET
```

For local development, put the same value in the control plane `.dev.vars` file:

```txt
STS_SIGNING_SECRET='nYb0v...43_base64url_chars'
```

Cloudflare supports `.dev.vars` or `.env` for local secrets. Use one format consistently. This project’s examples use `.dev.vars`.

Same-account Cloudflare Workers can request tokens through a private WorkerEntrypoint service binding instead of HMAC. In that setup, the caller does not need a service-client secret; the named RPC entrypoint fixes the caller service id before issuing the token.

## What Each Service Gets

Control plane:

- `STS_SIGNING_SECRET`
- HMAC service-client secrets for callers that may request tokens
- Service bindings or HTTPS URLs for the services it discovers
- Grant policy code on service registrations

Service Worker:

- A binding or URL to fetch the control plane JWKS
- Its own `defineCapabilities(...)` catalog
- No STS private key

Caller service:

- Its own HMAC service-client secret for authenticating to the control plane token endpoint
- `capabilityFetch(...)` or `createCapabilityTokenProvider(...)` to request and reuse short-lived tokens
- No STS private key

If a service had the private key, it could mint arbitrary tokens. Keeping the private key control-plane-only is what makes grants enforceable.

Generate HMAC service-client secrets separately from the STS signing secret:

```sh
node --input-type=module -e "import { generateServiceClientSecret } from 'service-plane/control-plane'; console.log('SERVICE_CLIENT_HMAC_SECRET=' + generateServiceClientSecret())"
```

The HMAC secret belongs in the caller service and the control plane. Use your platform secret manager for both copies.

Skip the HMAC secret for same-account Cloudflare RPC token issuance.
