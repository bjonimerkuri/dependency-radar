import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/args.ts';

describe('parseArgs', () => {
  it('defaults to package.json in the current directory', () => {
    const args = parseArgs([]);
    assert.equal(args.path, 'package.json');
    assert.equal(args.error, undefined);
    assert.equal(args.json, false);
  });

  it('reads a path and all flags', () => {
    const args = parseArgs(['app/package.json', '--all', '--json', '--no-color', '--no-scan', '--no-changelog', '--no-ai', '--fail-on-breaking', '--fail-on-major', '--lockfile', 'lock.json', '--html', 'out/report.html']);
    assert.equal(args.path, 'app/package.json');
    assert.equal(args.all, true);
    assert.equal(args.json, true);
    assert.equal(args.noColor, true);
    assert.equal(args.noScan, true);
    assert.equal(args.noChangelog, true);
    assert.equal(args.noAi, true);
    assert.equal(args.failOnBreaking, true);
    assert.equal(args.failOnMajor, true);
    assert.equal(args.lockfile, 'lock.json');
    assert.equal(args.html, 'out/report.html');
  });

  it('accepts flags before the path', () => {
    assert.equal(parseArgs(['--all', 'x/package.json']).path, 'x/package.json');
  });

  it('recognizes help in both forms', () => {
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['--help']).help, true);
  });

  it('rejects unknown options', () => {
    assert.match(parseArgs(['--nope']).error ?? '', /Unknown option: --nope/);
  });

  it('rejects a missing lockfile value', () => {
    assert.match(parseArgs(['--lockfile']).error ?? '', /needs a path/);
    assert.match(parseArgs(['--lockfile', '--all']).error ?? '', /needs a path/);
  });

  it('rejects a missing html path', () => {
    assert.match(parseArgs(['--html']).error ?? '', /needs a file path/);
    assert.match(parseArgs(['--html', '--all']).error ?? '', /needs a file path/);
  });

  it('rejects more than one path', () => {
    assert.match(parseArgs(['a.json', 'b.json']).error ?? '', /Only one/);
  });
});

import { parseCheckArgs } from '../src/args.ts';

describe('parseCheckArgs', () => {
  it('defaults to the current folder', () => {
    const args = parseCheckArgs([]);
    assert.equal(args.dir, '.');
    assert.equal(args.error, undefined);
    assert.equal(args.stats, false);
  });

  it('reads a folder and every option', () => {
    const args = parseCheckArgs(['../task', '--all', '--stats', '--json', '--no-color', '--html', 'r.html', '--fail-on', 'medium']);
    assert.equal(args.dir, '../task');
    assert.equal(args.all, true);
    assert.equal(args.stats, true);
    assert.equal(args.json, true);
    assert.equal(args.noColor, true);
    assert.equal(args.html, 'r.html');
    assert.equal(args.failOn, 'medium');
  });

  it('recognizes help and rejects bad input', () => {
    assert.equal(parseCheckArgs(['--help']).help, true);
    assert.match(parseCheckArgs(['--nope']).error ?? '', /Unknown option/);
    assert.match(parseCheckArgs(['--html']).error ?? '', /needs a file path/);
    assert.match(parseCheckArgs(['--fail-on', 'low']).error ?? '', /high or medium/);
    assert.match(parseCheckArgs(['--fail-on']).error ?? '', /high or medium/);
    assert.match(parseCheckArgs(['a', 'b']).error ?? '', /Only one folder/);
  });
});
