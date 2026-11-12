import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeProject,
  attachImpact,
  buildUsageIndex,
  describeImpact,
  readProject,
  readTsconfigAliasKeys,
  scanProject,
} from '../src/index.ts';
import type { FetchPackumentResult, RegistryClient } from '../src/index.ts';

const packageJson = JSON.stringify({
  name: 'sample-shop',
  scripts: { build: 'vite build', lint: 'eslint .' },
  dependencies: { react: '^18.2.0', 'react-router-dom': '6.22.1', zod: '^3.22.4', lodash: '^4.17.21' },
  devDependencies: { vite: '^5.2.0', eslint: '^8.57.0', '@types/lodash': '^4.14.0' },
});

const sources = [
  {
    path: 'src/router.tsx',
    content: "import { createBrowserRouter, json } from 'react-router-dom';\nexport const r = createBrowserRouter([]);\nexport const data = () => json({});",
  },
  { path: 'src/App.tsx', content: "import React from 'react';\nimport { z } from '@/schemas/z';\nexport const App = () => <div />;" },
  { path: 'src/util.ts', content: "import get from 'lodash/get';\nexport const g = (o: object) => get(o, 'a');" },
  { path: 'vite.config.ts', content: "import { defineConfig } from 'vite';\nexport default defineConfig({});" },
];

const tsconfig = '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } } }';

function ok(latest: string, versions: string[]): FetchPackumentResult {
  const built: Record<string, { peerDependencies: Record<string, string> }> = {};
  for (const version of versions) built[version] = { peerDependencies: {} };
  return { ok: true, packument: { name: 'x', distTags: { latest }, versions: built } };
}

const registry: RegistryClient = {
  async getPackument(name) {
    const map: Record<string, FetchPackumentResult> = {
      react: ok('18.3.1', ['18.2.0', '18.3.1']),
      'react-router-dom': ok('7.1.0', ['6.22.1', '7.1.0']),
      zod: ok('3.23.8', ['3.22.4', '3.23.8']),
      lodash: ok('4.17.21', ['4.17.21']),
      vite: ok('5.4.2', ['5.2.0', '5.4.2']),
      eslint: ok('9.12.0', ['8.57.0', '9.12.0']),
      '@types/lodash': ok('4.17.0', ['4.14.0', '4.17.0']),
    };
    return map[name] ?? { ok: false, code: 'NOT_FOUND', message: 'not found' };
  },
};

describe('end to end: read, analyze, scan, attach impact', () => {
  it('connects a major update to the files that use the package', async () => {
    const parsed = readProject({ packageJson });
    assert.ok(parsed.ok);
    const analysis = await analyzeProject(parsed.value.entries, { registry });
    const scan = scanProject(sources, {
      aliasKeys: readTsconfigAliasKeys(tsconfig),
      knownPackages: parsed.value.entries.map((entry) => entry.name),
    });
    attachImpact(analysis.results, buildUsageIndex(scan.imports), parsed.value.scripts);

    const byName = new Map(analysis.results.map((result) => [result.name, result]));

    const router = byName.get('react-router-dom');
    assert.equal(router?.preliminary, 'breaking-candidate');
    assert.equal(router?.impact?.level, 'used');
    assert.deepEqual(router?.impact?.files, ['src/router.tsx']);
    assert.match(describeImpact(router!.impact!), /Used in 1 file: src\/router\.tsx\. Uses: createBrowserRouter, json/);

    assert.equal(byName.get('zod')?.impact?.level, 'not-found');
    assert.equal(byName.get('lodash')?.impact?.level, 'used');
    assert.equal(byName.get('@types/lodash')?.impact?.level, 'used');
    assert.equal(byName.get('vite')?.impact?.level, 'used');
    assert.equal(byName.get('eslint')?.impact?.level, 'scripts-only');
    assert.equal(byName.get('eslint')?.preliminary, 'breaking-candidate');
  });
});
