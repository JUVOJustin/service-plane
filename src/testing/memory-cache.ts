import type { CapabilityTokenCache, CapabilityTokenCacheEntry } from '../shared/types.js';

type TokenEntry = {
  expiresAt: number;
  value: CapabilityTokenCacheEntry;
};

export function memoryCapabilityTokenCache(now: () => number = () => Date.now()): CapabilityTokenCache {
  const entries = new Map<string, TokenEntry>();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      entries.set(key, {
        expiresAt: now() + ttlSeconds * 1000,
        value,
      });
    },
  };
}
