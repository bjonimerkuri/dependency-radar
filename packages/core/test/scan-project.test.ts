import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTsconfigAliasKeys, scanProject } from '../src/index.ts';

const file = (path: string, content: string) => ({ path, content });

describe('scanProject', () => {
  it('scans source files and ignores everything else', () => {
    const result = scanProject([
      file('src/a.ts', "import a from 'alpha';"),
      file('src/b.tsx', "import b from 'beta';"),
      file('README.md', "import c from 'gamma';"),
      file('package.json', '{}'),
      file('src/style.css', 'a {}'),
    ]);
    assert.equal(result.scannedFiles, 2);
    assert.deepEqual(result.imports.map((item) => item.packageName), ['alpha', 'beta']);
  });

  it('skips ignored directories, declaration files and unsupported languages', () => {
    const result = scanProject([
      file('node_modules/x/index.js', "import a from 'a';"),
      file('dist/app.js', "import a from 'a';"),
      file('packages/web/build/app.js', "import a from 'a';"),
      file('src/types.d.ts', "import a from 'a';"),
      file('src/App.vue', "<script>import a from 'a'</script>"),
      file('src/ok.ts', "import ok from 'ok';"),
    ]);
    assert.deepEqual(result.imports.map((item) => item.packageName), ['ok']);
    assert.equal(result.skippedCounts['ignored-directory'], 3);
    assert.equal(result.skippedCounts['declaration-file'], 1);
    assert.equal(result.skippedCounts['unsupported-language'], 1);
    assert.equal(result.skipped.some((entry) => entry.reason === 'ignored-directory'), false);
  });

  it('skips files that are too large or minified', () => {
    const result = scanProject(
      [
        file('big.ts', `import a from 'a';${' '.repeat(60_000)}`),
        file('vendor.min.js', "import a from 'a';"),
        file('bundle.js', `${"import a from 'a';".padEnd(40_000, ';')}`),
        file('ok.ts', "import ok from 'ok';"),
      ],
      { maxFileChars: 50_000 },
    );
    assert.deepEqual(result.imports.map((item) => item.packageName), ['ok']);
    assert.equal(result.skippedCounts['too-large'], 1);
    assert.equal(result.skippedCounts.minified, 2);
  });

  it('applies the file and size limits', () => {
    const files = Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`, `import p${i} from 'pkg-${i}';`));
    const byCount = scanProject(files, { maxFiles: 2 });
    assert.equal(byCount.scannedFiles, 2);
    assert.equal(byCount.skippedCounts.limit, 3);

    const bySize = scanProject(files, { maxTotalChars: 60 });
    assert.ok(bySize.scannedFiles < 5);
    assert.ok((bySize.skippedCounts.limit ?? 0) > 0);
  });

  it('handles Windows-style paths', () => {
    const result = scanProject([file('src\\a.ts', "import a from 'a';"), file('node_modules\\x\\i.js', "import a from 'a';")]);
    assert.equal(result.scannedFiles, 1);
  });

  it('uses aliases and known packages from the options', () => {
    const result = scanProject([file('a.ts', "import a from '@app/x';\nimport b from 'real';")], {
      aliasKeys: ['@app/*'],
    });
    assert.deepEqual(result.imports.map((item) => item.packageName), ['real']);
  });

  it('is deterministic regardless of input order', () => {
    const a = file('a.ts', "import a from 'a';");
    const b = file('b.ts', "import b from 'b';");
    assert.deepEqual(scanProject([b, a]).imports, scanProject([a, b]).imports);
  });
});

describe('readTsconfigAliasKeys', () => {
  it('reads path keys from a tsconfig with comments and trailing commas', () => {
    const text = `{
      // aliases
      "compilerOptions": {
        "paths": { "@app/*": ["src/app/*"], "utils": ["src/utils"], },
      },
    }`;
    assert.deepEqual(readTsconfigAliasKeys(text), ['@app/*', 'utils']);
  });

  it('returns nothing for missing or invalid configs', () => {
    assert.deepEqual(readTsconfigAliasKeys('{}'), []);
    assert.deepEqual(readTsconfigAliasKeys('{"compilerOptions":{}}'), []);
    assert.deepEqual(readTsconfigAliasKeys('not json at all'), []);
    assert.deepEqual(readTsconfigAliasKeys(''), []);
  });
});
