import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeEntry, analyzeProject, parseSpecifier } from '../src/index.ts';
import type { DependencyEntry, FetchPackumentResult, Packument, RegistryClient } from '../src/index.ts';

function entry(name: string, spec: string, extra: Partial<DependencyEntry> = {}): DependencyEntry {
  const parsed = parseSpecifier(spec);
  const result: DependencyEntry = {
    name,
    section: 'dependencies',
    spec,
    kind: parsed.kind,
    analyzable: parsed.analyzable,
    ...extra,
  };
  if (parsed.reason !== undefined) result.reason = parsed.reason;
  if (parsed.aliasOf !== undefined) result.aliasOf = parsed.aliasOf;
  if (parsed.aliasRange !== undefined) result.aliasRange = parsed.aliasRange;
  return result;
}

function packument(
  versions: Record<string, { deprecated?: string; peers?: Record<string, string> }>,
  latest: string,
  distTags: Record<string, string> = {},
): Packument {
  const built: Packument['versions'] = {};
  for (const [version, info] of Object.entries(versions)) {
    built[version] = { peerDependencies: info.peers ?? {} };
    if (info.deprecated !== undefined) built[version].deprecated = info.deprecated;
  }
  return { name: 'pkg', distTags: { latest, ...distTags }, versions: built };
}

const none = () => undefined;

describe('analyzeEntry: update kinds', () => {
  const pk = packument({ '4.17.0': {}, '4.17.1': {}, '4.18.0': {}, '5.0.0': {} }, '4.18.0');

  it('treats a patch update as safe', () => {
    const result = analyzeEntry(entry('p', '4.17.0', { installed: '4.17.0' }), packument({ '4.17.0': {}, '4.17.1': {} }, '4.17.1'), none);
    assert.equal(result.kind, 'patch');
    assert.equal(result.preliminary, 'safe');
    assert.equal(result.confidence, 'high');
  });

  it('treats a minor update as safe', () => {
    const result = analyzeEntry(entry('p', '^4.17.0', { installed: '4.17.1' }), pk, none);
    assert.equal(result.kind, 'minor');
    assert.equal(result.preliminary, 'safe');
    assert.equal(result.target, '4.18.0');
  });

  it('flags a major update as a breaking candidate', () => {
    const result = analyzeEntry(entry('p', '^4.17.0', { installed: '4.17.1' }), packument({ '4.17.1': {}, '5.0.0': {} }, '5.0.0'), none);
    assert.equal(result.kind, 'major');
    assert.equal(result.preliminary, 'breaking-candidate');
  });

  it('reports up to date when current equals the latest', () => {
    const result = analyzeEntry(entry('p', '^4.18.0', { installed: '4.18.0' }), pk, none);
    assert.equal(result.kind, 'none');
    assert.equal(result.preliminary, 'safe');
  });

  it('reports an installed version that is ahead of latest', () => {
    const result = analyzeEntry(entry('p', '^5.0.0-beta.1', { installed: '5.0.0-beta.1' }), packument({ '4.18.0': {}, '5.0.0-beta.1': {} }, '4.18.0'), none);
    assert.equal(result.kind, 'none');
    assert.match(result.reasons.join(' '), /ahead/);
  });

  it('reviews minor and patch updates of 0.x packages', () => {
    const result = analyzeEntry(entry('p', '^0.4.0', { installed: '0.4.0' }), packument({ '0.4.0': {}, '0.5.0': {} }, '0.5.0'), none);
    assert.equal(result.kind, 'minor');
    assert.equal(result.preliminary, 'review');
  });

  it('flags 0.x to 1.0 as a major change', () => {
    const result = analyzeEntry(entry('p', '^0.9.0', { installed: '0.9.0' }), packument({ '0.9.0': {}, '1.0.0': {} }, '1.0.0'), none);
    assert.equal(result.preliminary, 'breaking-candidate');
  });
});

describe('analyzeEntry: choosing the target', () => {
  it('ignores a prerelease latest tag', () => {
    const pk = packument({ '1.0.0': {}, '1.1.0': {}, '2.0.0-rc.1': {} }, '2.0.0-rc.1');
    const result = analyzeEntry(entry('p', '^1.0.0', { installed: '1.0.0' }), pk, none);
    assert.equal(result.target, '1.1.0');
  });

  it('follows the latest tag when it points to an older version', () => {
    const pk = packument({ '1.0.0': {}, '1.5.0': {}, '2.0.0': {} }, '1.5.0');
    const result = analyzeEntry(entry('p', '^1.0.0', { installed: '1.0.0' }), pk, none);
    assert.equal(result.target, '1.5.0');
  });

  it('falls back to the highest stable version without a usable latest tag', () => {
    const pk: Packument = { name: 'p', distTags: {}, versions: { '1.0.0': { peerDependencies: {} }, '1.2.0': { peerDependencies: {} } } };
    const result = analyzeEntry(entry('p', '^1.0.0', { installed: '1.0.0' }), pk, none);
    assert.equal(result.target, '1.2.0');
  });

  it('reports an error when no stable version exists', () => {
    const pk = packument({ '1.0.0-beta.1': {} }, '1.0.0-beta.1');
    const result = analyzeEntry(entry('p', '^1.0.0-beta.1'), pk, none);
    assert.equal(result.status, 'error');
  });
});

describe('analyzeEntry: current version', () => {
  const pk = packument({ '18.2.0': {}, '18.3.1': {} }, '18.3.1');

  it('uses the lowest version of the range without a lockfile', () => {
    const result = analyzeEntry(entry('react', '^18.2.0'), pk, none);
    assert.equal(result.current, '18.2.0');
    assert.equal(result.currentSource, 'range-minimum');
    assert.equal(result.confidence, 'medium');
    assert.match(result.reasons.join(' '), /No lockfile/);
  });

  it('prefers the installed version from the lockfile', () => {
    const result = analyzeEntry(entry('react', '^18.2.0', { installed: '18.3.1' }), pk, none);
    assert.equal(result.current, '18.3.1');
    assert.equal(result.confidence, 'high');
    assert.equal(result.kind, 'none');
  });

  it('marks floating tags without a lockfile as unknown', () => {
    for (const spec of ['latest', '*', 'next']) {
      const result = analyzeEntry(entry('react', spec), pk, none);
      assert.equal(result.kind, 'unknown');
      assert.equal(result.preliminary, 'review');
      assert.equal(result.confidence, 'low');
    }
  });

  it('compares floating tags against the lockfile version when available', () => {
    const result = analyzeEntry(entry('react', 'latest', { installed: '18.2.0' }), pk, none);
    assert.equal(result.kind, 'minor');
  });

  it('reports ranges it cannot interpret', () => {
    const odd = entry('react', '>>1', { kind: 'range', analyzable: true });
    const result = analyzeEntry(odd, pk, none);
    assert.equal(result.preliminary, 'unknown');
  });
});

describe('analyzeEntry: range and extra signals', () => {
  it('says when the declared range already allows the update', () => {
    const pk = packument({ '18.2.0': {}, '18.3.1': {} }, '18.3.1');
    const result = analyzeEntry(entry('react', '^18.2.0', { installed: '18.2.0' }), pk, none);
    assert.equal(result.withinRange, true);
    assert.match(result.reasons.join(' '), /lockfile is enough/);
  });

  it('says when package.json must change', () => {
    const pk = packument({ '6.22.1': {}, '7.1.0': {} }, '7.1.0');
    const result = analyzeEntry(entry('react-router-dom', '6.22.1', { installed: '6.22.1' }), pk, none);
    assert.equal(result.withinRange, false);
    assert.match(result.reasons.join(' '), /package.json must change/);
  });

  it('lists the major versions that would be skipped', () => {
    const pk = packument({ '1.0.0': {}, '2.0.0': {}, '3.0.0': {}, '4.0.0': {}, '4.0.1': {} }, '4.0.1');
    const result = analyzeEntry(entry('p', '^1.0.0', { installed: '1.0.0' }), pk, none);
    assert.deepEqual(result.intermediateMajors, [2, 3]);
  });

  it('raises a safe update to review when the target is deprecated', () => {
    const pk = packument({ '1.0.0': {}, '1.1.0': { deprecated: 'moved to @scope/p' } }, '1.1.0');
    const result = analyzeEntry(entry('p', '^1.0.0', { installed: '1.0.0' }), pk, none);
    assert.equal(result.preliminary, 'review');
    assert.equal(result.deprecated, 'moved to @scope/p');
  });

  it('flags a deprecated installed version', () => {
    const pk = packument({ '1.0.0': { deprecated: 'security issue' }, '1.0.1': {} }, '1.0.1');
    const result = analyzeEntry(entry('p', '1.0.0', { installed: '1.0.0' }), pk, none);
    assert.equal(result.preliminary, 'review');
    assert.match(result.reasons.join(' '), /Your version is deprecated/);
  });

  it('flags an installed version that is no longer in the registry', () => {
    const pk = packument({ '1.0.1': {} }, '1.0.1');
    const result = analyzeEntry(entry('p', '1.0.0', { installed: '1.0.0' }), pk, none);
    assert.equal(result.preliminary, 'review');
    assert.match(result.reasons.join(' '), /no longer listed/);
  });

  it('detects peer dependency conflicts', () => {
    const pk = packument(
      { '6.22.1': {}, '7.1.0': { peers: { react: '>=18', 'react-dom': '>=18' } } },
      '7.1.0',
    );
    const versionOf = (name: string) => (name === 'react' ? '17.0.2' : name === 'react-dom' ? '18.3.1' : undefined);
    const result = analyzeEntry(entry('react-router-dom', '^6.22.1', { installed: '6.22.1' }), pk, versionOf);
    assert.deepEqual(result.peerConflicts, [{ dependency: 'react', required: '>=18', have: '17.0.2' }]);
  });

  it('upgrades a safe minor update to review on a peer conflict', () => {
    const pk = packument({ '1.0.0': {}, '1.1.0': { peers: { react: '^18' } } }, '1.1.0');
    const result = analyzeEntry(entry('p', '^1.0.0', { installed: '1.0.0' }), pk, () => '17.0.0');
    assert.equal(result.preliminary, 'review');
  });
});

function fakeRegistry(map: Record<string, FetchPackumentResult>) {
  const state = { inFlight: 0, peak: 0, calls: [] as string[] };
  const registry: RegistryClient = {
    async getPackument(name) {
      state.calls.push(name);
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.inFlight--;
      return map[name] ?? { ok: false, code: 'NOT_FOUND', message: `${name} not found` };
    },
  };
  return { registry, state };
}

describe('analyzeProject', () => {
  const ok = (versions: Record<string, object>, latest: string): FetchPackumentResult => ({
    ok: true,
    packument: packument(versions, latest),
  });

  it('analyzes every entry and summarizes the result', async () => {
    const { registry } = fakeRegistry({
      react: ok({ '18.2.0': {}, '18.3.1': {} }, '18.3.1'),
      'react-router-dom': ok({ '6.22.1': {}, '7.1.0': {} }, '7.1.0'),
      vite: ok({ '5.4.0': {} }, '5.4.0'),
    });
    const entries = [
      entry('react', '^18.2.0'),
      entry('react-router-dom', '6.22.1'),
      entry('vite', '^5.4.0', { section: 'devDependencies' }),
      entry('local-lib', 'file:../lib'),
      entry('ghost', '^1.0.0'),
    ];
    const { results, summary } = await analyzeProject(entries, { registry });
    assert.equal(results.length, 5);
    assert.deepEqual(
      results.map((result) => result.status),
      ['analyzed', 'analyzed', 'analyzed', 'skipped', 'error'],
    );
    assert.equal(results[4]?.errorCode, 'NOT_FOUND');
    assert.deepEqual(summary, {
      total: 5,
      analyzed: 3,
      skipped: 1,
      errors: 1,
      safe: 1,
      review: 0,
      breakingCandidate: 1,
      unknown: 0,
      upToDate: 1,
    });
  });

  it('keeps going when one lookup fails', async () => {
    const registry: RegistryClient = {
      async getPackument(name) {
        if (name === 'bad') throw new Error('boom');
        return ok({ '1.0.0': {} }, '1.0.0');
      },
    };
    const { results } = await analyzeProject([entry('bad', '^1.0.0'), entry('good', '^1.0.0')], { registry });
    assert.equal(results[0]?.status, 'error');
    assert.equal(results[1]?.status, 'analyzed');
  });

  it('limits concurrent registry requests', async () => {
    const map: Record<string, FetchPackumentResult> = {};
    const entries: DependencyEntry[] = [];
    for (let i = 0; i < 12; i++) {
      map[`pkg-${i}`] = ok({ '1.0.0': {} }, '1.0.0');
      entries.push(entry(`pkg-${i}`, '^1.0.0'));
    }
    const { registry, state } = fakeRegistry(map);
    await analyzeProject(entries, { registry, concurrency: 3 });
    assert.ok(state.peak <= 3, `peak was ${state.peak}`);
    assert.equal(state.calls.length, 12);
  });

  it('requests each package once even if it appears in several sections', async () => {
    const { registry, state } = fakeRegistry({ react: ok({ '18.2.0': {} }, '18.2.0') });
    await analyzeProject(
      [entry('react', '^18.2.0'), entry('react', '^18.2.0', { section: 'devDependencies' })],
      { registry },
    );
    assert.deepEqual(state.calls, ['react']);
  });

  it('looks up the real package behind an alias', async () => {
    const { registry, state } = fakeRegistry({ react: ok({ '18.2.0': {}, '18.3.1': {} }, '18.3.1') });
    const { results } = await analyzeProject([entry('react18', 'npm:react@^18.2.0')], { registry });
    assert.deepEqual(state.calls, ['react']);
    assert.equal(results[0]?.registryName, 'react');
    assert.equal(results[0]?.target, '18.3.1');
  });

  it('skips packages beyond the limit', async () => {
    const map: Record<string, FetchPackumentResult> = {};
    const entries: DependencyEntry[] = [];
    for (let i = 0; i < 5; i++) {
      map[`pkg-${i}`] = ok({ '1.0.0': {} }, '1.0.0');
      entries.push(entry(`pkg-${i}`, '^1.0.0'));
    }
    const { registry, state } = fakeRegistry(map);
    const { results, summary } = await analyzeProject(entries, { registry, maxPackages: 2 });
    assert.equal(state.calls.length, 2);
    assert.equal(summary.skipped, 3);
    assert.match(results[4]?.reasons.join(' ') ?? '', /first 2 packages/);
  });

  it('uses other dependencies as context for peer checks', async () => {
    const { registry } = fakeRegistry({
      'react-router-dom': ok({ '6.22.1': {}, '7.1.0': { peers: { react: '>=18' } } } as Record<string, object>, '7.1.0'),
      react: ok({ '17.0.2': {} }, '17.0.2'),
    });
    const { results } = await analyzeProject(
      [entry('react-router-dom', '6.22.1', { installed: '6.22.1' }), entry('react', '^17.0.2', { installed: '17.0.2' })],
      { registry },
    );
    assert.equal(results[0]?.peerConflicts.length, 1);
  });
});
