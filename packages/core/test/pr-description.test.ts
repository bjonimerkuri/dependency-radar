import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPrDescription, PR_MAX_CHARS, planMultiRemediation, planRemediation } from '../src/index.ts';
import type { MultiRemediationPlan, RemediationPlan } from '../src/index.ts';
import { LOCKFILE, LODASH_TICKET, PACKAGE_JSON, QS_TICKET } from './remediate-fixtures.ts';

function single(ticket: string, packageJson = PACKAGE_JSON): RemediationPlan {
  const result = planRemediation({ packageJson, lockfile: LOCKFILE, ticket });
  assert.ok(result.ok);
  return result;
}

function several(): MultiRemediationPlan {
  const result = planMultiRemediation({
    packageJson: PACKAGE_JSON,
    lockfile: LOCKFILE,
    tickets: [{ text: LODASH_TICKET }, { text: QS_TICKET }, { label: 'SEC-9', text: 'Affected package: minimist\nFixed in: 1.2.6' }],
  });
  assert.ok(result.ok);
  return result;
}

describe('buildPrDescription: Markdown for GitHub', () => {
  const plan = single(LODASH_TICKET);
  const description = buildPrDescription(plan, { usage: new Map([['lodash', { files: ['src/a.ts', 'src/b.ts'] }]]) });

  it('has a one-line title and the sections a reviewer needs', () => {
    assert.equal(description.title, 'Security: update lodash');
    for (const heading of ['## What changes', '## Why', '## Risk', '## How to verify', '## References']) {
      assert.ok(description.body.includes(heading), heading);
    }
    assert.equal(description.format, 'markdown');
    assert.equal(description.language, 'en');
  });

  it('says what changes, with the old and new version and the line', () => {
    assert.match(description.body, /- `lodash`: \^4\.17\.20 → \^4\.17\.21 \(package\.json line 6\)/);
  });

  it('uses the careful wording and never says the problem is solved', () => {
    assert.match(description.body, /according to the advisory it is fixed in 4\.17\.21; verify with npm audit\./);
    assert.equal(/fixes the vulnerabilit|is fixed\b(?! in)|resolves the vulnerabilit|no longer vulnerable/i.test(description.body), false);
  });

  it('lists the files that import the package and says that imports are not reachability', () => {
    assert.match(description.body, /lodash is imported in 2 files: src\/a\.ts, src\/b\.ts/);
    const none = buildPrDescription(plan, { usage: new Map() });
    assert.match(none.body, /not imported in the scanned files\. This only shows imports, not whether the vulnerable function is called/);
    const unknown = buildPrDescription(plan);
    assert.match(unknown.body, /Code impact was not checked/);
  });

  it('has a checklist with the commands to run', () => {
    assert.match(description.body, /- \[ \] `npm install`/);
    assert.match(description.body, /- \[ \] `npm ls lodash`/);
    assert.match(description.body, /- \[ \] `npm audit`/);
    assert.match(description.body, /- \[ \] Run the tests\./);
  });

  it('references the advisory ids and warns about confidential text', () => {
    assert.match(description.body, /## References\n- CVE-2021-23337/);
    assert.equal(description.warnings.length, 1);
    assert.match(description.warnings[0] ?? '', /confidential/);
  });

  it('states a major change as a risk, with the versions', () => {
    const major = buildPrDescription(single('Affected package: jest\nInstalled version: 29.0.0\nFixed in: 30.0.0\nCVE-2099-0001'));
    assert.match(major.body, /jest: major version change \(29\.0\.0 → 30\.0\.0\)\. Read the changelog and run the tests\./);
    assert.match(major.body, /jest is only a development dependency/);
  });

  it('leaves the ticket id field empty instead of inventing one', () => {
    const none = buildPrDescription(single('Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21'));
    assert.match(none.body, /## References\n- \(no ticket ID in the text, add it here\)/);
    assert.equal(/CVE-|GHSA-/.test(none.body), false);
  });
});

describe('buildPrDescription: plain text for Jira and other languages', () => {
  it('uses plain headings and no Markdown syntax in the Jira format', () => {
    const jira = buildPrDescription(single(LODASH_TICKET), { format: 'jira' });
    assert.match(jira.body, /^WHAT CHANGES$/m);
    assert.equal(jira.body.includes('`'), false);
    assert.equal(jira.body.includes('##'), false);
    assert.match(jira.body, /^\[ \] npm audit$/m);
    assert.match(jira.body, /^- lodash: \^4\.17\.20 → \^4\.17\.21 \(package\.json line 6\)$/m);
  });

  it('can be written in Albanian with the same facts', () => {
    const sq = buildPrDescription(single(LODASH_TICKET), { format: 'jira', language: 'sq' });
    assert.equal(sq.title, 'Siguria: përditëso lodash');
    assert.match(sq.body, /^ÇFARË NDRYSHON$/m);
    assert.match(sq.body, /rreshti 6/);
    assert.match(sq.body, /sipas këshillës rregullohet në 4\.17\.21; verifiko me npm audit\./);
    assert.match(sq.body, /^\[ \] Ekzekuto testet\.$/m);
    assert.match(sq.warnings[0] ?? '', /konfidencial/);
  });
});

describe('buildPrDescription: several tickets', () => {
  const description = buildPrDescription(several());

  it('names the packages, lists every ticket under references and includes all changes', () => {
    assert.equal(description.title, 'Security: update lodash, qs, minimist');
    assert.match(description.body, /Updates 3 packages named in the security tickets\./);
    assert.match(description.body, /- Ticket 1: CVE-2021-23337/);
    assert.match(description.body, /- Ticket 2: GHSA-hrpp-h998-j3pp/);
    assert.match(description.body, /- SEC-9: CVE-2021-44906|- SEC-9: \(no ticket ID in the text, add it here\)/);
    assert.match(description.body, /`qs`: added to overrides with version 6\.7\.3/);
    assert.match(description.body, /`minimist`: refresh the lockfile \(npm update minimist\)/);
  });

  it('lists tickets that were not analyzed under "Not changed"', () => {
    const result = planMultiRemediation({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, tickets: [{ text: LODASH_TICKET }, { text: 'nothing useful here' }] });
    assert.ok(result.ok);
    const text = buildPrDescription(result).body;
    assert.match(text, /## Not changed\n- Ticket 2: not analyzed \(No package name could be found in this ticket\.\)/);
  });
});

describe('buildPrDescription: limits and nothing to change', () => {
  it('shortens the text for the length limit of the target and says so', () => {
    const description = buildPrDescription(several(), { maxChars: 400 });
    assert.equal(description.truncated, true);
    assert.ok(description.body.length <= 400);
    assert.match(description.body, /Shortened to fit the length limit/);
    assert.equal(buildPrDescription(several()).truncated, false);
  });

  it('uses the real platform limits by default', () => {
    assert.equal(PR_MAX_CHARS.markdown, 60_000);
    assert.equal(PR_MAX_CHARS.jira, 30_000);
    const many = planMultiRemediation({
      packageJson: PACKAGE_JSON,
      lockfile: LOCKFILE,
      tickets: Array.from({ length: 20 }, (_, index) => ({ label: `T${index} ${'x'.repeat(55)}`, text: `Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21\nCVE-2021-${String(1000 + index)}` })),
    });
    assert.ok(many.ok);
    const jira = buildPrDescription(many, { format: 'jira' });
    assert.ok(jira.body.length <= PR_MAX_CHARS.jira);
  });

  it('says plainly when no change is needed', () => {
    const none = buildPrDescription(single('Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.19'));
    assert.match(none.body, /No change to package\.json or the lockfile is needed/);
    assert.match(none.body, /## Not changed\n- lodash: the installed version is not affected/);
    assert.equal(none.body.includes('## What changes'), false);
  });

  it('cleans labels that could break the formatting', () => {
    const result = planMultiRemediation({
      packageJson: PACKAGE_JSON,
      lockfile: LOCKFILE,
      tickets: [{ label: 'A `bad`\nlabel', text: LODASH_TICKET }],
    });
    assert.ok(result.ok);
    const body = buildPrDescription(result).body;
    assert.equal(body.includes('`bad`'), false);
    assert.match(body, /- A bad label: CVE-2021-23337/);
  });
});
