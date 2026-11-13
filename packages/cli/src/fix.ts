import { basename, dirname, join } from 'node:path';
import {
  applyMajorChecks,
  buildPrDescription,
  buildUsageIndex,
  checkMajorFixChangelogs,
  createGithubChangelogSource,
  createOsvSource,
  createRegistryClient,
  formatFixHtml,
  planMultiRemediation,
  planMultiRemediationWithLookup,
  planRemediation,
  planRemediationWithLookup,
  readTsconfigAliasKeys,
  scanProject,
  splitTickets,
} from '@dependency-radar/core';
import type {
  AdvisorySource,
  ChangelogSource,
  ManifestClient,
  MajorFixCheck,
  MultiRemediationPlan,
  PackageUsage,
  RemediationPlan,
  SourceFile,
  TicketInput,
} from '@dependency-radar/core';
import { FIX_HELP, parseFixArgs } from './args.ts';
import { formatFixReport } from './format-fix.ts';

export interface FixIo {
  readText(path: string): string | undefined;
  readStdin(): Promise<string>;
  writeText(path: string, text: string): boolean;
  collectSources(root: string): { files: SourceFile[]; truncated: boolean };
  out(text: string): void;
  err(text: string): void;
  color: boolean;
  now(): Date;
}

export interface FixDeps {
  advisories?: AdvisorySource;
  manifests?: ManifestClient;
  changelogs?: ChangelogSource;
}

export async function runFix(argv: readonly string[], io: FixIo, deps: FixDeps = {}): Promise<number> {
  const args = parseFixArgs(argv);
  if (args.error) {
    io.err(args.error);
    io.err('Run with --help for usage.');
    return 1;
  }
  if (args.help) {
    io.out(`${FIX_HELP}\n`);
    return 0;
  }
  if (args.tickets.length === 0) {
    io.err('Give the ticket with --ticket <file>. Use --ticket - to read it from standard input.');
    return 1;
  }

  const packageJson = io.readText(args.path);
  if (packageJson === undefined) {
    io.err(`Cannot read ${args.path}`);
    return 1;
  }
  const lockfilePath = args.lockfile ?? join(dirname(args.path), 'package-lock.json');
  const lockfile = io.readText(lockfilePath);
  if (args.lockfile && lockfile === undefined) {
    io.err(`Cannot read ${lockfilePath}`);
    return 1;
  }

  const tickets: TicketInput[] = [];
  const notes: string[] = [];
  let stdinUsed = false;
  for (const source of args.tickets) {
    let text: string | undefined;
    if (source === '-') {
      if (stdinUsed) continue;
      stdinUsed = true;
      text = await io.readStdin();
    } else {
      text = io.readText(source);
    }
    if (text === undefined) {
      io.err(`Cannot read ${source}`);
      return 1;
    }
    const name = source === '-' ? 'stdin' : basename(source);
    const split = splitTickets(text);
    notes.push(...split.warnings);
    const multipleFiles = args.tickets.length > 1;
    split.tickets.forEach((ticket, index) => {
      const label = split.tickets.length === 1 && multipleFiles ? name : multipleFiles ? `${name} ${index + 1}` : ticket.label;
      tickets.push({ label, text: ticket.text });
    });
  }
  if (tickets.length === 0) {
    io.err('The ticket is empty. Paste the text of the security ticket.');
    return 1;
  }

  const fixedVersions = args.fixed;
  const advisories = deps.advisories ?? createOsvSource();
  let plan: RemediationPlan | MultiRemediationPlan;
  let lookedUp: Record<string, string[]> = {};
  const base = { packageJson, ...(lockfile === undefined ? {} : { lockfile }), ...(args.packageManager ? { packageManager: args.packageManager } : {}), fixedVersions };

  if (tickets.length > 1) {
    if (args.noLookup) {
      const result = planMultiRemediation({ ...base, tickets });
      if (!result.ok) {
        io.err(result.message);
        return 1;
      }
      plan = result;
    } else {
      const { result, lookup } = await planMultiRemediationWithLookup({ ...base, tickets }, advisories);
      if (!result.ok) {
        io.err(result.message);
        return 1;
      }
      plan = result;
      lookedUp = lookup.found;
    }
  } else {
    const ticket = (tickets[0] as TicketInput).text;
    if (args.noLookup) {
      const result = planRemediation({ ...base, ticket });
      if (!result.ok) {
        io.err(result.message);
        return 1;
      }
      plan = result;
    } else {
      const { result, lookup } = await planRemediationWithLookup({ ...base, ticket }, advisories);
      if (!result.ok) {
        io.err(result.message);
        return 1;
      }
      plan = result;
      lookedUp = lookup.found;
    }
  }

  let usage: Map<string, PackageUsage> | undefined;
  if (!args.noScan) {
    const root = dirname(args.path);
    const collected = io.collectSources(root);
    const tsconfig = io.readText(join(root, 'tsconfig.json'));
    const names = plan.findings.map((finding) => finding.finding.packageName);
    const scan = scanProject(collected.files, {
      aliasKeys: tsconfig === undefined ? [] : readTsconfigAliasKeys(tsconfig),
      knownPackages: names,
    });
    usage = buildUsageIndex(scan.imports);
    if (collected.truncated) notes.push('The folder was too large to read completely, so the list of files that use each package may be incomplete.');
  }

  let majorChecks: MajorFixCheck[] = [];
  if (!args.noChangelog) {
    const registry = deps.manifests ? undefined : createRegistryClient();
    const manifests = deps.manifests ?? (registry as ManifestClient);
    const changelogs = deps.changelogs ?? createGithubChangelogSource({});
    majorChecks = await checkMajorFixChangelogs(plan, { manifests, changelogs, ...(usage ? { usage } : {}) });
    applyMajorChecks(plan, majorChecks, usage !== undefined);
  }

  const prOptions = { language: args.lang, ...(usage ? { usage } : {}) };
  const markdown = buildPrDescription(plan, { ...prOptions, format: 'markdown' });
  const jira = buildPrDescription(plan, { ...prOptions, format: 'jira' });
  const chosen = args.prFormat === 'jira' ? jira : markdown;

  const generatedAt = `${io.now().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  if (args.html) {
    const page = formatFixHtml(plan, { subject: args.path, generatedAt, notes, pr: { markdown, jira } });
    if (!io.writeText(args.html, page)) {
      io.err(`Cannot write ${args.html}`);
      return 1;
    }
    io.err(`HTML report written to ${args.html}`);
  }
  if (args.patch) {
    if (!io.writeText(args.patch, plan.diff)) {
      io.err(`Cannot write ${args.patch}`);
      return 1;
    }
    io.err(plan.changed ? `Patch written to ${args.patch}` : `Patch written to ${args.patch} (it is empty, because package.json does not change)`);
  }
  if (args.pr && args.pr !== '-') {
    if (!io.writeText(args.pr, `${chosen.title}\n\n${chosen.body}`)) {
      io.err(`Cannot write ${args.pr}`);
      return 1;
    }
    io.err(`Description written to ${args.pr}`);
    for (const warning of chosen.warnings) io.err(warning);
  }

  if (args.pr === '-') {
    io.out(`${chosen.title}\n\n${chosen.body}`);
    for (const warning of chosen.warnings) io.err(warning);
  } else if (args.json) {
    io.out(
      `${JSON.stringify(
        { ...plan, hunks: undefined, notes, lookedUp, majorChecks, pr: { markdown, jira } },
        null,
        2,
      )}\n`,
    );
  } else {
    io.out(formatFixReport(plan, { subject: args.path, color: io.color && !args.noColor, ...(usage ? { usage } : {}), notes }));
  }

  return args.failIfChanges && plan.findings.some((finding) => finding.status === 'planned') ? 2 : 0;
}
