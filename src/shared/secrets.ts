import { ServicePlaneError } from './errors.js';

export type SecretKind = 'string' | 'jwk' | 'json';

export type SecretSpec = SecretKind | { kind: SecretKind; optional?: boolean };

export type SecretsSchema = Record<string, SecretSpec>;

type ParsedValue<K extends SecretKind> = K extends 'string'
  ? string
  : K extends 'jwk'
    ? JsonWebKey
    : unknown;

type SpecKind<S extends SecretSpec> = S extends SecretKind
  ? S
  : S extends { kind: infer K extends SecretKind }
    ? K
    : never;

type IsOptional<S extends SecretSpec> = S extends { optional: true } ? true : false;

export type SecretsBindings<S extends SecretsSchema> = {
  [K in keyof S]: IsOptional<S[K]> extends true ? string | undefined : string;
};

export type SecretsValues<S extends SecretsSchema> = {
  [K in keyof S]: IsOptional<S[K]> extends true
    ? ParsedValue<SpecKind<S[K]>> | undefined
    : ParsedValue<SpecKind<S[K]>>;
};

export type DefinedSecrets<S extends SecretsSchema> = {
  /**
   * Compile-time helper exposing the typed shape of the Worker `Bindings`
   * object. Use as `Hono<{ Bindings: typeof secrets.Bindings }>` or as the
   * `Env` type of a Workers `fetch(request, env, ctx)` handler.
   */
  readonly Bindings: SecretsBindings<S>;
  /**
   * The raw schema object. Useful for tooling that wants to enumerate which
   * secrets a Worker requires (for example a future `wrangler.jsonc` sync
   * step).
   */
  readonly schema: S;
  /**
   * Fail-fast validator. Reads the raw env, ensures every required secret is
   * present and parses JWK / JSON kinds. Throws a `ServicePlaneError` that
   * lists *all* missing or malformed secrets in a single message so the
   * Worker logs surface the problem on first request instead of crashing
   * deep inside business logic.
   */
  validate(env: Record<string, unknown>): SecretsValues<S>;
};

export function defineSecrets<S extends SecretsSchema>(schema: S): DefinedSecrets<S> {
  const entries = Object.entries(schema).map(([name, spec]) => [name, normalizeSpec(spec)] as const);
  return {
    Bindings: undefined as unknown as SecretsBindings<S>,
    schema,
    validate(env) {
      const missing: string[] = [];
      const invalid: string[] = [];
      const values: Record<string, unknown> = {};

      for (const [name, normalized] of entries) {
        const raw = env[name];
        if (raw === undefined || raw === null || raw === '') {
          if (!normalized.optional) missing.push(name);
          continue;
        }
        if (typeof raw !== 'string') {
          invalid.push(`${name} must be a string secret`);
          continue;
        }
        try {
          values[name] = parseSecret(raw, normalized.kind);
        } catch (error) {
          invalid.push(`${name}: ${(error as Error).message}`);
        }
      }

      if (missing.length > 0 || invalid.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing required secrets: ${missing.join(', ')}`);
        if (invalid.length > 0) parts.push(`invalid secrets: ${invalid.join('; ')}`);
        throw new ServicePlaneError(`Service-Plane secrets are not configured (${parts.join('; ')})`, 500);
      }

      return values as SecretsValues<S>;
    },
  };
}

function normalizeSpec(spec: SecretSpec): { kind: SecretKind; optional: boolean } {
  if (typeof spec === 'string') return { kind: spec, optional: false };
  return { kind: spec.kind, optional: spec.optional ?? false };
}

function parseSecret(raw: string, kind: SecretKind): unknown {
  if (kind === 'string') return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`expected ${kind === 'jwk' ? 'JWK' : 'JSON'} string, got malformed JSON`);
  }
  if (kind === 'jwk') {
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { kty?: unknown }).kty !== 'string') {
      throw new Error('expected JWK object with a "kty" field');
    }
    return parsed as JsonWebKey;
  }
  return parsed;
}
