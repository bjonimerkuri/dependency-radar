import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOsvSource, fixedVersionsFromOsv, planMultiRemediationWithLookup, planRemediationWithLookup } from '../src/index.ts';
import type { AdvisorySource } from '../src/index.ts';
import { LOCKFILE, PACKAGE_JSON } from './remediate-fixtures.ts';

const record = {
  id: 'GHSA-35jh-r3h4-6jhm',
  affected: [
    {
      package: { ecosystem: 'npm', name: 'lodash' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
    },
    {
      package: { ecosystem: 'PyPI', name: 'lodash' },
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '9.9.9' }] }],
    },
    {
      package: { ecosystem: 'npm', name: 'lodash-es' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.22' }] }],
    },
  ],
};

function jsonFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: fake, urls };
}

describe('fixedVersionsFromOsv', () => {
  it('reads fixed versions for the right package and ecosystem only', () => {
    assert.deepEqual(fixedVersionsFromOsv(record, 'lodash'), ['4.17.21']);
    assert.deepEqual(fixedVersionsFromOsv(record, 'lodash-es'), ['4.17.22']);
    assert.deepEqual(fixedVersionsFromOsv(record, 'other'), []);
  });

  it('collects several fixed versions in order and ignores invalid data', () => {
    const many = {
      affected: [
        {
          package: { ecosystem: 'npm', name: 'qs' },
          ranges: [
            { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '6.2.4' }, { introduced: '6.3.0' }, { fixed: '6.3.3' }, { fixed: 'not-a-version' }] },
          ],
        },
        'junk',
        { package: 'junk' },
      ],
    };
    assert.deepEqual(fixedVersionsFromOsv(many, 'qs'), ['6.2.4', '6.3.3']);
    assert.deepEqual(fixedVersionsFromOsv(null, 'qs'), []);
    assert.deepEqual(fixedVersionsFromOsv({ affected: 'x' }, 'qs'), []);
  });
});

describe('createOsvSource', () => {
  it('asks only api.osv.dev, with the id in its usual letter case', async () => {
    const { fetch, urls } = jsonFetch(record);
    const source = createOsvSource({ fetch });
    assert.deepEqual(await source.fixedVersions('GHSA-35JH-R3H4-6JHM', 'lodash'), ['4.17.21']);
    assert.deepEqual(await source.fixedVersions('cve-2021-23337', 'lodash'), ['4.17.21']);
    assert.deepEqual(urls, ['https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm', 'https://api.osv.dev/v1/vulns/CVE-2021-23337']);
  });

  it('does not send anything for text that is not an advisory id', async () => {
    const { fetch, urls } = jsonFetch(record);
    assert.deepEqual(await createOsvSource({ fetch }).fixedVersions('../../etc/passwd', 'lodash'), []);
    assert.deepEqual(await createOsvSource({ fetch }).fixedVersions('SNYK-JS-LODASH-1018905', 'lodash'), []);
    assert.deepEqual(urls, []);
  });

  it('returns nothing when the service fails, is not found or sends junk', async () => {
    assert.deepEqual(await createOsvSource({ fetch: jsonFetch({}, 500).fetch }).fixedVersions('CVE-2021-23337', 'lodash'), []);
    assert.deepEqual(await createOsvSource({ fetch: jsonFetch({}, 404).fetch }).fixedVersions('CVE-2021-23337', 'lodash'), []);
    const junk = (async () => new Response('<html>')) as unknown as typeof fetch;
    assert.deepEqual(await createOsvSource({ fetch: junk }).fixedVersions('CVE-2021-23337', 'lodash'), []);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    assert.deepEqual(await createOsvSource({ fetch: down }).fixedVersions('CVE-2021-23337', 'lodash'), []);
  });

  it('refuses a redirect to another host', async () => {
    const redirected = (async () => {
      const response = new Response(JSON.stringify(record));
      Object.defineProperty(response, 'url', { value: 'https://evil.example/x' });
      return response;
    }) as unknown as typeof fetch;
    assert.deepEqual(await createOsvSource({ fetch: redirected }).fixedVersions('CVE-2021-23337', 'lodash'), []);
  });
});

const noFix = 'Affected package: lodash\nInstalled version: 4.17.20\nSeverity: high\nCVE-2021-23337';

describe('planRemediationWithLookup', () => {
  it('fills in a missing fixed version from the advisory database and says so', async () => {
    const asked: Array<[string, string]> = [];
    const source: AdvisorySource = {
      async fixedVersions(id, name) {
        asked.push([id, name]);
        return ['4.17.21'];
      },
    };
    const { result, lookup } = await planRemediationWithLookup({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket: noFix }, source);
    assert.ok(result.ok);
    assert.deepEqual(asked, [['CVE-2021-23337', 'lodash']]);
    assert.equal(result.findings[0]?.status, 'planned');
    assert.equal(JSON.parse(result.newPackageJson).dependencies.lodash, '^4.17.21');
    assert.ok(result.warnings.some((text) => /taken from the OSV advisory database/.test(text)));
    assert.deepEqual(lookup, { looked: true, found: { lodash: ['4.17.21'] } });
  });

  it('does not call the service when the ticket already has the fixed version', async () => {
    let calls = 0;
    const source: AdvisorySource = {
      async fixedVersions() {
        calls++;
        return [];
      },
    };
    const { result, lookup } = await planRemediationWithLookup({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket: `${noFix}\nFixed in: 4.17.21` }, source);
    assert.ok(result.ok);
    assert.equal(calls, 0);
    assert.equal(lookup.looked, false);
  });

  it('keeps going when the lookup fails or throws', async () => {
    const failing: AdvisorySource = {
      async fixedVersions() {
        throw new Error('boom');
      },
    };
    const { result, lookup } = await planRemediationWithLookup({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket: noFix }, failing);
    assert.ok(result.ok);
    assert.equal(result.findings[0]?.status, 'no-fixed-version');
    assert.deepEqual(lookup, { looked: true, found: {} });
  });

  it('limits the number of lookups', async () => {
    let calls = 0;
    const source: AdvisorySource = {
      async fixedVersions() {
        calls++;
        return [];
      },
    };
    const ids = Array.from({ length: 30 }, (_, index) => `CVE-2099-${String(1000 + index)}`).join(' ');
    await planRemediationWithLookup({ packageJson: PACKAGE_JSON, lockfile: LOCKFILE, ticket: `Affected package: lodash\nInstalled version: 4.17.20\n${ids}` }, source, { maxLookups: 4 });
    assert.equal(calls, 4);
  });

  it('passes errors for bad input through without calling the service', async () => {
    let calls = 0;
    const source: AdvisorySource = {
      async fixedVersions() {
        calls++;
        return [];
      },
    };
    const { result } = await planRemediationWithLookup({ packageJson: '{', ticket: noFix }, source);
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  });
});

describe('planMultiRemediationWithLookup', () => {
  it('looks up only the tickets that have no fixed version', async () => {
    const asked: string[] = [];
    const source: AdvisorySource = {
      async fixedVersions(id) {
        asked.push(id);
        return ['4.17.21'];
      },
    };
    const { result } = await planMultiRemediationWithLookup(
      { packageJson: PACKAGE_JSON, lockfile: LOCKFILE, tickets: [{ text: noFix }, { text: 'Affected package: qs\nVulnerable versions: <6.7.3\nFixed in: 6.7.3\nGHSA-hrpp-h998-j3pp' }] },
      source,
    );
    assert.ok(result.ok);
    assert.deepEqual(asked, ['CVE-2021-23337']);
    assert.deepEqual(result.matrix.map((row) => row.status), ['planned', 'planned']);
  });
});
