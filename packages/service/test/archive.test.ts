import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { downloadGithubArchive, extractProject, parseGithubUrl } from '../src/archive.ts';
import { makeZip } from './zip-helper.ts';

describe('parseGithubUrl', () => {
  it('reads the common address forms', () => {
    const same = { owner: 'octo', repo: 'app' };
    for (const input of [
      'https://github.com/octo/app',
      'http://github.com/octo/app/',
      'https://www.github.com/octo/app.git',
      'github.com/octo/app',
      'octo/app',
      '  https://github.com/octo/app#readme ',
      'https://github.com/octo/app?tab=readme',
    ]) {
      assert.deepEqual(parseGithubUrl(input), same, input);
    }
  });

  it('reads a branch and a folder from a tree address', () => {
    assert.deepEqual(parseGithubUrl('https://github.com/octo/app/tree/main'), { owner: 'octo', repo: 'app', ref: 'main' });
    assert.deepEqual(parseGithubUrl('https://github.com/octo/app/tree/v1.2.0/packages/web'), {
      owner: 'octo',
      repo: 'app',
      ref: 'v1.2.0',
      path: 'packages/web',
    });
  });

  it('rejects everything else', () => {
    for (const input of [
      '',
      'not a url',
      'https://gitlab.com/octo/app',
      'https://github.com/octo',
      'https://evil.example.com/github.com/octo/app',
      'https://github.com/octo/app/tree/main/../../x',
      'https://github.com/octo/app/tree/main/%2e%2e/x',
      'a.b/app',
      'octo/app/extra',
      'x'.repeat(400),
    ]) {
      assert.equal(parseGithubUrl(input), undefined, input);
    }
  });
});

const target = { owner: 'octo', repo: 'app' };

function archiveFetch(make: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return make();
  }) as typeof fetch;
  return { fetch: fakeFetch, urls };
}

const repoZip = () =>
  makeZip([
    { name: 'app-main/package.json', data: '{"name":"app"}' },
    { name: 'app-main/package-lock.json', data: '{"lockfileVersion":3,"packages":{}}' },
    { name: 'app-main/tsconfig.json', data: '{}' },
    { name: 'app-main/src/index.ts', data: "import a from 'a';" },
    { name: 'app-main/src/App.vue', data: '<template/>' },
    { name: 'app-main/node_modules/x/index.js', data: 'x' },
    { name: 'app-main/logo.png', data: 'x'.repeat(100) },
    { name: 'app-main/README.md', data: '# hi' },
    { name: 'app-main/pnpm-lock.yaml', data: 'lockfileVersion: 9' },
  ]);

describe('downloadGithubArchive', () => {
  it('downloads from codeload and keeps only the useful files', async () => {
    const { fetch, urls } = archiveFetch(() => new Response(repoZip()));
    const result = await downloadGithubArchive(target, fetch);
    assert.ok(result.ok);
    assert.deepEqual(urls, ['https://codeload.github.com/octo/app/zip/HEAD']);
    assert.deepEqual(result.files.map((file) => file.path).sort(), [
      'app-main/package-lock.json',
      'app-main/package.json',
      'app-main/src/App.vue',
      'app-main/src/index.ts',
      'app-main/tsconfig.json',
    ]);
    assert.ok(result.names.includes('app-main/pnpm-lock.yaml'));
  });

  it('uses the requested branch or tag', async () => {
    const { fetch, urls } = archiveFetch(() => new Response(repoZip()));
    await downloadGithubArchive({ ...target, ref: 'v1.0.0' }, fetch);
    assert.deepEqual(urls, ['https://codeload.github.com/octo/app/zip/v1.0.0']);
  });

  it('explains common failures', async () => {
    const cases: Array<[number, RegExp]> = [
      [404, /not found, or it is private/],
      [429, /limiting requests/],
      [500, /could not be reached/],
    ];
    for (const [status, message] of cases) {
      const { fetch } = archiveFetch(() => new Response('', { status }));
      const result = await downloadGithubArchive(target, fetch);
      assert.ok(!result.ok);
      assert.match(result.message, message);
    }
  });

  it('refuses archives that are too large', async () => {
    const { fetch } = archiveFetch(() => new Response('x', { headers: { 'content-length': '99999999' } }));
    const result = await downloadGithubArchive(target, fetch);
    assert.ok(!result.ok);
    assert.match(result.message, /too large/);
  });

  it('reports archives that are not zip files', async () => {
    const { fetch } = archiveFetch(() => new Response('<html>not a zip, just a plain web page body here</html>'));
    const result = await downloadGithubArchive(target, fetch);
    assert.ok(!result.ok);
    assert.match(result.message, /could not be read/);
  });
});

function extract(path?: string) {
  const zip = makeZip([
    { name: 'app-main/package.json', data: '{"name":"root"}' },
    { name: 'app-main/package-lock.json', data: '{"lockfileVersion":3}' },
    { name: 'app-main/src/a.ts', data: 'a' },
    { name: 'app-main/packages/web/package.json', data: '{"name":"web"}' },
    { name: 'app-main/packages/web/tsconfig.json', data: '{"compilerOptions":{}}' },
    { name: 'app-main/packages/web/src/b.tsx', data: 'b' },
    { name: 'app-main/packages/web/pnpm-lock.yaml', data: 'x' },
    { name: 'app-main/packages/api/package.json', data: '{"name":"api"}' },
  ]);
  return zip;
}

import { readZip } from '../src/zip.ts';

function files(path?: string) {
  const read = readZip(extract());
  assert.ok(read.ok);
  return extractProject(read.files, read.names, path);
}

describe('extractProject', () => {
  it('finds the package.json, lockfile and sources in the repository root', () => {
    const result = files();
    assert.ok(result.ok);
    assert.equal(result.project.packageJson, '{"name":"root"}');
    assert.equal(result.project.lockfile, '{"lockfileVersion":3}');
    assert.equal(result.project.tsconfig, undefined);
    assert.ok(result.project.sources.some((source) => source.path === 'src/a.ts'));
    assert.ok(result.project.sources.some((source) => source.path === 'packages/web/src/b.tsx'));
  });

  it('works inside a folder of a monorepo with paths relative to that folder', () => {
    const result = files('packages/web');
    assert.ok(result.ok);
    assert.equal(result.project.packageJson, '{"name":"web"}');
    assert.equal(result.project.tsconfig, '{"compilerOptions":{}}');
    assert.deepEqual(result.project.sources.map((source) => source.path), ['src/b.tsx']);
  });

  it('warns about lockfiles it cannot read', () => {
    const result = files('packages/web');
    assert.ok(result.ok);
    assert.match(result.project.warnings[0] ?? '', /pnpm-lock\.yaml, which is not supported/);
  });

  it('suggests folders when the root has no package.json', () => {
    const zip = makeZip([
      { name: 'repo-x/packages/web/package.json', data: '{}' },
      { name: 'repo-x/packages/api/package.json', data: '{}' },
      { name: 'repo-x/node_modules/dep/package.json', data: '{}' },
    ]);
    const read = readZip(zip);
    assert.ok(read.ok);
    const result = extractProject(read.files, read.names);
    assert.ok(!result.ok);
    assert.match(result.message, /in the repository root/);
    assert.match(result.message, /packages\/web/);
    assert.match(result.message, /packages\/api/);
    assert.equal(result.message.includes('node_modules'), false);
  });

  it('reports a folder without a package.json', () => {
    const result = files('packages/missing');
    assert.ok(!result.ok);
    assert.match(result.message, /in packages\/missing/);
  });

  it('rejects folder paths that try to escape', () => {
    for (const path of ['../x', 'a/../../b', '%2e%2e/x']) {
      const result = files(path);
      assert.ok(!result.ok, path);
      assert.match(result.message, /not valid/);
    }
  });
});

import { stripArchiveRoot } from '../src/archive.ts';

describe('stripArchiveRoot', () => {
  const read = readZip(
    makeZip([
      { name: 'r-main/a.txt', data: 'a' },
      { name: 'r-main/dir/b.txt', data: 'b' },
      { name: 'r-main/dir/sub/c.txt', data: 'c' },
    ]),
  );

  it('removes the folder GitHub adds around the repository', () => {
    assert.ok(read.ok);
    const result = stripArchiveRoot(read.files, read.names);
    assert.deepEqual(result?.files.map((file) => file.path).sort(), ['a.txt', 'dir/b.txt', 'dir/sub/c.txt']);
    assert.deepEqual([...(result?.names ?? [])].sort(), ['a.txt', 'dir/b.txt', 'dir/sub/c.txt']);
  });

  it('keeps only a folder and makes paths relative to it', () => {
    assert.ok(read.ok);
    const result = stripArchiveRoot(read.files, read.names, 'dir');
    assert.deepEqual(result?.files.map((file) => file.path).sort(), ['b.txt', 'sub/c.txt']);
  });

  it('rejects folder paths that try to escape', () => {
    assert.ok(read.ok);
    assert.equal(stripArchiveRoot(read.files, read.names, '../x'), undefined);
  });
});
