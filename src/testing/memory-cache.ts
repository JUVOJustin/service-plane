import type { RegistryCache, ServiceDiscoverySnapshot } from '../shared/types.js';

type Entry = {
  expiresAt: number;
  value: ServiceDiscoverySnapshot;
};

export function memoryRegistryCache(now: () => number = () => Date.now()): RegistryCache {
  const entries = new Map<string, Entry>();
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
