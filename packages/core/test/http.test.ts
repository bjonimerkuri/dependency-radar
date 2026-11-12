import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getBytes, getText } from '../src/index.ts';

const hosts = ['files.example.com'];

function responder(make: () => Response) {
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return make();
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe('getBytes', () => {
  it('returns the downloaded bytes', async () => {
    const { fetch } = responder(() => new Response(new Uint8Array([1, 2, 3])));
    const result = await getBytes('https://files.example.com/a.zip', { fetch, allowedHosts: hosts });
    assert.ok(result.ok);
    assert.deepEqual([...result.bytes], [1, 2, 3]);
  });

  it('blocks hosts that are not allowed and plain http without calling the network', async () => {
    const { fetch, calls } = responder(() => new Response('x'));
    for (const url of ['https://evil.example.com/a.zip', 'http://files.example.com/a.zip', 'not a url']) {
      const result = await getBytes(url, { fetch, allowedHosts: hosts });
      assert.ok(!result.ok);
      assert.equal(result.code, 'BLOCKED');
    }
    assert.equal(calls.length, 0);
  });

  it('blocks redirects to other hosts', async () => {
    const { fetch } = responder(() => {
      const response = new Response('x');
      Object.defineProperty(response, 'url', { value: 'https://evil.example.com/a.zip' });
      return response;
    });
    const result = await getBytes('https://files.example.com/a.zip', { fetch, allowedHosts: hosts });
    assert.ok(!result.ok);
    assert.equal(result.code, 'BLOCKED');
  });

  it('maps status codes', async () => {
    const cases: Array<[number, string]> = [[404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'UNAVAILABLE']];
    for (const [status, code] of cases) {
      const { fetch } = responder(() => new Response('', { status }));
      const result = await getBytes('https://files.example.com/a.zip', { fetch, allowedHosts: hosts });
      assert.ok(!result.ok);
      assert.equal(result.code, code);
    }
  });

  it('refuses downloads over the size limit, declared or streamed', async () => {
    const declared = responder(() => new Response('x', { headers: { 'content-length': '999999' } }));
    const first = await getBytes('https://files.example.com/a.zip', { fetch: declared.fetch, allowedHosts: hosts, maxBytes: 100 });
    assert.ok(!first.ok);
    assert.equal(first.code, 'TOO_LARGE');

    const streamed = responder(() => new Response(new Uint8Array(500)));
    const second = await getBytes('https://files.example.com/a.zip', { fetch: streamed.fetch, allowedHosts: hosts, maxBytes: 100 });
    assert.ok(!second.ok);
    assert.equal(second.code, 'TOO_LARGE');
  });

  it('reports network failures', async () => {
    const result = await getBytes('https://files.example.com/a.zip', {
      fetch: (async () => { throw new Error('down'); }) as typeof fetch,
      allowedHosts: hosts,
    });
    assert.ok(!result.ok);
    assert.equal(result.code, 'UNAVAILABLE');
  });
});

describe('getText', () => {
  it('returns text and enforces the size limit', async () => {
    const { fetch } = responder(() => new Response('hello'));
    const ok = await getText('https://files.example.com/a.txt', { fetch, allowedHosts: hosts });
    assert.deepEqual(ok, { ok: true, text: 'hello' });
    const big = await getText('https://files.example.com/a.txt', { fetch, allowedHosts: hosts, maxChars: 2 });
    assert.ok(!big.ok);
    assert.equal(big.code, 'TOO_LARGE');
  });
});
