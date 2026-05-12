# Security

`service-plane` v0.1.0 uses STS capability tokens for direct service-to-service calls.

## STS Capability Tokens

The control plane signs short-lived ES256 JWS tokens. Services verify those tokens with the control plane public key and then enforce `aud`, `iss`, `exp`, and route-required scopes.

The private signing key stays in the control plane. Services fetch the public JWKS from the control plane through a Service Binding or HTTPS and cache it locally.

```json
{
  "iss": "control-plane",
  "sub": "moco",
  "aud": "fizzy",
  "scp": ["fizzy.users.lookup"],
  "exp": 1778337900
}
```

Route scopes are target-owned operation names. The control plane only issues tokens for caller, target, and scope combinations listed in its grant manifest.

Do not protect service-to-service APIs with a shared mesh secret. If every service knows the same secret and target services accept it as authorization, any service can bypass STS grants. Use STS tokens for peer calls and keep service-to-plane authentication separate.

## Service-To-Plane Authentication

The token endpoint must authenticate the caller before issuing a token. The high-level control plane fails closed if caller authentication is not configured.

For distributed HTTP deployments, `hmacServiceClientAuth(...)` verifies a request signature and returns the matched service id. The signature covers method, path, body hash, timestamp, client id, and request id. A service id header is request metadata at best; it is not authentication.

By default, HMAC requests are limited by timestamp skew. Pass `replayCache` to reject repeated signatures or request ids inside the skew window when your runtime has a suitable short-lived cache.

`serviceClientCredentialsAuth(...)` is also available for simpler bearer-secret deployments where hash-only storage in the control plane matters more than request signing.

## Future Strict Replay Protection

Strict one-time replay protection can be added with a storage callback later. Redis `SET NX EX`, a Durable Object, or a strongly consistent database are better choices than eventually consistent caches for this.
