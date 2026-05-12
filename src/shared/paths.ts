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
  const pattern = pathPattern(normalizePath(routePath));
  if (!pattern) return false;
  return new RegExp(`^${pattern}$`, 'u').test(normalizePath(requestPath));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function pathPattern(path: string): string | undefined {
  const patterns = path.split('/').map(pathPartPattern);
  return patterns.includes(undefined) ? undefined : patterns.join('/');
}

function pathPartPattern(part: string): string | undefined {
  const param = /^:([^{}]+)(?:\{(.+)\})?$/u.exec(part);
  if (!param) return escapeRegExp(part);

  const constraint = param[2];
  if (!constraint) return '[^/]+';

  try {
    new RegExp(`^(?:${constraint})$`, 'u');
  } catch {
    return undefined;
  }
  return `(?:${constraint})`;
}
