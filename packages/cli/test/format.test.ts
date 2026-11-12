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

function withVerdicts(): ProjectAnalysis {
  const verdicts: Record<string, UpdateAnalysis['verdict']> = {
    react: { level: 'safe', confidence: 'high', reasons: ['Already up to date.'] },
    'react-router-dom': { level: 'breaking', confidence: 'high', reasons: ['Your code uses json, which the changelog marks as changed or removed.'] },
    vite: { level: 'safe', confidence: 'high', reasons: ['Compatible according to semver.'] },
    zod: { level: 'review', confidence: 'medium', reasons: ['The changelog mentions parse, but not clearly as a breaking change.'] },
  };
  return {
    ...analysis,
    results: results.map((item) => {
      const verdict = verdicts[item.name];
      return verdict ? { ...item, verdict } : item;
    }),
  };
}

describe('formatReport with verdicts', () => {
  it('does not repeat routine semver reasons once there is a verdict', () => {
    const output = formatReport(entries, withVerdicts(), warnings, base);
    assert.equal(output.includes('Major version change (6.22.1 to 7.1.0)'), false);
    assert.match(output, /Your code uses json, which the changelog marks as changed or removed\./);
  });

  it('strips the list marker from changelog excerpts', () => {
    const enriched = withVerdicts();
    const router = enriched.results.find((item) => item.name === 'react-router-dom') as UpdateAnalysis;
    router.changelog = {
      status: 'found', source: 'file', sections: 1, lineCount: 2, truncated: false,
      mentions: [{ symbol: 'json', inBreaking: true, excerpts: [{ id: 'L2', version: '7.0.0', text: '- Removed the json helper.' }] }],
    };
    const output = formatReport(entries, enriched, warnings, base);
    assert.match(output, /# json: "Removed the json helper\."/);
  });

  it('uses BREAKING only when the verdict says so and counts by verdict', () => {
    const output = formatReport(entries, withVerdicts(), warnings, base);
    assert.match(output, /BREAKING\s+react-router-dom/);
    assert.match(output, /REVIEW\s+zod/);
    assert.match(output, /1 breaking, 1 to review, 1 safe, 1 up to date/);
  });

  it('shows a review of a major update as MAJOR, not BREAKING', () => {
    const analysisWithMajorReview: ProjectAnalysis = {
      ...analysis,
      results: results.map((item) =>
        item.name === 'react-router-dom'
          ? { ...item, verdict: { level: 'review' as const, confidence: 'low' as const, reasons: ['Not sure.'] } }
          : item,
      ),
    };
    const output = formatReport(entries, analysisWithMajorReview, warnings, base);
    assert.match(output, /MAJOR\s+react-router-dom/);
    assert.equal(output.includes('BREAKING'), false);
  });

  it('shows changelog evidence and the AI explanation under a row', () => {
    const enriched = withVerdicts();
    const router = enriched.results.find((item) => item.name === 'react-router-dom') as UpdateAnalysis;
    router.changelog = {
      status: 'found',
      source: 'file',
      repository: 'o/r',
      sections: 2,
      lineCount: 9,
      truncated: false,
      mentions: [{ symbol: 'json', inBreaking: true, excerpts: [{ id: 'L3', version: '7.0.0', text: 'Removed the json helper.' }] }],
    };
    router.explanation = { summary: 'The json helper was removed.', confidence: 'high', unknown: false, findings: [], steps: ['Return plain objects.'], droppedFindings: 0 };
    const output = formatReport(entries, enriched, warnings, base);
    assert.match(output, /# json: "Removed the json helper\." \(7\.0\.0\)/);
    assert.match(output, /AI: The json helper was removed\./);
    assert.match(output, /\* Return plain objects\./);
  });

  it('says why a changelog was not used and when the AI was unavailable', () => {
    const enriched = withVerdicts();
    const zod = enriched.results.find((item) => item.name === 'zod') as UpdateAnalysis;
    zod.changelog = { status: 'not-found', sections: 0, lineCount: 0, truncated: false, mentions: [], message: 'No changelog file or GitHub releases were found.' };
    zod.explanationError = 'quota used up';
    const output = formatReport(entries, enriched, warnings, base);
    assert.match(output, /# No changelog used: No changelog file or GitHub releases were found\./);
    assert.match(output, /AI unavailable: quota used up/);
  });

  it('says when no changelog entry mentions the imported names', () => {
    const enriched = withVerdicts();
    const zod = enriched.results.find((item) => item.name === 'zod') as UpdateAnalysis;
    zod.changelog = { status: 'found', source: 'releases', sections: 3, lineCount: 9, truncated: false, mentions: [] };
    assert.match(formatReport(entries, enriched, warnings, base), /Read 3 changelog versions; none mention the names you import\./);
  });
});

describe('formatReport', () => {
  it('shows where a package is used under major and review rows', () => {
    const withImpact = results.map((item) =>
      item.name === 'react-router-dom'
        ? { ...item, impact: { level: 'used' as const, fileCount: 2, files: ['src/a.ts', 'src/b.ts'], symbols: ['json'], members: [], inScripts: false, dynamic: false } }
        : item,
    );
    const output = formatReport(entries, { ...analysis, results: withImpact }, warnings, base);
    assert.match(output, /> Used in 2 files: src\/a\.ts, src\/b\.ts\. Uses: json/);
  });

  it('describes the scan in the header', () => {
    const output = formatReport(entries, analysis, warnings, { ...base, scan: { scannedFiles: 42, unsupportedFiles: 3, truncated: false } });
    assert.match(output, /Scanned 42 source files; 3 Vue, Svelte or Astro files not analyzed\./);
    const one = formatReport(entries, analysis, warnings, { ...base, scan: { scannedFiles: 1, unsupportedFiles: 0, truncated: true } });
    assert.match(one, /Scanned 1 source file; the folder was too large to read completely\./);
  });

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
