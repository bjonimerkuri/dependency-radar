import {
  analyzeProject,
  applyMajorChecks,
  assessRepository,
  buildPrDescription,
  attachImpact,
  buildUsageIndex,
  checkMajorFixChangelogs,
  createOpenAiCompatibleProvider,
  enrichWithChangelogs,
  KNOWN_AI_HOSTS,
  planMultiRemediation,
  planMultiRemediationWithLookup,
  planRemediation,
  planRemediationWithLookup,
  readProject,
  readTsconfigAliasKeys,
  refineLookalikes,
  scanProject,
  splitTickets,
} from '@dependency-radar/core';
import type {
  AdvisorySource,
  AiProvider,
  AiResult,
  ChangelogSource,
  DependencyEntry,
  MajorFixCheck,
  ManifestClient,
  MultiRemediationPlan,
  PackageUsage,
  PrDescription,
  RemediationPlan,
  ProjectAnalysis,
  RegistryClient,
  RiskReport,
  ScanInfo,
  SourceFile,
  StatsSource,
  Warning,
} from '@dependency-radar/core';
import { downloadGithubArchive, extractProject, parseGithubUrl, stripArchiveRoot } from './archive.ts';
import type { DailyBudget } from './limits.ts';

export type AiMode = 'none' | 'server' | 'byok';

export interface AiChoice {
  mode?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface AnalyzeRequest {
  packageJson?: string;
  lockfile?: string;
  githubUrl?: string;
  path?: string;
  ai?: AiChoice;
}

export interface AnalysisReport {
  source: 'paste' | 'github' | 'demo';
  fileName: string;
  lockfileName?: string;
  generatedAt: string;
  entries: DependencyEntry[];
  analysis: ProjectAnalysis;
  warnings: Warning[];
  scan?: ScanInfo;
  notes: string[];
}

export interface AnalyzeFailure {
  ok: false;
  status: 400 | 404 | 413 | 422 | 502;
  code: string;
  message: string;
}

export type AnalyzeOutcome = { ok: true; report: AnalysisReport } | AnalyzeFailure;

export interface CheckRequest {
  githubUrl?: string;
}

export interface CheckReport {
  subject: string;
  generatedAt: string;
  report: RiskReport;
}

export type CheckOutcome = { ok: true; check: CheckReport } | AnalyzeFailure;

export interface FixRequest {
  packageJson?: string;
  lockfile?: string;
  ticket?: string;
  githubUrl?: string;
  path?: string;
  packageManager?: string;
  language?: string;
}

export interface FixReport {
  source: 'paste' | 'github' | 'demo';
  subject: string;
  generatedAt: string;
  plan: RemediationPlan | MultiRemediationPlan;
  pr: { markdown: PrDescription; jira: PrDescription };
  notes: string[];
  majorChecks: MajorFixCheck[];
  scanned: boolean;
}

export type FixOutcome = { ok: true; fix: FixReport } | AnalyzeFailure;

export interface AnalyzeService {
  analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome>;
  check(request: CheckRequest): Promise<CheckOutcome>;
  fix(request: FixRequest): Promise<FixOutcome>;
}

export interface ServiceDeps {
  registry: RegistryClient;
  manifests: ManifestClient;
  changelogs: ChangelogSource;
  fetch?: typeof fetch;
  serverAi?: AiProvider;
  aiBudget?: DailyBudget;
  maxAiCalls?: number;
  maxChangelogLookups?: number;
  stats?: StatsSource;
  advisories?: AdvisorySource;
  createByokProvider?: (options: { baseUrl: string; apiKey: string; model: string }) => AiProvider;
  now?: () => Date;
}

const MAX_PACKAGE_JSON_CHARS = 200_000;
const MAX_FIELD_CHARS = 500;
const AI_MODES: ReadonlySet<string> = new Set(['none', 'server', 'byok']);

function failure(status: AnalyzeFailure['status'], code: string, message: string): AnalyzeFailure {
  return { ok: false, status, code, message };
}

function limitCalls(provider: AiProvider, max: number): AiProvider {
  let calls = 0;
  return {
    async complete(request): Promise<AiResult> {
      calls++;
      if (calls > max) {
        return { ok: false, code: 'RATE_LIMITED', message: 'Too many AI explanations in one analysis.' };
      }
      return provider.complete(request);
    },
  };
}

function withBudget(provider: AiProvider, budget: DailyBudget): AiProvider {
  return {
    async complete(request): Promise<AiResult> {
      if (!budget.tryConsume()) {
        return { ok: false, code: 'RATE_LIMITED', message: 'The daily AI budget is used up.' };
      }
      return provider.complete(request);
    },
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function createAnalyzeService(deps: ServiceDeps): AnalyzeService {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? globalThis.fetch;
  const maxAiCalls = deps.maxAiCalls ?? 5;
  const createByok = deps.createByokProvider ?? createOpenAiCompatibleProvider;

  function chooseAi(choice: AiChoice | undefined, notes: string[]): { provider?: AiProvider; error?: AnalyzeFailure } {
    const mode = choice?.mode?.trim() || 'none';
    if (!AI_MODES.has(mode)) return { error: failure(400, 'INVALID_AI_MODE', 'The AI option is not valid.') };
    if (mode === 'none') return {};

    if (mode === 'server') {
      if (!deps.serverAi || !deps.aiBudget) {
        notes.push('AI explanations are not enabled on this server.');
        return {};
      }
      if (deps.aiBudget.remaining() <= 0) {
        notes.push('The daily AI budget is used up, so no AI explanations were added.');
        return {};
      }
      return { provider: limitCalls(withBudget(deps.serverAi, deps.aiBudget), maxAiCalls) };
    }

    const baseUrl = text(choice?.baseUrl)?.trim();
    const apiKey = text(choice?.apiKey)?.trim();
    const model = text(choice?.model)?.trim();
    if (!baseUrl || !apiKey || !model) {
      return { error: failure(400, 'INVALID_AI_CONFIG', 'To use your own key, enter the address, the key and the model.') };
    }
    if ([baseUrl, apiKey, model].some((value) => value.length > MAX_FIELD_CHARS)) {
      return { error: failure(400, 'INVALID_AI_CONFIG', 'One of the AI fields is too long.') };
    }
    try {
      return { provider: limitCalls(createByok({ baseUrl, apiKey, model }), maxAiCalls) };
    } catch {
      return {
        error: failure(400, 'AI_HOST_NOT_ALLOWED', `The AI address must be an https address on one of: ${KNOWN_AI_HOSTS.join(', ')}.`),
      };
    }
  }

  async function analyze(request: AnalyzeRequest): Promise<AnalyzeOutcome> {
    const githubUrl = text(request.githubUrl)?.trim();
    const notes: string[] = [];
    const extraWarnings: Warning[] = [];

    let packageJson = text(request.packageJson);
    let lockfile = text(request.lockfile);
    let tsconfig: string | undefined;
    let sources: SourceFile[] | undefined;
    let source: 'paste' | 'github' = 'paste';
    let truncated = false;

    if (githubUrl) {
      const target = parseGithubUrl(githubUrl);
      if (!target) {
        return failure(400, 'INVALID_GITHUB_URL', 'Enter a GitHub repository address like https://github.com/owner/repo.');
      }
      const downloaded = await downloadGithubArchive(target, doFetch);
      if (!downloaded.ok) return failure(404, 'REPOSITORY_UNAVAILABLE', downloaded.message);
      const pathOverride = text(request.path)?.trim() ?? target.path;
      const extracted = extractProject(downloaded.files, downloaded.names, pathOverride);
      if (!extracted.ok) return failure(422, 'NO_PACKAGE_JSON', extracted.message);

      packageJson = extracted.project.packageJson;
      lockfile = extracted.project.lockfile;
      tsconfig = extracted.project.tsconfig;
      sources = extracted.project.sources;
      source = 'github';
      truncated = downloaded.truncated;
      for (const message of extracted.project.warnings) extraWarnings.push({ code: 'LOCKFILE_UNSUPPORTED', message });
    } else if (!packageJson) {
      return failure(400, 'MISSING_INPUT', 'Paste a package.json or enter a GitHub repository address.');
    }

    if (packageJson.length > MAX_PACKAGE_JSON_CHARS) {
      return failure(413, 'PACKAGE_JSON_TOO_LARGE', 'The package.json is too large.');
    }

    const parsed = readProject(lockfile === undefined ? { packageJson } : { packageJson, lockfile });
    if (!parsed.ok) return failure(422, 'INVALID_PACKAGE_JSON', `package.json: ${parsed.error.message}`);

    const ai = chooseAi(request.ai, notes);
    if (ai.error) return ai.error;

    const analysis = await analyzeProject(parsed.value.entries, { registry: deps.registry });

    let scan: ScanInfo | undefined;
    if (sources) {
      const scanned = scanProject(sources, {
        aliasKeys: tsconfig === undefined ? [] : readTsconfigAliasKeys(tsconfig),
        knownPackages: parsed.value.entries.map((entry) => entry.name),
      });
      attachImpact(analysis.results, buildUsageIndex(scanned.imports), parsed.value.scripts);
      scan = {
        scannedFiles: scanned.scannedFiles,
        unsupportedFiles: scanned.skippedCounts['unsupported-language'] ?? 0,
        truncated,
      };
    } else {
      notes.push('Your code was not scanned, because only a package.json was provided. Enter a GitHub repository address to see where each package is used.');
    }

    await enrichWithChangelogs(analysis.results, {
      manifests: deps.manifests,
      changelogs: deps.changelogs,
      maxLookups: deps.maxChangelogLookups ?? 15,
      ...(ai.provider ? { ai: ai.provider } : {}),
    });

    const report: AnalysisReport = {
      source,
      fileName: 'package.json',
      generatedAt: now().toISOString(),
      entries: parsed.value.entries,
      analysis,
      warnings: [...parsed.warnings, ...extraWarnings],
      notes,
    };
    if (lockfile !== undefined && !parsed.warnings.some((warning) => warning.code === 'NO_LOCKFILE')) {
      report.lockfileName = 'package-lock.json';
    }
    if (scan) report.scan = scan;
    return { ok: true, report };
  }

  async function check(request: CheckRequest): Promise<CheckOutcome> {
    const githubUrl = text(request.githubUrl)?.trim();
    if (!githubUrl) return failure(400, 'MISSING_INPUT', 'Enter a GitHub repository address.');
    const target = parseGithubUrl(githubUrl);
    if (!target) {
      return failure(400, 'INVALID_GITHUB_URL', 'Enter a GitHub repository address like https://github.com/owner/repo.');
    }

    const downloaded = await downloadGithubArchive(target, doFetch, 'check');
    if (!downloaded.ok) return failure(404, 'REPOSITORY_UNAVAILABLE', downloaded.message);
    const stripped = stripArchiveRoot(downloaded.files, downloaded.names, target.path);
    if (!stripped) return failure(400, 'INVALID_GITHUB_URL', 'The folder path is not valid.');

    const report = assessRepository({ files: stripped.files, names: stripped.names });
    if (downloaded.truncated) {
      report.truncated = true;
      report.limitations.push('The repository was too large to read completely.');
    }
    if (deps.stats) {
      try {
        await refineLookalikes(report, deps.stats, { maxLookups: 10 });
      } catch {
        report.limitations.push('Download counts could not be looked up.');
      }
    }

    const where = [target.ref ? `branch ${target.ref}` : undefined, target.path].filter(Boolean).join(', ');
    return {
      ok: true,
      check: {
        subject: `https://github.com/${target.owner}/${target.repo}${where ? ` (${where})` : ''}`,
        generatedAt: now().toISOString(),
        report,
      },
    };
  }

  async function fix(request: FixRequest): Promise<FixOutcome> {
    const ticket = text(request.ticket);
    if (!ticket) return failure(400, 'MISSING_TICKET', 'Paste the text of the security ticket.');
    const pm = request.packageManager?.trim() || undefined;
    if (pm !== undefined && pm !== 'npm' && pm !== 'yarn' && pm !== 'pnpm') {
      return failure(400, 'INVALID_PACKAGE_MANAGER', 'The package manager must be npm, yarn or pnpm.');
    }
    const language = request.language?.trim() || 'en';
    if (language !== 'en' && language !== 'sq') return failure(400, 'INVALID_LANGUAGE', 'The language must be en or sq.');

    const githubUrl = text(request.githubUrl)?.trim();
    const notes: string[] = [];
    let packageJson = text(request.packageJson);
    let lockfile = text(request.lockfile);
    let tsconfig: string | undefined;
    let sources: SourceFile[] | undefined;
    let source: 'paste' | 'github' = 'paste';
    let subject = 'package.json';

    if (githubUrl) {
      const target = parseGithubUrl(githubUrl);
      if (!target) return failure(400, 'INVALID_GITHUB_URL', 'Enter a GitHub repository address like https://github.com/owner/repo.');
      const downloaded = await downloadGithubArchive(target, doFetch);
      if (!downloaded.ok) return failure(404, 'REPOSITORY_UNAVAILABLE', downloaded.message);
      const extracted = extractProject(downloaded.files, downloaded.names, text(request.path)?.trim() ?? target.path);
      if (!extracted.ok) return failure(422, 'NO_PACKAGE_JSON', extracted.message);
      packageJson = extracted.project.packageJson;
      lockfile = extracted.project.lockfile;
      tsconfig = extracted.project.tsconfig;
      sources = extracted.project.sources;
      source = 'github';
      subject = `https://github.com/${target.owner}/${target.repo}`;
      notes.push(...extracted.project.warnings);
      if (downloaded.truncated) notes.push('The repository was too large to read completely, so the list of files that use each package may be incomplete.');
    } else if (!packageJson) {
      return failure(400, 'MISSING_INPUT', 'Paste a package.json or enter a GitHub repository address.');
    }
    if (packageJson.length > MAX_PACKAGE_JSON_CHARS) return failure(413, 'PACKAGE_JSON_TOO_LARGE', 'The package.json is too large.');

    const split = splitTickets(ticket);
    notes.push(...split.warnings);
    if (split.tickets.length === 0) return failure(400, 'MISSING_TICKET', 'Paste the text of the security ticket.');

    const base = { packageJson, ...(lockfile === undefined ? {} : { lockfile }), ...(pm ? { packageManager: pm as 'npm' | 'yarn' | 'pnpm' } : {}) };
    let plan: RemediationPlan | MultiRemediationPlan;
    let failed: { code: string; message: string } | undefined;
    if (split.tickets.length > 1) {
      const outcome = deps.advisories
        ? (await planMultiRemediationWithLookup({ ...base, tickets: split.tickets }, deps.advisories)).result
        : planMultiRemediation({ ...base, tickets: split.tickets });
      if (!outcome.ok) failed = outcome;
      plan = outcome as MultiRemediationPlan;
    } else {
      const input = { ...base, ticket: (split.tickets[0] as { text: string }).text };
      const outcome = deps.advisories ? (await planRemediationWithLookup(input, deps.advisories)).result : planRemediation(input);
      if (!outcome.ok) failed = outcome;
      plan = outcome as RemediationPlan;
    }
    if (failed) {
      const status = failed.code === 'NO_FINDINGS' || failed.code === 'INVALID_PACKAGE_JSON' ? 422 : 400;
      return failure(status, failed.code, failed.message);
    }

    let usage: Map<string, PackageUsage> | undefined;
    if (sources) {
      const scanned = scanProject(sources, {
        aliasKeys: tsconfig === undefined ? [] : readTsconfigAliasKeys(tsconfig),
        knownPackages: plan.findings.map((finding) => finding.finding.packageName),
      });
      usage = buildUsageIndex(scanned.imports);
    } else {
      notes.push('Your code was not scanned, because only a package.json was provided. Enter a GitHub repository address to see which files use each package.');
    }

    let majorChecks: MajorFixCheck[] = [];
    try {
      majorChecks = await checkMajorFixChangelogs(plan, { manifests: deps.manifests, changelogs: deps.changelogs, maxLookups: 3, ...(usage ? { usage } : {}) });
      applyMajorChecks(plan, majorChecks, usage !== undefined);
    } catch {
      notes.push('Changelogs could not be checked.');
    }

    const options = { language: language as 'en' | 'sq', ...(usage ? { usage } : {}) };
    return {
      ok: true,
      fix: {
        source,
        subject,
        generatedAt: now().toISOString(),
        plan,
        pr: { markdown: buildPrDescription(plan, { ...options, format: 'markdown' }), jira: buildPrDescription(plan, { ...options, format: 'jira' }) },
        notes,
        majorChecks,
        scanned: usage !== undefined,
      },
    };
  }

  return { analyze, check, fix };
}
