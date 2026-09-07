/** Minimal link surface used by flat ability clients. */
export type FlatAbilityClientLink<TCallOptions> = {
  /** Invokes one top-level ability method. */
  call(path: [string], input: unknown, options?: TCallOptions): unknown;
};

/**
 * Builds the public client from declared methods only. A null prototype avoids inherited JavaScript
 * names becoming fake RPC members while keeping every declared method as a normal own property.
 */
export function createFlatAbilityClient<TClient extends object, TCallOptions>(
  methodNames: Iterable<string>,
  link: FlatAbilityClientLink<TCallOptions>,
): TClient {
  const client = Object.create(null) as Record<PropertyKey, unknown>;
  for (const methodName of methodNames) {
    Object.defineProperty(client, methodName, {
      enumerable: true,
      value: (input: unknown, options?: TCallOptions) => link.call([methodName], input, options),
    });
  }

  // Coercion must not fall through to a user-defined `toString` or `valueOf` RPC method.
  Object.defineProperty(client, Symbol.toPrimitive, {
    value: () => '[object ServicePlaneAbilityClient]',
  });
  return client as TClient;
}
