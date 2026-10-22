import type { FetchPackumentResult, Packument, RegistryClient } from './registry.ts';

export interface PackumentCache {
  get(key: string): Promise<Packument | undefined> | Packument | undefined;
  set(key: string, value: Packument, ttlMs: number): Promise<void> | void;
}

export interface MemoryCacheOptions {
  now?: () => number;
  maxEntries?: number;
}

export function createMemoryCache(options: MemoryCacheOptions = {}): PackumentCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 500;
  const store = new Map<string, { value: Packument; expiresAt: number }>();

  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value, ttlMs) {
      store.delete(key);
      store.set(key, { value, expiresAt: now() + ttlMs });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
  };
}

export interface WithCacheOptions {
  ttlMs?: number;
}

export function withCache(client: RegistryClient, cache: PackumentCache, options: WithCacheOptions = {}): RegistryClient {
  const ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const inFlight = new Map<string, Promise<FetchPackumentResult>>();

  async function load(name: string): Promise<FetchPackumentResult> {
    const cached = await cache.get(name);
    if (cached) return { ok: true, packument: cached };
    const result = await client.getPackument(name);
    if (result.ok) await cache.set(name, result.packument, ttlMs);
    return result;
  }

  return {
    getPackument(name) {
      const pending = inFlight.get(name);
      if (pending) return pending;
      const started = load(name).finally(() => {
        inFlight.delete(name);
      });
      inFlight.set(name, started);
      return started;
    },
  };
}
