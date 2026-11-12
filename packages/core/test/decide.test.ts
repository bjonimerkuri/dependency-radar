import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideVerdict } from '../src/index.ts';
import type { ChangelogEvidence, ExplanationFinding, PackageImpact, UpdateAnalysis } from '../src/index.ts';

function result(extra: Partial<UpdateAnalysis> = {}): UpdateAnalysis {
  return {
    name: 'react-router-dom',
    section: 'dependencies',
    spec: '6.22.1',
    registryName: 'react-router-dom',
    status: 'analyzed',
    reasons: ['Major version change (6.22.1 to 7.0.0).'],
    intermediateMajors: [],
    peerConflicts: [],
    current: '6.22.1',
    target: '7.0.0',
    kind: 'major',
    preliminary: 'breaking-candidate',
    confidence: 'high',
    ...extra,
  };
}

function impact(level: PackageImpact['level'], symbols: string[] = ['json'], members: string[] = []): PackageImpact {
  return { level, fileCount: 1, files: ['src/a.ts'], symbols, members, inScripts: false, dynamic: false };
}

function evidence(mentions: ChangelogEvidence['mentions'] = [], status: ChangelogEvidence['status'] = 'found'): ChangelogEvidence {
  return { status, sections: 1, lineCount: 5, truncated: false, mentions };
}

const mention = (symbol: string, inBreaking: boolean) => ({
  symbol,
  inBreaking,
  excerpts: [{ id: 'L2', version: '7.0.0', text: 'Removed json' }],
});

describe('decideVerdict: results that never need a changelog', () => {
  it('returns nothing for results that were not analyzed', () => {
    assert.equal(decideVerdict(result({ status: 'error' }), undefined), undefined);
    assert.equal(decideVerdict(result({ status: 'skipped' }), undefined), undefined);
  });

  it('keeps up to date and safe results safe', () => {
    assert.equal(decideVerdict(result({ kind: 'none', preliminary: 'safe' }), undefined)?.level, 'safe');
    assert.equal(decideVerdict(result({ kind: 'minor', preliminary: 'safe', confidence: 'medium' }), undefined)?.confidence, 'medium');
  });

  it('keeps unknown results unknown', () => {
    const verdict = decideVerdict(result({ kind: 'unknown', preliminary: 'unknown', confidence: 'low' }), undefined);
    assert.equal(verdict?.level, 'unknown');
    assert.equal(verdict?.confidence, 'low');
  });
});

describe('decideVerdict: major updates', () => {
  it('is breaking when the code uses a name the changelog marks as changed', () => {
    const verdict = decideVerdict(result({ impact: impact('used') }), evidence([mention('json', true)]));
    assert.equal(verdict?.level, 'breaking');
    assert.equal(verdict?.confidence, 'high');
    assert.match(verdict?.reasons[0] ?? '', /Your code uses json/);
  });

  it('is only medium confidence when the version came from a range', () => {
    const verdict = decideVerdict(result({ confidence: 'medium', impact: impact('used') }), evidence([mention('json', true)]));
    assert.equal(verdict?.confidence, 'medium');
  });

  it('is breaking for type-only usage too', () => {
    const verdict = decideVerdict(result({ impact: impact('type-only') }), evidence([mention('json', true)]));
    assert.equal(verdict?.level, 'breaking');
  });

  it('is not breaking when the package is imported but unused', () => {
    const verdict = decideVerdict(result({ impact: impact('unused') }), evidence([mention('json', true)]));
    assert.equal(verdict?.level, 'review');
    assert.equal(verdict?.confidence, 'low');
  });

  it('asks for a check when the name is mentioned but not clearly breaking', () => {
    const verdict = decideVerdict(result({ impact: impact('used') }), evidence([mention('json', false)]));
    assert.equal(verdict?.level, 'review');
    assert.equal(verdict?.confidence, 'medium');
    assert.match(verdict?.reasons[0] ?? '', /not clearly as a breaking change/);
  });

  it('says it is likely fine, but never safe, when no used name is mentioned', () => {
    const verdict = decideVerdict(result({ impact: impact('used') }), evidence());
    assert.equal(verdict?.level, 'review');
    assert.equal(verdict?.confidence, 'medium');
    assert.match(verdict?.reasons[0] ?? '', /Likely fine, but verify/);
  });

  it('says it is not sure when there is no changelog', () => {
    for (const status of ['not-found', 'no-repository', 'not-github', 'rate-limited', 'error', 'no-versions'] as const) {
      const verdict = decideVerdict(result({ impact: impact('used') }), evidence([], status));
      assert.equal(verdict?.level, 'review', status);
      assert.equal(verdict?.confidence, 'low', status);
      assert.match(verdict?.reasons[0] ?? '', /not sure/, status);
    }
  });

  it('says the code was not scanned when there is no impact data', () => {
    const verdict = decideVerdict(result(), evidence());
    assert.equal(verdict?.level, 'review');
    assert.match(verdict?.reasons[0] ?? '', /not scanned/);
  });

  it('is low confidence when the package is not imported in code', () => {
    for (const level of ['not-found', 'scripts-only'] as const) {
      const verdict = decideVerdict(result({ impact: impact(level, []) }), evidence());
      assert.equal(verdict?.level, 'review');
      assert.equal(verdict?.confidence, 'low');
    }
  });
});

describe('decideVerdict: AI findings', () => {
  const finding = (symbol: string | undefined, kind: ExplanationFinding['kind'] = 'breaking'): ExplanationFinding => {
    const item: ExplanationFinding = { kind, description: 'd', evidence: ['L2'] };
    if (symbol !== undefined) item.symbol = symbol;
    return item;
  };

  it('can raise a review to breaking when the finding names a used symbol', () => {
    const verdict = decideVerdict(result({ impact: impact('used') }), evidence(), [finding('json')]);
    assert.equal(verdict?.level, 'breaking');
    assert.equal(verdict?.confidence, 'high');
  });

  it('ignores findings about names the code does not use', () => {
    const verdict = decideVerdict(result({ impact: impact('used') }), evidence(), [finding('somethingElse')]);
    assert.equal(verdict?.level, 'review');
  });

  it('ignores findings that are not breaking or have no symbol', () => {
    assert.equal(decideVerdict(result({ impact: impact('used') }), evidence(), [finding('json', 'behavior')])?.level, 'review');
    assert.equal(decideVerdict(result({ impact: impact('used') }), evidence(), [finding(undefined)])?.level, 'review');
  });

  it('can never make a safe result worse or a review safe', () => {
    assert.equal(decideVerdict(result({ kind: 'minor', preliminary: 'safe', impact: impact('used') }), evidence(), [finding('json')])?.level, 'safe');
  });
});

describe('decideVerdict: other reviews', () => {
  it('keeps a 0.x or deprecated review as a review with its own reason', () => {
    const verdict = decideVerdict(
      result({ kind: 'minor', preliminary: 'review', reasons: ['Version 0.x: any release can contain breaking changes.'] }),
      undefined,
    );
    assert.equal(verdict?.level, 'review');
    assert.equal(verdict?.confidence, 'low');
    assert.match(verdict?.reasons[0] ?? '', /0\.x/);
  });
});
