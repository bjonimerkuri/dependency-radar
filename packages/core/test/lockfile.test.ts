import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseLockfile } from '../src/index.ts';

const v3 = JSON.stringify({
  name: 'x',
  lockfileVersion: 3,
  packages: {
    '': { name: 'x' },
    'node_modules/react': { version: '18.2.0' },
    'node_modules/@types/node': { version: '22.1.0' },
    'node_modules/a/node_modules/react': { version: '17.0.2' },
    'node_modules/linked': { link: true, resolved: '../linked' },
  },
});

const v1 = JSON.stringify({
  lockfileVersion: 1,
  dependencies: { react: { version: '18.2.0' }, lodash: { version: '4.17.21' } },
});

describe('parseLockfile', () => {
  it('reads top-level packages from lockfile v3', () => {
    const result = parseLockfile(v3);
    assert.ok(result.ok);
    assert.equal(result.value.lockfileVersion, 3);
    assert.equal(result.value.installed.get('react'), '18.2.0');
    assert.equal(result.value.installed.get('@types/node'), '22.1.0');
  });

  it('ignores nested copies and linked packages', () => {
    const result = parseLockfile(v3);
    assert.ok(result.ok);
    assert.equal(result.value.installed.has('a/node_modules/react'), false);
    assert.equal(result.value.installed.has('linked'), false);
  });

  it('reads lockfile v1', () => {
    const result = parseLockfile(v1);
    assert.ok(result.ok);
    assert.equal(result.value.lockfileVersion, 1);
    assert.equal(result.value.installed.get('lodash'), '4.17.21');
  });

  it('reports pnpm and yarn lockfiles as unsupported', () => {
    const result = parseLockfile("lockfileVersion: '9.0'\n");
    assert.ok(!result.ok);
    assert.equal(result.code, 'UNSUPPORTED');
  });

  it('reports invalid JSON', () => {
    const result = parseLockfile('{');
    assert.ok(!result.ok);
    assert.equal(result.code, 'INVALID');
  });

  it('rejects JSON that is not a lockfile', () => {
    const result = parseLockfile('{}');
    assert.ok(!result.ok);
    assert.equal(result.code, 'INVALID');
  });

  it('tolerates a BOM', () => {
    assert.ok(parseLockfile('\uFEFF' + v1).ok);
  });
});
