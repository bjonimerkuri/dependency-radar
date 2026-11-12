#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  analyzeProject,
  assessRepository,
  attachImpact,
  buildUsageIndex,
  createGithubChangelogSource,
  createMemoryCache,
  createNpmStatsSource,
  createRegistryClient,
  enrichWithChangelogs,
  formatHtml,
  formatRiskHtml,
  readProject,
  readTsconfigAliasKeys,
  refineLookalikes,
  scanProject,
  withCache,
} from '@dependency-radar/core';
import type { ScanInfo } from '@dependency-radar/core';
import { createAiFromEnv } from './ai-env.ts';
import { CHECK_HELP, HELP, parseArgs, parseCheckArgs } from './args.ts';
import { collectRepoFiles, collectSourceFiles } from './files.ts';
import { formatRiskReport } from './format-risk.ts';
import { formatReport } from './format.ts';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function runCheck(argv: readonly string[]): Promise<number> {
  const args = parseCheckArgs(argv);
  if (args.error) {
    console.error(args.error);
    console.error('Run with --help for usage.');
    return 1;
  }
  if (args.help) {
    console.log(CHECK_HELP);
    return 0;
  }

  const root = resolve(args.dir);
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a folder');
  } catch {
    console.error(`Cannot read the folder ${root}`);
    return 1;
  }

  const collected = collectRepoFiles(root);
  const report = assessRepository({ files: collected.files, names: collected.names });
  if (collected.truncated) {
    report.truncated = true;
    report.limitations.push('The folder was too large to read completely.');
  }
  if (args.stats) await refineLookalikes(report, createNpmStatsSource());

  if (args.html) {
    const htmlPath = resolve(args.html);
    try {
      writeFileSync(
        htmlPath,
        formatRiskHtml(report, { subject: root, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC' }),
      );
      console.error(`HTML report written to ${htmlPath}`);
    } catch {
      console.error(`Cannot write ${htmlPath}`);
      return 1;
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const color = !args.noColor && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
    process.stdout.write(formatRiskReport(report, { subject: root, color, showAll: args.all }));
  }

  if (args.failOn === 'high' && report.highest === 'high') return 2;
  if (args.failOn === 'medium' && (report.highest === 'high' || report.highest === 'medium')) return 2;
  return 0;
}

async function run(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'check') return runCheck(argv.slice(1));
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

  const ai = args.noAi || args.noChangelog ? {} : createAiFromEnv(process.env);
  if (ai.error) {
    console.error(ai.error);
    return 1;
  }

  const npm = createRegistryClient();
  const registry = withCache(npm, createMemoryCache());
  const analysis = await analyzeProject(parsed.value.entries, { registry });

  let scanInfo: ScanInfo | undefined;
  if (!args.noScan) {
    const root = dirname(packagePath);
    const collected = collectSourceFiles(root);
    const tsconfig = readText(join(root, 'tsconfig.json'));
    const scan = scanProject(collected.files, {
      aliasKeys: tsconfig === undefined ? [] : readTsconfigAliasKeys(tsconfig),
      knownPackages: parsed.value.entries.map((entry) => entry.name),
    });
    attachImpact(analysis.results, buildUsageIndex(scan.imports), parsed.value.scripts);
    scanInfo = {
      scannedFiles: scan.scannedFiles,
      unsupportedFiles: scan.skippedCounts['unsupported-language'] ?? 0,
      truncated: collected.truncated,
    };
  }

  if (!args.noChangelog) {
    const token = process.env.GITHUB_TOKEN?.trim();
    await enrichWithChangelogs(analysis.results, {
      manifests: npm,
      changelogs: createGithubChangelogSource(token ? { token } : {}),
      ...(ai.provider ? { ai: ai.provider } : {}),
    });
  }

  if (args.html) {
    const htmlPath = resolve(args.html);
    try {
      writeFileSync(
        htmlPath,
        formatHtml(parsed.value.entries, analysis, parsed.warnings, {
          fileName: basename(packagePath),
          ...(lockfile === undefined ? {} : { lockfileName: basename(lockfilePath) }),
          ...(scanInfo ? { scan: scanInfo } : {}),
          generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        }),
      );
      console.error(`HTML report written to ${htmlPath}`);
    } catch {
      console.error(`Cannot write ${htmlPath}`);
      return 1;
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        { warnings: parsed.warnings, summary: analysis.summary, scan: scanInfo ?? null, results: analysis.results },
        null,
        2,
      ),
    );
  } else {
    const color = !args.noColor && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
    process.stdout.write(
      formatReport(parsed.value.entries, analysis, parsed.warnings, {
        color,
        showAll: args.all,
        fileName: basename(packagePath),
        lockfileName: lockfile === undefined ? undefined : basename(lockfilePath),
        ...(scanInfo ? { scan: scanInfo } : {}),
      }),
    );
  }

  if (analysis.summary.analyzed === 0 && analysis.summary.errors > 0) return 1;
  if (args.failOnBreaking && analysis.results.some((result) => result.verdict?.level === 'breaking')) return 2;
  return args.failOnMajor && analysis.summary.breakingCandidate > 0 ? 2 : 0;
}

process.exitCode = await run(process.argv.slice(2));
