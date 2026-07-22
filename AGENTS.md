# AGENTS.md

## Package Scope

This package is `service-plane`: a TypeScript library for ability-first service APIs. It provides primitives for:

- Service-owned ability definitions with Zod input and output schemas.
- Cap'n Web RPC sessions over HTTP-batch, WebSocket, Cloudflare service bindings, and custom transports.
- Control-plane issued capability tokens and JWKS verification.
- Service discovery documents.
- OpenAPI, Swagger, and MCP projections from published ability metadata.
- Allow mixed infrastructure cloudfalre + nodejs workers
- Runtime agnostic cloudflare + full honojs stack
- Test helpers for in-memory transports and caches.

Keep changes inside these boundaries unless the user explicitly asks for a broader redesign.

## Architecture Boundaries

The package has three main public surfaces:

- `src/service`: service authors define capabilities, abilities, service discovery, RPC transports, token requesters, and the `ServicePlaneService` Hono shell.
- `src/control-plane`: control-plane authors configure services, grants, caller authentication, STS/JWKS endpoints, the broker, OpenAPI, Swagger, and MCP.
- `src/testing`: test-only utilities such as memory transports and caches.

Shared primitives live in `src/shared`. Add to shared only when both service and control-plane code need the type, constant, or helper.

## Ability Visibility And Access

Abilities are the main usability unit of this package. When adding or changing abilities, keep these concepts separate:

- `exposure` controls discoverability in user-facing projections.
- `access` controls whether the broker treats the ability as plane-callable or service-only.
- `scopes` control what a signed capability token may do once the service receives it.
- `ingress` controls whether the service accepts only brokered Service Plane calls.

Use `exposure: 'private'` for abilities that should not appear in generated OpenAPI, Swagger, or MCP projections.

Use `exposure: 'published'` only for abilities intended to become product or integration surfaces. Published abilities can be projected into OpenAPI or MCP when their methods include `rest` or `mcp` metadata.

Use `access: 'plane'` for the default Service Plane path. The control plane or gateway owns any product-level user, API-key, or anonymous access decision before it asks the service to run an ability.

Use `access: 'service'` for internal service-to-service abilities that should only be brokered when the broker caller is another service. Do not use service access to model end-user authentication.

Define scopes at the service capability catalog, then reference them at both ability and method level. Ability scopes declare the maximum scope surface. Method scopes declare the minimum scopes for one operation. A method must not require a scope that the parent ability does not declare.

When `ServicePlaneService` uses `ingress`, direct callers with ordinary valid tokens are not enough. Calls must arrive with a brokered capability token minted by the control plane, so the service can reject direct application-side calls before handler creation.

## Security Model

Treat the security model as core package behavior.

- The control plane is the only component that issues capability tokens.
- Services verify token issuer, audience, expiry, signature, and scopes before handlers run.
- Only the control plane should be allowed to call services. No direct ingress to services  allowed.
- Ability handlers should receive validated input only through the Service Plane wrapper.
- Do not weaken scope checks, grant checks, token validation, JWK/HMAC caller auth, replay protection, or ingress protection to make tests pass.
- When `ServicePlaneService` uses `ingress`, direct application-side calls with ordinary valid tokens must be rejected before input validation or handler creation. The control-plane broker mints brokered capability tokens using the existing issuer/JWKS trust chain.
- Avoid adding new secrets when an existing signed token claim or caller-auth mechanism can express the boundary safely.

## Public API Expectations

This package is intended for library consumers. Changes to exported names, exported types, default paths, token claim shapes, discovery documents, and error behavior can be breaking.

Before changing public API:

- Check `src/service/index.ts`, `src/control-plane/index.ts`, and `src/index.ts`.
- Update docs in `README.md` and `docs/`.
- Add or update focused tests that prove the intended consumer behavior.
- Prefer additive options over changing defaults unless the user asks for a breaking change.

## Implementation Guidelines

- Match existing TypeScript style and Biome formatting.
- Keep code comments short and explain why a boundary exists, not what each line does.
- Prefer small, explicit helpers near the code that owns the behavior.
- Use Zod schemas as the source of truth for ability input and output.
- Use structured token claims, discovery fields, and typed options instead of ad hoc request parsing.
- Keep service logic separate from control-plane logic. The service should verify and enforce; the control plane should issue, discover, broker, and project.
- Do not edit generated `dist/` output unless the user specifically asks for built artifacts to be committed.

## Documentation Scope

Docs follow the existing Diataxis-style split:

- `README.md`: minimal end-to-end overview.
- `docs/architecture.md`: explanation of the model and boundaries.
- `docs/service-creation.md`: how to create a service.
- `docs/plane-creation.md`: how to create a control plane.
- `docs/auth.md`: authentication and token behavior.
- `docs/streaming.md`: streaming ability methods and session transports.
- `docs/cloudflare.md` and `docs/nodejs.md`: deployment-specific usage.
- `docs/reference.md`: API and route reference.

Update the smallest relevant docs when behavior changes. Keep examples aligned with current exports and defaults.

The repo also ships an APM agent skill in `.apm/skills/service-plane/`. Its `references/` are synced copies of `docs/*.md` — never edit them directly. After changing docs, run `npm run sync:skill-docs`, then `apm install --target claude,agent-skills` to refresh the deployed copies under `.claude/` and `.agents/`. Those deployed directories are build output and gitignored — commit only `.apm/`, `apm.yml`, and `apm.lock.yaml`.

## Validation Commands

Run the narrowest useful checks while iterating, then run the full relevant set before finishing:

```sh
npm run check
npm run typecheck
npm run test
npm run build
```
