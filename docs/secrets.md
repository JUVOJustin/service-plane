# Secrets

`service-plane` ships a small `defineSecrets({...})` helper that gives you a typed `Bindings` shape, runtime validation that fails fast on missing or malformed secrets, and a single declarative spot for tooling to enumerate what a Worker requires.

## Defining

```ts
import { defineSecrets } from 'service-plane';

export const secrets = defineSecrets({
  STS_PRIVATE_KEY_JWK: 'jwk',
  SERVICE_AUTH_TOKEN: 'string',
  FEATURE_FLAGS: { kind: 'json', optional: true },
});
```

Supported kinds:

- `'string'` — any string secret. Returned verbatim.
- `'jwk'` — JSON-encoded JWK. Parsed and validated to be an object with a `kty` field.
- `'json'` — arbitrary JSON-encoded value. Parsed; not further validated.

Wrap in `{ kind: '...', optional: true }` to make a secret optional. Optional values that are absent return `undefined`.

## Typed Bindings

`secrets.Bindings` is a compile-time-only value (`undefined` at runtime) whose *type* is the typed Worker `Bindings` shape:

```ts
type Env = typeof secrets.Bindings & { CONTROL_PLANE: Fetcher };
// Env = {
//   STS_PRIVATE_KEY_JWK: string;
//   SERVICE_AUTH_TOKEN: string;
//   FEATURE_FLAGS: string | undefined;
//   CONTROL_PLANE: Fetcher;
// }
```

Use it as the `env` type on Cloudflare Workers fetch handlers, or as `Hono<{ Bindings: Env }>` if you mount Hono on top.

## Runtime Validation

Call `secrets.validate(env)` once per request entry point (or once at module load if your runtime caches modules). It returns the *parsed* secret values:

```ts
export default {
  fetch(request: Request, env: Env) {
    const { STS_PRIVATE_KEY_JWK, SERVICE_AUTH_TOKEN } = secrets.validate(env);
    // STS_PRIVATE_KEY_JWK is already typed as JsonWebKey
    // SERVICE_AUTH_TOKEN is typed as string
    // ...
  },
};
```

Missing or malformed secrets throw a single `ServicePlaneError(500)` whose message lists *every* problem found, e.g.:

```
Service-Plane secrets are not configured (missing required secrets: STS_PRIVATE_KEY_JWK; invalid secrets: FEATURE_FLAGS: expected JSON string, got malformed JSON)
```

This makes the first failed request after a bad deploy diagnose itself, instead of crashing deep in business logic.

## Local Development

Mirror Worker secrets in `.dev.vars`. Strings stay as plain strings, but `'jwk'` and `'json'` kinds must contain valid JSON:

```txt
STS_PRIVATE_KEY_JWK='{"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}'
SERVICE_AUTH_TOKEN=hunter2
```

## Tooling Hook

`secrets.schema` is a plain object whose keys are the secret names. You can iterate it to produce documentation, generate `wrangler.jsonc` snippets, or feed CI scripts that confirm every secret has been set:

```ts
for (const name of Object.keys(secrets.schema)) {
  console.log(`required secret: ${name}`);
}
```

A future `service-plane secrets sync` CLI is planned to write the secret list directly into `wrangler.jsonc`.
