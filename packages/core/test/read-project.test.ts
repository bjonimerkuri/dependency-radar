import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupByName, readProject } from '../src/index.ts';
import type { ReadProjectResult } from '../src/index.ts';

const sample = `{
  "name": "sample-shop",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "react-router-dom": "6.22.1"
  },
  "devDependencies": {
    "vite": "^5.2.0",
    "typescript": "latest"
  }
}`;

function success(result: ReadProjectResult) {
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result;
}

function failed(result: ReadProjectResult) {
  assert.ok(!result.ok);
  return result.error;
}

describe('readProject: valid input', () => {
  it('reads entries from every section', () => {
    const { value } = success(readProject({ packageJson: sample }));
    assert.equal(value.name, 'sample-shop');
    assert.equal(value.version, '1.0.0');
    assert.deepEqual(
      value.entries.map((entry) => [entry.name, entry.section, entry.kind]),
      [
        ['react', 'dependencies', 'range'],
        ['react-router-dom', 'dependencies', 'exact'],
        ['vite', 'devDependencies', 'range'],
        ['typescript', 'devDependencies', 'tag'],
      ],
    );
  });

  it('records the exact line and column of each dependency', () => {
    const { value } = success(readProject({ packageJson: sample }));
    const byName = new Map(value.entries.map((entry) => [entry.name, entry.position]));
    assert.deepEqual(byName.get('react'), { line: 5, column: 5 });
    assert.deepEqual(byName.get('react-router-dom'), { line: 6, column: 5 });
    assert.deepEqual(byName.get('vite'), { line: 9, column: 5 });
    assert.deepEqual(byName.get('typescript'), { line: 10, column: 5 });
  });

  it('counts lines correctly with CRLF line endings', () => {
    const { value } = success(readProject({ packageJson: sample.replace(/\n/g, '\r\n') }));
    const react = value.entries.find((entry) => entry.name === 'react');
    assert.deepEqual(react?.position, { line: 5, column: 5 });
  });

  it('locates keys written with escapes', () => {
    const text = String.raw`{"dependencies":{"a\u0062c":"1.0.0"}}`;
    const { value } = success(readProject({ packageJson: text }));
    assert.equal(value.entries[0]?.name, 'abc');
    assert.ok(value.entries[0]?.position);
  });

  it('accepts a leading BOM', () => {
    const { value } = success(readProject({ packageJson: '\uFEFF{"dependencies":{"a":"1.0.0"}}' }));
    assert.equal(value.entries.length, 1);
  });

  it('reads metadata', () => {
    const text = JSON.stringify({
      name: 'x',
      private: true,
      packageManager: 'pnpm@9.1.0',
      engines: { node: '>=20', bad: 1 },
      scripts: { build: 'vite build', postinstall: 'node setup.js', broken: 5 },
      dependencies: { a: '1.0.0' },
    });
    const { value } = success(readProject({ packageJson: text }));
    assert.equal(value.private, true);
    assert.equal(value.packageManager, 'pnpm@9.1.0');
    assert.deepEqual(value.engines, { node: '>=20' });
    assert.deepEqual(value.scripts, { build: 'vite build', postinstall: 'node setup.js' });
  });
});

describe('readProject: invalid input', () => {
  it('rejects an empty file', () => {
    assert.equal(failed(readProject({ packageJson: '   ' })).code, 'EMPTY');
  });

  it('rejects a file over the size limit', () => {
    const error = failed(readProject({ packageJson: sample }, { maxPackageJsonBytes: 10 }));
    assert.equal(error.code, 'TOO_LARGE');
  });

  it('reports line and column for invalid JSON', () => {
    const text = '{\n  "a": 1,\n  "b": ,\n}';
    const error = failed(readProject({ packageJson: text }));
    assert.equal(error.code, 'INVALID_JSON');
    assert.deepEqual(error.position, { line: 3, column: 8 });
    assert.match(error.message, /line 3, column 8/);
  });

  it('reports the same position with CRLF', () => {
    const text = '{\r\n  "a": 1,\r\n  "b": ,\r\n}';
    assert.deepEqual(failed(readProject({ packageJson: text })).position, { line: 3, column: 8 });
  });

  it('rejects JSON that is not an object', () => {
    for (const text of ['[]', 'null', '123', '"text"']) {
      assert.equal(failed(readProject({ packageJson: text })).code, 'NOT_AN_OBJECT');
    }
  });
});

describe('readProject: warnings and skipped entries', () => {
  it('skips unsafe package names', () => {
    const text = '{"dependencies":{"__proto__":"1.0.0","constructor":"1.0.0","ok":"1.0.0"}}';
    const result = success(readProject({ packageJson: text }));
    assert.deepEqual(result.value.entries.map((entry) => entry.name), ['ok']);
    assert.equal(result.warnings.filter((warning) => warning.code === 'UNSAFE_NAME').length, 2);
  });

  it('skips invalid package names', () => {
    const result = success(readProject({ packageJson: '{"dependencies":{"Bad Name!":"1.0.0"}}' }));
    assert.equal(result.value.entries.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'INVALID_NAME'));
  });

  it('skips non-string versions', () => {
    const result = success(readProject({ packageJson: '{"dependencies":{"a":1,"b":"1.0.0"}}' }));
    assert.deepEqual(result.value.entries.map((entry) => entry.name), ['b']);
    assert.ok(result.warnings.some((warning) => warning.code === 'INVALID_SPEC'));
  });

  it('ignores a section that is not an object', () => {
    const result = success(readProject({ packageJson: '{"dependencies":["a"]}' }));
    assert.equal(result.value.entries.length, 0);
    assert.ok(result.warnings.some((warning) => warning.code === 'INVALID_SECTION'));
    assert.ok(result.warnings.some((warning) => warning.code === 'NO_DEPENDENCIES'));
  });

  it('marks non-registry specifiers as not analyzable without failing', () => {
    const text = JSON.stringify({
      dependencies: { a: 'workspace:*', b: 'file:../b', c: 'github:u/c', d: '^1.0.0' },
    });
    const { value } = success(readProject({ packageJson: text }));
    assert.deepEqual(
      value.entries.map((entry) => [entry.name, entry.analyzable]),
      [['a', false], ['b', false], ['c', false], ['d', true]],
    );
  });

  it('groups a package that appears in several sections', () => {
    const text = JSON.stringify({
      dependencies: { react: '^18.2.0' },
      devDependencies: { react: '^18.2.0' },
      peerDependencies: { react: '>=17' },
    });
    const { value, warnings } = success(readProject({ packageJson: text }));
    const groups = groupByName(value.entries);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.entries.length, 3);
    assert.equal(warnings.some((warning) => warning.code === 'CONFLICTING_SPEC'), false);
  });

  it('warns when dependencies and devDependencies disagree', () => {
    const text = JSON.stringify({
      dependencies: { react: '^18.2.0' },
      devDependencies: { react: '^17.0.0' },
    });
    const { warnings } = success(readProject({ packageJson: text }));
    assert.ok(warnings.some((warning) => warning.code === 'CONFLICTING_SPEC' && warning.name === 'react'));
  });

  it('warns about workspaces in both forms', () => {
    for (const workspaces of [['packages/*'], { packages: ['packages/*'] }]) {
      const text = JSON.stringify({ workspaces, dependencies: { a: '1.0.0' } });
      const result = success(readProject({ packageJson: text }));
      assert.deepEqual(result.value.workspaces, ['packages/*']);
      assert.ok(result.warnings.some((warning) => warning.code === 'MONOREPO'));
    }
  });
});

describe('readProject: lockfile', () => {
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/react': { version: '18.2.0' },
      'node_modules/vite': { version: '5.2.8' },
    },
  });

  it('warns when no lockfile is given', () => {
    const { warnings } = success(readProject({ packageJson: sample }));
    assert.ok(warnings.some((warning) => warning.code === 'NO_LOCKFILE'));
  });

  it('fills installed versions from package-lock.json', () => {
    const { value, warnings } = success(readProject({ packageJson: sample, lockfile: lock }));
    const installed = new Map(value.entries.map((entry) => [entry.name, entry.installed]));
    assert.equal(installed.get('react'), '18.2.0');
    assert.equal(installed.get('vite'), '5.2.8');
    assert.equal(installed.get('typescript'), undefined);
    assert.equal(warnings.some((warning) => warning.code === 'NO_LOCKFILE'), false);
  });

  it('warns about unsupported lockfile formats', () => {
    const { warnings } = success(readProject({ packageJson: sample, lockfile: "lockfileVersion: '9.0'" }));
    assert.ok(warnings.some((warning) => warning.code === 'LOCKFILE_UNSUPPORTED'));
  });

  it('warns about invalid lockfiles without failing', () => {
    const { warnings } = success(readProject({ packageJson: sample, lockfile: '{' }));
    assert.ok(warnings.some((warning) => warning.code === 'LOCKFILE_INVALID'));
  });

  it('warns about oversized lockfiles', () => {
    const { warnings } = success(readProject({ packageJson: sample, lockfile: lock }, { maxLockfileBytes: 5 }));
    assert.ok(warnings.some((warning) => warning.code === 'LOCKFILE_TOO_LARGE'));
  });
});
