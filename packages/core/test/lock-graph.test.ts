import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLockGraph } from '../src/index.ts';

const v3 = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app', dependencies: { express: '^4.17.1', lodash: '^4.17.20' }, devDependencies: { jest: '^29.0.0' } },
    'node_modules/express': { version: '4.17.1', dependencies: { qs: '6.7.0', 'body-parser': '1.19.0' } },
    'node_modules/body-parser': { version: '1.19.0', dependencies: { qs: '6.7.0' } },
    'node_modules/qs': { version: '6.7.0' },
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/jest': { version: '29.0.0', dev: true, dependencies: { lodash: '^4.17.0' } },
    'node_modules/jest/node_modules/qs': { version: '6.5.0', dev: true },
    'node_modules/linked': { link: true, resolved: '../linked' },
    'packages/web': { name: 'web', version: '1.0.0', dependencies: { qs: '^6.0.0' } },
  },
});

describe('buildLockGraph', () => {
  const graph = buildLockGraph(v3);

  it('reads every installed package with its name, version and flags', () => {
    assert.equal(graph?.lockfileVersion, 3);
    assert.deepEqual(graph?.byName('qs').map((node) => [node.path, node.version, node.dev]).sort(), [
      ['node_modules/jest/node_modules/qs', '6.5.0', true],
      ['node_modules/qs', '6.7.0', false],
    ]);
    assert.equal(graph?.byName('jest')[0]?.dev, true);
    assert.deepEqual(graph?.byName('missing'), []);
    assert.equal(graph?.byName('linked').length, 0);
  });

  it('finds who depends on a package and with which range', () => {
    const dependents = graph?.dependents('node_modules/qs') ?? [];
    assert.deepEqual(dependents.map((entry) => [entry.from, entry.range]).sort(), [
      ['node_modules/body-parser', '6.7.0'],
      ['node_modules/express', '6.7.0'],
      ['packages/web', '^6.0.0'],
    ]);
    assert.deepEqual(graph?.dependents('node_modules/jest/node_modules/qs'), []);
  });

  it('finds the shortest chains from the project to a package', () => {
    assert.deepEqual(graph?.chains('node_modules/qs'), [['project', 'express@4.17.1', 'qs@6.7.0']]);
    assert.deepEqual(graph?.chains('node_modules/lodash'), [['project', 'lodash@4.17.20']]);
    assert.deepEqual(graph?.chains('node_modules/express'), [['project', 'express@4.17.1']]);
  });

  it('lists several equally short chains and can limit them', () => {
    const two = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '1', b: '1' } },
          'node_modules/a': { version: '1.0.0', dependencies: { qs: '1' } },
          'node_modules/b': { version: '2.0.0', dependencies: { qs: '1' } },
          'node_modules/qs': { version: '1.0.0' },
        },
      }),
    );
    assert.deepEqual(two?.chains('node_modules/qs').sort(), [['project', 'a@1.0.0', 'qs@1.0.0'], ['project', 'b@2.0.0', 'qs@1.0.0']]);
    assert.equal(two?.chains('node_modules/qs', 1).length, 1);
  });

  it('returns nothing for packages that cannot be reached', () => {
    assert.deepEqual(graph?.chains('node_modules/jest/node_modules/qs'), []);
    assert.deepEqual(graph?.chains('node_modules/does-not-exist'), []);
  });

  it('uses nested copies for the packages that sit next to them', () => {
    const nested = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '1', b: '1' } },
          'node_modules/a': { version: '1.0.0', dependencies: { qs: '^6.5.0' } },
          'node_modules/a/node_modules/qs': { version: '6.5.0' },
          'node_modules/b': { version: '1.0.0', dependencies: { qs: '^6.7.0' } },
          'node_modules/qs': { version: '6.7.0' },
        },
      }),
    );
    assert.deepEqual(nested?.dependents('node_modules/a/node_modules/qs').map((entry) => entry.from), ['node_modules/a']);
    assert.deepEqual(nested?.dependents('node_modules/qs').map((entry) => entry.from), ['node_modules/b']);
  });

  it('survives cycles', () => {
    const cyclic = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '1' } },
          'node_modules/a': { version: '1.0.0', dependencies: { b: '1' } },
          'node_modules/b': { version: '1.0.0', dependencies: { a: '1', c: '1' } },
          'node_modules/c': { version: '1.0.0' },
        },
      }),
    );
    assert.deepEqual(cyclic?.chains('node_modules/c'), [['project', 'a@1.0.0', 'b@1.0.0', 'c@1.0.0']]);
  });

  it('reads the old nested lockfile format', () => {
    const v1 = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          express: { version: '4.17.1', requires: { qs: '6.7.0' }, dependencies: { qs: { version: '6.7.0' } } },
          lodash: { version: '4.17.20', dev: true },
        },
      }),
      { express: '^4.17.1' },
    );
    assert.equal(v1?.lockfileVersion, 1);
    assert.deepEqual(v1?.byName('qs').map((node) => node.path), ['node_modules/express/node_modules/qs']);
    assert.deepEqual(v1?.chains('node_modules/express/node_modules/qs'), [['project', 'express@4.17.1', 'qs@6.7.0']]);
    assert.equal(v1?.byName('lodash')[0]?.dev, true);
  });

  it('rejects things that are not lockfiles', () => {
    for (const text of ['', 'not json', '[]', '{}', '{"name":"x"}']) assert.equal(buildLockGraph(text), undefined, text);
  });
});
