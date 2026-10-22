import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DependencyEntry, ProjectAnalysis, UpdateAnalysis, Warning } from '@dependency-radar/core';
import { formatReport } from '../src/format.ts';

function entry(name: string, line: number): DependencyEntry {
  return { name, section: 'dependencies', spec: '^1.0.0', kind: 'range', analyzable: true, position: { line, column: 5 } };
}

function result(name: string, extra: Partial<UpdateAnalysis>): UpdateAnalysis {
  return {
    name,
    section: 'dependencies',
    spec: '^1.0.0',
    registryName: name,
    status: 'analyzed',
    reasons: [],
    intermediateMajors: [],
    peerConflicts: [],
    ...extra,
  };
}

const entries = [entry('react', 5), entry('react-router-dom', 6), entry('vite', 9), entry('zod', 10), entry('ghost', 11), entry('local', 12)];

const results: UpdateAnalysis[] = [
  result('react', { current: '18.2.0', target: '18.2.0', kind: 'none', preliminary: 'safe', reasons: ['Already at the latest stable version (18.2.0).'] }),
  result('react-router-dom', {
    current: '6.22.1',
    target: '7.1.0',
    kind: 'major',
    preliminary: 'breaking-candidate',
    reasons: ['No lockfile: the installed version is assumed to be the lowest the range allows (6.22.1).', 'Major version change (6.22.1 to 7.1.0). Semver allows breaking changes, but none are confirmed yet.'],
  }),
  result('vite', { current: '5.2.0', target: '5.4.2', kind: 'minor', preliminary: 'safe', reasons: ['Minor update (5.2.0 to 5.4.2), backwards compatible according to semver.'] }),
  result('zod', { current: '3.22.4', target: '3.23.8', kind: 'minor', preliminary: 'review', reasons: ['A reason.'] }),
  result('ghost', { status: 'error', errorCode: 'NOT_FOUND', reasons: ['"ghost" was not found in the npm registry.'] }),
  result('local', { status: 'skipped', reasons: ['Local path dependency'] }),
];

const analysis: ProjectAnalysis = {
  results,
  summary: { total: 6, analyzed: 4, skipped: 1, errors: 1, safe: 1, review: 1, breakingCandidate: 1, unknown: 0, upToDate: 1 },
};

const warnings: Warning[] = [
  { code: 'NO_LOCKFILE', message: 'No lockfile provided.' },
  { code: 'NO_LOCKFILE', message: 'No lockfile provided.' },
];

const base = { color: false, showAll: false, fileName: 'package.json' };

describe('formatReport', () => {
  it('shows the summary line', () => {
    const output = formatReport(entries, analysis, warnings, base);
    assert.match(output, /4 analyzed: 1 major, 1 review, 1 safe, 1 up to date\. 1 skipped, 1 errors\./);
  });

  it('puts major updates first and hides safe ones by default', () => {
    const output = formatReport(entries, analysis, warnings, base);
    assert.ok(output.indexOf('react-router-dom') < output.indexOf('zod'));
    assert.ok(output.indexOf('zod') < output.indexOf('ghost'));
    assert.equal(output.includes('vite'), false);
    assert.match(output, /3 more hidden/);
  });

  it('shows everything with showAll', () => {
    const output = formatReport(entries, analysis, warnings, { ...base, showAll: true });
    for (const name of ['react', 'react-router-dom', 'vite', 'zod', 'ghost', 'local']) {
      assert.ok(output.includes(name), name);
    }
    assert.equal(output.includes('more hidden'), false);
  });

  it('prints the package.json line of each package', () => {
    const output = formatReport(entries, analysis, warnings, base);
    assert.match(output, /react-router-dom\s+6\.22\.1 -> 7\.1\.0\s+package\.json:6/);
  });

  it('keeps the lockfile note out of the per-package reasons', () => {
    const output = formatReport(entries, analysis, warnings, base);
    assert.equal(output.includes('lowest the range allows'), false);
    assert.match(output, /Major version change/);
  });

  it('lists each note once', () => {
    const output = formatReport(entries, analysis, warnings, base);
    assert.equal(output.split('No lockfile provided.').length - 1, 1);
  });

  it('mentions the lockfile name when there is one', () => {
    assert.match(formatReport(entries, analysis, [], { ...base, lockfileName: 'package-lock.json' }), /\(package-lock\.json\)/);
    assert.match(formatReport(entries, analysis, [], base), /\(no lockfile\)/);
  });

  it('uses no colors unless asked', () => {
    assert.equal(formatReport(entries, analysis, warnings, base).includes('\u001b['), false);
    assert.equal(formatReport(entries, analysis, warnings, { ...base, color: true }).includes('\u001b[31m'), true);
  });

  it('says when nothing needs attention', () => {
    const quiet: ProjectAnalysis = {
      results: [results[0] as UpdateAnalysis],
      summary: { total: 1, analyzed: 1, skipped: 0, errors: 0, safe: 0, review: 0, breakingCandidate: 0, unknown: 0, upToDate: 1 },
    };
    assert.match(formatReport([entries[0] as DependencyEntry], quiet, [], base), /Nothing needs attention\./);
  });
});
