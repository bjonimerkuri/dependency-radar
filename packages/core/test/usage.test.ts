import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeEntry,
  attachImpact,
  buildUsageIndex,
  computeImpact,
  describeImpact,
  isInScripts,
  parseSpecifier,
  scanProject,
} from '../src/index.ts';
import type { DependencyEntry, Packument } from '../src/index.ts';

const project = scanProject([
  { path: 'src/router.tsx', content: "import * as rr from 'react-router-dom';\nrr.json({});\nrr.redirect('/');" },
  { path: 'src/App.tsx', content: "import { Link } from 'react-router-dom';\nimport type { FC } from 'react';\nconst x = <Link />;" },
  { path: 'src/types.ts', content: "import type { Foo } from 'only-types';\nlet f: Foo;" },
  { path: 'src/dead.ts', content: "import { never } from 'dead-import';" },
  { path: 'src/dyn.ts', content: "const m = await import('lazy-lib');\nconsole.log(m);" },
  { path: 'src/a.ts', content: "import get from 'lodash/get';\nget({}, 'a');" },
  { path: 'src/b.ts', content: "import set from 'lodash/set';\nset({}, 'a', 1);" },
]);

const index = buildUsageIndex(project.imports);
const scripts = { build: 'vite build', lint: 'eslint . --max-warnings 0', test: 'node ./node_modules/.bin/vitest run' };

describe('buildUsageIndex', () => {
  it('groups imports by package', () => {
    const usage = index.get('react-router-dom');
    assert.deepEqual(usage?.files, ['src/App.tsx', 'src/router.tsx']);
    assert.equal(usage?.importCount, 2);
    assert.deepEqual(usage?.symbols.sort(), ['*', 'Link']);
    assert.deepEqual(usage?.members, ['json', 'redirect']);
  });

  it('merges subpath imports into the package', () => {
    const usage = index.get('lodash');
    assert.deepEqual(usage?.files, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(usage?.subpaths.sort(), ['get', 'set']);
  });

  it('tracks type-only, unused and dynamic usage', () => {
    assert.equal(index.get('react')?.typeOnly, true);
    assert.equal(index.get('only-types')?.typeOnly, true);
    assert.equal(index.get('dead-import')?.unusedOnly, true);
    assert.equal(index.get('lazy-lib')?.dynamic, true);
  });
});

describe('isInScripts', () => {
  it('matches command names and paths to binaries', () => {
    assert.equal(isInScripts('vite', scripts), true);
    assert.equal(isInScripts('eslint', scripts), true);
    assert.equal(isInScripts('vitest', scripts), true);
  });

  it('does not match substrings', () => {
    assert.equal(isInScripts('vit', scripts), false);
    assert.equal(isInScripts('esl', scripts), false);
  });
});

describe('computeImpact', () => {
  it('reports used packages with files and symbols', () => {
    const impact = computeImpact('react-router-dom', index, scripts);
    assert.equal(impact.level, 'used');
    assert.equal(impact.fileCount, 2);
    assert.deepEqual(impact.members, ['json', 'redirect']);
  });

  it('distinguishes type-only, unused, scripts-only and not found', () => {
    assert.equal(computeImpact('only-types', index, scripts).level, 'type-only');
    assert.equal(computeImpact('dead-import', index, scripts).level, 'unused');
    assert.equal(computeImpact('eslint', index, scripts).level, 'scripts-only');
    assert.equal(computeImpact('nowhere', index, scripts).level, 'not-found');
  });

  it('maps @types packages to the package they describe', () => {
    assert.equal(computeImpact('@types/react', index, scripts).level, 'type-only');
    assert.equal(computeImpact('@types/lodash', index, scripts).level, 'used');
    const scoped = buildUsageIndex(
      scanProject([{ path: 'a.ts', content: "import { x } from '@scope/pkg';\nx();" }]).imports,
    );
    assert.equal(computeImpact('@types/scope__pkg', scoped, {}).level, 'used');
  });

  it('caps the number of files listed', () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, content: "import a from 'many';\na();" }));
    const many = buildUsageIndex(scanProject(files).imports);
    const impact = computeImpact('many', many, {});
    assert.equal(impact.fileCount, 30);
    assert.equal(impact.files.length, 20);
  });
});

describe('describeImpact', () => {
  it('describes each level', () => {
    assert.match(describeImpact(computeImpact('react-router-dom', index, scripts)), /Used in 2 files: src\/App\.tsx, src\/router\.tsx\. Uses: Link, json, redirect/);
    assert.match(describeImpact(computeImpact('only-types', index, scripts)), /Only imported as types in 1 file/);
    assert.match(describeImpact(computeImpact('dead-import', index, scripts)), /appear unused/);
    assert.match(describeImpact(computeImpact('eslint', index, scripts)), /package\.json scripts/);
    assert.match(describeImpact(computeImpact('nowhere', index, scripts)), /Not imported in any scanned file/);
  });
});

describe('attachImpact', () => {
  it('adds impact to analyzed results only', () => {
    const entry: DependencyEntry = { name: 'react-router-dom', section: 'dependencies', spec: '6.22.1', kind: 'exact', analyzable: true };
    const packument: Packument = {
      name: 'react-router-dom',
      distTags: { latest: '7.1.0' },
      versions: { '6.22.1': { peerDependencies: {} }, '7.1.0': { peerDependencies: {} } },
    };
    const analyzed = analyzeEntry({ ...entry, ...parseSpecifierFields(entry.spec) }, packument, () => undefined);
    const skipped = { ...analyzed, name: 'other', status: 'skipped' as const };
    attachImpact([analyzed, skipped], index, scripts);
    assert.equal(analyzed.impact?.level, 'used');
    assert.equal(skipped.impact, undefined);
  });
});

function parseSpecifierFields(spec: string) {
  const parsed = parseSpecifier(spec);
  return { kind: parsed.kind, analyzable: parsed.analyzable };
}
