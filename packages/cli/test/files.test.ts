import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { collectSourceFiles } from '../src/files.ts';

const root = mkdtempSync(join(tmpdir(), 'radar-'));
after(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('collectSourceFiles', () => {
  it('collects source files with relative posix paths and skips ignored folders', () => {
    write('src/a.ts', "import a from 'a';");
    write('src/deep/b.tsx', "import b from 'b';");
    write('src/App.vue', '<template />');
    write('src/readme.md', '# hi');
    write('node_modules/x/index.js', 'x');
    write('dist/out.js', 'x');
    const result = collectSourceFiles(root);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.files.map((file) => file.path).sort(), ['src/App.vue', 'src/a.ts', 'src/deep/b.tsx']);
    assert.equal(result.files.find((file) => file.path === 'src/a.ts')?.content, "import a from 'a';");
  });

  it('returns nothing for a folder that does not exist', () => {
    assert.deepEqual(collectSourceFiles(join(root, 'missing')).files, []);
  });
});

import { collectRepoFiles } from '../src/files.ts';

describe('collectRepoFiles', () => {
  it('collects text files and all names, and skips node_modules and .git', () => {
    const repo = mkdtempSync(join(tmpdir(), 'radar-repo-'));
    const put = (path: string, content: string) => {
      const full = join(repo, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    };
    put('package.json', '{}');
    put('.npmrc', 'registry=x');
    put('.vscode/tasks.json', '{}');
    put('scripts/setup.sh', 'echo hi');
    put('logo.png', 'binary');
    put('tools/run.exe', 'MZ');
    put('node_modules/x/index.js', 'x');
    put('.git/hooks/pre-commit', 'x');
    try {
      const result = collectRepoFiles(repo);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.files.map((file) => file.path).sort(), ['.npmrc', '.vscode/tasks.json', 'package.json', 'scripts/setup.sh']);
      assert.ok(result.names.includes('tools/run.exe'));
      assert.ok(result.names.includes('logo.png'));
      assert.equal(result.names.some((name) => name.includes('node_modules')), false);
      assert.equal(result.names.some((name) => name.startsWith('.git')), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns nothing for a folder that does not exist', () => {
    assert.deepEqual(collectRepoFiles(join(tmpdir(), 'radar-missing-folder')).files, []);
  });
});
