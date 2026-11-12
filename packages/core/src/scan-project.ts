import { scanSourceFile } from './scan-file.ts';
import type { ImportRecord } from './scan-file.ts';
import { createAliasMatcher } from './tsconfig-aliases.ts';

export interface SourceFile {
  path: string;
  content: string;
}

export type SkipReason =
  | 'ignored-directory'
  | 'declaration-file'
  | 'unsupported-language'
  | 'too-large'
  | 'minified'
  | 'limit'
  | 'parse-error';

export interface SkippedFile {
  path: string;
  reason: SkipReason;
}

export interface ScanOptions {
  maxFiles?: number;
  maxTotalChars?: number;
  maxFileChars?: number;
  aliasKeys?: readonly string[];
  knownPackages?: Iterable<string>;
}

export interface ScanResult {
  imports: ImportRecord[];
  scannedFiles: number;
  scannedChars: number;
  skipped: SkippedFile[];
  skippedCounts: Partial<Record<SkipReason, number>>;
}

export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  'vendor',
]);

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']);
const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(['vue', 'svelte', 'astro']);
const MAX_LISTED_SKIPS = 200;

function extensionOf(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? (match[1] as string).toLowerCase() : '';
}

function looksMinified(path: string, content: string): boolean {
  if (/\.min\.[cm]?js$/i.test(path)) return true;
  if (content.length < 20_000) return false;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++;
  }
  return content.length / lines > 300;
}

export function scanProject(files: readonly SourceFile[], options: ScanOptions = {}): ScanResult {
  const maxFiles = options.maxFiles ?? 500;
  const maxTotalChars = options.maxTotalChars ?? 2_000_000;
  const maxFileChars = options.maxFileChars ?? 300_000;
  const context = {
    isAlias: createAliasMatcher(options.aliasKeys ?? []),
    knownPackages: new Set(options.knownPackages ?? []),
  };

  const result: ScanResult = { imports: [], scannedFiles: 0, scannedChars: 0, skipped: [], skippedCounts: {} };

  function skip(path: string, reason: SkipReason): void {
    result.skippedCounts[reason] = (result.skippedCounts[reason] ?? 0) + 1;
    if (reason !== 'ignored-directory' && result.skipped.length < MAX_LISTED_SKIPS) {
      result.skipped.push({ path, reason });
    }
  }

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const path = file.path.replace(/\\/g, '/');
    if (path.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment))) {
      skip(path, 'ignored-directory');
      continue;
    }
    const extension = extensionOf(path);
    if (UNSUPPORTED_EXTENSIONS.has(extension)) {
      skip(path, 'unsupported-language');
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    if (/\.d\.[cm]?ts$/i.test(path)) {
      skip(path, 'declaration-file');
      continue;
    }
    if (file.content.length > maxFileChars) {
      skip(path, 'too-large');
      continue;
    }
    if (looksMinified(path, file.content)) {
      skip(path, 'minified');
      continue;
    }
    if (result.scannedFiles >= maxFiles || result.scannedChars + file.content.length > maxTotalChars) {
      skip(path, 'limit');
      continue;
    }

    const scan = scanSourceFile(path, file.content, context);
    if (scan.error !== undefined) {
      skip(path, 'parse-error');
      continue;
    }
    result.scannedFiles++;
    result.scannedChars += file.content.length;
    result.imports.push(...scan.imports);
  }

  return result;
}
