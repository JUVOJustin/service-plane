import type { OpenApiObject } from './types.js';

/** Inlines a local-ref root while preserving the schema resource and its definitions. */
export function inlineJsonSchemaRoot(schema: OpenApiObject): OpenApiObject {
  const target = resolveLocalRefTarget(schema);
  if (!target) return schema;
  const { $ref, ...rootExtras } = schema;
  return { ...target, ...rootExtras };
}

/** Returns an inlined JSON Schema root's declared top-level properties, when it has any. */
export function jsonSchemaRootProperties(schema: OpenApiObject): Record<string, unknown> | undefined {
  const properties = inlineJsonSchemaRoot(schema).properties;
  return isRecord(properties) ? properties : undefined;
}

function resolveLocalRefTarget(schema: OpenApiObject): OpenApiObject | undefined {
  const seen = new Set<string>();
  let current: OpenApiObject = schema;
  while (typeof current.$ref === 'string' && current.$ref.startsWith('#/')) {
    if (seen.has(current.$ref)) return undefined;
    seen.add(current.$ref);
    const resolved = resolveJsonPointer(schema, current.$ref.slice(2));
    if (!isRecord(resolved)) return undefined;
    current = resolved;
  }
  return current === schema ? undefined : current;
}

function resolveJsonPointer(document: OpenApiObject, pointer: string): unknown {
  let current: unknown = document;
  for (const rawSegment of pointer.split('/')) {
    const segment = decodeURIComponent(rawSegment).replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || !Object.hasOwn(current, index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
