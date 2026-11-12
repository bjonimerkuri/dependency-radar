import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDiff, unifiedDiff } from '../src/index.ts';
import type { DiffHunk } from '../src/index.ts';

const numbered = (count: number, mutate: (lines: string[]) => void = () => {}): string => {
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`);
  mutate(lines);
  return `${lines.join('\n')}\n`;
};

function rebuild(oldText: string, hunks: readonly DiffHunk[]): string {
  const oldLines = oldText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  const out: string[] = [];
  let position = 0;
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    while (position < start) out.push(oldLines[position++] as string);
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        out.push(oldLines[position++] as string);
      } else if (line.type === 'remove') {
        position++;
      } else {
        out.push(line.text);
      }
    }
  }
  while (position < oldLines.length) out.push(oldLines[position++] as string);
  return `${out.join('\n')}\n`;
}

describe('computeDiff and unifiedDiff', () => {
  it('returns nothing when the texts are the same, even with different line endings', () => {
    assert.deepEqual(computeDiff('a\nb\n', 'a\nb\n'), []);
    assert.equal(unifiedDiff('x', 'a\nb\n', 'a\r\nb\r\n'), '');
  });

  it('shows a single changed line with three lines of context', () => {
    const before = numbered(20);
    const after = numbered(20, (lines) => (lines[9] = 'changed'));
    assert.equal(
      unifiedDiff('package.json', before, after),
      '--- a/package.json\n+++ b/package.json\n@@ -7,7 +7,7 @@\n line 7\n line 8\n line 9\n-line 10\n+changed\n line 11\n line 12\n line 13\n',
    );
  });

  it('numbers the lines of both sides', () => {
    const hunks = computeDiff(numbered(10), numbered(10, (lines) => lines.splice(4, 0, 'inserted')));
    assert.equal(hunks.length, 1);
    const inserted = hunks[0]?.lines.find((line) => line.type === 'add');
    assert.deepEqual([inserted?.text, inserted?.newNumber, inserted?.oldNumber], ['inserted', 5, undefined]);
    const after = hunks[0]?.lines.find((line) => line.text === 'line 5');
    assert.deepEqual([after?.oldNumber, after?.newNumber], [5, 6]);
  });

  it('handles additions, removals and changes at the start and the end', () => {
    const cases: Array<(lines: string[]) => void> = [
      (lines) => lines.unshift('first'),
      (lines) => lines.push('last'),
      (lines) => lines.shift(),
      (lines) => lines.pop(),
      (lines) => lines.splice(3, 2),
      (lines) => lines.splice(0, lines.length, 'only'),
      (lines) => lines.splice(5, 0, 'a', 'b', 'c'),
    ];
    for (const mutate of cases) {
      const before = numbered(12);
      const after = numbered(12, mutate);
      assert.equal(rebuild(before, computeDiff(before, after)), after);
    }
  });

  it('keeps distant changes in separate hunks and merges near ones', () => {
    const distant = computeDiff(numbered(40), numbered(40, (lines) => { lines[2] = 'a'; lines[35] = 'b'; }));
    assert.equal(distant.length, 2);
    const near = computeDiff(numbered(40), numbered(40, (lines) => { lines[10] = 'a'; lines[14] = 'b'; }));
    assert.equal(near.length, 1);
    const before = numbered(40);
    const after = numbered(40, (lines) => { lines[2] = 'a'; lines[35] = 'b'; });
    assert.equal(rebuild(before, distant), after);
  });

  it('describes a change in an empty file and a deleted file', () => {
    assert.equal(unifiedDiff('x', '', 'a\nb\n'), '--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n');
    assert.equal(unifiedDiff('x', 'a\nb\n', ''), '--- a/x\n+++ b/x\n@@ -1,2 +0,0 @@\n-a\n-b\n');
  });

  it('stays fast and correct on large files', () => {
    const before = numbered(2500);
    const after = numbered(2500, (lines) => { lines[5] = 'near the top'; lines[2490] = 'near the end'; });
    const started = Date.now();
    const hunks = computeDiff(before, after);
    assert.ok(Date.now() - started < 3000);
    assert.equal(hunks.length, 2);
    assert.equal(rebuild(before, hunks), after);
  });

  it('falls back to a plain replacement when the changed area is huge', () => {
    const before = `${Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n')}\n`;
    const after = `${Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n')}\n`;
    const hunks = computeDiff(before, after);
    assert.equal(hunks.length, 1);
    assert.equal(rebuild(before, hunks), after);
  });
});
