import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package metadata', () => {
  it('requires Hono versions with current security patches', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>;
    };

    // 4.13 is the first release with first-class HTTP QUERY routing, which `rest.method: 'query'`
    // projections rely on; it also carries all current security patches.
    expect(packageJson.peerDependencies?.hono).toBe('>=4.13.0 <5.0.0');
    // Validation is Standard Schema based, so no validation library is a peer dependency.
    expect(packageJson.peerDependencies?.zod).toBeUndefined();
  });
});
