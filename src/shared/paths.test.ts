import { describe, expect, it } from 'vitest';
import { isOriginRelativePath } from './paths.js';

describe('path matching', () => {
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
