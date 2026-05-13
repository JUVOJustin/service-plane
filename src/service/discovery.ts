import type { Context } from 'hono';
import { CapabilityAuthError } from '../shared/errors.js';
import { joinPaths, normalizePath, pathMatches } from '../shared/paths.js';
import {
  type DefineServiceOptions,
  SERVICE_DISCOVERY_PATH,
  type ServiceDefinition,
  type ServiceDiscoveryDocument,
  type ServiceNamespaceDefinition,
} from '../shared/types.js';
import { routeRequiredScopes } from './capabilities.js';

type NamespaceRoute = ServiceDiscoveryDocument['routes'][number] & {
  requiredScopes: string[];
  routeIndex: number;
};

export function defineNamespace(namespace: ServiceNamespaceDefinition): ServiceNamespaceDefinition {
  return {
    ...namespace,
    prefix: normalizePath(namespace.prefix),
  };
}

export function defineService(service: ServiceDefinition, options: DefineServiceOptions = {}): ServiceDefinition {
  const normalized = {
    ...service,
    id: normalizeValue(service.id, 'service id'),
    namespaces: service.namespaces.map(defineNamespace),
    title: normalizeValue(service.title, 'service title'),
    version: normalizeValue(service.version, 'service version'),
  };
  validateServiceDefinition(normalized, options);
  return normalized;
}

export function serviceDiscoveryDocument(service: ServiceDefinition): ServiceDiscoveryDocument {
  const routes = service.namespaces.flatMap((namespace) =>
    namespaceRoutes(namespace).map((route) => ({
      method: route.method,
      path: route.path,
      requiredScopes: route.requiredScopes,
      visibility: route.visibility,
    })),
  );
  const uniqueRoutes = [
    ...routes
      .reduce((merged, route) => {
        const key = `${route.method} ${route.path} ${route.visibility}`;
        const existing = merged.get(key);
        const requiredScopes = [...new Set([...(existing?.requiredScopes ?? []), ...route.requiredScopes])];
        merged.set(key, {
          method: route.method,
          path: route.path,
          ...(requiredScopes.length > 0 ? { requiredScopes } : {}),
          visibility: route.visibility,
        });
        return merged;
      }, new Map<string, ServiceDiscoveryDocument['routes'][number]>())
      .values(),
  ];

  return {
    ...(service.capabilities ? { capabilities: service.capabilities } : {}),
    id: service.id,
    routes: uniqueRoutes,
    title: service.title,
    version: service.version,
  };
}

export function mountDiscovery(
  app: {
    get(path: string, handler: (context: Context) => Response | Promise<Response>): unknown;
  },
  service: ServiceDefinition,
  path = SERVICE_DISCOVERY_PATH,
): void {
  app.get(path, (context) => context.json(serviceDiscoveryDocument(service), 200));
}

function validateServiceDefinition(service: ServiceDefinition, options: DefineServiceOptions): void {
  if (service.namespaces.length === 0) {
    throw new CapabilityAuthError('Service-Plane service must define at least one namespace', 500);
  }
  const knownScopes = new Set(service.capabilities?.scopes.map((scope) => normalizeValue(scope.id, 'scope')) ?? []);

  for (const namespace of service.namespaces) {
    if (!Array.isArray(namespace.app.routes)) {
      throw new CapabilityAuthError('Service-Plane namespace app must expose Hono routes', 500);
    }
    const routes = namespaceRoutes(namespace);
    const routesByKey = routes.reduce((merged, route) => {
      const key = `${route.method} ${route.path}`;
      const existing = merged.get(key) ?? [];
      existing.push(route);
      merged.set(key, existing);
      return merged;
    }, new Map<string, typeof routes>());

    for (const [key, matchingRoutes] of routesByKey) {
      const [method, ...pathParts] = key.split(' ');
      const path = pathParts.join(' ');
      const requiredScopes = [...new Set(matchingRoutes.flatMap((route) => route.requiredScopes))];
      if (options.requireRouteScopes && requiredScopes.length === 0) {
        throw new CapabilityAuthError(`Service-Plane route is missing capability(...) annotation: ${method?.toUpperCase()} ${path}`, 500);
      }
      if (options.requireRouteScopes && matchingRoutes[0]?.requiredScopes.length === 0) {
        throw new CapabilityAuthError(
          `Service-Plane route must begin with capability(...) annotation: ${method?.toUpperCase()} ${path}`,
          500,
        );
      }
      if (requiredScopes.length > 0 && !service.capabilities) {
        throw new CapabilityAuthError(
          `Service-Plane route requires scopes but service has no capability catalog: ${method?.toUpperCase()} ${path}`,
          500,
        );
      }
      for (const scope of requiredScopes) {
        if (!knownScopes.has(scope)) {
          throw new CapabilityAuthError(`Service-Plane route requires unknown scope: ${scope}`, 500);
        }
      }
    }
  }
}

function namespaceRoutes(namespace: ServiceNamespaceDefinition): NamespaceRoute[] {
  const routes = namespace.app.routes
    .map((route, routeIndex) => ({
      method: route.method.toUpperCase(),
      path: joinPaths(namespace.prefix, route.path),
      requiredScopes: routeRequiredScopes(route.handler),
      routeIndex,
      visibility: namespace.visibility,
    }))
    .filter((route) => route.path !== SERVICE_DISCOVERY_PATH);
  const scopedMiddlewareRoutes = routes.filter((route) => route.method === 'ALL' && route.requiredScopes.length > 0);

  return routes.map((route) => {
    const inheritedScopes = scopedMiddlewareRoutes
      .filter((middleware) => middleware.routeIndex < route.routeIndex && pathMatches(middleware.path, route.path))
      .flatMap((middleware) => middleware.requiredScopes);
    return {
      ...route,
      requiredScopes: [...new Set([...inheritedScopes, ...route.requiredScopes])],
    };
  });
}

function normalizeValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new CapabilityAuthError(`Service-Plane ${field} cannot be empty`, 500);
  return normalized;
}
