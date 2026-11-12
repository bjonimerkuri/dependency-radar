import { isPlainObject } from './util.ts';

export type RepositoryRef =
  | { kind: 'github'; owner: string; repo: string; directory?: string }
  | { kind: 'other' }
  | { kind: 'none' };

const GITHUB_URL = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i;
const GITHUB_SCP = /^[^@\s]+@github\.com:([^/\s]+)\/([^/\s#?]+)/i;
const GITHUB_PREFIX = /^github:([^/\s]+)\/([^/\s#?]+)/i;
const SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#.*)?$/;
const PART = /^[A-Za-z0-9_.-]+$/;

function fromString(value: string): RepositoryRef {
  const text = value.trim();
  if (text === '') return { kind: 'none' };
  const match = GITHUB_URL.exec(text) ?? GITHUB_SCP.exec(text) ?? GITHUB_PREFIX.exec(text) ?? SHORTHAND.exec(text);
  if (!match) return { kind: 'other' };
  const owner = match[1] as string;
  const repo = (match[2] as string).replace(/\.git$/i, '');
  if (!PART.test(owner) || !PART.test(repo) || repo === '') return { kind: 'other' };
  return { kind: 'github', owner, repo };
}

function cleanDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined;
  return parts.join('/');
}

export function parseRepositoryField(repository: unknown, homepage?: unknown): RepositoryRef {
  let ref: RepositoryRef = { kind: 'none' };
  if (typeof repository === 'string') {
    ref = fromString(repository);
  } else if (isPlainObject(repository) && typeof repository.url === 'string') {
    ref = fromString(repository.url);
    const directory = cleanDirectory(repository.directory);
    if (ref.kind === 'github' && directory !== undefined) ref = { ...ref, directory };
  }
  if (ref.kind === 'none' && typeof homepage === 'string' && /github\.com/i.test(homepage)) {
    ref = fromString(homepage);
  }
  return ref;
}
