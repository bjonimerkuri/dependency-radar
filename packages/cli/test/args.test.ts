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
    const args = parseArgs(['app/package.json', '--all', '--json', '--no-color', '--fail-on-major', '--lockfile', 'lock.json']);
    assert.equal(args.path, 'app/package.json');
    assert.equal(args.all, true);
    assert.equal(args.json, true);
    assert.equal(args.noColor, true);
    assert.equal(args.failOnMajor, true);
    assert.equal(args.lockfile, 'lock.json');
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

  it('rejects more than one path', () => {
    assert.match(parseArgs(['a.json', 'b.json']).error ?? '', /Only one/);
  });
});
