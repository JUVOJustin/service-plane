import type { Hono } from 'hono';
import { SERVICE_DISCOVERY_PATH, type ServiceDefinition, type ServiceDiscoveryDocument, type ServiceNamespaceDefinition } from '../shared/types.js';
import { joinPaths, normalizePath } from '../shared/paths.js';

export function defineNamespace(namespace: ServiceNamespaceDefinition): ServiceNamespaceDefinition {
  return {
    ...namespace,
    prefix: normalizePath(namespace.prefix),
  };
}

export function defineService(service: ServiceDefinition): ServiceDefinition {
  return {
    ...service,
    namespaces: service.namespaces.map(defineNamespace),
  };
}

export function serviceDiscoveryDocument(service: ServiceDefinition): ServiceDiscoveryDocument {
  const routes = service.namespaces.flatMap((namespace) =>
    namespace.app.routes
      .map((route) => ({
        method: route.method.toUpperCase(),
        path: joinPaths(namespace.prefix, route.path),
        visibility: namespace.visibility,
      }))
      .filter((route) => route.path !== SERVICE_DISCOVERY_PATH),
  );
  const uniqueRoutes = [...new Map(routes.map((route) => [`${route.method} ${route.path} ${route.visibility}`, route])).values()];

  return {
    id: service.id,
    routes: uniqueRoutes,
    title: service.title,
    version: service.version,
  };
}

export function mountDiscovery(app: Pick<Hono, 'get'>, service: ServiceDefinition, path = SERVICE_DISCOVERY_PATH): void {
  app.get(path, (context) => context.json(serviceDiscoveryDocument(service), 200));
}
