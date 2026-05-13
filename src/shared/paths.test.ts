import { describe, expect, it } from 'vitest';
import { pathMatches } from './paths.js';

describe('path matching', () => {
  it('honors constrained Hono route parameters', () => {
    expect(pathMatches('/users/:id{[0-9]+}', '/users/123')).toBe(true);
    expect(pathMatches('/users/:id{[0-9]+}', '/users/admin')).toBe(false);
  });

  it('honors Hono wildcard route segments', () => {
    expect(pathMatches('/*', '/users/123')).toBe(true);
    expect(pathMatches('/users/*', '/users/123/settings')).toBe(true);
    expect(pathMatches('/users/*', '/teams/123')).toBe(false);
  });
});
