import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planMultiRemediation, splitTickets } from '../src/index.ts';
import type { MultiRemediationInput, MultiRemediationPlan } from '../src/index.ts';
import { LOCKFILE, LODASH_TICKET, PACKAGE_JSON, QS_TICKET } from './remediate-fixtures.ts';

function multi(tickets: Array<string | { label?: string; text: string }>, extra: Partial<MultiRemediationInput> = {}): MultiRemediationPlan {
  const result = planMultiRemediation({
    packageJson: PACKAGE_JSON,
    lockfile: LOCKFILE,
    tickets: tickets.map((ticket) => (typeof ticket === 'string' ? { text: ticket } : ticket)),
    ...extra,
  });
  assert.ok(result.ok, result.ok ? '' : result.message);
  return result;
}

const lodash = (fixed: string, id: string, range?: string): string =>
  `Affected package: lodash\nInstalled version: 4.17.20\n${range ? `Vulnerable versions: ${range}\n` : ''}Fixed in: ${fixed}\nSeverity: high\n${id}`;

describe('planMultiRemediation: several tickets, one diff', () => {
  it('builds a single diff and a matrix that says which change closes which ticket', () => {
    const result = multi([LODASH_TICKET, QS_TICKET]);
    assert.equal(result.findings.length, 2);
    const data = JSON.parse(result.newPackageJson);
    assert.equal(data.dependencies.lodash, '^4.17.21');
    assert.deepEqual(data.overrides, { qs: '6.7.3' });
    assert.equal((result.diff.match(/^--- a\/package\.json$/gm) ?? []).length, 1);

    assert.deepEqual(
      result.matrix.map((row) => [row.ticket, row.packageName, row.status, row.closedBy]),
      [
        ['Ticket 1', 'lodash', 'planned', ['Raise lodash to ^4.17.21']],
        ['Ticket 2', 'qs', 'planned', ['Force qs to 6.7.3 with overrides']],
      ],
    );
    assert.deepEqual(result.matrix.map((row) => row.ids), [['CVE-2021-23337'], ['GHSA-HRPP-H998-J3PP']]);
    assert.deepEqual(result.verify, ['npm ls lodash qs', 'npm audit', 'Run your tests.']);
  });

  it('chooses the lowest version that satisfies two tickets for the same package', () => {
    const result = multi([lodash('4.17.21', 'CVE-2021-23337'), lodash('4.17.23', 'CVE-2099-1111')]);
    assert.equal(JSON.parse(result.newPackageJson).dependencies.lodash, '^4.17.23');
    const finding = result.findings[0];
    assert.deepEqual(finding?.finding.ids, ['CVE-2021-23337', 'CVE-2099-1111']);
    assert.ok(finding?.notes.some((text) => /Ticket 1 and Ticket 2 ask for different versions of lodash \(4\.17\.21 and 4\.17\.23\)\. The lowest version that satisfies all of them is 4\.17\.23\./.test(text)));
    assert.deepEqual(result.matrix.map((row) => row.fixedIn), ['4.17.21', '4.17.23']);
    assert.ok(result.matrix.every((row) => row.closedBy.length === 1));
  });

  it('shows the cost when one ticket forces a major version', () => {
    const result = multi([lodash('4.17.21', 'CVE-2021-23337'), lodash('5.0.0', 'CVE-2099-2222', '<5.0.0')]);
    assert.equal(JSON.parse(result.newPackageJson).dependencies.lodash, '^5.0.0');
    const option = result.findings[0]?.options.find((candidate) => candidate.kind === 'bump-direct');
    assert.equal(option?.majorChange, true);
    assert.ok(option?.cons.some((text) => /major version change \(4\.17\.20 to 5\.0\.0\)/.test(text)));
  });

  it('merges a ticket that repeats the same advisory instead of counting it twice', () => {
    const second = `Package: lodash\nCVE-2021-23337\nFixed in: 4.17.21\nInstalled version: 4.17.20`;
    const result = multi([LODASH_TICKET, second]);
    assert.deepEqual(result.matrix.map((row) => [row.ticket, row.status, row.duplicateOf]), [
      ['Ticket 1', 'planned', undefined],
      ['Ticket 2', 'duplicate', 'Ticket 1'],
    ]);
    assert.equal(result.findings.length, 1);
    assert.equal(result.diff.match(/^\+\s+"lodash"/gm)?.length, 1);
  });

  it('merges tickets with identical text, even when they have no ID', () => {
    const text = 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21';
    const result = multi([text, `  ${text}\n\n`]);
    assert.deepEqual(result.tickets.map((ticket) => ticket.status), ['analyzed', 'duplicate']);
    assert.equal(result.tickets[1]?.duplicateOf, 'Ticket 1');
    assert.equal(result.matrix[1]?.status, 'duplicate');
  });

  it('lists an unreadable or empty ticket as not analyzed and keeps going', () => {
    const result = multi([LODASH_TICKET, 'The dashboard is red, please look.', '   ', QS_TICKET]);
    assert.deepEqual(result.tickets.map((ticket) => ticket.status), ['analyzed', 'not-analyzed', 'not-analyzed', 'analyzed']);
    assert.match(result.tickets[1]?.reason ?? '', /No package name/);
    assert.equal(result.tickets[2]?.reason, 'The ticket is empty.');
    assert.equal(result.findings.length, 2);
    assert.equal(result.changed, true);
    assert.deepEqual(result.matrix.map((row) => row.status), ['planned', 'not-analyzed', 'not-analyzed', 'planned']);
  });

  it('a ticket without a fixed version does not block the others', () => {
    const noFix = 'Affected package: lodash\nInstalled version: 4.17.20\nSeverity: low\nCVE-2099-3333';
    const result = multi([noFix, lodash('4.17.21', 'CVE-2021-23337')]);
    assert.deepEqual(result.matrix.map((row) => row.status), ['no-fixed-version', 'planned']);
    assert.equal(JSON.parse(result.newPackageJson).dependencies.lodash, '^4.17.21');
    assert.match(result.matrix[0]?.note ?? '', /does not give a fixed version/);
  });

  it('does not treat a ticket for an already fixed version as a reason to change anything', () => {
    const result = multi([lodash('4.17.19', 'CVE-2020-8203')]);
    assert.equal(result.changed, false);
    assert.equal(result.findings[0]?.status, 'already-fixed');
    assert.equal(result.matrix[0]?.status, 'already-fixed');
    assert.deepEqual(result.commands, []);
  });

  it('keeps the ids of tickets that do not apply out of the finding that is planned', () => {
    const result = multi([lodash('4.17.19', 'CVE-2020-8203'), lodash('4.17.21', 'CVE-2021-23337')]);
    assert.deepEqual(result.findings[0]?.finding.ids, ['CVE-2021-23337']);
    assert.deepEqual(result.matrix.map((row) => row.status), ['already-fixed', 'planned']);
  });

  it('handles tickets for packages that are not in the project', () => {
    const result = multi(['Affected package: left-pad\nFixed in: 1.3.1\nCVE-2099-4444', LODASH_TICKET]);
    assert.deepEqual(result.matrix.map((row) => row.status), ['not-in-project', 'planned']);
  });

  it('plans one override for a nested package that several tickets mention', () => {
    const result = multi([QS_TICKET, 'Affected package: qs\nVulnerable versions: <6.7.4\nFixed in: 6.7.4\nCVE-2099-5555']);
    assert.deepEqual(JSON.parse(result.newPackageJson).overrides, { qs: '6.7.4' });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.instances.every((item) => item.vulnerable), true);
  });

  it('plans a lockfile-only update and a bump together, with the right commands', () => {
    const result = multi([LODASH_TICKET, 'Affected package: minimist\nFixed in: 1.2.6\nCVE-2021-44906']);
    assert.deepEqual(result.commands, ['npm install', 'npm update minimist']);
    assert.equal(result.matrix[1]?.closedBy[0], 'Update minimist in the lockfile only');
  });

  it('stops at the ticket limit and says so', () => {
    const tickets = Array.from({ length: 5 }, () => LODASH_TICKET);
    const result = multi(tickets.map((text, index) => `${text}\nnote ${index}`), { maxTickets: 3 });
    assert.equal(result.tickets.length, 3);
    assert.ok(result.warnings.some((text) => /Only the first 3 tickets/.test(text)));
  });

  it('works end to end with pasted text split into blocks', () => {
    const pasted = `${LODASH_TICKET}\n---\n${QS_TICKET}`;
    const result = multi(splitTickets(pasted).tickets);
    assert.equal(result.matrix.length, 2);
    assert.equal(result.changed, true);
  });

  it('warns about npm audit --force advice in any of the tickets', () => {
    const result = multi([LODASH_TICKET, 'qs\nfix available via `npm audit fix --force`\nSeverity: high']);
    assert.ok(result.warnings.some((text) => /--force/.test(text)));
  });

  it('raises the direct dependency and explains why when a nested copy needs a newer version', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { qs: '^6.0.0', host: '^1.0.0' } },
        'node_modules/qs': { version: '6.5.0' },
        'node_modules/host': { version: '1.0.0', dependencies: { qs: '6.4.0' } },
        'node_modules/host/node_modules/qs': { version: '6.4.0' },
      },
    });
    const result = planMultiRemediation({
      packageJson: JSON.stringify({ dependencies: { qs: '^6.0.0', host: '^1.0.0' } }, null, 2),
      lockfile: lock,
      tickets: [
        { text: 'Affected package: qs\nVulnerable versions: >=6.5.0 <6.5.1\nFixed in: 6.5.1\nCVE-2099-6001' },
        { text: 'Affected package: qs\nVulnerable versions: <6.5.0\nFixed in: 6.7.0\nCVE-2099-6002' },
      ],
    });
    assert.ok(result.ok);
    const data = JSON.parse(result.newPackageJson);
    assert.equal(data.dependencies.qs, '^6.7.0');
    assert.deepEqual(data.overrides, { qs: '$qs' });
    assert.ok(result.findings[0]?.conflicts.some((text) => /direct dependency and is also pulled in by other packages that need 6\.7\.0/.test(text)));
    assert.deepEqual(result.matrix.map((row) => row.status), ['planned', 'planned']);
  });

  it('rejects bad input', () => {
    const noTickets = planMultiRemediation({ packageJson: PACKAGE_JSON, tickets: [] });
    assert.equal(noTickets.ok ? undefined : noTickets.code, 'NO_TICKETS');
    const broken = planMultiRemediation({ packageJson: '{', tickets: [{ text: LODASH_TICKET }] });
    assert.equal(broken.ok ? undefined : broken.code, 'INVALID_PACKAGE_JSON');
    const nothing = planMultiRemediation({ packageJson: PACKAGE_JSON, tickets: [{ text: 'hello' }, { text: 'world' }] });
    assert.equal(nothing.ok ? undefined : nothing.code, 'NO_FINDINGS');
  });
});
