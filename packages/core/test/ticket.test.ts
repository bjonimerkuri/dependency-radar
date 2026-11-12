import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTicket } from '../src/index.ts';

const summary = (text: string) =>
  parseTicket(text).findings.map((finding) => ({
    name: finding.packageName,
    installed: finding.installedVersion,
    range: finding.vulnerableRange,
    fixed: finding.fixedVersions,
    ids: finding.ids,
    severity: finding.severity,
  }));

describe('parseTicket: tables and titles', () => {
  it('reads a Trivy style table, including rows that continue the previous package', () => {
    const table = `
┌─────────┬────────────────┬──────────┬───────────────────┬───────────────┐
│ Library │ Vulnerability  │ Severity │ Installed Version │ Fixed Version │
├─────────┼────────────────┼──────────┼───────────────────┼───────────────┤
│ lodash  │ CVE-2021-23337 │ HIGH     │ 4.17.20           │ 4.17.21       │
│         │ CVE-2020-8203  │ HIGH     │ 4.17.20           │ 4.17.19       │
│ qs      │ CVE-2022-24999 │ MEDIUM   │ 6.7.0             │ 6.7.3, 6.8.3  │
└─────────┴────────────────┴──────────┴───────────────────┴───────────────┘`;
    assert.deepEqual(summary(table), [
      { name: 'lodash', installed: '4.17.20', range: undefined, fixed: ['4.17.19', '4.17.21'], ids: ['CVE-2020-8203', 'CVE-2021-23337'], severity: 'high' },
      { name: 'qs', installed: '6.7.0', range: undefined, fixed: ['6.7.3', '6.8.3'], ids: ['CVE-2022-24999'], severity: 'medium' },
    ]);
  });

  it('reads a markdown table', () => {
    const table = '| Package | Vulnerability | Severity | Installed Version | Fixed Version |\n| --- | --- | --- | --- | --- |\n| `minimist` | GHSA-xvch-5gv4-984h | critical | 1.2.5 | 1.2.6 |';
    assert.deepEqual(summary(table), [
      { name: 'minimist', installed: '1.2.5', range: undefined, fixed: ['1.2.6'], ids: ['GHSA-XVCH-5GV4-984H'], severity: 'critical' },
    ]);
  });

  it('reads dependency update titles', () => {
    assert.deepEqual(summary('Bump lodash from 4.17.20 to 4.17.21 in /app'), [{ name: 'lodash', installed: '4.17.20', range: undefined, fixed: ['4.17.21'], ids: [], severity: undefined }]);
    assert.equal(summary('chore(deps): bump @babel/core from 7.12.0 to 7.23.2')[0]?.name, '@babel/core');
    assert.equal(summary('Upgrade `axios@0.21.0` to `axios@0.21.2`')[0]?.fixed[0], '0.21.2');
    assert.equal(summary('Update minimist 1.2.5 -> 1.2.6')[0]?.installed, '1.2.5');
  });
});

describe('parseTicket: labelled fields', () => {
  it('reads a Dependabot or advisory style block', () => {
    const block = 'Package: qs\nInstalled version: 6.7.0\nAffected versions: >= 6.7.0, < 6.7.3\nPatched versions: 6.7.3\nSeverity: High\nCVE-2022-24999';
    assert.deepEqual(summary(block), [
      { name: 'qs', installed: '6.7.0', range: '>=6.7.0 <6.7.3', fixed: ['6.7.3'], ids: ['CVE-2022-24999'], severity: 'high' },
    ]);
  });

  it('reads Snyk style output', () => {
    const snyk = '✗ High severity vulnerability found in minimist\n  Vulnerable module: minimist\n  Introduced through: mkdirp@0.5.1 > minimist@0.0.8\n  Fixed in: 0.2.4, 1.2.6\n  SNYK-JS-MINIMIST-559764';
    const found = summary(snyk);
    assert.equal(found.length, 1);
    assert.deepEqual([found[0]?.name, found[0]?.fixed, found[0]?.ids, found[0]?.severity], ['minimist', ['0.2.4', '1.2.6'], ['SNYK-JS-MINIMIST-559764'], 'high']);
  });

  it('reads npm audit text output', () => {
    const audit = 'lodash  <4.17.21\nSeverity: high\nPrototype Pollution in lodash - https://github.com/advisories/GHSA-35jh-r3h4-6jhm\nfix available via `npm audit fix`\nnode_modules/lodash';
    assert.deepEqual(summary(audit), [{ name: 'lodash', installed: undefined, range: '<4.17.21', fixed: [], ids: ['GHSA-35JH-R3H4-6JHM'], severity: 'high' }]);
  });

  it('keeps several findings apart', () => {
    const ticket = 'Package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21\nSeverity: high\n\nPackage: qs\nInstalled version: 6.7.0\nFixed in: 6.7.3\nSeverity: low\nCVE-2022-24999';
    const found = summary(ticket);
    assert.deepEqual(found.map((item) => [item.name, item.fixed, item.severity, item.ids]), [
      ['lodash', ['4.17.21'], 'high', []],
      ['qs', ['6.7.3'], 'low', ['CVE-2022-24999']],
    ]);
  });

  it('splits findings that follow each other without a blank line', () => {
    const ticket = 'Package: lodash\nFixed in: 4.17.21\nPackage: qs\nFixed in: 6.7.3';
    assert.deepEqual(summary(ticket).map((item) => [item.name, item.fixed]), [['lodash', ['4.17.21']], ['qs', ['6.7.3']]]);
  });

  it('understands markdown decoration around labels', () => {
    const ticket = '- **Package:** `lodash`\n- **Installed version:** `4.17.20`\n- **Fixed version:** 4.17.21';
    assert.deepEqual(summary(ticket), [{ name: 'lodash', installed: '4.17.20', range: undefined, fixed: ['4.17.21'], ids: [], severity: undefined }]);
  });

  it('treats a single affected version as the installed version', () => {
    assert.equal(summary('Package: lodash\nAffected version: 4.17.20')[0]?.installed, '4.17.20');
  });
});

describe('parseTicket: sentences', () => {
  it('reads upgrade requests and the fix version from a nearby sentence', () => {
    const found = summary('Please upgrade lodash to 4.17.21 or later because of prototype pollution.');
    assert.deepEqual([found[0]?.name, found[0]?.fixed], ['lodash', ['4.17.21']]);
    const second = summary('`qs@6.7.0` is vulnerable. This is fixed in 6.7.3.');
    assert.deepEqual([second[0]?.name, second[0]?.installed, second[0]?.fixed], ['qs', '6.7.0', ['6.7.3']]);
  });

  it('does not invent findings from ordinary text', () => {
    for (const text of ['Please update to node 18 as soon as possible.', 'Meeting notes: nothing to see here.', '']) {
      const result = parseTicket(text);
      assert.deepEqual(result.findings, [], text);
      assert.match(result.warnings.join(' '), /No packages could be read/);
    }
  });
});

describe('parseTicket: JSON', () => {
  it('reads npm audit --json', () => {
    const audit = {
      vulnerabilities: {
        qs: {
          name: 'qs', severity: 'high', range: '<6.7.3',
          via: [{ source: 1, name: 'qs', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp', severity: 'high', range: '<6.7.3' }],
          fixAvailable: { name: 'qs', version: '6.7.3', isSemVerMajor: false },
        },
        express: { name: 'express', severity: 'high', range: '*', via: ['qs'], fixAvailable: { name: 'express', version: '4.18.2' } },
      },
    };
    assert.deepEqual(summary(JSON.stringify(audit)), [
      { name: 'qs', installed: undefined, range: '<6.7.3', fixed: ['6.7.3'], ids: ['GHSA-HRPP-H998-J3PP'], severity: 'high' },
    ]);
  });

  it('does not take a parent package as the fix version', () => {
    const audit = { vulnerabilities: { qs: { name: 'qs', severity: 'high', range: '<6.7.3', via: [{ name: 'qs', url: 'https://x/GHSA-hrpp-h998-j3pp' }], fixAvailable: { name: 'express', version: '4.18.2' } } } };
    assert.deepEqual(summary(JSON.stringify(audit))[0]?.fixed, []);
  });

  it('reads the older npm audit format', () => {
    const audit = { advisories: { '1': { module_name: 'minimist', vulnerable_versions: '<0.2.4', patched_versions: '>=0.2.4', severity: 'critical', cves: ['CVE-2021-44906'] } } };
    assert.deepEqual(summary(JSON.stringify(audit)), [
      { name: 'minimist', installed: undefined, range: '<0.2.4', fixed: ['0.2.4'], ids: ['CVE-2021-44906'], severity: 'critical' },
    ]);
  });

  it('reads GitHub Dependabot alerts', () => {
    const alerts = [
      {
        security_vulnerability: { package: { ecosystem: 'npm', name: 'lodash' }, vulnerable_version_range: '< 4.17.21', first_patched_version: { identifier: '4.17.21' } },
        security_advisory: { ghsa_id: 'GHSA-35jh-r3h4-6jhm', cve_id: 'CVE-2021-23337', severity: 'high' },
      },
      { security_vulnerability: { package: { name: 'broken' } } },
    ];
    const found = summary(JSON.stringify(alerts));
    assert.deepEqual(found[0], { name: 'lodash', installed: undefined, range: '<4.17.21', fixed: ['4.17.21'], ids: ['CVE-2021-23337', 'GHSA-35JH-R3H4-6JHM'], severity: 'high' });
    assert.equal(found.length, 2);
  });

  it('ignores JSON that is not a vulnerability report and broken JSON', () => {
    assert.deepEqual(summary('{"hello": "world"}'), []);
    assert.deepEqual(summary('{ "vulnerabilities": '), []);
  });
});

describe('parseTicket: merging, limits and robustness', () => {
  it('merges what several sources say about the same package', () => {
    const ticket = 'Bump qs from 6.7.0 to 6.7.3\n\nPackage: qs\nFixed in: 6.8.3\nSeverity: high\nCVE-2022-24999';
    const found = summary(ticket);
    assert.equal(found.length, 1);
    assert.deepEqual([found[0]?.installed, found[0]?.fixed, found[0]?.severity], ['6.7.0', ['6.7.3', '6.8.3'], 'high']);
  });

  it('ignores names that cannot be packages', () => {
    assert.deepEqual(summary('Package: Not A Package!'), []);
    assert.deepEqual(summary('Package: ../../etc/passwd'), []);
  });

  it('keeps pre-release fixes and ignores impossible versions', () => {
    assert.deepEqual(summary('Package: foo\nFixed in: 2.0.0-beta.3')[0]?.fixed, ['2.0.0-beta.3']);
    assert.deepEqual(summary('Package: foo\nFixed in: 999.1')[0]?.fixed, []);
  });

  it('limits the size and number of findings and reports it', () => {
    const many = Array.from({ length: 30 }, (_, i) => `Package: pkg-${i}\nFixed in: 1.0.${i}`).join('\n\n');
    const limited = parseTicket(many, { maxFindings: 10 });
    assert.equal(limited.findings.length, 10);
    assert.equal(limited.truncated, true);
    const long = parseTicket(`Package: lodash\nFixed in: 4.17.21\n${'x'.repeat(5000)}`, { maxChars: 100 });
    assert.equal(long.truncated, true);
    assert.match(long.warnings.join(' '), /only the first part was read/);
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    parseTicket('upgrade '.repeat(50_000));
    parseTicket('a@1.0.0 '.repeat(50_000));
    parseTicket(`Package: ${'a'.repeat(100_000)}`);
    parseTicket('| Library | Vulnerability |\n' + '|'.repeat(90_000));
    parseTicket('Fixed in: ' + '1.'.repeat(40_000));
    parseTicket('x'.repeat(95_000) + ' to 1.0.0');
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  });
});
