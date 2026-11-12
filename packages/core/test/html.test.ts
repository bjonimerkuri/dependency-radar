import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, formatHtml } from '../src/index.ts';
import type { DependencyEntry, PackageImpact, ProjectAnalysis, UpdateAnalysis, Warning } from '../src/index.ts';

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

const impact: PackageImpact = {
  level: 'used',
  fileCount: 1,
  files: ['src/router.tsx'],
  symbols: ['json'],
  members: [],
  inScripts: false,
  dynamic: false,
};

const entries = [entry('react-router-dom', 6), entry('vite', 9), entry('react', 5), entry('local', 12)];

const results: UpdateAnalysis[] = [
  result('react-router-dom', {
    current: '6.22.1',
    target: '7.0.0',
    kind: 'major',
    preliminary: 'breaking-candidate',
    reasons: ['Major version change.'],
    impact,
    verdict: { level: 'breaking', confidence: 'high', reasons: ['Your code uses json, which the changelog marks as changed or removed.'] },
    changelog: {
      status: 'found',
      source: 'file',
      repository: 'o/r',
      sections: 2,
      lineCount: 9,
      truncated: false,
      mentions: [{ symbol: 'json', inBreaking: true, excerpts: [{ id: 'L3', version: '7.0.0', text: 'Removed the json helper.' }] }],
    },
    explanation: { summary: 'The json helper was removed.', confidence: 'high', unknown: false, findings: [], steps: ['Return plain objects.'], droppedFindings: 0 },
  }),
  result('vite', { current: '5.2.0', target: '5.4.2', kind: 'minor', preliminary: 'safe', verdict: { level: 'safe', confidence: 'high', reasons: ['Compatible according to semver.'] } }),
  result('react', { current: '18.3.1', target: '18.3.1', kind: 'none', preliminary: 'safe', verdict: { level: 'safe', confidence: 'high', reasons: ['Already up to date.'] } }),
  result('local', { status: 'skipped', reasons: ['Local path dependency'] }),
];

const analysis: ProjectAnalysis = {
  results,
  summary: { total: 4, analyzed: 3, skipped: 1, errors: 0, safe: 1, review: 0, breakingCandidate: 1, unknown: 0, upToDate: 1 },
};

const warnings: Warning[] = [{ code: 'NO_LOCKFILE', message: 'No lockfile provided.' }];
const options = { fileName: 'package.json', scan: { scannedFiles: 12, unsupportedFiles: 0, truncated: false } };

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('formatHtml', () => {
  const html = formatHtml(entries, analysis, warnings, options);

  it('is a complete document with the project details', () => {
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Dependency Radar report<\/title>/);
    assert.match(html, /package\.json \(no lockfile\)/);
    assert.match(html, /Scanned 12 source files\./);
  });

  it('has no scripts, no external resources and a strict content security policy', () => {
    assert.equal(/<script/i.test(html), false);
    assert.equal(/\b(?:src|href)=/i.test(html), false);
    assert.equal(/https?:\/\//i.test(html), false);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  });

  it('shows the summary tiles', () => {
    assert.match(html, /<div class="tile red"><div class="value">1<\/div><div class="label">breaking<\/div><\/div>/);
    assert.match(html, /<div class="label">up to date<\/div>/);
  });

  it('shows a card with verdict, version, line, impact, evidence and explanation', () => {
    assert.match(html, /<span class="badge red">BREAKING<\/span>/);
    assert.match(html, /6\.22\.1 \u2192 7\.0\.0/);
    assert.match(html, /<p class="where">package\.json:6<\/p>/);
    assert.match(html, /Used in 1 file: src\/router\.tsx\. Uses: json/);
    assert.match(html, /<code>json<\/code> <q>Removed the json helper\.<\/q> <span class="muted">\(7\.0\.0\)<\/span>/);
    assert.match(html, /<strong>AI explanation<\/strong><p>The json helper was removed\.<\/p><ol><li>Return plain objects\.<\/li><\/ol>/);
  });

  it('puts packages without attention into a collapsed list', () => {
    assert.match(html, /<details><summary>3 more packages/);
    assert.match(html, /<td class="mono">vite<\/td>/);
    assert.match(html, /<td class="mono">react<\/td>/);
    assert.match(html, /<td class="mono">local<\/td>/);
  });

  it('lists the notes once', () => {
    assert.equal(html.split('No lockfile provided.').length - 1, 1);
  });

  it('supports dark mode', () => {
    assert.match(html, /prefers-color-scheme:dark/);
  });

  it('can show a banner and a link back to the form', () => {
    const output = formatHtml(entries, analysis, warnings, { ...options, banner: 'Sample data <b>only</b>', homeHref: '/' });
    assert.match(output, /<p class="banner">Sample data &lt;b&gt;only&lt;\/b&gt;<\/p>/);
    assert.match(output, /<a href="\/">&larr; Analyze another project<\/a>/);
  });

  it('shows extra notes and escapes them', () => {
    const output = formatHtml(entries, analysis, [], { ...options, notes: ['Check <this>'] });
    assert.match(output, /<li>Check &lt;this&gt;<\/li>/);
  });

  it('says when nothing needs attention', () => {
    const quiet: ProjectAnalysis = { results: [results[2] as UpdateAnalysis], summary: { ...analysis.summary, total: 1 } };
    const output = formatHtml([entries[2] as DependencyEntry], quiet, [], options);
    assert.match(output, /Nothing needs attention\./);
    assert.equal(output.includes('<article'), false);
  });

  it('escapes text that comes from the registry, the changelog and the AI', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const evil = result('<b>evil</b>', {
      current: '1.0.0',
      target: '2.0.0',
      kind: 'major',
      preliminary: 'breaking-candidate',
      reasons: [hostile],
      impact: { ...impact, files: [hostile], symbols: [hostile] },
      verdict: { level: 'review', confidence: 'low', reasons: [hostile] },
      changelog: {
        status: 'found',
        sections: 1,
        lineCount: 1,
        truncated: false,
        mentions: [{ symbol: hostile, inBreaking: false, excerpts: [{ id: 'L1', version: hostile, text: hostile }] }],
      },
      explanation: { summary: hostile, confidence: 'low', unknown: false, findings: [], steps: [hostile], droppedFindings: 0 },
      explanationError: hostile,
    });
    const output = formatHtml(
      [entry('<b>evil</b>', 3)],
      { results: [evil], summary: { ...analysis.summary, total: 1 } },
      [{ code: 'NO_LOCKFILE', message: hostile }],
      { ...options, generatedAt: hostile },
    );
    assert.equal(/<script/i.test(output), false);
    assert.equal(/<img/i.test(output), false);
    assert.equal(output.includes('<b>evil</b>'), false);
    assert.ok(output.includes('&lt;script&gt;'));
  });
});
