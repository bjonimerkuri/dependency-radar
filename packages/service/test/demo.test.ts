import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDemoReport } from '../src/demo.ts';

describe('buildDemoReport', () => {
  it('produces a varied report without any network access', async () => {
    const report = await buildDemoReport(new Date('2026-10-30T10:00:00Z'));
    const byName = new Map(report.analysis.results.map((result) => [result.name, result]));

    assert.equal(report.source, 'demo');
    assert.equal(report.generatedAt, '2026-10-30T10:00:00.000Z');
    assert.equal(report.scan?.scannedFiles, 5);

    const router = byName.get('demo-router');
    assert.equal(router?.verdict?.level, 'breaking');
    assert.deepEqual(
      router?.changelog?.mentions.map((mention) => [mention.symbol, mention.inBreaking]),
      [['createRouter', true], ['json', true], ['redirect', false]],
    );
    assert.equal(router?.explanation?.findings[0]?.symbol, 'json');
    assert.equal(router?.verdict?.confidence, 'high');

    assert.equal(byName.get('demo-lint')?.verdict?.level, 'review');
    assert.equal(byName.get('demo-lint')?.verdict?.confidence, 'low');
    assert.equal(byName.get('demo-lint')?.impact?.level, 'scripts-only');
    assert.equal(byName.get('demo-lint')?.changelog?.status, 'not-found');

    assert.equal(byName.get('demo-dates')?.verdict?.level, 'review');
    assert.equal(byName.get('demo-dates')?.verdict?.confidence, 'medium');
    assert.equal(byName.get('demo-http')?.verdict?.level, 'review');
    assert.equal(byName.get('demo-http')?.verdict?.confidence, 'medium');
    assert.equal(byName.get('demo-schema')?.verdict?.level, 'safe');
    assert.equal(byName.get('demo-build')?.verdict?.level, 'safe');
    assert.equal(byName.get('demo-utils')?.kind, 'none');
  });

  it('is deterministic', async () => {
    const now = new Date('2026-10-30T10:00:00Z');
    assert.deepEqual(await buildDemoReport(now), await buildDemoReport(now));
  });
});
