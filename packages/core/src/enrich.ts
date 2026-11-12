import { explainUpdate } from './ai.ts';
import type { AiProvider } from './ai.ts';
import type { UpdateAnalysis } from './analyze.ts';
import { buildChangelogLines, findSymbolMentions, selectForPrompt } from './changelog.ts';
import { decideVerdict } from './decide.ts';
import type { ChangelogEvidence } from './decide.ts';
import type { ChangelogSource } from './github.ts';
import { parseRepositoryField } from './repository.ts';
import type { ManifestClient } from './registry.ts';
import { mapWithConcurrency } from './util.ts';

export interface EnrichDeps {
  manifests: ManifestClient;
  changelogs: ChangelogSource;
  ai?: AiProvider;
  concurrency?: number;
  maxLookups?: number;
  maxPromptChars?: number;
  randomId?: () => string;
}

const DEFAULT_PROMPT_CHARS = 12_000;

function emptyEvidence(status: ChangelogEvidence['status'], message?: string): ChangelogEvidence {
  const evidence: ChangelogEvidence = { status, sections: 0, lineCount: 0, truncated: false, mentions: [] };
  if (message !== undefined) evidence.message = message;
  return evidence;
}

function needsEvidence(result: UpdateAnalysis): boolean {
  return (
    result.status === 'analyzed' &&
    result.current !== undefined &&
    result.target !== undefined &&
    (result.kind === 'major' || result.kind === 'minor' || result.kind === 'patch') &&
    (result.preliminary === 'breaking-candidate' || result.preliminary === 'review')
  );
}

async function enrichOne(result: UpdateAnalysis, deps: EnrichDeps): Promise<void> {
  const current = result.current as string;
  const target = result.target as string;

  const manifest = await deps.manifests.getManifest(result.registryName);
  if (!manifest.ok) {
    result.changelog = emptyEvidence('error', manifest.message);
    result.verdict = decideVerdict(result, result.changelog);
    return;
  }

  const repository = parseRepositoryField(manifest.manifest.repository, manifest.manifest.homepage);
  if (repository.kind !== 'github') {
    result.changelog = emptyEvidence(
      repository.kind === 'none' ? 'no-repository' : 'not-github',
      repository.kind === 'none' ? 'The package does not list a repository.' : 'The repository is not on GitHub.',
    );
    result.verdict = decideVerdict(result, result.changelog);
    return;
  }

  const fetched = await deps.changelogs.fetchChangelog(repository, {
    packageName: result.registryName,
    from: current,
    to: target,
  });
  if (!fetched.ok) {
    const status =
      fetched.code === 'RATE_LIMITED'
        ? 'rate-limited'
        : fetched.code === 'NOT_FOUND'
          ? 'not-found'
          : fetched.code === 'NO_MATCHING_VERSIONS'
            ? 'no-versions'
            : 'error';
    result.changelog = emptyEvidence(status, fetched.message);
    result.verdict = decideVerdict(result, result.changelog);
    return;
  }

  const lines = buildChangelogLines(fetched.sections);
  const usedNames = [...(result.impact?.symbols ?? []), ...(result.impact?.members ?? [])];
  const selection = selectForPrompt(lines, deps.maxPromptChars ?? DEFAULT_PROMPT_CHARS);
  const evidence: ChangelogEvidence = {
    status: 'found',
    source: fetched.source,
    repository: `${repository.owner}/${repository.repo}`,
    sections: fetched.sections.length,
    lineCount: lines.length,
    truncated: selection.truncated,
    mentions: findSymbolMentions(lines, usedNames),
  };
  result.changelog = evidence;

  if (deps.ai && lines.length > 0) {
    const explained = await explainUpdate(
      {
        packageName: result.registryName,
        from: current,
        to: target,
        usedNames,
        files: result.impact?.files ?? [],
        lines: selection.lines,
      },
      deps.ai,
      deps.randomId ? { randomId: deps.randomId } : {},
    );
    if (explained.ok) result.explanation = explained.explanation;
    else result.explanationError = explained.message;
  }

  result.verdict = decideVerdict(result, evidence, result.explanation?.findings ?? []);
}

function lookupPriority(result: UpdateAnalysis): number {
  const used = result.impact?.level === 'used' || result.impact?.level === 'type-only';
  return (used ? 0 : 2) + (result.preliminary === 'breaking-candidate' ? 0 : 1);
}

export async function enrichWithChangelogs(results: readonly UpdateAnalysis[], deps: EnrichDeps): Promise<void> {
  let pending = results.filter(needsEvidence);
  const limit = deps.maxLookups;
  if (limit !== undefined && pending.length > limit) {
    const ordered = [...pending].sort((a, b) => lookupPriority(a) - lookupPriority(b));
    const chosen = new Set(ordered.slice(0, Math.max(0, limit)));
    for (const result of pending) {
      if (chosen.has(result)) continue;
      result.changelog = emptyEvidence('skipped', `Skipped: only ${Math.max(0, limit)} changelogs are checked per analysis.`);
      result.verdict = decideVerdict(result, result.changelog);
    }
    pending = pending.filter((result) => chosen.has(result));
  }
  await mapWithConcurrency(pending, deps.concurrency ?? 3, async (result) => {
    try {
      await enrichOne(result, deps);
    } catch {
      result.changelog = emptyEvidence('error', 'The changelog lookup failed.');
      result.verdict = decideVerdict(result, result.changelog);
    }
  });

  for (const result of results) {
    if (result.verdict === undefined) result.verdict = decideVerdict(result, undefined);
  }
}
