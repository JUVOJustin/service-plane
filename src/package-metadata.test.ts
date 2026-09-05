import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const { releaseNpmTag } = await import(new URL('../scripts/check-release.mjs', import.meta.url).href);

describe('release version verification', () => {
  it.each(['0.4.0-beta.1', '0.4.0-rc.2+build.7'])('publishes prerelease %s with beta RPC dependencies to next', (version) => {
    expect(releaseNpmTag({ version, dependencies: { '@orpc/client': '2.0.0-beta.33' } }, `v${version}`)).toBe('next');
  });

  it.each(['0.4.0', '0.4.0+build-with-hyphens'])('recognizes stable SemVer %s including build metadata', (version) => {
    expect(releaseNpmTag({ version, dependencies: { '@orpc/client': '2.0.0' } }, `v${version}`)).toBe('latest');
  });

  it.each(['@orpc/client', '@orpc/server', '@orpc/hibernation'])('rejects a stable package depending on prerelease %s', (name) => {
    expect(() => releaseNpmTag({ version: '0.4.0', dependencies: { [name]: '2.0.0-rc.999' } }, 'v0.4.0')).toThrow(
      'Stable releases cannot depend on prerelease',
    );
  });

  it.each(['', '0.4.0', 'v0.4.1', 'release/0.4.0', 'v0.4.0\n'])('rejects non-matching release tag %j', (tag) => {
    expect(() => releaseNpmTag({ version: '0.4.0' }, tag)).toThrow('must exactly match');
  });

  it.each(['next', 'v0.4.0', '0.4', '00.4.0', '0.04.0', '0.4.00', '0.4.0-beta.01', '0.4.0-', '0.4.0+', '0.4.0-beta..1', '0.4.0\n'])(
    'rejects malformed package SemVer %s even when the tag matches',
    (version) => {
      expect(() => releaseNpmTag({ version }, `v${version}`)).toThrow('valid exact SemVer');
    },
  );

  it.each(['^2.0.0-beta.33', 'latest', '2.0.0-01'])('rejects an unpinned or malformed RPC dependency %s', (version) => {
    expect(() => releaseNpmTag({ version: '0.4.0-beta.1', dependencies: { '@orpc/server': version } }, 'v0.4.0-beta.1')).toThrow(
      'valid exact SemVer',
    );
  });
});

describe('package metadata', () => {
  it('requires Hono versions with current security patches', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    // 4.13 is the first release with first-class HTTP QUERY routing, while 4.13.5 closes the
    // query-parser and request-body security issues that affect the public Hono shell.
    expect(packageJson.peerDependencies?.hono).toBe('>=4.13.7 <5.0.0');
    // Validation is Standard Schema based, so no validation library is a peer dependency.
    expect(packageJson.peerDependencies?.zod).toBeUndefined();
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(
      expect.arrayContaining(['@orpc/client', '@orpc/hibernation', '@orpc/server']),
    );
    expect(packageJson.dependencies).not.toHaveProperty('@orpc/contract');
    expect(Object.keys(packageJson.peerDependencies ?? {}).some((name) => name.startsWith('@orpc/'))).toBe(false);
    expect(Object.keys(packageJson.dependencies ?? {}).some((name) => name.includes('capn'))).toBe(false);
  });

  it('keeps the installed RPC engine out of the public service exports', async () => {
    const serviceIndex = await readFile(new URL('./service/index.ts', import.meta.url), 'utf8');
    const serviceApi = (await import('./service/index.js')) as Record<string, unknown>;

    expect(serviceIndex).not.toContain('@orpc');
    expect(serviceIndex).not.toMatch(/ORPC|Orpc/);
    expect(serviceIndex).not.toContain('plugins');
    expect(serviceApi).not.toHaveProperty('ORPCError');
    expect(serviceApi).not.toHaveProperty('HibernationHandlerPlugin');
    expect(serviceApi).not.toHaveProperty('BatchLinkPlugin');
  });

  it('keeps the manual broker engine behind the contract-first control-plane API', async () => {
    const controlPlaneApi = (await import('./control-plane/index.js')) as Record<string, unknown>;

    expect(controlPlaneApi).not.toHaveProperty('createControlPlaneRpcBroker');
    expect(controlPlaneApi).not.toHaveProperty('controlPlaneBrokerRouter');
    expect(controlPlaneApi).not.toHaveProperty('issueCapabilityTokenForCaller');
  });
});
