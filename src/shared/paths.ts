export function joinPaths(prefix: string, path: string): string {
  const normalizedPrefix = normalizePath(prefix);
  const normalizedPath = normalizePath(path);
  if (normalizedPrefix === '/') return normalizedPath;
  if (normalizedPath === '/') return normalizedPrefix;
  return `${normalizedPrefix}${normalizedPath}`;
}

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, '') : withLeadingSlash;
}

export function pathAndQuery(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function pathMatches(routePath: string, requestPath: string): boolean {
  const pattern = normalizePath(routePath)
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) return '[^/]+';
      return escapeRegExp(part);
    })
    .join('/');
  return new RegExp(`^${pattern}$`, 'u').test(normalizePath(requestPath));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
