import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyMajorChecks, checkMajorFixChangelogs, describeMajorCheck, parseVersionSections, planRemediation } from '../src/index.ts';
import type { ChangelogSource, ManifestClient } from '../src/index.ts';
import { LOCKFILE, PACKAGE_JSON } from './remediate-fixtures.ts';

const ticket = 'Affected package: jest\nInstalled version: 29.0.0\nFixed in: 30.0.0\nSeverity: high\nCVE-2099-0001';

function majorPlan() {
  const plan = planRemediation({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket });
  assert.ok(plan.ok);
  return plan;
}

const manifests: ManifestClient = {
  async getManifest(name) {
    return name === 'jest' ? { ok: true, manifest: { repository: 'github:acme/jest' } } : { ok: false, code: 'NOT_FOUND', message: 'Not found.' };
  },
};

const changelog = `# Changelog\n\n## 30.0.0\n\n### Breaking\n\n- Removed the \`runInBand\` option, use \`workers\` instead.\n- Dropped Node 14.\n\n## 29.5.0\n\n- Added \`workers\`.\n`;

const changelogs: ChangelogSource = {
  async fetchChangelog(_repository, request) {
    return { ok: true, source: 'file', sections: parseVersionSections(changelog).filter((section) => section.version > request.from) };
  },
};

describe('checkMajorFixChangelogs', () => {
  it('reads the changelog for a major fix and finds names the code uses', async () => {
    const plan = majorPlan();
    const usage = new Map([['jest', { symbols: ['runInBand'], members: [] as string[] }]]);
    const checks = await checkMajorFixChangelogs(plan, { manifests, changelogs, usage });
    assert.equal(checks.length, 1);
    const check = checks[0];
    assert.equal(check?.status, 'found');
    assert.equal(check?.repository, 'acme/jest');
    assert.equal(check?.from, '29.0.0');
    assert.equal(check?.to, '30.0.0');
    assert.deepEqual(check?.mentions.map((mention) => [mention.symbol, mention.inBreaking]), [['runInBand', true]]);
    assert.match(describeMajorCheck(check as NonNullable<typeof check>, true), /Names your code uses that the changelog mentions: runInBand \(in breaking changes: runInBand\)\./);
    applyMajorChecks(plan, checks, true);
    assert.ok(plan.findings[0]?.notes.some((text) => /Changelog for jest 29\.0\.0 to 30\.0\.0/.test(text)));
  });

  it('says that finding nothing is not proof, and that unscanned code cannot be judged', async () => {
    const plan = majorPlan();
    const [check] = await checkMajorFixChangelogs(plan, { manifests, changelogs, usage: new Map([['jest', { symbols: ['describe'], members: [] }]]) });
    assert.match(describeMajorCheck(check as NonNullable<typeof check>, true), /does not prove the update is safe/);
    assert.match(describeMajorCheck(check as NonNullable<typeof check>, false), /Your code was not scanned/);
  });

  it('is honest when the changelog cannot be found', async () => {
    const plan = majorPlan();
    const missing: ChangelogSource = { async fetchChangelog() { return { ok: false, code: 'NOT_FOUND', message: 'No changelog.' }; } };
    const [check] = await checkMajorFixChangelogs(plan, { manifests, changelogs: missing });
    assert.equal(check?.status, 'not-found');
    assert.match(describeMajorCheck(check as NonNullable<typeof check>, true), /I am not sure whether this major update breaks your code/);

    const noRepo: ManifestClient = { async getManifest() { return { ok: true, manifest: {} }; } };
    assert.equal((await checkMajorFixChangelogs(plan, { manifests: noRepo, changelogs }))[0]?.status, 'no-repository');
    const gitlab: ManifestClient = { async getManifest() { return { ok: true, manifest: { repository: 'https://gitlab.com/a/b' } }; } };
    assert.equal((await checkMajorFixChangelogs(plan, { manifests: gitlab, changelogs }))[0]?.status, 'not-github');
    const broken: ManifestClient = { async getManifest() { throw new Error('boom'); } };
    assert.equal((await checkMajorFixChangelogs(plan, { manifests: broken, changelogs }))[0]?.status, 'error');
  });

  it('ignores fixes that are not major and respects the lookup limit', async () => {
    const minor = planRemediation({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket: 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21' });
    assert.ok(minor.ok);
    let calls = 0;
    const counting: ManifestClient = { async getManifest() { calls++; return { ok: true, manifest: {} }; } };
    assert.deepEqual(await checkMajorFixChangelogs(minor, { manifests: counting, changelogs }), []);
    assert.equal(calls, 0);

    const plan = majorPlan();
    const [skipped] = await checkMajorFixChangelogs(plan, { manifests: counting, changelogs, maxLookups: 0 });
    assert.equal(skipped?.status, 'skipped');
    assert.equal(calls, 0);
  });
});
