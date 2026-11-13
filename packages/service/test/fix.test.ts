import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdvisorySource, ChangelogSource, ManifestClient } from '@dependency-radar/core';
import { buildFixDemo, DEMO_FIX_LOCKFILE, DEMO_FIX_PACKAGE_JSON, DEMO_FIX_TICKETS } from '../src/fix-demo.ts';
import { createHandler } from '../src/handler.ts';
import type { HttpRequest } from '../src/handler.ts';
import { createRateLimiter } from '../src/limits.ts';
import { createAnalyzeService } from '../src/service.ts';
import type { ServiceDeps } from '../src/service.ts';
import { makeZip } from './zip-helper.ts';

const LODASH = 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 4.17.21\nSeverity: high\nCVE-2021-23337';

const manifests: ManifestClient = { async getManifest() { return { ok: true, manifest: {} }; } };
const changelogs: ChangelogSource = { async fetchChangelog() { return { ok: false, code: 'NOT_FOUND', message: 'none' }; } };
const noRegistry = {
  registry: { async getPackument(): Promise<never> { throw new Error('the registry must not be used'); } },
  manifests,
  changelogs,
  now: () => new Date('2026-11-12T10:00:00Z'),
};

function service(extra: Partial<ServiceDeps> = {}) {
  return createAnalyzeService({ ...noRegistry, ...extra });
}

describe('service.fix', () => {
  it('builds the plan and both descriptions from pasted files', async () => {
    const outcome = await service().fix({ ticket: LODASH, packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE });
    assert.ok(outcome.ok);
    assert.equal(outcome.fix.source, 'paste');
    assert.equal(outcome.fix.generatedAt, '2026-11-12T10:00:00.000Z');
    assert.equal(outcome.fix.plan.findings[0]?.status, 'planned');
    assert.match(outcome.fix.pr.markdown.body, /## What changes/);
    assert.match(outcome.fix.pr.jira.body, /^WHAT CHANGES$/m);
    assert.ok(outcome.fix.notes.some((text) => /not scanned/.test(text)));
    assert.equal(outcome.fix.scanned, false);
  });

  it('handles several tickets separated by dashes', async () => {
    const outcome = await service().fix({ ticket: DEMO_FIX_TICKETS, packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE, language: 'sq' });
    assert.ok(outcome.ok);
    assert.equal('matrix' in outcome.fix.plan && outcome.fix.plan.matrix.length, 3);
    assert.match(outcome.fix.pr.markdown.body, /## Çfarë ndryshon/);
  });

  it('looks up fixed versions only when an advisory source is given', async () => {
    const noFix = 'Affected package: lodash\nInstalled version: 4.17.20\nCVE-2021-23337';
    const without = await service().fix({ ticket: noFix, packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE });
    assert.ok(without.ok);
    assert.equal(without.fix.plan.findings[0]?.status, 'no-fixed-version');
    const asked: string[] = [];
    const advisories: AdvisorySource = { async fixedVersions(id) { asked.push(id); return ['4.17.21']; } };
    const withLookup = await service({ advisories }).fix({ ticket: noFix, packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE });
    assert.ok(withLookup.ok);
    assert.deepEqual(asked, ['CVE-2021-23337']);
    assert.equal(withLookup.fix.plan.findings[0]?.status, 'planned');
  });

  it('reads a GitHub repository, scans the code and lists the files that use the package', async () => {
    const zip = makeZip([
      { name: 'shop-main/package.json', data: DEMO_FIX_PACKAGE_JSON },
      { name: 'shop-main/package-lock.json', data: DEMO_FIX_LOCKFILE },
      { name: 'shop-main/src/a.ts', data: "import _ from 'lodash';\n_.get({}, 'a');" },
    ]);
    const urls: string[] = [];
    const fake = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response(zip); }) as typeof fetch;
    const outcome = await service({ fetch: fake }).fix({ ticket: LODASH, githubUrl: 'https://github.com/octo/shop' });
    assert.ok(outcome.ok);
    assert.deepEqual(urls, ['https://codeload.github.com/octo/shop/zip/HEAD']);
    assert.equal(outcome.fix.source, 'github');
    assert.equal(outcome.fix.subject, 'https://github.com/octo/shop');
    assert.equal(outcome.fix.scanned, true);
    assert.match(outcome.fix.pr.markdown.body, /lodash is imported in 1 file: src\/a\.ts/);
  });

  it('checks the changelog of a major fix with at most a few lookups', async () => {
    let calls = 0;
    const counting: ManifestClient = { async getManifest() { calls++; return { ok: true, manifest: { repository: 'github:acme/lodash' } }; } };
    const outcome = await service({ manifests: counting }).fix({
      ticket: 'Affected package: lodash\nInstalled version: 4.17.20\nFixed in: 5.0.0\nCVE-2099-0001',
      packageJson: DEMO_FIX_PACKAGE_JSON,
      lockfile: DEMO_FIX_LOCKFILE,
    });
    assert.ok(outcome.ok);
    assert.equal(calls, 1);
    assert.equal(outcome.fix.majorChecks[0]?.status, 'not-found');
    assert.ok(outcome.fix.plan.findings[0]?.notes.some((text) => /I am not sure whether this major update breaks your code/.test(text)));
  });

  it('rejects bad input with clear codes', async () => {
    const s = service();
    const code = async (request: Parameters<typeof s.fix>[0]) => {
      const outcome = await s.fix(request);
      return outcome.ok ? 'ok' : `${outcome.status} ${outcome.code}`;
    };
    assert.equal(await code({ packageJson: '{}' }), '400 MISSING_TICKET');
    assert.equal(await code({ ticket: LODASH }), '400 MISSING_INPUT');
    assert.equal(await code({ ticket: LODASH, packageJson: '{ nope' }), '422 INVALID_PACKAGE_JSON');
    assert.equal(await code({ ticket: 'hello', packageJson: '{}' }), '422 NO_FINDINGS');
    assert.equal(await code({ ticket: LODASH, packageJson: '{}', packageManager: 'bun' }), '400 INVALID_PACKAGE_MANAGER');
    assert.equal(await code({ ticket: LODASH, packageJson: '{}', language: 'fr' }), '400 INVALID_LANGUAGE');
    assert.equal(await code({ ticket: LODASH, githubUrl: 'not a url' }), '400 INVALID_GITHUB_URL');
    assert.equal(await code({ ticket: LODASH, packageJson: 'x'.repeat(200_001) }), '413 PACKAGE_JSON_TOO_LARGE');
  });

  it('reports a repository that cannot be downloaded', async () => {
    const fake = (async () => new Response('', { status: 404 })) as typeof fetch;
    const outcome = await service({ fetch: fake }).fix({ ticket: LODASH, githubUrl: 'octo/missing' });
    assert.equal(outcome.ok ? 'ok' : outcome.code, 'REPOSITORY_UNAVAILABLE');
  });
});

function setup(limit = 100) {
  const handler = createHandler({
    service: service(),
    limiter: createRateLimiter({ limit, windowMs: 3_600_000 }),
    demo: async () => { throw new Error('not used'); },
    serverAiEnabled: false,
  });
  const call = (method: string, path: string, extra: Partial<HttpRequest> = {}) => handler({ method, path, headers: {}, body: '', ip: '203.0.113.9', ...extra });
  return { call };
}
const form = (fields: Record<string, string>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const jsonBody = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

describe('fix routes', () => {
  it('serves the form without scripts, and an example that fills it in', async () => {
    const { call } = setup();
    const page = await call('GET', '/fix');
    assert.equal(page.status, 200);
    assert.match(page.body, /<form method="post" action="\/fix">/);
    assert.match(page.body, /name="ticket"/);
    assert.equal(/<script/i.test(page.body), false);
    assert.match(page.headers['content-security-policy'] ?? '', /default-src 'none'/);
    const example = await call('GET', '/fix/example');
    assert.match(example.body, /CVE-2021-23337/);
    assert.match(example.body, /demo-shop/);
    assert.match((await call('GET', '/')).body, /href="\/fix"/);
  });

  it('shows a sample result without any network use', async () => {
    const { call } = setup();
    const page = await call('GET', '/fix/demo');
    assert.equal(page.status, 200);
    assert.match(page.body, /Sample data for a made-up project/);
    assert.match(page.body, /Which change closes which ticket/);
    assert.match(page.body, /Raise lodash to \^4\.17\.21/);
    const api = await call('GET', '/api/fix/demo');
    const data = JSON.parse(api.body);
    assert.equal(data.source, 'demo');
    assert.equal(data.plan.hunks, undefined);
    assert.equal(data.plan.matrix.length, 3);
    assert.match(data.pr.markdown.body, /According to the advisory|according to the advisory/);
    assert.equal(buildFixDemo(new Date('2026-11-12T10:00:00Z')).generatedAt, '2026-11-12T10:00:00.000Z');
  });

  it('answers a form post with the result page', async () => {
    const { call } = setup();
    const response = await call('POST', '/fix', form({ ticket: LODASH, packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE }));
    assert.equal(response.status, 200);
    assert.match(response.body, /One package needs a change/);
    assert.match(response.body, /Markdown for GitHub/);
    assert.equal(/<script/i.test(response.body), false);
  });

  it('keeps what was typed when the form has an error', async () => {
    const { call } = setup();
    const response = await call('POST', '/fix', form({ ticket: 'hello <b>there</b>', packageJson: '{}' }));
    assert.equal(response.status, 422);
    assert.match(response.body, /could not find a package name/);
    assert.match(response.body, /hello &lt;b&gt;there&lt;\/b&gt;/);
  });

  it('answers the API with JSON and with JSON errors', async () => {
    const { call } = setup();
    const ok = await call('POST', '/api/fix', jsonBody({ ticket: LODASH, packageJson: DEMO_FIX_PACKAGE_JSON, lockfile: DEMO_FIX_LOCKFILE }));
    assert.equal(ok.status, 200);
    const data = JSON.parse(ok.body);
    assert.equal(data.plan.findings[0].status, 'planned');
    assert.equal(data.plan.changed, true);
    assert.equal(JSON.parse(data.plan.newPackageJson).dependencies.lodash, '^4.17.21');
    assert.match(data.pr.jira.body, /^WHAT CHANGES$/m);

    const bad = await call('POST', '/api/fix', jsonBody({ packageJson: '{}' }));
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'MISSING_TICKET');
    const broken = await call('POST', '/api/fix', { headers: { 'content-type': 'application/json' }, body: '[1]' });
    assert.equal(JSON.parse(broken.body).error.code, 'INVALID_JSON');
    assert.equal((await call('POST', '/api/fix', { headers: { 'content-type': 'text/plain' }, body: '' })).status, 415);
  });

  it('applies the same limits as the other routes', async () => {
    const { call } = setup(1);
    const first = await call('POST', '/api/fix', jsonBody({ ticket: LODASH, packageJson: DEMO_FIX_PACKAGE_JSON }));
    assert.equal(first.status, 200);
    const second = await call('POST', '/api/fix', jsonBody({ ticket: LODASH, packageJson: DEMO_FIX_PACKAGE_JSON }));
    assert.equal(second.status, 429);
    assert.equal((await call('GET', '/fix/demo')).status, 200);
    assert.equal((await call('PUT', '/fix')).status, 405);
    assert.equal((await call('POST', '/fix/demo')).status, 405);
  });
});
