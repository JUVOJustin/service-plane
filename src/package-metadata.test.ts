import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('package metadata', () => {
  it('requires Hono versions with current security patches', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    // 4.13 is the first release with first-class HTTP QUERY routing, while 4.13.5 closes the
    // query-parser and request-body security issues that affect the public Hono shell.
    expect(packageJson.peerDependencies?.hono).toBe('>=4.13.5 <5.0.0');
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
