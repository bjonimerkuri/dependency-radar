import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGithubChangelogSource, parseTagVersion } from '../src/index.ts';
import { SAMPLE } from './fixtures.ts';

type Route = { status?: number; body?: string; headers?: Record<string, string>; url?: string };

function router(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const route = routes[url];
    if (!route) return new Response('', { status: 404 });
    const response = new Response(route.body ?? '', { status: route.status ?? 200, headers: route.headers ?? {} });
    if (route.url !== undefined) Object.defineProperty(response, 'url', { value: route.url });
    return response;
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const repo = { kind: 'github' as const, owner: 'o', repo: 'r' };
const request = { packageName: 'pkg', from: '6.22.1', to: '7.0.0' };
const raw = (path: string) => `https://raw.githubusercontent.com/o/r/HEAD/${path}`;
const releases = (page = 1) => `https://api.github.com/repos/o/r/releases?per_page=100&page=${page}`;

describe('parseTagVersion', () => {
  it('reads common tag formats', () => {
    for (const tag of ['v1.2.3', '1.2.3', 'release-1.2.3', 'pkg@1.2.3', 'pkg-v1.2.3', 'v1.2.3-beta.1']) {
      assert.ok(parseTagVersion(tag, 'pkg'), tag);
    }
    assert.equal(parseTagVersion('v1.2.3-beta.1', 'pkg'), '1.2.3-beta.1');
  });

  it('handles scoped packages', () => {
    assert.equal(parseTagVersion('@scope/pkg@2.0.0', '@scope/pkg'), '2.0.0');
    assert.equal(parseTagVersion('pkg@2.0.0', '@scope/pkg'), '2.0.0');
  });

  it('skips tags of other packages and non-version tags', () => {
    assert.equal(parseTagVersion('other@2.0.0', 'pkg'), undefined);
    assert.equal(parseTagVersion('other-v2.0.0', 'pkg'), undefined);
    assert.equal(parseTagVersion('nightly', 'pkg'), undefined);
  });
});

describe('createGithubChangelogSource', () => {
  it('reads the changelog file', async () => {
    const { fetch, calls } = router({ [raw('CHANGELOG.md')]: { body: SAMPLE } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(result.ok);
    assert.equal(result.source, 'file');
    assert.equal(result.path, 'CHANGELOG.md');
    assert.deepEqual(result.sections.map((section) => section.version), ['7.0.0', '6.23.0']);
    assert.equal(calls.length, 1);
  });

  it('looks in the package directory first for monorepos', async () => {
    const { fetch, calls } = router({ [raw('packages/pkg/CHANGELOG.md')]: { body: SAMPLE } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog({ ...repo, directory: 'packages/pkg' }, request);
    assert.ok(result.ok);
    assert.equal(result.path, 'packages/pkg/CHANGELOG.md');
    assert.equal(calls[0]?.url, raw('packages/pkg/CHANGELOG.md'));
  });

  it('falls back to GitHub releases', async () => {
    const body = JSON.stringify([
      { tag_name: 'v7.0.0', body: '### Major Changes\n- Removed json.' },
      { tag_name: 'v6.23.0', body: '- Added things.' },
      { tag_name: 'v7.0.0-beta.1', body: 'beta', prerelease: true },
      { tag_name: 'draft', body: 'x', draft: true },
      { tag_name: 'other@7.0.0', body: 'foreign' },
      { tag_name: 'v6.22.1', body: 'old' },
    ]);
    const { fetch } = router({ [releases()]: { body } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(result.ok);
    assert.equal(result.source, 'releases');
    assert.deepEqual(result.sections.map((section) => section.version), ['7.0.0', '6.23.0']);
  });

  it('uses releases when the file has no entries in the range', async () => {
    const stale = '## 6.0.0\n\n- Old.\n';
    const body = JSON.stringify([{ tag_name: 'v7.0.0', body: '- Removed json.' }]);
    const { fetch } = router({ [raw('CHANGELOG.md')]: { body: stale }, [releases()]: { body } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(result.ok);
    assert.equal(result.source, 'releases');
  });

  it('sends the token only to the GitHub API', async () => {
    const { fetch, calls } = router({ [releases()]: { body: JSON.stringify([{ tag_name: 'v7.0.0', body: 'x' }]) } });
    await createGithubChangelogSource({ fetch, token: 'ghp_secret' }).fetchChangelog(repo, request);
    const api = calls.find((call) => call.url.startsWith('https://api.github.com'));
    const files = calls.filter((call) => call.url.startsWith('https://raw.githubusercontent.com'));
    assert.equal(api?.headers.authorization, 'Bearer ghp_secret');
    assert.ok(files.length > 0);
    assert.ok(files.every((call) => call.headers.authorization === undefined));
  });

  it('reports when nothing is found', async () => {
    const { fetch } = router({});
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(!result.ok);
    assert.equal(result.code, 'NOT_FOUND');
  });

  it('reports a changelog without entries in the range', async () => {
    const { fetch } = router({ [raw('CHANGELOG.md')]: { body: '## 6.0.0\n\n- Old.\n' } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(!result.ok);
    assert.equal(result.code, 'NO_MATCHING_VERSIONS');
  });

  it('reports a rate limit with a hint about the token', async () => {
    const { fetch } = router({ [releases()]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(!result.ok);
    assert.equal(result.code, 'RATE_LIMITED');
    assert.match(result.message, /GITHUB_TOKEN/);
  });

  it('refuses redirects to other hosts', async () => {
    const { fetch } = router({
      [raw('CHANGELOG.md')]: { body: SAMPLE, url: 'https://evil.example.com/CHANGELOG.md' },
    });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.equal(result.ok, false);
  });

  it('survives invalid release JSON', async () => {
    const { fetch } = router({ [releases()]: { body: '<html>' } });
    const result = await createGithubChangelogSource({ fetch }).fetchChangelog(repo, request);
    assert.ok(!result.ok);
  });
});
