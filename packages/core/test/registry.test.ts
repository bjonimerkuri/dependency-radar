import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRegistryClient, normalizePackument } from '../src/index.ts';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

const reactPackument = {
  name: 'react',
  'dist-tags': { latest: '18.3.1', next: '19.0.0-rc.1' },
  versions: {
    '18.2.0': { peerDependencies: {} },
    '18.3.1': { deprecated: '', peerDependencies: { 'react-dom': '^18.3.1' } },
    '19.0.0-rc.1': { deprecated: 'use 19', peerDependencies: {} },
    'not-a-version': {},
  },
};

function scripted(responses: Array<Response | Error>) {
  const calls: string[] = [];
  const delays: number[] = [];
  let index = 0;
  const fakeFetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses[Math.min(index++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return (next as Response).clone();
  }) as typeof fetch;
  const client = createRegistryClient({
    fetch: fakeFetch,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { client, calls, delays };
}

describe('normalizePackument', () => {
  it('keeps valid versions and dist-tags only', () => {
    const packument = normalizePackument(reactPackument);
    assert.ok(packument);
    assert.deepEqual(Object.keys(packument.versions), ['18.2.0', '18.3.1', '19.0.0-rc.1']);
    assert.deepEqual(packument.distTags, { latest: '18.3.1', next: '19.0.0-rc.1' });
  });

  it('treats an empty deprecated string as not deprecated', () => {
    const packument = normalizePackument(reactPackument);
    assert.equal(packument?.versions['18.3.1']?.deprecated, undefined);
    assert.equal(packument?.versions['19.0.0-rc.1']?.deprecated, 'use 19');
  });

  it('truncates long deprecation messages', () => {
    const packument = normalizePackument({
      name: 'x',
      versions: { '1.0.0': { deprecated: 'a'.repeat(1000) } },
    });
    assert.equal(packument?.versions['1.0.0']?.deprecated?.length, 300);
  });

  it('rejects unexpected shapes', () => {
    for (const raw of [null, [], 'x', {}, { name: 'x' }, { name: 1, versions: {} }, { name: 'x', versions: [] }]) {
      assert.equal(normalizePackument(raw), undefined);
    }
  });

  it('ignores prototype-polluting keys', () => {
    const raw = JSON.parse('{"name":"x","dist-tags":{"__proto__":"1.0.0","latest":"1.0.0"},"versions":{"1.0.0":{"peerDependencies":{"__proto__":"1"}}}}');
    const packument = normalizePackument(raw);
    assert.deepEqual(Object.keys(packument?.distTags ?? {}), ['latest']);
    assert.deepEqual(packument?.versions['1.0.0']?.peerDependencies, {});
  });
});

describe('createRegistryClient', () => {
  it('fetches an abbreviated packument', async () => {
    const { client, calls } = scripted([json(reactPackument)]);
    const result = await client.getPackument('react');
    assert.ok(result.ok);
    assert.equal(result.packument.distTags.latest, '18.3.1');
    assert.deepEqual(calls, ['https://registry.npmjs.org/react']);
  });

  it('encodes scoped package names', async () => {
    const { client, calls } = scripted([json({ ...reactPackument, name: '@types/node' })]);
    await client.getPackument('@types/node');
    assert.deepEqual(calls, ['https://registry.npmjs.org/@types%2Fnode']);
  });

  it('rejects invalid names without calling the network', async () => {
    const { client, calls } = scripted([json(reactPackument)]);
    const result = await client.getPackument('../etc/passwd');
    assert.ok(!result.ok);
    assert.equal(result.code, 'INVALID_NAME');
    assert.equal(calls.length, 0);
  });

  it('reports 404 without retrying', async () => {
    const { client, calls, delays } = scripted([new Response('{}', { status: 404 })]);
    const result = await client.getPackument('missing-pkg');
    assert.ok(!result.ok);
    assert.equal(result.code, 'NOT_FOUND');
    assert.equal(calls.length, 1);
    assert.equal(delays.length, 0);
  });

  it('retries a 429 and then succeeds, honoring Retry-After', async () => {
    const { client, calls, delays } = scripted([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      json(reactPackument),
    ]);
    const result = await client.getPackument('react');
    assert.ok(result.ok);
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [2000]);
  });

  it('caps the Retry-After delay', async () => {
    const { client, delays } = scripted([
      new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
      json(reactPackument),
    ]);
    await client.getPackument('react');
    assert.deepEqual(delays, [5000]);
  });

  it('gives up after the retries with exponential backoff', async () => {
    const { client, calls, delays } = scripted([new Response('', { status: 503 })]);
    const result = await client.getPackument('react');
    assert.ok(!result.ok);
    assert.equal(result.code, 'UNAVAILABLE');
    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [300, 600]);
  });

  it('retries network errors', async () => {
    const { client, calls } = scripted([new Error('boom'), json(reactPackument)]);
    const result = await client.getPackument('react');
    assert.ok(result.ok);
    assert.equal(calls.length, 2);
  });

  it('reports a rate limit that never clears', async () => {
    const { client } = scripted([new Response('', { status: 429 })]);
    const result = await client.getPackument('react');
    assert.ok(!result.ok);
    assert.equal(result.code, 'RATE_LIMITED');
  });

  it('does not retry other client errors', async () => {
    const { client, calls } = scripted([new Response('', { status: 403 })]);
    const result = await client.getPackument('react');
    assert.ok(!result.ok);
    assert.equal(result.code, 'UNAVAILABLE');
    assert.equal(calls.length, 1);
  });

  it('reports invalid JSON and unexpected shapes', async () => {
    const bad = scripted([new Response('<html>', { status: 200 })]);
    const first = await bad.client.getPackument('react');
    assert.ok(!first.ok);
    assert.equal(first.code, 'INVALID_RESPONSE');

    const shape = scripted([json({ hello: 'world' })]);
    const second = await shape.client.getPackument('react');
    assert.ok(!second.ok);
    assert.equal(second.code, 'INVALID_RESPONSE');
  });

  it('rejects oversized responses', async () => {
    const client = createRegistryClient({
      fetch: (async () => json(reactPackument)) as typeof fetch,
      maxBytes: 20,
    });
    const result = await client.getPackument('react');
    assert.ok(!result.ok);
    assert.equal(result.code, 'TOO_LARGE');
  });

  it('refuses registry hosts that are not allowed', () => {
    assert.throws(() => createRegistryClient({ registryUrl: 'https://evil.example.com' }));
    assert.throws(() => createRegistryClient({ registryUrl: 'http://registry.npmjs.org' }));
  });

  it('refuses redirects', async () => {
    let received: RequestInit | undefined;
    const client = createRegistryClient({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        received = init;
        return json(reactPackument);
      }) as typeof fetch,
    });
    await client.getPackument('react');
    assert.equal(received?.redirect, 'error');
  });
});
