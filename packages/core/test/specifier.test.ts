import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSpecifier } from '../src/index.ts';
import type { SpecKind } from '../src/index.ts';

const cases: Array<[string, SpecKind, boolean]> = [
  ['1.2.3', 'exact', true],
  ['v1.2.3', 'exact', true],
  ['1.2.3-beta.1', 'exact', true],
  ['^1.2.3', 'range', true],
  ['~1.2', 'range', true],
  ['1.x', 'range', true],
  ['>=1.0.0 <2.0.0', 'range', true],
  ['1.2.3 - 2.0.0', 'range', true],
  ['^1.0.0 || ^2.0.0', 'range', true],
  ['*', 'any', true],
  ['', 'any', true],
  ['x', 'any', true],
  ['latest', 'tag', true],
  ['next', 'tag', true],
  ['beta', 'tag', true],
  ['workspace:*', 'workspace', false],
  ['workspace:^1.0.0', 'workspace', false],
  ['file:../lib', 'local', false],
  ['link:../lib', 'local', false],
  ['portal:../lib', 'local', false],
  ['git+https://github.com/a/b.git', 'git', false],
  ['git@github.com:a/b.git', 'git', false],
  ['github:user/repo', 'git', false],
  ['user/repo', 'git', false],
  ['user/repo#main', 'git', false],
  ['https://example.com/pkg.tgz', 'url', false],
  ['npm:react@^18.0.0', 'alias', true],
  ['npm:react', 'alias', true],
  ['npm:', 'unknown', false],
  ['!!!', 'unknown', false],
];

describe('parseSpecifier', () => {
  for (const [spec, kind, analyzable] of cases) {
    it(`classifies ${JSON.stringify(spec)} as ${kind}`, () => {
      const result = parseSpecifier(spec);
      assert.equal(result.kind, kind);
      assert.equal(result.analyzable, analyzable);
      if (!analyzable) assert.ok(result.reason);
    });
  }

  it('extracts the target of a scoped alias with a range', () => {
    const result = parseSpecifier('npm:@scope/pkg@1.2.3');
    assert.equal(result.aliasOf, '@scope/pkg');
    assert.equal(result.aliasRange, '1.2.3');
  });

  it('uses latest for an alias without a range', () => {
    const result = parseSpecifier('npm:react');
    assert.equal(result.aliasOf, 'react');
    assert.equal(result.aliasRange, 'latest');
  });

  it('keeps the original text', () => {
    assert.equal(parseSpecifier(' ^1.0.0 ').raw, ' ^1.0.0 ');
  });
});
