#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  analyzeProject,
  createMemoryCache,
  createRegistryClient,
  readProject,
  withCache,
} from '@dependency-radar/core';
import { HELP, parseArgs } from './args.ts';
import { formatReport } from './format.ts';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error('Run with --help for usage.');
    return 1;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const packagePath = resolve(args.path);
  const packageJson = readText(packagePath);
  if (packageJson === undefined) {
    console.error(`Cannot read ${packagePath}`);
    return 1;
  }

  const lockfilePath = args.lockfile ? resolve(args.lockfile) : join(dirname(packagePath), 'package-lock.json');
  const lockfile = readText(lockfilePath);
  if (args.lockfile && lockfile === undefined) {
    console.error(`Cannot read ${lockfilePath}`);
    return 1;
  }

  const parsed = readProject(lockfile === undefined ? { packageJson } : { packageJson, lockfile });
  if (!parsed.ok) {
    console.error(`${basename(packagePath)}: ${parsed.error.message}`);
    return 1;
  }

  const registry = withCache(createRegistryClient(), createMemoryCache());
  const analysis = await analyzeProject(parsed.value.entries, { registry });

  if (args.json) {
    console.log(JSON.stringify({ warnings: parsed.warnings, summary: analysis.summary, results: analysis.results }, null, 2));
  } else {
    const color = !args.noColor && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
    process.stdout.write(
      formatReport(parsed.value.entries, analysis, parsed.warnings, {
        color,
        showAll: args.all,
        fileName: basename(packagePath),
        lockfileName: lockfile === undefined ? undefined : basename(lockfilePath),
      }),
    );
  }

  if (analysis.summary.analyzed === 0 && analysis.summary.errors > 0) return 1;
  return args.failOnMajor && analysis.summary.breakingCandidate > 0 ? 2 : 0;
}

process.exitCode = await run(process.argv.slice(2));
