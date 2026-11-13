import semver from 'semver';
import { buildChangelogLines, findSymbolMentions } from './changelog.ts';
import type { SymbolMention } from './changelog.ts';
import type { ChangelogSource } from './github.ts';
import { parseRepositoryField } from './repository.ts';
import type { ManifestClient } from './registry.ts';
import type { RemediationPlan } from './remediate.ts';
import { mapWithConcurrency } from './util.ts';

export interface FixChangelogDeps {
  manifests: ManifestClient;
  changelogs: ChangelogSource;
  usage?: ReadonlyMap<string, { symbols: readonly string[]; members: readonly string[] }>;
  maxLookups?: number;
}

export type MajorCheckStatus = 'found' | 'no-repository' | 'not-github' | 'not-found' | 'rate-limited' | 'no-versions' | 'error' | 'skipped';

export interface MajorFixCheck {
  packageName: string;
  from: string;
  to: string;
  status: MajorCheckStatus;
  repository?: string;
  sections: number;
  lineCount: number;
  breakingLines: number;
  mentions: SymbolMention[];
  message?: string;
}

function empty(packageName: string, from: string, to: string, status: MajorCheckStatus, message?: string): MajorFixCheck {
  const check: MajorFixCheck = { packageName, from, to, status, sections: 0, lineCount: 0, breakingLines: 0, mentions: [] };
  if (message !== undefined) check.message = message;
  return check;
}

async function checkOne(packageName: string, from: string, to: string, deps: FixChangelogDeps): Promise<MajorFixCheck> {
  const manifest = await deps.manifests.getManifest(packageName);
  if (!manifest.ok) return empty(packageName, from, to, 'error', manifest.message);
  const repository = parseRepositoryField(manifest.manifest.repository, manifest.manifest.homepage);
  if (repository.kind === 'none') return empty(packageName, from, to, 'no-repository', 'The package does not list a repository.');
  if (repository.kind !== 'github') return empty(packageName, from, to, 'not-github', 'The repository is not on GitHub.');

  const fetched = await deps.changelogs.fetchChangelog(repository, { packageName, from, to });
  if (!fetched.ok) {
    const status: MajorCheckStatus = fetched.code === 'RATE_LIMITED' ? 'rate-limited' : fetched.code === 'NOT_FOUND' ? 'not-found' : fetched.code === 'NO_MATCHING_VERSIONS' ? 'no-versions' : 'error';
    return empty(packageName, from, to, status, fetched.message);
  }
  const lines = buildChangelogLines(fetched.sections);
  const used = deps.usage?.get(packageName);
  const names = used ? [...used.symbols, ...used.members] : [];
  return {
    packageName,
    from,
    to,
    status: 'found',
    repository: `${repository.owner}/${repository.repo}`,
    sections: fetched.sections.length,
    lineCount: lines.length,
    breakingLines: lines.filter((line) => line.breaking).length,
    mentions: findSymbolMentions(lines, names),
  };
}

export async function checkMajorFixChangelogs(plan: RemediationPlan, deps: FixChangelogDeps): Promise<MajorFixCheck[]> {
  const targets: Array<{ name: string; from: string; to: string }> = [];
  for (const finding of plan.findings) {
    if (finding.status !== 'planned') continue;
    const option = finding.options.find((candidate) => candidate.recommended && candidate.majorChange && candidate.kind !== 'lockfile-update');
    if (!option) continue;
    const versions = finding.instances.filter((instance) => instance.vulnerable).map((instance) => instance.version).sort(semver.compare);
    const from = versions[0];
    if (from === undefined) continue;
    targets.push({ name: finding.finding.packageName, from, to: option.target });
  }

  const limit = deps.maxLookups ?? 5;
  const results: MajorFixCheck[] = new Array(targets.length);
  await mapWithConcurrency(targets.map((target, index) => ({ target, index })), 3, async ({ target, index }) => {
    if (index >= limit) {
      results[index] = empty(target.name, target.from, target.to, 'skipped', `Skipped: only ${limit} changelogs are checked per run.`);
      return;
    }
    try {
      results[index] = await checkOne(target.name, target.from, target.to, deps);
    } catch {
      results[index] = empty(target.name, target.from, target.to, 'error', 'The changelog lookup failed.');
    }
  });
  return results;
}

export function describeMajorCheck(check: MajorFixCheck, usageKnown: boolean): string {
  const span = `${check.packageName} ${check.from} to ${check.to}`;
  if (check.status !== 'found') {
    return `Changelog for ${span} could not be checked (${check.message ?? check.status}). I am not sure whether this major update breaks your code, so read the release notes and run your tests.`;
  }
  const base = `Changelog for ${span} (${check.repository}): ${check.breakingLines} of ${check.lineCount} lines look like breaking changes.`;
  if (!usageKnown) return `${base} Your code was not scanned, so I cannot say whether they affect you.`;
  if (check.mentions.length === 0) return `${base} None of the names your code imports is mentioned there. That does not prove the update is safe, so still run your tests.`;
  const names = check.mentions.map((mention) => mention.symbol).slice(0, 8).join(', ');
  const breaking = check.mentions.filter((mention) => mention.inBreaking).map((mention) => mention.symbol).slice(0, 8).join(', ');
  return `${base} Names your code uses that the changelog mentions: ${names}${breaking !== '' ? ` (in breaking changes: ${breaking})` : ''}.`;
}

export function applyMajorChecks(plan: RemediationPlan, checks: readonly MajorFixCheck[], usageKnown: boolean): void {
  for (const check of checks) {
    const finding = plan.findings.find((item) => item.finding.packageName === check.packageName);
    if (finding) finding.notes.push(describeMajorCheck(check, usageKnown));
  }
}
