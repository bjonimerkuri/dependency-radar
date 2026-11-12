import semver from 'semver';
import { parseVersionSections, sectionsBetween } from './changelog.ts';
import type { VersionSection } from './changelog.ts';
import { getText } from './http.ts';
import type { HttpErrorCode } from './http.ts';
import type { RepositoryRef } from './repository.ts';
import { isPlainObject } from './util.ts';

export type GithubRepository = Extract<RepositoryRef, { kind: 'github' }>;

export interface ChangelogRequest {
  packageName: string;
  from: string;
  to: string;
}

export type ChangelogFetchResult =
  | { ok: true; source: 'file' | 'releases'; path?: string; sections: VersionSection[] }
  | { ok: false; code: HttpErrorCode | 'NO_MATCHING_VERSIONS'; message: string };

export interface ChangelogSource {
  fetchChangelog(repository: GithubRepository, request: ChangelogRequest): Promise<ChangelogFetchResult>;
}

export interface GithubSourceOptions {
  fetch?: typeof fetch;
  token?: string;
  timeoutMs?: number;
  maxReleasePages?: number;
}

const RAW_HOST = 'raw.githubusercontent.com';
const API_HOST = 'api.github.com';
const FILE_NAMES = ['CHANGELOG.md', 'Changelog.md', 'HISTORY.md', 'CHANGES.md'];
const ALLOWED_TAG_PREFIXES = new Set(['', 'v', 'V', 'release', 'releases', 'version']);

export function parseTagVersion(tag: string, packageName: string): string | undefined {
  const short = packageName.split('/').pop() as string;
  const scoped = /^(.+)@v?(\d+\.\d+\.\d+.*)$/.exec(tag);
  if (scoped) {
    const prefix = scoped[1] as string;
    if (prefix !== packageName && prefix !== short) return undefined;
    return semver.valid(scoped[2] as string) ?? undefined;
  }
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)/.exec(tag);
  if (!match) return undefined;
  const prefix = tag.slice(0, match.index).replace(/[vV]$/, '').replace(/[-_/@]+$/, '');
  if (!ALLOWED_TAG_PREFIXES.has(prefix) && prefix !== packageName && prefix !== short) return undefined;
  return semver.valid(match[1] as string) ?? undefined;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export function createGithubChangelogSource(options: GithubSourceOptions = {}): ChangelogSource {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxReleasePages = options.maxReleasePages ?? 2;
  const hosts = [RAW_HOST, API_HOST];
  const baseHeaders: Record<string, string> = { 'user-agent': 'dependency-radar' };
  const apiHeaders: Record<string, string> = {
    ...baseHeaders,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (options.token) apiHeaders.authorization = `Bearer ${options.token}`;

  async function fetchChangelog(repository: GithubRepository, request: ChangelogRequest): Promise<ChangelogFetchResult> {
    const { owner, repo, directory } = repository;
    let foundFile = false;
    let blocking: { code: HttpErrorCode; message: string } | undefined;

    const folders = directory === undefined ? [''] : [`${directory}/`, ''];
    for (const folder of folders) {
      for (const name of FILE_NAMES) {
        const path = `${folder}${name}`;
        const url = `https://${RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${encodePath(path)}`;
        const result = await getText(url, { fetch: doFetch, allowedHosts: hosts, headers: baseHeaders, timeoutMs });
        if (!result.ok) {
          if (result.code !== 'NOT_FOUND') blocking = { code: result.code, message: result.message };
          continue;
        }
        foundFile = true;
        const sections = sectionsBetween(parseVersionSections(result.text, request.packageName), request.from, request.to);
        if (sections.length > 0) return { ok: true, source: 'file', path, sections };
      }
    }

    for (let page = 1; page <= maxReleasePages; page++) {
      const url = `https://${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100&page=${page}`;
      const result = await getText(url, { fetch: doFetch, allowedHosts: hosts, headers: apiHeaders, timeoutMs });
      if (!result.ok) {
        if (result.code !== 'NOT_FOUND') blocking = { code: result.code, message: result.message };
        break;
      }
      let releases: unknown;
      try {
        releases = JSON.parse(result.text);
      } catch {
        break;
      }
      if (!Array.isArray(releases)) break;

      const sections: VersionSection[] = [];
      for (const release of releases) {
        if (!isPlainObject(release) || release.draft === true || typeof release.tag_name !== 'string') continue;
        const version = parseTagVersion(release.tag_name, request.packageName);
        if (version === undefined) continue;
        const body = typeof release.body === 'string' ? release.body : '';
        sections.push({ version, heading: release.tag_name, body });
      }
      const matching = sectionsBetween(sections, request.from, request.to);
      if (matching.length > 0) return { ok: true, source: 'releases', sections: matching };
      if (releases.length < 100) break;
    }

    if (blocking?.code === 'RATE_LIMITED') {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        message: 'GitHub rate limit reached. Set GITHUB_TOKEN to raise the limit.',
      };
    }
    if (foundFile) {
      return { ok: false, code: 'NO_MATCHING_VERSIONS', message: 'The changelog has no entries between these versions.' };
    }
    if (blocking) return { ok: false, code: blocking.code, message: blocking.message };
    return { ok: false, code: 'NOT_FOUND', message: 'No changelog file or GitHub releases were found.' };
  }

  return { fetchChangelog };
}
