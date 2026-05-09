# Security

`service-plane` v0.0.1 uses HMAC-SHA-256 request signing for machine-to-machine calls.

## Why HMAC Instead Of Static Tokens

A static bearer token proves that the caller knows the secret, but the secret is sent with every request. If the header is logged or captured, it can be reused until rotation.

HMAC request signing proves that the caller knows the secret without sending it. The signature is bound to the method, path/query, timestamp, and body hash. Changing any of those values invalidates the request.

## Timestamp Window

Signed requests include `Service-Plane-Timestamp`. The verifier rejects requests outside `maxSkewSeconds`, which defaults to 300 seconds.

This is not strict one-time replay protection. A captured request can theoretically be replayed inside the timestamp window. It does prevent old captured requests from being reused later without adding Redis, D1, Workers KV, or a Durable Object dependency.

## Headers

```txt
Service-Plane-Key-Id: default
Service-Plane-Timestamp: 2026-05-09T12:00:00.000Z
Service-Plane-Body-Sha256: <base64url sha256>
Service-Plane-Signature: hmac-sha256=:<base64url hmac>
```

## Secret Rotation

Use `Service-Plane-Key-Id` to resolve the active secret:

```ts
machineAuth({
  resolveSecret: (keyId) => secrets[keyId],
});
```

Run both old and new keys during rotation, then remove the old key after all callers have switched.

## Future Strict Replay Protection

Strict one-time replay protection can be added with a storage callback later. Redis `SET NX EX`, a Durable Object, or a strongly consistent database are better choices than eventually consistent caches for this.
