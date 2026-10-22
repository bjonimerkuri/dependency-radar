import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryCache, withCache } from '../src/index.ts';
import type { FetchPackumentResult, Packument, RegistryClient } from '../src/index.ts';

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
