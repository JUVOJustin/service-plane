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

// The WHATWG URL parser strips tab/CR/LF from anywhere in the input and trims C0 controls and
// spaces at both ends, so a value like '/\t/attacker.example' passes a naive '//' check and then
// resolves to a foreign origin. Route paths never contain these bytes unencoded.
function hasStrippablePathChar(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * A route advertised by a service must stay on that service's origin when resolved with
 * `new URL(path, origin)`. Network-path references (`//host`) and backslashes can replace the
 * host under WHATWG URL parsing, while query/fragment components are not route paths.
 */
export function isOriginRelativePath(path: string): boolean {
  if (hasStrippablePathChar(path)) return false;
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !path.includes('?') && !path.includes('#');
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
  if (part === '*') return '.*';

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
