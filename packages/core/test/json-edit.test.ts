import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyEdits, detectIndentUnit, detectNewline, memberOf, parseJsonOffsets, setJsonMember } from '../src/index.ts';

function set(text: string, path: string[], key: string, value: string): string {
  const edit = setJsonMember(text, path, key, value);
  assert.ok(edit, 'an edit was expected');
  const result = applyEdits(text, [edit]);
  JSON.parse(result);
  return result;
}

describe('parseJsonOffsets', () => {
  it('records where every member and value starts and ends', () => {
    const text = '{ "a": "x", "b": { "c": [1, 2] }, "d": true }';
    const root = parseJsonOffsets(text);
    assert.equal(root?.type, 'object');
    assert.equal(root?.start, 0);
    assert.equal(root?.end, text.length);
    const a = memberOf(root, 'a');
    assert.equal(text.slice(a?.value.start, a?.value.end), '"x"');
    assert.equal(text.slice(a?.keyStart, a?.keyEnd), '"a"');
    const b = memberOf(root, 'b');
    assert.equal(text.slice(b?.value.start, b?.value.end), '{ "c": [1, 2] }');
    assert.equal(text.slice(memberOf(b?.value, 'c')?.value.start, memberOf(b?.value, 'c')?.value.end), '[1, 2]');
    assert.equal(text.slice(memberOf(root, 'd')?.value.start, memberOf(root, 'd')?.value.end), 'true');
  });

  it('handles escapes, unicode, nesting and empty containers', () => {
    const text = '{"k\\"ey": "va\\\\lue \\u00e9", "e": {}, "f": [], "g": [[{}]]}';
    const root = parseJsonOffsets(text);
    assert.deepEqual(root?.type === 'object' ? root.members.map((member) => member.key) : [], ['k"ey', 'e', 'f', 'g']);
  });

  it('rejects text that is not exactly one JSON value', () => {
    for (const text of ['', '{', '{"a":}', '{"a":1} x', '[1,', '{"a" 1}']) {
      assert.equal(parseJsonOffsets(text), undefined, text);
    }
  });

  it('copes with very deep nesting without crashing', () => {
    assert.doesNotThrow(() => parseJsonOffsets('['.repeat(20_000) + ']'.repeat(20_000)));
  });
});

describe('detectNewline and detectIndentUnit', () => {
  it('detects line endings and the indentation style', () => {
    assert.equal(detectNewline('a\r\nb'), '\r\n');
    assert.equal(detectNewline('a\nb'), '\n');
    assert.equal(detectIndentUnit('{\n  "a": 1\n}'), '  ');
    assert.equal(detectIndentUnit('{\n    "a": 1\n}'), '    ');
    assert.equal(detectIndentUnit('{\n\t"a": 1\n}'), '\t');
    assert.equal(detectIndentUnit('{"a":1}'), '  ');
  });
});

describe('setJsonMember', () => {
  const base = '{\n  "name": "x",\n  "dependencies": {\n    "a": "^1.0.0"\n  }\n}\n';

  it('replaces the value of an existing member and keeps everything else', () => {
    const text = '{\n  "overrides": {\n    "qs": "1.0.0",\n    "other": "2.0.0"\n  }\n}\n';
    const result = set(text, ['overrides'], 'qs', '"6.11.2"');
    assert.equal(result, '{\n  "overrides": {\n    "qs": "6.11.2",\n    "other": "2.0.0"\n  }\n}\n');
  });

  it('adds a member after the last one with the same indentation', () => {
    const result = set(base, ['dependencies'], 'b', '"^2.0.0"');
    assert.equal(result, '{\n  "name": "x",\n  "dependencies": {\n    "a": "^1.0.0",\n    "b": "^2.0.0"\n  }\n}\n');
  });

  it('adds a member to an empty object', () => {
    assert.equal(set('{\n  "overrides": {}\n}\n', ['overrides'], 'qs', '"1.0.0"'), '{\n  "overrides": {\n    "qs": "1.0.0"\n  }\n}\n');
    assert.equal(set('{}', [], 'a', '"b"'), '{\n  "a": "b"\n}');
  });

  it('creates a missing top-level block after the last member', () => {
    const result = set(base, ['overrides'], 'qs', '"6.11.2"');
    assert.equal(result, '{\n  "name": "x",\n  "dependencies": {\n    "a": "^1.0.0"\n  },\n  "overrides": {\n    "qs": "6.11.2"\n  }\n}\n');
  });

  it('adds into an existing parent that lacks the block, and creates both levels when needed', () => {
    const withPnpm = '{\n  "pnpm": {\n    "other": true\n  }\n}\n';
    assert.deepEqual(JSON.parse(set(withPnpm, ['pnpm', 'overrides'], 'qs', '"1.0.0"')), { pnpm: { other: true, overrides: { qs: '1.0.0' } } });
    const result = set(base, ['pnpm', 'overrides'], 'qs', '"1.0.0"');
    assert.deepEqual(JSON.parse(result).pnpm, { overrides: { qs: '1.0.0' } });
    assert.match(result, /\n  "pnpm": \{\n    "overrides": \{\n      "qs": "1\.0\.0"\n    \}\n  \}\n\}/);
  });

  it('keeps tabs and Windows line endings', () => {
    const tabs = '{\n\t"name": "x"\n}\n';
    assert.equal(set(tabs, ['overrides'], 'qs', '"1.0.0"'), '{\n\t"name": "x",\n\t"overrides": {\n\t\t"qs": "1.0.0"\n\t}\n}\n');
    const crlf = '{\r\n  "name": "x"\r\n}\r\n';
    const result = set(crlf, ['overrides'], 'qs', '"1.0.0"');
    assert.equal(result, '{\r\n  "name": "x",\r\n  "overrides": {\r\n    "qs": "1.0.0"\r\n  }\r\n}\r\n');
    assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
  });

  it('works on a file written on one line', () => {
    assert.deepEqual(JSON.parse(set('{"name":"x"}', ['overrides'], 'qs', '"1.0.0"')), { name: 'x', overrides: { qs: '1.0.0' } });
  });

  it('does not guess when the path leads through something that is not an object', () => {
    assert.equal(setJsonMember('{"overrides": "oops"}', ['overrides'], 'qs', '"1"'), undefined);
    assert.equal(setJsonMember('not json', [], 'a', '"b"'), undefined);
    assert.equal(setJsonMember('[1]', [], 'a', '"b"'), undefined);
  });
});

describe('applyEdits', () => {
  it('applies several edits at once in any order', () => {
    const text = '0123456789';
    assert.equal(applyEdits(text, [{ start: 2, end: 4, insert: 'AA' }, { start: 7, end: 7, insert: 'ZZ' }, { start: 0, end: 1, insert: '' }]), '1AA456ZZ789');
  });

  it('refuses overlapping edits', () => {
    assert.throws(() => applyEdits('0123456789', [{ start: 2, end: 6, insert: 'x' }, { start: 4, end: 8, insert: 'y' }]));
  });
});
