import semver from 'semver';
import type { FetchPackumentResult, Packument, RegistryClient } from './registry.ts';
import type { DependencyEntry } from './types.ts';
import { mapWithConcurrency } from './util.ts';

export type UpdateKind = 'none' | 'patch' | 'minor' | 'major' | 'unknown';
export type Preliminary = 'safe' | 'review' | 'breaking-candidate' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';

export interface PeerConflict {
  dependency: string;
  required: string;
  have: string;
}

export interface UpdateAnalysis {
  name: string;
  section: DependencyEntry['section'];
  spec: string;
  registryName: string;
  status: 'analyzed' | 'skipped' | 'error';
  reasons: string[];
  intermediateMajors: number[];
  peerConflicts: PeerConflict[];
  current?: string;
  currentSource?: 'lockfile' | 'range-minimum';
  target?: string;
  kind?: UpdateKind;
  preliminary?: Preliminary;
  confidence?: Confidence;
  withinRange?: boolean;
  deprecated?: string;
  errorCode?: string;
}

export interface AnalysisSummary {
  total: number;
  analyzed: number;
  skipped: number;
  errors: number;
  safe: number;
  review: number;
  breakingCandidate: number;
  unknown: number;
  upToDate: number;
}

export interface ProjectAnalysis {
  results: UpdateAnalysis[];
  summary: AnalysisSummary;
}

export interface AnalyzeProjectOptions {
  registry: RegistryClient;
  concurrency?: number;
  maxPackages?: number;
}

type VersionLookup = (name: string) => string | undefined;

function declaredRange(entry: DependencyEntry): string | undefined {
  switch (entry.kind) {
    case 'exact':
    case 'range':
      return entry.spec.trim();
    case 'alias':
      return entry.aliasRange !== undefined && semver.validRange(entry.aliasRange) ? entry.aliasRange : undefined;
    default:
      return undefined;
  }
}

function resolveCurrent(entry: DependencyEntry): { version: string; source: 'lockfile' | 'range-minimum' } | undefined {
  const installed = entry.installed !== undefined ? semver.valid(entry.installed) : null;
  if (installed) return { version: installed, source: 'lockfile' };
  const range = declaredRange(entry);
  if (!range || !semver.validRange(range)) return undefined;
  const minimum = semver.minVersion(range);
  return minimum ? { version: minimum.version, source: 'range-minimum' } : undefined;
}

function pickTarget(packument: Packument): string | undefined {
  const latest = packument.distTags.latest;
  if (latest !== undefined && semver.prerelease(latest) === null && packument.versions[latest] !== undefined) {
    return latest;
  }
  const stable = Object.keys(packument.versions)
    .filter((version) => semver.prerelease(version) === null)
    .sort(semver.rcompare);
  return stable[0];
}

function mapDiff(difference: string | null): UpdateKind {
  switch (difference) {
    case 'major':
    case 'premajor':
      return 'major';
    case 'minor':
    case 'preminor':
      return 'minor';
    case 'patch':
    case 'prepatch':
    case 'prerelease':
      return 'patch';
    default:
      return 'unknown';
  }
}

function newResult(entry: DependencyEntry): UpdateAnalysis {
  return {
    name: entry.name,
    section: entry.section,
    spec: entry.spec,
    registryName: entry.aliasOf ?? entry.name,
    status: 'analyzed',
    reasons: [],
    intermediateMajors: [],
    peerConflicts: [],
  };
}

export function analyzeEntry(entry: DependencyEntry, packument: Packument, versionOf: VersionLookup): UpdateAnalysis {
  const result = newResult(entry);
  const target = pickTarget(packument);

  if (target === undefined) {
    result.status = 'error';
    result.errorCode = 'INVALID_RESPONSE';
    result.reasons.push('The registry lists no stable version for this package.');
    return result;
  }
  result.target = target;

  const resolved = resolveCurrent(entry);
  if (!resolved) {
    result.kind = 'unknown';
    result.confidence = 'low';
    if (declaredRange(entry) === undefined) {
      result.preliminary = 'review';
      result.reasons.push(
        `The version is not pinned ("${entry.spec}") and no lockfile gives the installed version, so the current version is unknown.`,
      );
    } else {
      result.preliminary = 'unknown';
      result.reasons.push(`The version range "${entry.spec}" could not be interpreted.`);
    }
    return result;
  }

  const current = resolved.version;
  result.current = current;
  result.currentSource = resolved.source;
  result.confidence = resolved.source === 'lockfile' ? 'high' : 'medium';
  if (resolved.source === 'range-minimum') {
    result.reasons.push(
      `No lockfile: the installed version is assumed to be the lowest the range allows (${current}).`,
    );
  }

  const kind: UpdateKind = semver.gte(current, target) ? 'none' : mapDiff(semver.diff(current, target));
  result.kind = kind;
  const currentMajor = semver.major(current);

  let preliminary: Preliminary = kind === 'major' ? 'breaking-candidate' : 'safe';

  if (kind === 'none') {
    result.reasons.push(
      semver.gt(current, target)
        ? `The installed version (${current}) is ahead of the latest stable release (${target}).`
        : `Already at the latest stable version (${current}).`,
    );
  } else if (kind === 'major') {
    result.reasons.push(
      `Major version change (${current} to ${target}). Semver allows breaking changes, but none are confirmed yet.`,
    );
  } else if (currentMajor === 0) {
    preliminary = 'review';
    result.reasons.push(`Version 0.x: any release can contain breaking changes (${current} to ${target}).`);
  } else {
    result.reasons.push(
      `${kind === 'minor' ? 'Minor' : 'Patch'} update (${current} to ${target}), backwards compatible according to semver.`,
    );
  }

  if (kind === 'major') {
    const majors = new Set<number>();
    for (const version of Object.keys(packument.versions)) {
      if (semver.prerelease(version) !== null) continue;
      const major = semver.major(version);
      if (major > currentMajor && major < semver.major(target)) majors.add(major);
    }
    result.intermediateMajors = [...majors].sort((a, b) => a - b);
    if (result.intermediateMajors.length > 0) {
      result.reasons.push(`Skips major versions ${result.intermediateMajors.join(', ')}. Migrate one step at a time.`);
    }
  }

  const targetDeprecated = packument.versions[target]?.deprecated;
  const currentDeprecated = packument.versions[current]?.deprecated;
  if (targetDeprecated !== undefined) {
    result.deprecated = targetDeprecated;
    result.reasons.push(`The latest version is deprecated: ${targetDeprecated}`);
    if (preliminary === 'safe') preliminary = 'review';
  } else if (currentDeprecated !== undefined) {
    result.deprecated = currentDeprecated;
    result.reasons.push(`Your version is deprecated: ${currentDeprecated}`);
    if (preliminary === 'safe') preliminary = 'review';
  } else if (resolved.source === 'lockfile' && packument.versions[current] === undefined) {
    result.reasons.push(`Version ${current} is no longer listed in the registry.`);
    if (preliminary === 'safe') preliminary = 'review';
  }

  const peers = packument.versions[target]?.peerDependencies ?? {};
  for (const [peerName, required] of Object.entries(peers)) {
    const have = versionOf(peerName);
    if (have === undefined || !semver.validRange(required)) continue;
    if (!semver.satisfies(have, required, { includePrerelease: true })) {
      result.peerConflicts.push({ dependency: peerName, required, have });
      result.reasons.push(`${target} requires ${peerName} ${required}, but the project has ${have}.`);
      if (preliminary === 'safe') preliminary = 'review';
    }
  }

  const range = declaredRange(entry);
  if (range !== undefined && semver.validRange(range)) {
    result.withinRange = semver.satisfies(target, range);
    if (kind !== 'none') {
      result.reasons.push(
        result.withinRange
          ? 'Your declared range already allows it, so updating the lockfile is enough.'
          : 'It is outside your declared range, so package.json must change.',
      );
    }
  }

  result.preliminary = preliminary;
  return result;
}

function buildVersionLookup(entries: readonly DependencyEntry[]): VersionLookup {
  const versions = new Map<string, string>();
  for (const entry of entries) {
    if (versions.has(entry.name)) continue;
    const resolved = resolveCurrent(entry);
    if (resolved) versions.set(entry.name, resolved.version);
  }
  return (name) => versions.get(name);
}

function notAnalyzed(entry: DependencyEntry, status: 'skipped' | 'error', reason: string, errorCode?: string): UpdateAnalysis {
  const result = newResult(entry);
  result.status = status;
  result.reasons.push(reason);
  if (errorCode !== undefined) result.errorCode = errorCode;
  return result;
}

function summarize(results: readonly UpdateAnalysis[]): AnalysisSummary {
  const summary: AnalysisSummary = {
    total: results.length,
    analyzed: 0,
    skipped: 0,
    errors: 0,
    safe: 0,
    review: 0,
    breakingCandidate: 0,
    unknown: 0,
    upToDate: 0,
  };
  for (const result of results) {
    if (result.status === 'skipped') summary.skipped++;
    else if (result.status === 'error') summary.errors++;
    else {
      summary.analyzed++;
      if (result.kind === 'none') summary.upToDate++;
      else if (result.preliminary === 'safe') summary.safe++;
      else if (result.preliminary === 'review') summary.review++;
      else if (result.preliminary === 'breaking-candidate') summary.breakingCandidate++;
      else summary.unknown++;
    }
  }
  return summary;
}

export async function analyzeProject(
  entries: readonly DependencyEntry[],
  options: AnalyzeProjectOptions,
): Promise<ProjectAnalysis> {
  const maxPackages = options.maxPackages ?? 300;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.analyzable) continue;
    const registryName = entry.aliasOf ?? entry.name;
    if (seen.has(registryName)) continue;
    seen.add(registryName);
    names.push(registryName);
  }
  const allowed = new Set(names.slice(0, maxPackages));

  const fetched = new Map<string, FetchPackumentResult>();
  await mapWithConcurrency([...allowed], options.concurrency ?? 5, async (name) => {
    try {
      fetched.set(name, await options.registry.getPackument(name));
    } catch {
      fetched.set(name, { ok: false, code: 'UNAVAILABLE', message: 'The registry lookup failed.' });
    }
  });

  const versionOf = buildVersionLookup(entries);
  const results = entries.map((entry): UpdateAnalysis => {
    if (!entry.analyzable) return notAnalyzed(entry, 'skipped', entry.reason ?? 'Not analyzed.');
    const registryName = entry.aliasOf ?? entry.name;
    if (!allowed.has(registryName)) {
      return notAnalyzed(entry, 'skipped', `Skipped: only the first ${maxPackages} packages are analyzed.`);
    }
    const fetchedResult = fetched.get(registryName);
    if (!fetchedResult) return notAnalyzed(entry, 'error', 'The registry lookup did not finish.', 'UNAVAILABLE');
    if (!fetchedResult.ok) return notAnalyzed(entry, 'error', fetchedResult.message, fetchedResult.code);
    return analyzeEntry(entry, fetchedResult.packument, versionOf);
  });

  return { results, summary: summarize(results) };
}
