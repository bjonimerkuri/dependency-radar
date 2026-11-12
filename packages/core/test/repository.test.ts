import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRepositoryField } from '../src/index.ts';

const github = (owner: string, repo: string, directory?: string) =>
  directory === undefined ? { kind: 'github', owner, repo } : { kind: 'github', owner, repo, directory };

describe('parseRepositoryField', () => {
  it('reads the common GitHub URL forms', () => {
    const urls = [
      'git+https://github.com/remix-run/react-router.git',
      'https://github.com/remix-run/react-router',
      'https://www.github.com/remix-run/react-router/',
      'git://github.com/remix-run/react-router.git',
      'ssh://git@github.com/remix-run/react-router.git',
      'git@github.com:remix-run/react-router.git',
      'github:remix-run/react-router',
      'remix-run/react-router',
      'https://github.com/remix-run/react-router#readme',
    ];
    for (const url of urls) assert.deepEqual(parseRepositoryField(url), github('remix-run', 'react-router'), url);
  });

  it('reads the object form with a directory', () => {
    const ref = parseRepositoryField({ type: 'git', url: 'git+https://github.com/babel/babel.git', directory: 'packages/babel-core' });
    assert.deepEqual(ref, github('babel', 'babel', 'packages/babel-core'));
  });

  it('ignores unsafe directories', () => {
    const ref = parseRepositoryField({ url: 'https://github.com/a/b', directory: '../etc' });
    assert.deepEqual(ref, github('a', 'b'));
  });

  it('reports other hosts', () => {
    for (const url of ['https://gitlab.com/a/b', 'gitlab:a/b', 'bitbucket:a/b', 'https://example.com/a/b.git']) {
      assert.deepEqual(parseRepositoryField(url), { kind: 'other' }, url);
    }
  });

  it('reports a missing repository', () => {
    for (const value of [undefined, null, '', {}, 42, { url: 5 }]) {
      assert.deepEqual(parseRepositoryField(value), { kind: 'none' });
    }
  });

  it('falls back to a GitHub homepage', () => {
    assert.deepEqual(parseRepositoryField(undefined, 'https://github.com/a/b#readme'), github('a', 'b'));
    assert.deepEqual(parseRepositoryField(undefined, 'https://example.com'), { kind: 'none' });
  });
});
