import { DEFAULT_REGISTRY_CACHE_TTL_SECONDS } from './types.js';

/**
 * Edge freshness defaults track the registry cache TTL so the worst-case staleness of a
 * projection is registry TTL + edge max-age, not an unbounded window.
 */
export const DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS = DEFAULT_REGISTRY_CACHE_TTL_SECONDS;
export const DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS = 300;

export type ServicePlaneHttpCacheOptions = {
  maxAgeSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  tags?: string[];
};

export type ServicePlaneHttpCacheOption = boolean | ServicePlaneHttpCacheOptions;

/**
 * Builds Cache-Control and Cache-Tag headers for cache-in-front-of-worker setups such as
 * Cloudflare Workers Cache. Tags allow deploy hooks to purge one service's metadata without
 * touching other cached content.
 */
export function servicePlaneHttpCacheHeaders(
  cache: ServicePlaneHttpCacheOption | undefined,
  defaultTags: string[],
): Record<string, string> | undefined {
  if (!cache) return undefined;
  const options = cache === true ? {} : cache;
  const maxAge = normalizeSeconds(options.maxAgeSeconds, DEFAULT_HTTP_CACHE_MAX_AGE_SECONDS);
  const staleWhileRevalidate = normalizeSeconds(options.staleWhileRevalidateSeconds, DEFAULT_HTTP_CACHE_STALE_WHILE_REVALIDATE_SECONDS);
  const tags = [...new Set([...defaultTags, ...(options.tags ?? [])].map((tag) => tag.trim()).filter(Boolean))];
  return {
    'cache-control': `public, max-age=${maxAge}${staleWhileRevalidate > 0 ? `, stale-while-revalidate=${staleWhileRevalidate}` : ''}`,
    ...(tags.length > 0 ? { 'cache-tag': tags.join(',') } : {}),
  };
}

export function applyHttpCacheHeaders(headers: Record<string, string> | undefined, set: (name: string, value: string) => void): void {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) set(name, value);
}

function normalizeSeconds(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Service-Plane HTTP cache seconds must be a non-negative number: ${value}`);
  return Math.floor(value);
}
