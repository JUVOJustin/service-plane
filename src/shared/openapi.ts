import type { ServiceRegistry } from './types.js';

export type OpenApiDocument = {
  info: {
    title: string;
    version: string;
    [key: string]: unknown;
  };
  openapi: string;
  paths?: Record<string, Record<string, unknown>>;
  tags?: Array<{ name: string; description?: string }>;
  [key: string]: unknown;
};

export async function mergeServiceOpenApi(input: { baseDocument: OpenApiDocument; registry: ServiceRegistry }): Promise<OpenApiDocument> {
  const snapshot = await input.registry.discover();
  const paths: Record<string, Record<string, unknown>> = Object.assign(Object.create(null), input.baseDocument.paths ?? {});
  const tags = [...(input.baseDocument.tags ?? [])];
  const knownTags = new Set(tags.map((tag) => tag.name));

  for (const route of snapshot.routes) {
    if (route.visibility === 'internal') continue;
    if (!isSafeOpenApiPath(route.path)) continue;
    if (!isSafeOpenApiMethod(route.method)) continue;
    if (!knownTags.has(route.serviceTitle)) {
      tags.push({ name: route.serviceTitle });
      knownTags.add(route.serviceTitle);
    }
    const existingMethods = paths[route.path];
    const methods: Record<string, unknown> = isRecord(existingMethods) ? existingMethods : Object.create(null);
    if (!isRecord(existingMethods)) {
      paths[route.path] = methods;
    }
    methods[route.method.toLowerCase()] = {
      description: `${route.visibility} route discovered from ${route.serviceTitle}.`,
      responses: {
        200: {
          description: 'Successful response',
        },
      },
      summary: `${route.serviceTitle} ${route.method.toUpperCase()} ${route.path}`,
      tags: [route.serviceTitle],
      'x-service-plane': {
        ...(route.requiredScopes?.length ? { requiredScopes: route.requiredScopes } : {}),
        serviceId: route.serviceId,
        serviceVersion: route.serviceVersion,
        visibility: route.visibility,
      },
    };
  }

  return {
    ...input.baseDocument,
    paths,
    tags,
  };
}

function isSafeOpenApiPath(path: string): boolean {
  return path.startsWith('/') && !path.split('/').some(isPrototypeKey);
}

function isSafeOpenApiMethod(method: string): boolean {
  return /^(delete|get|head|options|patch|post|put|trace)$/iu.test(method);
}

function isPrototypeKey(value: string): boolean {
  return value === '__proto__' || value === 'constructor' || value === 'prototype';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
