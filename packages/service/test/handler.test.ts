import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDemoReport, demoDeps, DEMO_LOCKFILE, DEMO_PACKAGE_JSON } from '../src/demo.ts';
import { createHandler } from '../src/handler.ts';
import type { HttpRequest } from '../src/handler.ts';
import { createRateLimiter } from '../src/limits.ts';
import { createAnalyzeService } from '../src/service.ts';

function setup(options: { limit?: number; maxBodyBytes?: number; serverAiEnabled?: boolean } = {}) {
  const events: Array<{ route: string; status: number }> = [];
  let demoCalls = 0;
  const service = createAnalyzeService({
    registry: demoDeps.registry,
    manifests: demoDeps.manifests,
    changelogs: demoDeps.changelogs,
    createByokProvider: (settings) => {
      if (!settings.baseUrl.startsWith('https://api.groq.com')) throw new Error('not allowed');
      return demoDeps.ai;
    },
  });
  const handler = createHandler({
    service,
    limiter: createRateLimiter({ limit: options.limit ?? 100, windowMs: 3_600_000 }),
    demo: () => {
      demoCalls++;
      return buildDemoReport(new Date('2026-10-30T10:00:00Z'));
    },
    serverAiEnabled: options.serverAiEnabled ?? false,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    onEvent: (event) => events.push(event),
  });
  const call = (method: string, path: string, extra: Partial<HttpRequest> = {}) =>
    handler({ method, path, headers: {}, body: '', ip: '203.0.113.1', ...extra });
  return { call, events, demoCalls: () => demoCalls };
}

const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const jsonBody = (value: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

describe('pages and demo', () => {
  it('serves the form with strict security headers', async () => {
    const { call } = setup();
    const response = await call('GET', '/');
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/html/);
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'none'/);
    assert.match(response.headers['content-security-policy'] ?? '', /form-action 'self'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.body, /<form method="post" action="\/report">/);
    assert.match(response.body, /href="\/demo"/);
    assert.match(response.body, /type="password" name="ai_apiKey"/);
    assert.equal(/<script/i.test(response.body), false);
  });

  it('shows whether the server AI is enabled', async () => {
    assert.match((await setup({ serverAiEnabled: true }).call('GET', '/')).body, /value="server">/);
    assert.match((await setup({ serverAiEnabled: false }).call('GET', '/')).body, /value="server" disabled>/);
  });

  it('serves a labeled sample report and builds it only once', async () => {
    const { call, demoCalls } = setup();
    const first = await call('GET', '/demo');
    await call('GET', '/demo');
    await call('GET', '/api/demo');
    assert.equal(first.status, 200);
    assert.match(first.body, /Sample data for a made-up project/);
    assert.match(first.body, /BREAKING/);
    assert.match(first.body, /demo-router/);
    assert.match(first.body, /Analyze another project/);
    assert.equal(demoCalls(), 1);
  });

  it('serves the sample report as JSON', async () => {
    const response = await setup().call('GET', '/api/demo');
    const data = JSON.parse(response.body);
    assert.equal(data.source, 'demo');
    assert.equal(data.results.length, 7);
    assert.equal(data.summary.total, 7);
  });

  it('answers health checks', async () => {
    const response = await setup().call('GET', '/health');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { status: 'ok' });
  });
});

describe('analysis requests', () => {
  it('analyzes a package.json sent as JSON', async () => {
    const response = await setup().call('POST', '/api/analyze', jsonBody({ packageJson: DEMO_PACKAGE_JSON, lockfile: DEMO_LOCKFILE }));
    assert.equal(response.status, 200);
    const data = JSON.parse(response.body);
    assert.equal(data.source, 'paste');
    assert.equal(data.results.length, 7);
    assert.match(data.notes.join(' '), /not scanned/);
  });

  it('analyzes a package.json sent from the form and shows an HTML report', async () => {
    const response = await setup().call('POST', '/report', form({ packageJson: DEMO_PACKAGE_JSON, lockfile: DEMO_LOCKFILE }));
    assert.equal(response.status, 200);
    assert.match(response.body, /<title>Dependency Radar report<\/title>/);
    assert.match(response.body, /demo-router/);
    assert.match(response.body, /Analyze another project/);
  });

  it('shows form errors on the form and keeps what was typed', async () => {
    const response = await setup().call('POST', '/report', form({ packageJson: '{\n "a": ,\n}', githubUrl: '' }));
    assert.equal(response.status, 422);
    assert.match(response.body, /role="alert">package\.json: Invalid JSON at line 2/);
    assert.match(response.body, /<textarea name="packageJson"[^>]*>\{\n &quot;a&quot;: ,\n\}<\/textarea>/);
  });

  it('returns JSON errors for the API', async () => {
    const response = await setup().call('POST', '/api/analyze', jsonBody({}));
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'MISSING_INPUT');
  });

  it('escapes whatever the visitor typed', async () => {
    const hostile = '</textarea><script>alert(1)</script>';
    const response = await setup().call('POST', '/report', form({ packageJson: hostile, githubUrl: '"><script>alert(2)</script>', path: '<img src=x onerror=alert(3)>' }));
    assert.equal(/<script/i.test(response.body), false);
    assert.equal(/<img/i.test(response.body), false);
    assert.ok(response.body.includes('&lt;script&gt;alert(1)'));
  });

  it('never sends a visitor key back', async () => {
    const secret = 'sk-secret-abcdef';
    const attempts = [
      form({ packageJson: '{bad', ai_mode: 'byok', ai_apiKey: secret, ai_baseUrl: 'https://api.groq.com/v1', ai_model: 'm' }),
      form({ packageJson: DEMO_PACKAGE_JSON, ai_mode: 'byok', ai_apiKey: secret, ai_baseUrl: 'https://evil.example.com', ai_model: 'm' }),
      form({ packageJson: DEMO_PACKAGE_JSON, ai_mode: 'byok', ai_apiKey: secret, ai_baseUrl: 'https://api.groq.com/v1', ai_model: 'm' }),
    ];
    for (const attempt of attempts) {
      const response = await setup().call('POST', '/report', attempt);
      assert.equal(response.body.includes(secret), false);
    }
    const api = await setup().call('POST', '/api/analyze', jsonBody({ packageJson: DEMO_PACKAGE_JSON, ai: { mode: 'byok', apiKey: secret, baseUrl: 'https://api.groq.com/v1', model: 'm' } }));
    assert.equal(api.status, 200);
    assert.equal(api.body.includes(secret), false);
  });
});

describe('protocol rules', () => {
  it('answers unknown paths and wrong methods', async () => {
    const { call } = setup();
    const missingPage = await call('GET', '/nope');
    assert.equal(missingPage.status, 404);
    assert.match(missingPage.headers['content-type'] ?? '', /html/);
    const missingApi = await call('GET', '/api/nope');
    assert.equal(missingApi.status, 404);
    assert.equal(JSON.parse(missingApi.body).error.code, 'NOT_FOUND');
    const wrongMethod = await call('GET', '/report');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'POST');
    const wrongApi = await call('DELETE', '/api/analyze');
    assert.equal(wrongApi.status, 405);
    assert.equal((await call('POST', '/')).status, 405);
  });

  it('requires the right content type', async () => {
    const { call } = setup();
    assert.equal((await call('POST', '/api/analyze', { body: '{}' })).status, 415);
    assert.equal((await call('POST', '/api/analyze', { ...form({ a: 'b' }) })).status, 415);
    assert.equal((await call('POST', '/report', { ...jsonBody({}) })).status, 415);
    assert.equal((await call('POST', '/api/analyze', { headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: '{"packageJson":"{}"}' })).status, 200);
  });

  it('rejects invalid JSON bodies and oversized requests', async () => {
    const { call } = setup({ maxBodyBytes: 100 });
    const bad = await call('POST', '/api/analyze', { headers: { 'content-type': 'application/json' }, body: '[1,2]' });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, 'INVALID_JSON');
    const big = await call('POST', '/api/analyze', jsonBody({ packageJson: 'x'.repeat(500) }));
    assert.equal(big.status, 413);
    const bigForm = await call('POST', '/report', form({ packageJson: 'x'.repeat(500) }));
    assert.equal(bigForm.status, 413);
  });

  it('limits analyses per address and reports when to retry', async () => {
    const { call } = setup({ limit: 2 });
    const body = jsonBody({ packageJson: '{}' });
    assert.equal((await call('POST', '/api/analyze', body)).status, 200);
    assert.equal((await call('POST', '/api/analyze', body)).status, 200);
    const limited = await call('POST', '/api/analyze', body);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    const limitedForm = await call('POST', '/report', form({ packageJson: '{}' }));
    assert.equal(limitedForm.status, 429);
    assert.match(limitedForm.body, /Too many analyses/);
    assert.equal((await call('POST', '/api/analyze', { ...body, ip: '203.0.113.2' })).status, 200);
    assert.equal((await call('GET', '/demo')).status, 200);
    assert.equal((await call('GET', '/health')).status, 200);
  });

  it('reports each request without its content', async () => {
    const { call, events } = setup();
    await call('GET', '/health');
    await call('POST', '/api/analyze', jsonBody({ packageJson: '{}' }));
    assert.deepEqual(events.map((event) => [event.route, event.status]), [['health', 200], ['api-analyze', 200]]);
    assert.ok(events.every((event) => Object.keys(event).sort().join() === 'durationMs,route,status'));
  });
});
