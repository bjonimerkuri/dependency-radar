import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { IGNORED_DIRECTORIES } from '@dependency-radar/core';
import type { SourceFile } from '@dependency-radar/core';

export interface CollectedFiles {
  files: SourceFile[];
  truncated: boolean;
}

const MAX_ENTRIES = 20_000;
const MAX_READ_BYTES = 1_000_000;
const READABLE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;

export function collectSourceFiles(root: string): CollectedFiles {
  const files: SourceFile[] = [];
  const pending: string[] = [root];
  let visited = 0;

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (visited > MAX_ENTRIES) return { files, truncated: true };
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !READABLE.test(entry.name)) continue;
      try {
        if (statSync(fullPath).size > MAX_READ_BYTES) continue;
        files.push({
          path: relative(root, fullPath).split(sep).join('/'),
          content: readFileSync(fullPath, 'utf8'),
        });
      } catch {
        continue;
      }
    }
  }
  return { files, truncated: false };
}

const REPO_TEXT = /\.(?:[cm]?[jt]sx?|json|sh|bash|ps1|bat|cmd|ya?ml)$/i;
const REPO_DOTFILES = new Set(['.npmrc', '.yarnrc.yml']);
const MAX_REPO_TEXT_BYTES = 400_000;
const MAX_LOCKFILE_BYTES = 6_000_000;
const MAX_REPO_ENTRIES = 30_000;
const SKIP_COMPLETELY = new Set(['.git']);

export interface CollectedRepo {
  files: SourceFile[];
  names: string[];
  truncated: boolean;
}

export function collectRepoFiles(root: string): CollectedRepo {
  const files: SourceFile[] = [];
  const names: string[] = [];
  const pending: string[] = [root];
  let visited = 0;

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (visited > MAX_REPO_ENTRIES) return { files, names, truncated: true };
      const fullPath = join(directory, entry.name);
      const relativePath = relative(root, fullPath).split(sep).join('/');
      if (entry.isDirectory()) {
        if (SKIP_COMPLETELY.has(entry.name)) continue;
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      names.push(relativePath);
      const wanted = REPO_TEXT.test(entry.name) || REPO_DOTFILES.has(entry.name);
      if (!wanted) continue;
      try {
        const limit = entry.name === 'package-lock.json' ? MAX_LOCKFILE_BYTES : MAX_REPO_TEXT_BYTES;
        if (statSync(fullPath).size > limit) continue;
        files.push({ path: relativePath, content: readFileSync(fullPath, 'utf8') });
      } catch {
        continue;
      }
    }
  }
  return { files, names, truncated: false };
}
