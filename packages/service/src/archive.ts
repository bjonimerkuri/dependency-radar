import { getBytes, IGNORED_DIRECTORIES } from '@dependency-radar/core';
import type { SourceFile } from '@dependency-radar/core';
import { readZip } from './zip.ts';
import type { ZipFile } from './zip.ts';

export interface GithubTarget {
  owner: string;
  repo: string;
  ref?: string;
  path?: string;
}

export type ArchiveResult =
  | { ok: true; files: ZipFile[]; names: string[]; truncated: boolean }
  | { ok: false; message: string };

export interface ExtractedProject {
  packageJson: string;
  lockfile?: string;
  tsconfig?: string;
  sources: SourceFile[];
  rootDir: string;
  warnings: string[];
}

export type ExtractResult = { ok: true; project: ExtractedProject } | { ok: false; message: string };

const NAME_PART = /^[A-Za-z0-9_.-]+$/;
const OWNER_PART = /^[A-Za-z0-9-]+$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const CONFIG_FILE = /(?:^|\/)(?:package\.json|package-lock\.json|tsconfig\.json)$/;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_LOCKFILE_BYTES = 6_000_000;
const OTHER_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];

function decodePath(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    const parts = decoded.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.some((part) => part === '..' || part.includes('\0'))) return undefined;
    return parts.join('/');
  } catch {
    return undefined;
  }
}

export function parseGithubUrl(input: string): GithubTarget | undefined {
  const text = input.trim();
  if (text === '' || text.length > 300) return undefined;

  const shorthand = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
  const withHost = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)(?:\/tree\/([^/\s#?]+)(?:\/([^\s#?]+))?)?\/?(?:[#?].*)?$/i.exec(text);
  const match = withHost ?? shorthand;
  if (!match) return undefined;

  const owner = match[1] as string;
  const repo = (match[2] as string).replace(/\.git$/i, '');
  if (!OWNER_PART.test(owner) || !NAME_PART.test(repo) || repo === '.' || repo === '..') return undefined;

  const target: GithubTarget = { owner, repo };
  const ref = withHost?.[3];
  if (ref !== undefined) {
    const decoded = decodePath(ref);
    if (decoded === undefined || !NAME_PART.test(decoded)) return undefined;
    target.ref = decoded;
  }
  const path = withHost?.[4];
  if (path !== undefined) {
    const decoded = decodePath(path);
    if (decoded === undefined) return undefined;
    if (decoded !== '') target.path = decoded;
  }
  return target;
}

export type ArchivePurpose = 'analyze' | 'check';

const CHECK_TEXT = /\.(?:[cm]?[jt]sx?|json|sh|bash|ps1|bat|cmd|ya?ml)$/i;
const CHECK_DOTFILES = /(?:^|\/)(?:\.npmrc|\.yarnrc\.yml)$/;
const MAX_CHECK_TEXT_BYTES = 400_000;

export async function downloadGithubArchive(
  target: GithubTarget,
  fetchImpl: typeof fetch,
  purpose: ArchivePurpose = 'analyze',
): Promise<ArchiveResult> {
  const ref = encodeURIComponent(target.ref ?? 'HEAD');
  const url = `https://codeload.github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/zip/${ref}`;
  const downloaded = await getBytes(url, { fetch: fetchImpl, allowedHosts: ['codeload.github.com'], maxBytes: 25_000_000 });
  if (!downloaded.ok) {
    switch (downloaded.code) {
      case 'NOT_FOUND':
        return { ok: false, message: 'The repository was not found, or it is private. Only public repositories are supported.' };
      case 'RATE_LIMITED':
        return { ok: false, message: 'GitHub is limiting requests right now. Try again later.' };
      case 'TOO_LARGE':
        return { ok: false, message: 'The repository is too large to analyze (the download limit is about 25 MB).' };
      default:
        return { ok: false, message: 'GitHub could not be reached.' };
    }
  }

  const zip = readZip(downloaded.bytes, {
    maxFileBytes: MAX_LOCKFILE_BYTES,
    include: (path, size) => {
      if (path.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment))) return false;
      if (/(?:^|\/)package-lock\.json$/.test(path)) return size <= MAX_LOCKFILE_BYTES;
      if (purpose === 'check') return size <= MAX_CHECK_TEXT_BYTES && (CHECK_TEXT.test(path) || CHECK_DOTFILES.test(path));
      return size <= MAX_SOURCE_BYTES && (CONFIG_FILE.test(path) || SOURCE_FILE.test(path));
    },
  });
  if (!zip.ok) return { ok: false, message: 'The repository archive could not be read.' };
  return { ok: true, files: zip.files, names: zip.names, truncated: zip.truncated };
}

function commonRoot(paths: readonly string[]): string {
  const first = paths[0]?.split('/')[0];
  if (first === undefined || !paths.every((path) => path.startsWith(`${first}/`))) return '';
  return `${first}/`;
}

export function extractProject(files: readonly ZipFile[], names: readonly string[], path?: string): ExtractResult {
  const root = commonRoot(names.length > 0 ? names : files.map((file) => file.path));
  const relative = (full: string): string => full.slice(root.length);

  const base = path === undefined ? '' : (decodePath(path) ?? undefined);
  if (base === undefined) return { ok: false, message: 'The folder path is not valid.' };
  const prefix = base === '' ? '' : `${base}/`;

  const byPath = new Map(files.map((file) => [relative(file.path), file.content]));
  const packageJson = byPath.get(`${prefix}package.json`);

  if (packageJson === undefined) {
    const folders = [
      ...new Set(
        names
          .map(relative)
          .filter((name) => /(?:^|\/)package\.json$/.test(name))
          .filter((name) => !name.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment)))
          .map((name) => name.slice(0, Math.max(0, name.length - '/package.json'.length)))
          .filter((folder) => folder.split('/').length <= 3),
      ),
    ].slice(0, 5);
    const where = base === '' ? 'in the repository root' : `in ${base}`;
    const hint = folders.length > 0 ? ` Try one of these folders: ${folders.map((folder) => folder || '(root)').join(', ')}.` : '';
    return { ok: false, message: `No package.json was found ${where}.${hint}` };
  }

  const project: ExtractedProject = { packageJson, sources: [], rootDir: base, warnings: [] };
  const lockfile = byPath.get(`${prefix}package-lock.json`);
  if (lockfile !== undefined) project.lockfile = lockfile;
  const tsconfig = byPath.get(`${prefix}tsconfig.json`);
  if (tsconfig !== undefined) project.tsconfig = tsconfig;

  for (const [name, content] of byPath) {
    if (!name.startsWith(prefix)) continue;
    const inner = name.slice(prefix.length);
    if (CONFIG_FILE.test(inner) || !SOURCE_FILE.test(inner)) continue;
    project.sources.push({ path: inner, content });
  }

  if (lockfile === undefined) {
    const other = OTHER_LOCKFILES.find((lock) => names.map(relative).includes(`${prefix}${lock}`));
    if (other) project.warnings.push(`This project uses ${other}, which is not supported yet, so versions come from the ranges in package.json.`);
  }
  return { ok: true, project };
}

export function stripArchiveRoot(
  files: readonly ZipFile[],
  names: readonly string[],
  path?: string,
): { files: SourceFile[]; names: string[] } | undefined {
  const root = commonRoot(names.length > 0 ? names : files.map((file) => file.path));
  const base = path === undefined ? '' : decodePath(path);
  if (base === undefined) return undefined;
  const prefix = base === '' ? '' : `${base}/`;
  const keep = (full: string): string | undefined => {
    const relative = full.slice(root.length);
    return relative.startsWith(prefix) ? relative.slice(prefix.length) : undefined;
  };
  return {
    files: files.flatMap((file) => {
      const relative = keep(file.path);
      return relative === undefined || relative === '' ? [] : [{ path: relative, content: file.content }];
    }),
    names: names.flatMap((name) => {
      const relative = keep(name);
      return relative === undefined || relative === '' ? [] : [relative];
    }),
  };
}
