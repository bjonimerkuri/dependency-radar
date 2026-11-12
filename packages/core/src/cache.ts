import type { ChangelogFetchResult, ChangelogSource } from './github.ts';
import type { FetchManifestResult, FetchPackumentResult, ManifestClient, Packument, RegistryClient } from './registry.ts';

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

export interface TtlCacheOptions {
  ttlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface TtlEntry<T> {
  value: T;
  expiresAt: number;
}

function createTtlStore<T>(options: TtlCacheOptions) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 1000;
  const store = new Map<string, TtlEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    ttlMs: options.ttlMs ?? 6 * 60 * 60 * 1000,
    negativeTtlMs: options.negativeTtlMs ?? 10 * 60 * 1000,
    get(key: string): T | undefined {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T, ttl: number): void {
      store.delete(key);
      store.set(key, { value, expiresAt: now() + ttl });
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
    },
    async run(key: string, load: () => Promise<T>): Promise<T> {
      const pending = inFlight.get(key);
      if (pending) return pending;
      const started = load().finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
  };
}

export function withManifestCache(client: ManifestClient, options: TtlCacheOptions = {}): ManifestClient {
  const store = createTtlStore<FetchManifestResult>(options);
  return {
    getManifest(name) {
      const cached = store.get(name);
      if (cached) return Promise.resolve(cached);
      return store.run(name, async () => {
        const result = await client.getManifest(name);
        if (result.ok) store.set(name, result, store.ttlMs);
        else if (result.code === 'NOT_FOUND') store.set(name, result, store.negativeTtlMs);
        return result;
      });
    },
  };
}

export function withChangelogCache(source: ChangelogSource, options: TtlCacheOptions = {}): ChangelogSource {
  const store = createTtlStore<ChangelogFetchResult>(options);
  return {
    fetchChangelog(repository, request) {
      const key = [
        repository.owner,
        repository.repo,
        repository.directory ?? '',
        request.packageName,
        request.from,
        request.to,
      ].join('|');
      const cached = store.get(key);
      if (cached) return Promise.resolve(cached);
      return store.run(key, async () => {
        const result = await source.fetchChangelog(repository, request);
        if (result.ok) store.set(key, result, store.ttlMs);
        else if (result.code === 'NOT_FOUND' || result.code === 'NO_MATCHING_VERSIONS') {
          store.set(key, result, store.negativeTtlMs);
        }
        return result;
      });
    },
  };
}
