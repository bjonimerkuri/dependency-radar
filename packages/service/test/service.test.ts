import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiProvider } from '@dependency-radar/core';
import { demoDeps, DEMO_LOCKFILE, DEMO_PACKAGE_JSON, DEMO_SOURCES } from '../src/demo.ts';
import { createDailyBudget } from '../src/limits.ts';
import { createAnalyzeService } from '../src/service.ts';
import type { ServiceDeps } from '../src/service.ts';
import { makeZip } from './zip-helper.ts';

const base = (): ServiceDeps => ({
  registry: demoDeps.registry,
  manifests: demoDeps.manifests,
  changelogs: demoDeps.changelogs,
  now: () => new Date('2026-10-30T10:00:00Z'),
});

function repoFetch(prefix = 'shop-main/', status = 200) {
  const zip = makeZip([
    { name: `${prefix}package.json`, data: DEMO_PACKAGE_JSON },
    { name: `${prefix}package-lock.json`, data: DEMO_LOCKFILE },
    ...DEMO_SOURCES.map((file) => ({ name: `${prefix}${file.path}`, data: file.content })),
  ]);
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return status === 200 ? new Response(zip) : new Response('', { status });
  }) as typeof fetch;
  return { fetch: fakeFetch, urls };
}

const levels = (outcome: Awaited<ReturnType<ReturnType<typeof createAnalyzeService>['analyze']>>) => {
  assert.ok(outcome.ok);
  return new Map(outcome.report.analysis.results.map((result) => [result.name, result.verdict?.level]));
};

describe('analyze: pasted package.json', () => {
  it('analyzes and explains that the code was not scanned', async () => {
    const outcome = await createAnalyzeService(base()).analyze({ packageJson: DEMO_PACKAGE_JSON, lockfile: DEMO_LOCKFILE });
    assert.ok(outcome.ok);
    assert.equal(outcome.report.source, 'paste');
    assert.equal(outcome.report.lockfileName, 'package-lock.json');
    assert.equal(outcome.report.scan, undefined);
    assert.match(outcome.report.notes.join(' '), /code was not scanned/);
    assert.equal(levels(outcome).get('demo-router'), 'review');
    assert.equal(levels(outcome).get('demo-schema'), 'safe');
  });

  it('omits the lockfile name when none was given', async () => {
    const outcome = await createAnalyzeService(base()).analyze({ packageJson: DEMO_PACKAGE_JSON });
    assert.ok(outcome.ok);
    assert.equal(outcome.report.lockfileName, undefined);
    assert.ok(outcome.report.warnings.some((warning) => warning.code === 'NO_LOCKFILE'));
  });

  it('rejects missing, invalid and oversized input', async () => {
    const service = createAnalyzeService(base());
    const missing = await service.analyze({});
    assert.ok(!missing.ok);
    assert.equal(missing.status, 400);

    const invalid = await service.analyze({ packageJson: '{\n  "a": ,\n}' });
    assert.ok(!invalid.ok);
    assert.equal(invalid.status, 422);
    assert.match(invalid.message, /line 2/);

    const large = await service.analyze({ packageJson: `{"a":"${'x'.repeat(200_001)}"}` });
    assert.ok(!large.ok);
    assert.equal(large.status, 413);
  });

  it('still returns a partial report when the registry is down', async () => {
    const down = { ...base(), registry: { async getPackument() { return { ok: false as const, code: 'UNAVAILABLE' as const, message: 'down' }; } } };
    const outcome = await createAnalyzeService(down).analyze({ packageJson: DEMO_PACKAGE_JSON });
    assert.ok(outcome.ok);
    assert.equal(outcome.report.analysis.summary.errors, 7);
  });
});

describe('analyze: GitHub repository', () => {
  it('downloads, scans and links major updates to the code that uses them', async () => {
    const { fetch, urls } = repoFetch();
    const outcome = await createAnalyzeService({ ...base(), fetch }).analyze({ githubUrl: 'https://github.com/octo/shop' });
    assert.ok(outcome.ok);
    assert.deepEqual(urls, ['https://codeload.github.com/octo/shop/zip/HEAD']);
    assert.equal(outcome.report.source, 'github');
    assert.equal(outcome.report.scan?.scannedFiles, 5);
    assert.equal(levels(outcome).get('demo-router'), 'breaking');
    assert.equal(outcome.report.analysis.results.find((result) => result.name === 'demo-router')?.impact?.fileCount, 1);
  });

  it('takes the folder from a tree address or from the path field', async () => {
    const { fetch } = repoFetch('shop-main/packages/web/');
    const service = createAnalyzeService({ ...base(), fetch });
    const fromTree = await service.analyze({ githubUrl: 'https://github.com/octo/shop/tree/main/packages/web' });
    assert.ok(fromTree.ok);
    const fromField = await service.analyze({ githubUrl: 'octo/shop', path: 'packages/web' });
    assert.ok(fromField.ok);
    const wrong = await service.analyze({ githubUrl: 'octo/shop', path: 'packages/other' });
    assert.ok(!wrong.ok);
    assert.equal(wrong.status, 422);
  });

  it('rejects invalid addresses and unavailable repositories', async () => {
    const service = createAnalyzeService({ ...base(), fetch: repoFetch('x/', 404).fetch });
    const invalid = await service.analyze({ githubUrl: 'https://gitlab.com/a/b' });
    assert.ok(!invalid.ok);
    assert.equal(invalid.status, 400);
    const missing = await service.analyze({ githubUrl: 'octo/shop' });
    assert.ok(!missing.ok);
    assert.equal(missing.status, 404);
    assert.match(missing.message, /private/);
  });

  it('prefers the repository over a pasted package.json', async () => {
    const { fetch, urls } = repoFetch();
    const outcome = await createAnalyzeService({ ...base(), fetch }).analyze({ githubUrl: 'octo/shop', packageJson: '{}' });
    assert.ok(outcome.ok);
    assert.equal(urls.length, 1);
  });
});

describe('analyze: AI choices', () => {
  const counting = () => {
    const calls = { count: 0 };
    const provider: AiProvider = {
      async complete(request) {
        calls.count++;
        return demoDeps.ai.complete(request);
      },
    };
    return { provider, calls };
  };

  it('does not use AI by default', async () => {
    const { provider, calls } = counting();
    const outcome = await createAnalyzeService({ ...base(), serverAi: provider, aiBudget: createDailyBudget({ limit: 10 }), fetch: repoFetch().fetch }).analyze({ githubUrl: 'octo/shop' });
    assert.ok(outcome.ok);
    assert.equal(calls.count, 0);
    assert.ok(outcome.report.analysis.results.every((result) => result.explanation === undefined));
  });

  it('rejects unknown AI modes', async () => {
    const outcome = await createAnalyzeService(base()).analyze({ packageJson: DEMO_PACKAGE_JSON, ai: { mode: 'magic' } });
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, 'INVALID_AI_MODE');
  });

  it('uses the server AI within the daily budget and the per-analysis cap', async () => {
    const { provider, calls } = counting();
    const budget = createDailyBudget({ limit: 2 });
    const outcome = await createAnalyzeService({ ...base(), serverAi: provider, aiBudget: budget, fetch: repoFetch().fetch }).analyze({
      githubUrl: 'octo/shop',
      ai: { mode: 'server' },
    });
    assert.ok(outcome.ok);
    assert.equal(calls.count, 2);
    assert.equal(budget.remaining(), 0);
    const explained = outcome.report.analysis.results.filter((result) => result.explanation !== undefined);
    const failed = outcome.report.analysis.results.filter((result) => result.explanationError !== undefined);
    assert.equal(explained.length, 2);
    assert.equal(failed.length, 1);
    assert.match(failed[0]?.explanationError ?? '', /daily AI budget/);
    assert.equal(levels(outcome).get('demo-router'), 'breaking');
  });

  it('limits how many explanations one analysis can ask for', async () => {
    const { provider, calls } = counting();
    const outcome = await createAnalyzeService({
      ...base(),
      serverAi: provider,
      aiBudget: createDailyBudget({ limit: 100 }),
      maxAiCalls: 1,
      fetch: repoFetch().fetch,
    }).analyze({ githubUrl: 'octo/shop', ai: { mode: 'server' } });
    assert.ok(outcome.ok);
    assert.equal(calls.count, 1);
    assert.ok(outcome.report.analysis.results.some((result) => /Too many AI explanations/.test(result.explanationError ?? '')));
  });

  it('says so when the server AI is off or its budget is used up', async () => {
    const off = await createAnalyzeService(base()).analyze({ packageJson: DEMO_PACKAGE_JSON, ai: { mode: 'server' } });
    assert.ok(off.ok);
    assert.match(off.report.notes.join(' '), /not enabled on this server/);

    const budget = createDailyBudget({ limit: 0 });
    const spent = await createAnalyzeService({ ...base(), serverAi: demoDeps.ai, aiBudget: budget }).analyze({
      packageJson: DEMO_PACKAGE_JSON,
      ai: { mode: 'server' },
    });
    assert.ok(spent.ok);
    assert.match(spent.report.notes.join(' '), /daily AI budget is used up/);
  });

  it('uses the key a visitor brings without keeping it anywhere', async () => {
    const received: Array<{ baseUrl: string; apiKey: string; model: string }> = [];
    const service = createAnalyzeService({
      ...base(),
      fetch: repoFetch().fetch,
      createByokProvider: (options) => {
        received.push(options);
        return demoDeps.ai;
      },
    });
    const outcome = await service.analyze({
      githubUrl: 'octo/shop',
      ai: { mode: 'byok', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'sk-secret-123', model: 'm' },
    });
    assert.ok(outcome.ok);
    assert.deepEqual(received, [{ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'sk-secret-123', model: 'm' }]);
    assert.equal(JSON.stringify(outcome.report).includes('sk-secret-123'), false);
    assert.ok(outcome.report.analysis.results.some((result) => result.explanation !== undefined));
  });

  it('validates the visitor key settings without echoing the key', async () => {
    const service = createAnalyzeService(base());
    const missing = await service.analyze({ packageJson: DEMO_PACKAGE_JSON, ai: { mode: 'byok', apiKey: 'sk-secret-123' } });
    assert.ok(!missing.ok);
    assert.equal(missing.code, 'INVALID_AI_CONFIG');

    const badHost = await service.analyze({
      packageJson: DEMO_PACKAGE_JSON,
      ai: { mode: 'byok', baseUrl: 'https://evil.example.com/v1', apiKey: 'sk-secret-123', model: 'm' },
    });
    assert.ok(!badHost.ok);
    assert.equal(badHost.code, 'AI_HOST_NOT_ALLOWED');
    assert.equal(badHost.message.includes('sk-secret-123'), false);
    assert.equal(badHost.message.includes('evil.example.com'), false);

    const long = await service.analyze({
      packageJson: DEMO_PACKAGE_JSON,
      ai: { mode: 'byok', baseUrl: 'https://api.groq.com/v1', apiKey: 'k'.repeat(600), model: 'm' },
    });
    assert.ok(!long.ok);
  });
});

describe('analyze: limits', () => {
  it('checks only a limited number of changelogs', async () => {
    const outcome = await createAnalyzeService({ ...base(), maxChangelogLookups: 1, fetch: repoFetch().fetch }).analyze({ githubUrl: 'octo/shop' });
    assert.ok(outcome.ok);
    const statuses = outcome.report.analysis.results.map((result) => result.changelog?.status).filter(Boolean);
    assert.equal(statuses.filter((status) => status === 'skipped').length >= 2, true);
    assert.equal(levels(outcome).get('demo-router'), 'breaking');
  });
});
