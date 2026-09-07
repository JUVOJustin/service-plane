import { describe, expect, it } from 'vitest';
import { hasOnlySimpleTemplateExpressions, isOriginRelativePath } from './paths.js';

describe('path matching', () => {
  it.each([
    'example://items/{left}{right}',
    'example://items/{left}-between-{right}',
    'example://{host}.{suffix}/items',
    'example://items?q={query}&page={page}',
    'example://items#part-{start}-{end}',
    'example://{id}/items/{id}',
    'example://items/{id}?q={id}',
    'example://items/{nested{id}}',
    'example://items/{id',
    'example://items/id}',
    'example://items/}{id}',
  ])('rejects unsafe or malformed URI template components: %s', (template) => {
    expect(hasOnlySimpleTemplateExpressions(template)).toBe(false);
  });

  it.each([
    'example://items/static',
    'example://{host}.internal/items/pre-{id}.json?q={query}&fixed=yes#part-{fragment}-end',
    'example://items/{id}/{other}',
    'example://items/{__proto__}',
  ])('accepts one globally unique variable per URI component: %s', (template) => {
    expect(hasOnlySimpleTemplateExpressions(template)).toBe(true);
  });

  it('distinguishes service-local routes from host-replacing URL references', () => {
    expect(isOriginRelativePath('/rpc/v1/example.sync')).toBe(true);
    expect(isOriginRelativePath('//other.example/rpc')).toBe(false);
    expect(isOriginRelativePath('/\\other.example/rpc')).toBe(false);
    expect(isOriginRelativePath('/rpc/v1/example.sync?token=x')).toBe(false);
    expect(isOriginRelativePath('/rpc/v1/example.sync#fragment')).toBe(false);
  });

  it('rejects paths whose control characters the URL parser strips into a host reference', () => {
    // The URL parser removes tab/CR/LF, so each of these resolves to https://attacker.example.
    for (const path of ['/\t/attacker.example/rpc', '/\n/attacker.example/rpc', '/\r/attacker.example/rpc']) {
      expect(new URL(path, 'https://hub.internal').origin).toBe('https://attacker.example');
      expect(isOriginRelativePath(path)).toBe(false);
    }
    expect(isOriginRelativePath('/rpc/v1/example sync')).toBe(false);
    expect(isOriginRelativePath(' //attacker.example/rpc')).toBe(false);
  });
});
