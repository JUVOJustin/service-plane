import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package metadata', () => {
  it('requires Hono versions with current security patches', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>;
    };

    expect(packageJson.peerDependencies?.hono).toBe('>=4.10.3 <5.0.0');
  });
});
