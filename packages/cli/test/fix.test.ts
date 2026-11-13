import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdvisorySource, ChangelogSource, ManifestClient } from '@dependency-radar/core';
import { parseFixArgs } from '../src/args.ts';
import { runFix } from '../src/fix.ts';
import type { FixIo } from '../src/fix.ts';

const PACKAGE_JSON = JSON.stringify({ name: 'app', dependencies: { express: '^4.17.1', lodash: '^4.17.20' }, devDependencies: { jest: '^29.0.0' } }, null, 2) + '\n';
const LOCKFILE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { express: '^4.17.1', lodash: '^4.17.20' }, devDependencies: { jest: '^29.0.0' } },
    'node_modules/express': { version: '4.17.1', dependencies: { qs: '6.7.0' } },
    'node_modules/qs': { version: '6.7.0' },
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/jest': { version: '29.0.0', dev: true },
  },
});
const LODASH = 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21\nSeverity: high\nCVE-2021-23337';
const QS = 'Affected package: qs\nVulnerable versions: <6.7.3\nFixed in: 6.7.3\nSeverity: high\nGHSA-hrpp-h998-j3pp';

function setup(files: Record<string, string>, stdin = '') {
  const written: Record<string, string> = {};
  const out: string[] = [];
  const err: string[] = [];
  const io: FixIo = {
    readText: (path) => files[path],
    readStdin: async () => stdin,
    writeText: (path, text) => {
      if (path.startsWith('/readonly')) return false;
      written[path] = text;
      return true;
    },
    collectSources: () => ({ files: [{ path: 'src/a.ts', content: "import _ from 'lodash';\n_.get({}, 'a');" }], truncated: false }),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    color: false,
    now: () => new Date('2026-11-12T10:00:00Z'),
  };
  return { io, written, out: () => out.join(''), err: () => err.join('\n') };
}

const offline = ['--offline'];

describe('parseFixArgs', () => {
  it('reads tickets, paths, formats and repeated options', () => {
    const args = parseFixArgs(['app/package.json', '--ticket', 'a.txt', '--ticket', '-', '--pm', 'pnpm', '--fixed', 'lodash@4.17.21', '--fixed', '@scope/x@1.2.3', '--pr', 'pr.md', '--pr-format', 'jira', '--lang', 'sq', '--fail-if-changes', '--offline']);
    assert.equal(args.error, undefined);
    assert.equal(args.path, 'app/package.json');
    assert.deepEqual(args.tickets, ['a.txt', '-']);
    assert.equal(args.packageManager, 'pnpm');
    assert.deepEqual(args.fixed, { lodash: ['4.17.21'], '@scope/x': ['1.2.3'] });
    assert.deepEqual([args.pr, args.prFormat, args.lang, args.failIfChanges, args.noLookup, args.noChangelog], ['pr.md', 'jira', 'sq', true, true, true]);
  });

  it('reports clear errors', () => {
    assert.match(parseFixArgs(['--ticket']).error ?? '', /--ticket needs/);
    assert.match(parseFixArgs(['--pm', 'bun']).error ?? '', /--pm needs npm, yarn or pnpm/);
    assert.match(parseFixArgs(['--fixed', 'lodash']).error ?? '', /--fixed needs/);
    assert.match(parseFixArgs(['--lang', 'xx']).error ?? '', /--lang needs/);
    assert.match(parseFixArgs(['--nope']).error ?? '', /Unknown option/);
    assert.match(parseFixArgs(['a', 'b']).error ?? '', /Only one package\.json/);
  });
});

describe('runFix', () => {
  it('turns a ticket into a report, with the change and where the code uses the package', async () => {
    const { io, out } = setup({ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': LODASH });
    const code = await runFix(['--ticket', 't.txt', ...offline], io);
    assert.equal(code, 0);
    const text = out();
    assert.match(text, /One package needs a change/);
    assert.match(text, /lodash HIGH {2}\[change planned\]/);
    assert.match(text, /Your code: imported in 1 file: src\/a\.ts/);
    assert.match(text, /-    "lodash": "\^4\.17\.20"/);
    assert.match(text, /\+    "lodash": "\^4\.17\.21"/);
    assert.match(text, /\$ npm install/);
    assert.match(text, /What this can and cannot do/);
  });

  it('handles several tickets from one file and shows the matrix', async () => {
    const { io, out } = setup({ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': `${LODASH}\n---\n${QS}` });
    assert.equal(await runFix(['--ticket', 't.txt', ...offline], io), 0);
    assert.match(out(), /Which change closes which ticket/);
    assert.match(out(), /CHANGE {2}Ticket 1 \| CVE-2021-23337 \| lodash/);
    assert.match(out(), /Force qs to 6\.7\.3 with overrides/);
  });

  it('labels tickets by file name when several files are given, and reads standard input', async () => {
    const { io, out } = setup({ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 'sec-1.txt': LODASH }, QS);
    assert.equal(await runFix(['--ticket', 'sec-1.txt', '--ticket', '-', ...offline], io), 0);
    assert.match(out(), /sec-1\.txt \| CVE-2021-23337/);
    assert.match(out(), /stdin \| GHSA-hrpp-h998-j3pp/);
  });

  it('writes the patch, the description and the HTML report to files', async () => {
    const { io, written, err } = setup({ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': LODASH });
    await runFix(['--ticket', 't.txt', '--patch', 'x.patch', '--pr', 'pr.txt', '--pr-format', 'jira', '--lang', 'sq', '--html', 'r.html', ...offline], io);
    assert.match(written['x.patch'] ?? '', /^--- a\/package\.json\n\+\+\+ b\/package\.json/);
    assert.match(written['pr.txt'] ?? '', /^Siguria: përditëso lodash\n\nPërditëson 1 paketë e përmendur[\s\S]*ÇFARË NDRYSHON/);
    assert.match(written['r.html'] ?? '', /^<!doctype html>/);
    assert.match(written['r.html'] ?? '', /Plain text for Jira/);
    assert.match(err(), /konfidencial/);
  });

  it('prints only the description with --pr -', async () => {
    const { io, out } = setup({ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': LODASH });
    await runFix(['--ticket', 't.txt', '--pr', '-', ...offline], io);
    assert.match(out(), /^Security: update lodash\n\nUpdates 1 package/);
    assert.equal(out().includes('Dependency Radar: from ticket'), false);
  });

  it('prints JSON that includes the plan and the descriptions', async () => {
    const { io, out } = setup({ 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': LODASH });
    await runFix(['--ticket', 't.txt', '--json', ...offline], io);
    const data = JSON.parse(out());
    assert.equal(data.ok, true);
    assert.equal(data.findings[0].status, 'planned');
    assert.match(data.pr.markdown.body, /## What changes/);
    assert.equal(data.hunks, undefined);
  });

  it('exits with 2 only when asked and a change is needed', async () => {
    const files = { 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': LODASH, 'done.txt': 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.19' };
    assert.equal(await runFix(['--ticket', 't.txt', '--fail-if-changes', ...offline], setup(files).io), 2);
    assert.equal(await runFix(['--ticket', 't.txt', ...offline], setup(files).io), 0);
    assert.equal(await runFix(['--ticket', 'done.txt', '--fail-if-changes', ...offline], setup(files).io), 0);
  });

  it('asks the advisory database for a missing fixed version unless told not to', async () => {
    const files = { 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': 'Affected package: lodash\nInstalled version: 4.17.20\nCVE-2021-23337' };
    const asked: string[] = [];
    const advisories: AdvisorySource = { async fixedVersions(id) { asked.push(id); return ['4.17.21']; } };
    const first = setup(files);
    assert.equal(await runFix(['--ticket', 't.txt', '--no-changelog'], first.io, { advisories }), 0);
    assert.deepEqual(asked, ['CVE-2021-23337']);
    assert.match(first.out(), /OSV advisory database/);
    const second = setup(files);
    await runFix(['--ticket', 't.txt', '--no-lookup', '--no-changelog'], second.io, { advisories });
    assert.deepEqual(asked, ['CVE-2021-23337']);
    assert.match(second.out(), /does not say which version/);
    const third = setup(files);
    await runFix(['--ticket', 't.txt', '--offline', '--fixed', 'lodash@4.17.21'], third.io, { advisories });
    assert.match(third.out(), /One package needs a change/);
  });

  it('checks the changelog of a major fix with the names the code uses', async () => {
    const manifests: ManifestClient = { async getManifest() { return { ok: true, manifest: { repository: 'github:acme/jest' } }; } };
    const changelogs: ChangelogSource = {
      async fetchChangelog() {
        return { ok: true, source: 'file', sections: [{ version: '30.0.0', heading: '30.0.0', body: '### Breaking\n\n- Removed `get` helper.\n' }] };
      },
    };
    const files = { 'package.json': PACKAGE_JSON, 'package-lock.json': LOCKFILE, 't.txt': 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 5.0.0\nCVE-2099-0001' };
    const { io, out } = setup(files);
    await runFix(['--ticket', 't.txt', '--no-lookup'], io, { manifests, changelogs });
    assert.match(out(), /Changelog for lodash 4\.17\.20 to 5\.0\.0 \(acme\/jest\)/);
    assert.match(out(), /Names your code uses that the changelog mentions: get/);
  });

  it('fails clearly on missing files, empty tickets and bad tickets', async () => {
    const base = { 'package.json': PACKAGE_JSON };
    const noTicket = setup(base);
    assert.equal(await runFix([], noTicket.io), 1);
    assert.match(noTicket.err(), /Give the ticket with --ticket/);
    const missing = setup(base);
    assert.equal(await runFix(['--ticket', 'nope.txt'], missing.io), 1);
    assert.match(missing.err(), /Cannot read nope\.txt/);
    const noPackage = setup({ 't.txt': LODASH });
    assert.equal(await runFix(['--ticket', 't.txt'], noPackage.io), 1);
    assert.match(noPackage.err(), /Cannot read package\.json/);
    const badLock = setup({ ...base, 't.txt': LODASH });
    assert.equal(await runFix(['--ticket', 't.txt', '--lockfile', 'x.json'], badLock.io), 1);
    const empty = setup({ ...base, 't.txt': '  \n' });
    assert.equal(await runFix(['--ticket', 't.txt', ...offline], empty.io), 1);
    const nonsense = setup({ ...base, 't.txt': 'hello there' });
    assert.equal(await runFix(['--ticket', 't.txt', ...offline], nonsense.io), 1);
    assert.match(nonsense.err(), /could not find a package name/);
    const unwritable = setup({ ...base, 't.txt': LODASH });
    assert.equal(await runFix(['--ticket', 't.txt', '--patch', '/readonly/x', ...offline], unwritable.io), 1);
  });

  it('works without a lockfile and without scanning', async () => {
    const { io, out } = setup({ 'package.json': PACKAGE_JSON, 't.txt': LODASH });
    assert.equal(await runFix(['--ticket', 't.txt', '--no-scan', ...offline], io), 0);
    assert.match(out(), /No lockfile was given/);
    assert.equal(out().includes('Your code:'), false);
  });
});
