export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, '') : withLeadingSlash;
}

/** Accepts only balanced `{identifier}` expressions while allowing ordinary URI text around them. */
export function hasOnlySimpleTemplateExpressions(value: string): boolean {
  const expressions = value.match(/\{[^}]*\}|\{|\}/gu) ?? [];
  let balance = 0;
  for (const char of value) {
    if (char === '{') balance += 1;
    if (char === '}') balance -= 1;
    if (balance < 0) return false;
  }
  return balance === 0 && expressions.every((expression) => templateVariableName(expression) !== undefined);
}

/** The variable a whole `{name}` template segment declares, or undefined for any other text. */
export function templateVariableName(segment: string): string | undefined {
  return /^\{([A-Za-z_]\w*)\}$/u.exec(segment)?.[1];
}

/** Returns unique whole-segment `{name}` variables, or `undefined` for an invalid template. */
export function pathTemplateVariables(path: string): string[] | undefined {
  const names = new Set<string>();
  for (const segment of path.split('/')) {
    if (!segment.includes('{') && !segment.includes('}')) continue;
    const name = templateVariableName(segment);
    if (!name || names.has(name)) return undefined;
    names.add(name);
  }
  return [...names];
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

/** Trims and removes trailing slashes from a safe origin-relative route. */
export function normalizeOriginRelativePath(path: string): string | undefined {
  const trimmed = path.trim();
  return isOriginRelativePath(trimmed) ? normalizePath(trimmed) : undefined;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
