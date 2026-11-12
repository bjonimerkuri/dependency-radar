import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readZip } from '../src/zip.ts';
import { makeZip } from './zip-helper.ts';

function files(result: ReturnType<typeof readZip>) {
  assert.ok(result.ok, result.ok ? '' : result.message);
  return result;
}

describe('readZip', () => {
  it('reads stored and deflated files', () => {
    const zip = makeZip([
      { name: 'a.txt', data: 'hello', method: 8 },
      { name: 'dir/b.txt', data: 'world', method: 0 },
      { name: 'dir/', data: '', method: 0 },
    ]);
    const result = files(readZip(zip));
    assert.deepEqual(result.files, [{ path: 'a.txt', content: 'hello' }, { path: 'dir/b.txt', content: 'world' }]);
    assert.equal(result.skipped, 0);
  });

  it('reads unicode content and unicode names', () => {
    const result = files(readZip(makeZip([{ name: 'caf\u00e9/\u03b1.txt', data: 'na\u00efve \u2713' }])));
    assert.deepEqual(result.files, [{ path: 'caf\u00e9/\u03b1.txt', content: 'na\u00efve \u2713' }]);
  });

  it('reads archives with a trailing comment', () => {
    const result = files(readZip(makeZip([{ name: 'a.txt', data: 'x' }], 'created by a test')));
    assert.equal(result.files.length, 1);
  });

  it('only inflates the files that are asked for', () => {
    const zip = makeZip([
      { name: 'src/a.ts', data: 'a' },
      { name: 'image.png', data: 'x'.repeat(2000) },
    ]);
    const seen: string[] = [];
    const result = files(readZip(zip, { include: (path) => (seen.push(path), path.endsWith('.ts')) }));
    assert.deepEqual(result.files.map((file) => file.path), ['src/a.ts']);
    assert.deepEqual(seen, ['src/a.ts', 'image.png']);
  });

  it('skips unsafe names', () => {
    const zip = makeZip([
      { name: '../evil.txt', data: 'x' },
      { name: '/abs.txt', data: 'x' },
      { name: 'a/../../b.txt', data: 'x' },
      { name: 'C:/windows.txt', data: 'x' },
      { name: 'ok.txt', data: 'x' },
    ]);
    const result = files(readZip(zip));
    assert.deepEqual(result.files.map((file) => file.path), ['ok.txt']);
    assert.equal(result.skipped, 4);
  });

  it('skips encrypted entries and unsupported compression', () => {
    const zip = makeZip([
      { name: 'secret.txt', data: 'x', flags: 1 },
      { name: 'ok.txt', data: 'x' },
    ]);
    const result = files(readZip(zip));
    assert.deepEqual(result.files.map((file) => file.path), ['ok.txt']);
    assert.equal(result.skipped, 1);
  });

  it('skips entries whose checksum or size does not match', () => {
    const zip = makeZip([
      { name: 'badcrc.txt', data: 'hello', crc: 123 },
      { name: 'badsize.txt', data: 'hello', declaredSize: 3 },
      { name: 'good.txt', data: 'hello' },
    ]);
    const result = files(readZip(zip));
    assert.deepEqual(result.files.map((file) => file.path), ['good.txt']);
    assert.equal(result.skipped, 2);
  });

  it('does not expand a zip bomb beyond the declared size', () => {
    const zip = makeZip([
      { name: 'bomb.txt', data: 'A'.repeat(5_000_000), declaredSize: 10 },
      { name: 'ok.txt', data: 'fine' },
    ]);
    const result = files(readZip(zip));
    assert.deepEqual(result.files.map((file) => file.path), ['ok.txt']);
  });

  it('skips single files over the limit and stops at the total limit', () => {
    const zip = makeZip([
      { name: 'big.txt', data: 'x'.repeat(2000) },
      { name: 'a.txt', data: 'x'.repeat(600) },
      { name: 'b.txt', data: 'x'.repeat(600) },
      { name: 'c.txt', data: 'x'.repeat(600) },
    ]);
    const result = files(readZip(zip, { maxFileBytes: 1000, maxTotalBytes: 1500 }));
    assert.deepEqual(result.files.map((file) => file.path), ['a.txt', 'b.txt']);
    assert.equal(result.truncated, true);
    assert.equal(result.skipped, 1);
  });

  it('rejects things that are not zip files', () => {
    for (const data of [new Uint8Array(0), new Uint8Array(10), new TextEncoder().encode('this is plainly not a zip archive')]) {
      const result = readZip(data);
      assert.ok(!result.ok);
      assert.equal(result.code, 'NOT_A_ZIP');
    }
  });

  it('rejects archives that are too large or have too many entries', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'x' }, { name: 'b.txt', data: 'x' }]);
    const large = readZip(zip, { maxZipBytes: 10 });
    assert.ok(!large.ok);
    assert.equal(large.code, 'TOO_LARGE');
    const many = readZip(zip, { maxEntries: 1 });
    assert.ok(!many.ok);
    assert.equal(many.code, 'TOO_MANY_ENTRIES');
  });

  it('rejects a damaged directory', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
    const damaged = zip.slice();
    const view = new DataView(damaged.buffer);
    view.setUint32(damaged.length - 22 + 16, 5, true);
    const result = readZip(damaged);
    assert.ok(!result.ok);
    assert.equal(result.code, 'CORRUPT');
  });

  it('reports zip64 archives clearly', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello' }]);
    const marked = zip.slice();
    new DataView(marked.buffer).setUint32(marked.length - 22 + 16, 0xffffffff, true);
    const result = readZip(marked);
    assert.ok(!result.ok);
    assert.equal(result.code, 'ZIP64');
  });

  it('does not crash on random bytes', () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let round = 0; round < 50; round++) {
      const data = new Uint8Array(300);
      for (let i = 0; i < data.length; i++) data[i] = next();
      assert.doesNotThrow(() => readZip(data));
    }
  });

  it('does not crash on mutated real archives', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'hello world' }, { name: 'b/c.txt', data: 'more text' }]);
    for (let i = 0; i < zip.length; i++) {
      const mutated = zip.slice();
      mutated[i] = (mutated[i] ?? 0) ^ 0xff;
      assert.doesNotThrow(() => readZip(mutated), `byte ${i}`);
    }
  });
});
