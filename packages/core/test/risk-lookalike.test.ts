import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findLookalike, isPopularPackage, POPULAR_PACKAGES } from '../src/index.ts';

describe('findLookalike', () => {
  it('finds separator variants of popular packages', () => {
    assert.deepEqual(findLookalike('crossenv'), { popular: 'cross-env', kind: 'separator' });
    assert.deepEqual(findLookalike('cross_env'), { popular: 'cross-env', kind: 'separator' });
    assert.deepEqual(findLookalike('react.dom'), { popular: 'react-dom', kind: 'separator' });
  });

  it('finds a single typo, a missing letter or a swapped pair', () => {
    assert.deepEqual(findLookalike('lodahs'), { popular: 'lodash', kind: 'edit' });
    assert.deepEqual(findLookalike('expres'), { popular: 'express', kind: 'edit' });
    assert.deepEqual(findLookalike('axois'), { popular: 'axios', kind: 'edit' });
    assert.deepEqual(findLookalike('reactt'), { popular: 'react', kind: 'edit' });
    assert.deepEqual(findLookalike('momnet'), { popular: 'moment', kind: 'edit' });
  });

  it('finds a different spelling of the case', () => {
    assert.deepEqual(findLookalike('React'), { popular: 'react', kind: 'case' });
  });

  it('does not flag popular packages, scoped names or unrelated names', () => {
    for (const name of ['react', 'lodash', 'cross-env', '@scope/lodash', '@types/react', 'left-pad', 'chalk-template', 'my-internal-tool', 'vue', 'ws']) {
      assert.equal(findLookalike(name), undefined, name);
    }
  });

  it('does not flag known real packages that happen to be close', () => {
    for (const name of ['color', 'vitest', 'chain']) assert.equal(findLookalike(name), undefined, name);
  });

  it('only compares against names long enough to be meaningful', () => {
    assert.equal(findLookalike('vuee'), undefined);
    assert.equal(findLookalike('wss'), undefined);
  });

  it('has a clean list of names', () => {
    assert.ok(POPULAR_PACKAGES.length > 200);
    assert.ok(POPULAR_PACKAGES.every((name) => /^[a-z0-9][a-z0-9._-]*$/.test(name)), 'names are lowercase and valid');
    assert.equal(isPopularPackage('express'), true);
    assert.equal(isPopularPackage('expres'), false);
  });
});
