import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryCache, withCache, withChangelogCache, withManifestCache } from '../src/index.ts';
import type { ChangelogSource, FetchPackumentResult, ManifestClient, Packument, RegistryClient } from '../src/index.ts';

const packument: Packument = { name: 'react', distTags: { latest: '18.3.1' }, versions: {} };

function countingClient(result: FetchPackumentResult) {
  const state = { calls: 0 };
  const client: RegistryClient = {
    async getPackument() {
      state.calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return result;
    },
  };
  return { client, state };
}

describe('createMemoryCache', () => {
  it('returns stored values until they expire', () => {
    let clock = 0;
    const cache = createMemoryCache({ now: () => clock });
    cache.set('react', packument, 100);
    assert.equal(cache.get('react'), packument);
    clock = 99;
    assert.equal(cache.get('react'), packument);
    clock = 100;
    assert.equal(cache.get('react'), undefined);
  });

  it('evicts the oldest entry beyond the size limit', () => {
    const cache = createMemoryCache({ maxEntries: 2 });
    cache.set('a', packument, 1000);
    cache.set('b', packument, 1000);
    cache.set('c', packument, 1000);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), packument);
    assert.equal(cache.get('c'), packument);
  });
});

describe('withCache', () => {
  it('serves repeated lookups from the cache', async () => {
    const { client, state } = countingClient({ ok: true, packument });
    const cached = withCache(client, createMemoryCache());
    await cached.getPackument('react');
    const second = await cached.getPackument('react');
    assert.ok(second.ok);
    assert.equal(state.calls, 1);
  });

  it('shares one request between concurrent lookups', async () => {
    const { client, state } = countingClient({ ok: true, packument });
    const cached = withCache(client, createMemoryCache());
    await Promise.all([cached.getPackument('react'), cached.getPackument('react'), cached.getPackument('react')]);
    assert.equal(state.calls, 1);
  });

  it('does not cache failures', async () => {
    const { client, state } = countingClient({ ok: false, code: 'UNAVAILABLE', message: 'down' });
    const cached = withCache(client, createMemoryCache());
    await cached.getPackument('react');
    await cached.getPackument('react');
    assert.equal(state.calls, 2);
  });

  it('fetches again after the ttl', async () => {
    let clock = 0;
    const { client, state } = countingClient({ ok: true, packument });
    const cached = withCache(client, createMemoryCache({ now: () => clock }), { ttlMs: 50 });
    await cached.getPackument('react');
    clock = 51;
    await cached.getPackument('react');
    assert.equal(state.calls, 2);
  });
});

describe('withManifestCache and withChangelogCache', () => {
  const repo = { kind: 'github' as const, owner: 'o', repo: 'r' };
  const request = { packageName: 'pkg', from: '1.0.0', to: '2.0.0' };

  it('caches manifests, shares concurrent lookups and caches 404s for a short time', async () => {
    let clock = 0;
    let calls = 0;
    const found: ManifestClient = {
      async getManifest(name) {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 3));
        return name === 'missing' ? { ok: false, code: 'NOT_FOUND', message: 'x' } : { ok: true, manifest: {} };
      },
    };
    const cached = withManifestCache(found, { ttlMs: 100, negativeTtlMs: 10, now: () => clock });
    await Promise.all([cached.getManifest('a'), cached.getManifest('a')]);
    await cached.getManifest('a');
    assert.equal(calls, 1);
    await cached.getManifest('missing');
    await cached.getManifest('missing');
    assert.equal(calls, 2);
    clock = 11;
    await cached.getManifest('missing');
    assert.equal(calls, 3);
    clock = 101;
    await cached.getManifest('a');
    assert.equal(calls, 4);
  });

  it('does not cache temporary manifest failures', async () => {
    let calls = 0;
    const flaky: ManifestClient = {
      async getManifest() {
        calls++;
        return { ok: false, code: 'UNAVAILABLE', message: 'down' };
      },
    };
    const cached = withManifestCache(flaky);
    await cached.getManifest('a');
    await cached.getManifest('a');
    assert.equal(calls, 2);
  });

  it('caches changelog results per package and version range', async () => {
    let calls = 0;
    const source: ChangelogSource = {
      async fetchChangelog(_repository, req) {
        calls++;
        return req.to === '2.0.0'
          ? { ok: true, source: 'file', sections: [] }
          : { ok: false, code: 'NOT_FOUND', message: 'none' };
      },
    };
    const cached = withChangelogCache(source);
    await cached.fetchChangelog(repo, request);
    await cached.fetchChangelog(repo, request);
    assert.equal(calls, 1);
    await cached.fetchChangelog(repo, { ...request, to: '3.0.0' });
    await cached.fetchChangelog(repo, { ...request, to: '3.0.0' });
    assert.equal(calls, 2);
    await cached.fetchChangelog({ ...repo, directory: 'packages/x' }, request);
    assert.equal(calls, 3);
  });

  it('does not cache rate limits or other changelog errors', async () => {
    let calls = 0;
    const source: ChangelogSource = {
      async fetchChangelog() {
        calls++;
        return { ok: false, code: 'RATE_LIMITED', message: 'limit' };
      },
    };
    const cached = withChangelogCache(source);
    await cached.fetchChangelog(repo, request);
    await cached.fetchChangelog(repo, request);
    assert.equal(calls, 2);
  });
});
