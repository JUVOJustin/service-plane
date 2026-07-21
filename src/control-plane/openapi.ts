import {
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  type OpenApiDocument,
  type OpenApiDocumentCache,
  type OpenApiObject,
  SERVICE_PLANE_AUTHORIZATION_SCHEME,
  SERVICE_PLANE_OPENAPI_PATH,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';

export const DEFAULT_OPENAPI_CACHE_TTL_SECONDS = DEFAULT_REGISTRY_CACHE_TTL_SECONDS;

export type ControlPlaneOpenApiOptions = {
  cache?: OpenApiDocumentCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  description?: string;
  path?: string;
  servers?: OpenApiObject[];
  title?: string;
  version?: string;
};

export type GenerateControlPlaneOpenApiOptions = {
  description?: string;
  servers?: OpenApiObject[];
  snapshot: ServiceRegistrySnapshot;
  title?: string;
  version?: string;
};

export function generateControlPlaneOpenApi(options: GenerateControlPlaneOpenApiOptions): OpenApiDocument {
  const paths = Object.create(null) as Record<string, Record<string, OpenApiObject>>;
  const tags = new Map<string, { description?: string; name: string }>();
  let hasScopedOperation = false;

  for (const ability of options.snapshot.abilities) {
    if (ability.exposure !== 'published') continue;
    for (const [methodName, method] of Object.entries(ability.methods)) {
      if (!method.rest) continue;

      let path = paths[method.rest.path];
      if (!path) {
        path = Object.create(null) as Record<string, OpenApiObject>;
        paths[method.rest.path] = path;
      }
      if (path[method.rest.method]) {
        throw new Error(`Duplicate OpenAPI operation for ${method.rest.method.toUpperCase()} ${method.rest.path}`);
      }

      const operation = openApiOperation(ability, methodName);
      if (method.scopes.length > 0) hasScopedOperation = true;
      for (const tag of (operation.tags as string[] | undefined) ?? []) {
        if (!tags.has(tag)) tags.set(tag, { name: tag });
      }
      path[method.rest.method] = operation;
    }
  }

  const document: OpenApiDocument = {
    info: {
      ...(options.description ? { description: options.description } : {}),
      title: options.title ?? 'Service Plane API',
      version: options.version ?? '0.2.0',
    },
    openapi: '3.1.0',
    paths,
    ...(options.servers ? { servers: options.servers } : {}),
    ...(tags.size > 0 ? { tags: [...tags.values()] } : {}),
  };

  if (hasScopedOperation) {
    document.components = {
      securitySchemes: {
        [SERVICE_PLANE_AUTHORIZATION_SCHEME]: {
          bearerFormat: SERVICE_PLANE_AUTHORIZATION_SCHEME,
          scheme: 'bearer',
          type: 'http',
        },
      },
    };
  }

  return document;
}

export function controlPlaneOpenApiCacheKey(
  services: Array<{ id: string }>,
  options: Pick<ControlPlaneOpenApiOptions, 'description' | 'path' | 'servers' | 'title' | 'version'>,
): string {
  return JSON.stringify({
    description: options.description ?? null,
    path: options.path ?? SERVICE_PLANE_OPENAPI_PATH,
    servers: options.servers ?? null,
    services: services.map((service) => service.id).sort(),
    title: options.title ?? 'Service Plane API',
    version: options.version ?? '0.2.0',
  });
}

function openApiOperation(ability: ServiceRegistrySnapshot['abilities'][number], methodName: string): OpenApiObject {
  const method = ability.methods[methodName];
  if (!method?.rest) throw new Error(`Missing REST projection for ${ability.serviceId}/${ability.id}/${methodName}`);
  return {
    ...(method.rest.description ? { description: method.rest.description } : {}),
    operationId: method.rest.operationId ?? `${ability.id}.${methodName}`,
    requestBody: {
      content: {
        'application/json': {
          schema: method.inputSchema,
        },
      },
      required: true,
    },
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: method.outputSchema,
          },
        },
        description: 'Successful response',
      },
    },
    ...(method.scopes.length > 0 ? { security: [{ [SERVICE_PLANE_AUTHORIZATION_SCHEME]: [] }] } : {}),
    ...(method.rest.summary ? { summary: method.rest.summary } : {}),
    tags: method.rest.tags && method.rest.tags.length > 0 ? method.rest.tags : [ability.serviceTitle],
    'x-service-plane': {
      access: ability.access,
      abilityId: ability.id,
      method: methodName,
      scopes: method.scopes,
      serviceId: ability.serviceId,
      serviceTitle: ability.serviceTitle,
      serviceVersion: ability.serviceVersion,
    },
  };
}
