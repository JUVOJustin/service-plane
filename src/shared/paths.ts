export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '/';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, '') : withLeadingSlash;
}

/** A literal URI component or its single variable with fixed surrounding text. */
export type SimpleTemplateComponent =
  | string
  | {
      /** Globally unique identifier used as a method input property. */
      name: string;
      /** Literal component text before the variable. */
      prefix: string;
      /** Literal component text after the variable. */
      suffix: string;
    };

/** Accepts one globally unique `{identifier}` per component delimited by `/`, `?`, or `#`. */
export function hasOnlySimpleTemplateExpressions(value: string): boolean {
  return simpleTemplateComponents(value) !== undefined;
}

/** Keeps delimiters literal and prevents overlapping captures in URI template matching. */
export function simpleTemplateComponents(value: string): SimpleTemplateComponent[] | undefined {
  const components: SimpleTemplateComponent[] = [];
  const names = new Set<string>();
  for (const component of value.split(/([/?#])/u)) {
    const opening = component.indexOf('{');
    if (opening === -1) {
      if (component.includes('}')) return undefined;
      components.push(component);
      continue;
    }

    const closing = component.indexOf('}', opening + 1);
    const name = templateVariableName(component.slice(opening, closing + 1));
    const prefix = component.slice(0, opening);
    const suffix = component.slice(closing + 1);
    if (!name || names.has(name) || prefix.includes('}') || suffix.includes('{') || suffix.includes('}')) return undefined;
    names.add(name);
    components.push({ name, prefix, suffix });
  }
  return components;
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
