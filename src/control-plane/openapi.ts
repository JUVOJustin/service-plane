import { isRecord } from '../shared/guards.js';
import { inlineJsonSchemaRoot } from '../shared/json-schema.js';
import {
  DEFAULT_REGISTRY_CACHE_TTL_SECONDS,
  type OpenApiDocument,
  type OpenApiDocumentCache,
  type OpenApiObject,
  SERVICE_PLANE_OPENAPI_PATH,
  type ServiceEndpoint,
  type ServiceRegistrySnapshot,
} from '../shared/types.js';
import { normalizedReservedRestPaths, sortedServiceIdentities } from './registry.js';

export const DEFAULT_OPENAPI_CACHE_TTL_SECONDS = DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
const DEFAULT_OPENAPI_DOCUMENT_VERSION = '1.0.0';

export type ControlPlaneOpenApiOptions = {
  cache?: OpenApiDocumentCache;
  cacheKey?: string;
  cacheTtlSeconds?: number;
  description?: string;
  path?: string;
  /** OpenAPI security requirements applied to every projected REST operation. */
  security?: OpenApiObject[];
  /** OpenAPI security schemes matching the authentication performed by invocation middleware. */
  securitySchemes?: Record<string, OpenApiObject>;
  servers?: OpenApiObject[];
  title?: string;
  version?: string;
};

export type GenerateControlPlaneOpenApiOptions = {
  description?: string;
  /** OpenAPI security requirements applied to the projected public API. */
  security?: OpenApiObject[];
  /** OpenAPI security schemes matching the application-owned invocation middleware. */
  securitySchemes?: Record<string, OpenApiObject>;
  servers?: OpenApiObject[];
  snapshot: ServiceRegistrySnapshot;
  title?: string;
  version?: string;
};

export function generateControlPlaneOpenApi(options: GenerateControlPlaneOpenApiOptions): OpenApiDocument {
  const paths = Object.create(null) as Record<string, Record<string, OpenApiObject>>;
  const tags = new Map<string, { description?: string; name: string }>();
  const operationIds = new Set<string>();

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
      const operationId = operation.operationId as string;
      if (operationIds.has(operationId)) {
        throw new Error(`Duplicate OpenAPI operationId across published methods: ${operationId}`);
      }
      operationIds.add(operationId);
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
      version: options.version ?? DEFAULT_OPENAPI_DOCUMENT_VERSION,
    },
    // 3.2 is what makes `query` a fixed Path Item field; the schema dialect stays draft
    // 2020-12, so ability schemas are unaffected by the bump.
    openapi: '3.2.0',
    paths,
    ...(options.security === undefined ? {} : { security: options.security }),
    ...(options.servers ? { servers: options.servers } : {}),
    ...(tags.size > 0 ? { tags: [...tags.values()] } : {}),
  };

  if (options.securitySchemes) {
    document.components = {
      securitySchemes: options.securitySchemes,
    };
  }

  return document;
}

export function controlPlaneOpenApiCacheKey(
  services: Array<Pick<ServiceEndpoint, 'id' | 'origin'>>,
  options: Pick<ControlPlaneOpenApiOptions, 'description' | 'path' | 'security' | 'securitySchemes' | 'servers' | 'title' | 'version'>,
  reservedRestPaths: string[] = [],
): string {
  return JSON.stringify({
    description: options.description ?? null,
    path: options.path ?? SERVICE_PLANE_OPENAPI_PATH,
    reservedRestPaths: normalizedReservedRestPaths(reservedRestPaths),
    security: options.security ?? null,
    securitySchemes: options.securitySchemes ?? null,
    servers: options.servers ?? null,
    // Same identity as the registry cache key: the same service ids can resolve to
    // different origins per tenant/environment and must not share one cached document.
    services: sortedServiceIdentities(services),
    title: options.title ?? 'Service Plane API',
    version: options.version ?? DEFAULT_OPENAPI_DOCUMENT_VERSION,
  });
}

function openApiOperation(ability: ServiceRegistrySnapshot['abilities'][number], methodName: string): OpenApiObject {
  const method = ability.methods[methodName];
  if (!method?.rest) throw new Error(`Missing REST projection for ${ability.serviceId}/${ability.id}/${methodName}`);
  const status = method.rest.status ?? 200;
  const request = restRequestProjection(method.inputSchema, method.rest.path);
  const response =
    status === 204 || status === 205
      ? { description: 'Successful response' }
      : {
          content: {
            'application/json': {
              schema: method.outputSchema,
            },
          },
          description: 'Successful response',
        };
  return {
    ...(method.rest.description ? { description: method.rest.description } : {}),
    operationId: method.rest.operationId ?? `${ability.serviceId}.${ability.id}.${methodName}`,
    ...(request.parameters.length > 0 ? { parameters: request.parameters } : {}),
    ...(request.body ? { requestBody: request.body } : {}),
    responses: {
      [status]: response,
    },
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

function restRequestProjection(sourceSchema: OpenApiObject, path: string): { body?: OpenApiObject; parameters: OpenApiObject[] } {
  const schema = inlineJsonSchemaRoot(sourceSchema);
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const pathNames = [...path.matchAll(/\{([A-Za-z_]\w*)\}/gu)].flatMap((match) => (match[1] ? [match[1]] : []));
  const pathNameSet = new Set(pathNames);
  const parameters: OpenApiObject[] = pathNames.map((name) => ({
    in: 'path',
    name,
    required: true,
    schema: pathParameterSchema(properties?.[name]),
  }));

  const queryNames = properties
    ? Object.entries(properties)
        .filter(([name, property]) => !pathNameSet.has(name) && isQueryParameterSchema(property))
        .map(([name]) => name)
    : [];
  for (const name of queryNames) {
    parameters.push({
      description: 'Query fallback; a JSON body value with the same name takes precedence.',
      in: 'query',
      name,
      required: false,
      schema: properties?.[name],
    });
  }

  const bodySchema = restBodySchema(schema, pathNameSet, new Set(queryNames));
  if (!bodySchema) return { parameters };
  return {
    body: {
      content: { 'application/json': { schema: bodySchema.schema } },
      required: bodySchema.required,
    },
    parameters,
  };
}

function restBodySchema(
  schema: OpenApiObject,
  pathNames: Set<string>,
  queryNames: Set<string>,
): { required: boolean; schema: OpenApiObject } | undefined {
  if (schema.type !== 'object' || !isRecord(schema.properties)) {
    return { required: true, schema };
  }

  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !pathNames.has(name)));
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string' && !pathNames.has(name) && !queryNames.has(name))
    : [];
  if (Object.keys(properties).length === 0 && schema.additionalProperties === false) return undefined;

  const { required: _required, ...rest } = schema;
  return {
    required: required.length > 0,
    schema: {
      ...rest,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function isQueryParameterSchema(value: unknown): value is OpenApiObject {
  if (!isRecord(value)) return false;
  if (value.type === 'string') return true;
  return value.type === 'array' && isRecord(value.items) && value.items.type === 'string';
}

function pathParameterSchema(value: unknown): OpenApiObject {
  return isRecord(value) && value.type === 'string' ? value : { type: 'string' };
}
