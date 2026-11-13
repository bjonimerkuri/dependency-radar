import semver from 'semver';
import { getText } from './http.ts';
import { planMultiRemediation, planRemediation } from './remediate.ts';
import type { MultiRemediationInput, MultiRemediationResult, RemediationInput, RemediationResult } from './remediate.ts';
import { displayAdvisoryId, isPlainObject, mapWithConcurrency } from './util.ts';

export const ALLOWED_ADVISORY_HOSTS: readonly string[] = ['api.osv.dev'];

export interface AdvisorySource {
  fixedVersions(id: string, packageName: string): Promise<string[]>;
}

export interface OsvSourceOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ADVISORY_ID = /^(?:CVE-\d{4}-\d{4,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;

export function fixedVersionsFromOsv(record: unknown, packageName: string): string[] {
  if (!isPlainObject(record) || !Array.isArray(record.affected)) return [];
  const found = new Set<string>();
  for (const affected of record.affected) {
    if (!isPlainObject(affected) || !isPlainObject(affected.package)) continue;
    if (affected.package.ecosystem !== 'npm' || affected.package.name !== packageName) continue;
    if (!Array.isArray(affected.ranges)) continue;
    for (const range of affected.ranges) {
      if (!isPlainObject(range) || range.type !== 'SEMVER' || !Array.isArray(range.events)) continue;
      for (const event of range.events) {
        if (!isPlainObject(event) || typeof event.fixed !== 'string') continue;
        const version = semver.valid(event.fixed.trim());
        if (version !== null) found.add(version);
      }
    }
  }
  return [...found].sort(semver.compare);
}

export function createOsvSource(options: OsvSourceOptions = {}): AdvisorySource {
  const doFetch = options.fetch ?? globalThis.fetch;
  return {
    async fixedVersions(id, packageName) {
      if (!ADVISORY_ID.test(id)) return [];
      const result = await getText(`https://api.osv.dev/v1/vulns/${encodeURIComponent(displayAdvisoryId(id))}`, {
        fetch: doFetch,
        allowedHosts: ALLOWED_ADVISORY_HOSTS,
        timeoutMs: options.timeoutMs ?? 8_000,
        maxChars: 500_000,
      });
      if (!result.ok) return [];
      try {
        return fixedVersionsFromOsv(JSON.parse(result.text), packageName);
      } catch {
        return [];
      }
    },
  };
}

export interface LookupOptions {
  maxLookups?: number;
}

type Lookupable = { findings: ReadonlyArray<{ status: string; finding: { packageName: string; ids: readonly string[] } }> };

async function lookUp(plan: Lookupable, source: AdvisorySource, options: LookupOptions): Promise<Record<string, string[]>> {
  const wanted: Array<{ id: string; name: string }> = [];
  for (const item of plan.findings) {
    if (item.status !== 'no-fixed-version') continue;
    for (const id of item.finding.ids) {
      if (ADVISORY_ID.test(id)) wanted.push({ id, name: item.finding.packageName });
    }
  }
  const limited = wanted.slice(0, options.maxLookups ?? 10);
  const found: Record<string, string[]> = {};
  await mapWithConcurrency(limited, 3, async ({ id, name }) => {
    let versions: string[] = [];
    try {
      versions = await source.fixedVersions(id, name);
    } catch {
      versions = [];
    }
    if (versions.length > 0) found[name] = [...new Set([...(found[name] ?? []), ...versions])];
  });
  return found;
}

export interface LookupNote {
  looked: boolean;
  found: Record<string, string[]>;
}

export async function planRemediationWithLookup(
  input: RemediationInput,
  source: AdvisorySource,
  options: LookupOptions = {},
): Promise<{ result: RemediationResult; lookup: LookupNote }> {
  const first = planRemediation(input);
  if (!first.ok) return { result: first, lookup: { looked: false, found: {} } };
  const found = await lookUp(first, source, options);
  if (Object.keys(found).length === 0) return { result: first, lookup: { looked: first.findings.some((item) => item.status === 'no-fixed-version'), found } };
  const merged: Record<string, string[]> = { ...Object.fromEntries(Object.entries(input.fixedVersions ?? {}).map(([name, list]) => [name, [...list]])) };
  for (const [name, versions] of Object.entries(found)) merged[name] = [...new Set([...(merged[name] ?? []), ...versions])];
  const second = planRemediation({ ...input, fixedVersions: merged });
  if (second.ok) second.warnings.push(`Fixed versions for ${Object.keys(found).join(', ')} were taken from the OSV advisory database because the ticket did not list them.`);
  return { result: second, lookup: { looked: true, found } };
}

export async function planMultiRemediationWithLookup(
  input: MultiRemediationInput,
  source: AdvisorySource,
  options: LookupOptions = {},
): Promise<{ result: MultiRemediationResult; lookup: LookupNote }> {
  const first = planMultiRemediation(input);
  if (!first.ok) return { result: first, lookup: { looked: false, found: {} } };
  const found = await lookUp(first, source, options);
  if (Object.keys(found).length === 0) return { result: first, lookup: { looked: first.findings.some((item) => item.status === 'no-fixed-version'), found } };
  const merged: Record<string, string[]> = { ...Object.fromEntries(Object.entries(input.fixedVersions ?? {}).map(([name, list]) => [name, [...list]])) };
  for (const [name, versions] of Object.entries(found)) merged[name] = [...new Set([...(merged[name] ?? []), ...versions])];
  const second = planMultiRemediation({ ...input, fixedVersions: merged });
  if (second.ok) second.warnings.push(`Fixed versions for ${Object.keys(found).join(', ')} were taken from the OSV advisory database because the tickets did not list them.`);
  return { result: second, lookup: { looked: true, found } };
}
