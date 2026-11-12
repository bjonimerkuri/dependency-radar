import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAliasMatcher, scanSourceFile } from '../src/index.ts';

function scan(source: string, path = 'a.ts', options: { aliases?: string[]; known?: string[] } = {}) {
  const context = {
    isAlias: createAliasMatcher(options.aliases ?? []),
    knownPackages: new Set(options.known ?? []),
  };
  const result = scanSourceFile(path, source, context);
  assert.equal(result.error, undefined);
  return result.imports;
}

function summary(source: string, path = 'a.ts') {
  return scan(source, path).map((item) => [item.packageName, item.kind, item.symbols.map((entry) => entry.imported)]);
}

describe('scanSourceFile: static imports', () => {
  it('reads default, named, aliased and namespace imports', () => {
    const imports = scan(
      "import React, { useState as useS, type FC } from 'react';\nimport * as rr from 'react-router-dom';\nimport 'normalize.css';\n",
      'a.tsx',
    );
    assert.deepEqual(imports.map((item) => item.packageName), ['react', 'react-router-dom', 'normalize.css']);
    assert.deepEqual(imports[0]?.symbols, [
      { imported: 'default', local: 'React', typeOnly: false },
      { imported: 'useState', local: 'useS', typeOnly: false },
      { imported: 'FC', local: 'FC', typeOnly: true },
    ]);
    assert.deepEqual(imports[1]?.symbols, [{ imported: '*', local: 'rr', typeOnly: false }]);
  });

  it('keeps side-effect imports of packages', () => {
    const imports = scan("import 'reflect-metadata';");
    assert.equal(imports[0]?.packageName, 'reflect-metadata');
    assert.deepEqual(imports[0]?.symbols, []);
    assert.equal(imports[0]?.appearsUnused, false);
  });

  it('marks type-only imports', () => {
    const imports = scan("import type { A } from 'x';\nimport { type B, type C } from 'y';\nimport { D, type E } from 'z';");
    assert.deepEqual(imports.map((item) => item.typeOnly), [true, true, false]);
  });

  it('records the position of each import', () => {
    const imports = scan("const a = 1;\n  import x from 'x';\n");
    assert.equal(imports[0]?.line, 2);
    assert.equal(imports[0]?.column, 3);
  });

  it('parses TSX and JSX', () => {
    assert.equal(scan("import A from 'a';\nconst el = <A prop={1} />;", 'x.tsx').length, 1);
    assert.equal(scan("import A from 'a';\nconst el = <A prop={1} />;", 'x.jsx').length, 1);
    assert.equal(scan("import A from 'a';\nconst el = <A prop={1} />;", 'x.js').length, 1);
  });

  it('keeps scanning after a syntax error', () => {
    const imports = scan("import x from 'y';\nconst = ;\nimport z from 'w';");
    assert.deepEqual(imports.map((item) => item.packageName), ['y', 'w']);
  });
});

describe('scanSourceFile: other import forms', () => {
  it('reads re-exports', () => {
    const imports = scan("export { a as b } from 'x';\nexport * from 'y';\nexport * as ns from 'z';\nexport type { T } from 'w';");
    assert.deepEqual(imports.map((item) => item.kind), ['export-from', 'export-from', 'export-from', 'export-from']);
    assert.deepEqual(imports[0]?.symbols.map((entry) => entry.imported), ['a']);
    assert.deepEqual(imports[1]?.symbols.map((entry) => entry.imported), ['*']);
    assert.equal(imports[3]?.typeOnly, true);
  });

  it('does not treat local export lists as imports', () => {
    assert.equal(scan('const a = 1;\nexport { a };').length, 0);
  });

  it('reads require with destructuring, a whole module and a property', () => {
    const imports = scan(
      "const { json, redirect: go } = require('rr');\nconst fs2 = require('fse');\nconst def = require('d').default;\nrequire('side-effect');",
      'a.js',
    );
    assert.deepEqual(imports[0]?.symbols, [
      { imported: 'json', local: 'json', typeOnly: false },
      { imported: 'redirect', local: 'go', typeOnly: false },
    ]);
    assert.deepEqual(imports[1]?.symbols, [{ imported: '*', local: 'fs2', typeOnly: false }]);
    assert.deepEqual(imports[2]?.symbols, [{ imported: 'default', typeOnly: false }]);
    assert.deepEqual(imports[3]?.symbols, []);
    assert.ok(imports.every((item) => item.kind === 'require'));
  });

  it('reads dynamic imports, with and without destructuring', () => {
    const imports = scan(
      "const { a } = await import('x');\nimport('y').then((m) => m.b);\nconst mod = await import('z');",
    );
    assert.deepEqual(imports.map((item) => [item.packageName, item.kind]), [
      ['x', 'dynamic'],
      ['y', 'dynamic'],
      ['z', 'dynamic'],
    ]);
    assert.deepEqual(imports[0]?.symbols, [{ imported: 'a', local: 'a', typeOnly: false }]);
  });

  it('reads import-equals and import types', () => {
    const imports = scan("import fs = require('fse');\ntype T = import('types-only').Foo.Bar;");
    assert.equal(imports[0]?.kind, 'import-equals');
    assert.equal(imports[1]?.typeOnly, true);
    assert.deepEqual(imports[1]?.symbols.map((entry) => entry.imported), ['Foo']);
  });

  it('reads a require with a template literal but ignores computed ones', () => {
    const imports = scan("const a = require(`pkg`);\nconst b = require(name);\nconst c = require('x' + y);");
    assert.deepEqual(imports.map((item) => item.packageName), ['pkg']);
  });

  it('summarizes mixed files', () => {
    assert.deepEqual(summary("import a from 'a';\nconst b = require('b');\nexport * from 'c';"), [
      ['a', 'static', ['default']],
      ['b', 'require', ['*']],
      ['c', 'export-from', ['*']],
    ]);
  });
});

describe('scanSourceFile: which specifiers count as packages', () => {
  const source = [
    "import a from './a';",
    "import b from '../b';",
    "import c from '/abs/c';",
    "import d from '#internal';",
    "import e from 'node:fs';",
    "import f from 'fs';",
    "import g from 'fs/promises';",
    "import h from '@/components/h';",
    "import i from '~/i';",
    "import j from 'https://cdn.example.com/j.js';",
    "import k from 'lodash/get';",
    "import l from '@scope/pkg/sub/path';",
    "import m from 'plain';",
  ].join('\n');

  it('keeps only real package imports and normalizes subpaths', () => {
    const imports = scan(source);
    assert.deepEqual(imports.map((item) => [item.packageName, item.subpath]), [
      ['lodash', 'get'],
      ['@scope/pkg', 'sub/path'],
      ['plain', undefined],
    ]);
  });

  it('ignores tsconfig path aliases', () => {
    const imports = scan("import a from '@app/x';\nimport b from 'utils';\nimport c from 'real';", 'a.ts', {
      aliases: ['@app/*', 'utils'],
    });
    assert.deepEqual(imports.map((item) => item.packageName), ['real']);
  });

  it('lets a declared dependency win over an alias or a built-in name', () => {
    const imports = scan("import a from '@app/x';\nimport b from 'events';", 'a.ts', {
      aliases: ['@app/*'],
      known: ['@app/x', 'events'],
    });
    assert.deepEqual(imports.map((item) => item.packageName), ['@app/x', 'events']);
  });
});

describe('scanSourceFile: members and unused imports', () => {
  it('collects the members used on default and namespace imports', () => {
    const imports = scan(
      "import * as rr from 'react-router-dom';\nimport React from 'react';\nrr.json({});\nrr.redirect('/');\nrr.json(1);\nReact.useState();\nconst x = <rr.Link />;",
      'a.tsx',
    );
    assert.deepEqual(imports[0]?.members, ['json', 'redirect', 'Link']);
    assert.deepEqual(imports[1]?.members, ['useState']);
  });

  it('flags imports whose names are never used', () => {
    const imports = scan("import { a, b } from 'x';\nimport { c } from 'y';\nimport { d } from 'z';\na();\nlet v: d;");
    assert.deepEqual(imports.map((item) => item.appearsUnused), [false, true, false]);
  });

  it('counts uses in JSX and exports', () => {
    const imports = scan("import { Foo } from 'x';\nimport { bar } from 'y';\nconst el = <Foo />;\nexport { bar };", 'a.tsx');
    assert.deepEqual(imports.map((item) => item.appearsUnused), [false, false]);
  });

  it('does not flag re-exports as unused', () => {
    assert.equal(scan("export { a } from 'x';")[0]?.appearsUnused, false);
  });
});
