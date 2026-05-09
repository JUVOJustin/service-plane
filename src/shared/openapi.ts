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

export async function mergeServiceOpenApi(input: {
  baseDocument: OpenApiDocument;
  registry: ServiceRegistry;
}): Promise<OpenApiDocument> {
  const snapshot = await input.registry.discover();
  const paths: Record<string, Record<string, unknown>> = {
    ...(input.baseDocument.paths ?? {}),
  };
  const tags = [...(input.baseDocument.tags ?? [])];
  const knownTags = new Set(tags.map((tag) => tag.name));

  for (const route of snapshot.routes) {
    if (route.visibility === 'internal') continue;
    if (!knownTags.has(route.serviceTitle)) {
      tags.push({ name: route.serviceTitle });
      knownTags.add(route.serviceTitle);
    }
    const methods = (paths[route.path] ??= {});
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
