import { describe, expect, it, vi } from 'vitest';
import { runBestEffortCacheOperation } from './best-effort-cache.js';

describe('best-effort control-plane caches', () => {
  it('returns hits and treats synchronous or asynchronous failures as misses', async () => {
    await expect(runBestEffortCacheOperation(async () => 'hit')).resolves.toBe('hit');
    await expect(
      runBestEffortCacheOperation(() => {
        throw new Error('offline');
      }),
    ).resolves.toBeUndefined();
    await expect(runBestEffortCacheOperation(() => Promise.reject(new Error('offline')))).resolves.toBeUndefined();
  });

  it('stops awaiting a cache that never settles', async () => {
    const operation = vi.fn(() => new Promise<string>(() => undefined));

    await expect(runBestEffortCacheOperation(operation, 5)).resolves.toBeUndefined();

    expect(operation).toHaveBeenCalledOnce();
  });
});
