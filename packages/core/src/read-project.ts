import { findJsonSyntaxError } from './json-syntax.ts';
import type { JsonSyntaxIssue } from './json-syntax.ts';
import { parseLockfile } from './lockfile.ts';
import { dependencyKey, locateDependencyKeys } from './locate.ts';
import { parseSpecifier } from './specifier.ts';
import { DEPENDENCY_SECTIONS } from './types.ts';
import type {
  DependencyEntry,
  ErrorCode,
  ParsedPackage,
  Position,
  ReadProjectInput,
  ReadProjectOptions,
  ReadProjectResult,
  Warning,
} from './types.ts';
import {
  UNSAFE_NAMES,
  byteLength,
  createPositionResolver,
  isPlainObject,
  isValidPackageName,
  stringRecord,
  stripBom,
} from './util.ts';

export const DEFAULT_MAX_PACKAGE_JSON_BYTES = 200_000;
export const DEFAULT_MAX_LOCKFILE_BYTES = 5_000_000;

function failure(code: ErrorCode, message: string, position?: Position): ReadProjectResult {
  return { ok: false, error: position ? { code, message, position } : { code, message } };
}

function invalidJson(text: string, error: unknown): ReadProjectResult {
  const engineMessage = error instanceof Error ? error.message : 'Unknown error';
  let issue: JsonSyntaxIssue | undefined;
  try {
    issue = findJsonSyntaxError(text);
  } catch {
    issue = undefined;
  }
  if (!issue) return failure('INVALID_JSON', `Invalid JSON: ${engineMessage}`);
  const position = createPositionResolver(text)(issue.index);
  return failure(
    'INVALID_JSON',
    `Invalid JSON at line ${position.line}, column ${position.column}: ${issue.message}`,
    position,
  );
}

function readWorkspaces(value: unknown): string[] {
  const list: unknown[] = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.packages)
      ? value.packages
      : [];
  return list.filter((item): item is string => typeof item === 'string');
}

function safeLocate(text: string): ReturnType<typeof locateDependencyKeys> {
  try {
    return locateDependencyKeys(text, DEPENDENCY_SECTIONS);
  } catch {
    return new Map();
  }
}

function collectEntries(data: Record<string, unknown>, text: string, warnings: Warning[]): DependencyEntry[] {
  const positions = safeLocate(text);
  const entries: DependencyEntry[] = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const block = data[section];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      warnings.push({
        code: 'INVALID_SECTION',
        section,
        message: `"${section}" must be an object and was ignored.`,
      });
      continue;
    }
    for (const [name, spec] of Object.entries(block)) {
      if (UNSAFE_NAMES.has(name)) {
        warnings.push({ code: 'UNSAFE_NAME', name, section, message: `"${name}" is not a safe package name and was skipped.` });
        continue;
      }
      if (!isValidPackageName(name)) {
        warnings.push({ code: 'INVALID_NAME', name, section, message: `"${name}" is not a valid package name and was skipped.` });
        continue;
      }
      if (typeof spec !== 'string') {
        warnings.push({ code: 'INVALID_SPEC', name, section, message: `The version of "${name}" must be a string and was skipped.` });
        continue;
      }
      const parsed = parseSpecifier(spec);
      const entry: DependencyEntry = {
        name,
        section,
        spec,
        kind: parsed.kind,
        analyzable: parsed.analyzable,
      };
      if (parsed.reason !== undefined) entry.reason = parsed.reason;
      if (parsed.aliasOf !== undefined) entry.aliasOf = parsed.aliasOf;
      if (parsed.aliasRange !== undefined) entry.aliasRange = parsed.aliasRange;
      const position = positions.get(dependencyKey(section, name));
      if (position) entry.position = position;
      entries.push(entry);
    }
  }
  return entries;
}

function findConflicts(entries: readonly DependencyEntry[]): Warning[] {
  const production = new Map<string, string>();
  for (const entry of entries) {
    if (entry.section === 'dependencies') production.set(entry.name, entry.spec);
  }
  const warnings: Warning[] = [];
  for (const entry of entries) {
    if (entry.section !== 'devDependencies') continue;
    const other = production.get(entry.name);
    if (other !== undefined && other !== entry.spec) {
      warnings.push({
        code: 'CONFLICTING_SPEC',
        name: entry.name,
        message: `"${entry.name}" is in dependencies as "${other}" and in devDependencies as "${entry.spec}".`,
      });
    }
  }
  return warnings;
}

function applyLockfile(
  entries: DependencyEntry[],
  lockfile: string | undefined,
  maxBytes: number,
  warnings: Warning[],
): void {
  if (lockfile === undefined || lockfile.trim() === '') {
    warnings.push({
      code: 'NO_LOCKFILE',
      message: 'No lockfile provided. Installed versions are unknown, so version ranges are used instead of exact versions.',
    });
    return;
  }
  if (byteLength(lockfile) > maxBytes) {
    warnings.push({ code: 'LOCKFILE_TOO_LARGE', message: `The lockfile is larger than ${maxBytes} bytes and was not read.` });
    return;
  }
  const result = parseLockfile(lockfile);
  if (!result.ok) {
    warnings.push({
      code: result.code === 'UNSUPPORTED' ? 'LOCKFILE_UNSUPPORTED' : 'LOCKFILE_INVALID',
      message: result.message,
    });
    return;
  }
  for (const entry of entries) {
    const installed = result.value.installed.get(entry.name);
    if (installed !== undefined) entry.installed = installed;
  }
}

export function readProject(input: ReadProjectInput, options: ReadProjectOptions = {}): ReadProjectResult {
  const maxBytes = options.maxPackageJsonBytes ?? DEFAULT_MAX_PACKAGE_JSON_BYTES;
  const text = stripBom(input.packageJson);

  if (text.trim() === '') return failure('EMPTY', 'package.json is empty.');
  if (byteLength(text) > maxBytes) {
    return failure('TOO_LARGE', `package.json is larger than ${maxBytes} bytes.`);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return invalidJson(text, error);
  }
  if (!isPlainObject(data)) {
    return failure('NOT_AN_OBJECT', 'package.json must contain a JSON object at the top level.');
  }

  const warnings: Warning[] = [];
  const entries = collectEntries(data, text, warnings);
  const workspaces = readWorkspaces(data.workspaces);

  if (entries.length === 0) {
    warnings.push({ code: 'NO_DEPENDENCIES', message: 'No dependencies were found.' });
  }
  if (workspaces.length > 0) {
    warnings.push({
      code: 'MONOREPO',
      message: 'Workspaces detected. Only this package.json is analyzed, not the workspace packages.',
    });
  }
  warnings.push(...findConflicts(entries));
  applyLockfile(entries, input.lockfile, options.maxLockfileBytes ?? DEFAULT_MAX_LOCKFILE_BYTES, warnings);

  const value: ParsedPackage = {
    private: data.private === true,
    engines: stringRecord(data.engines),
    scripts: stringRecord(data.scripts),
    workspaces,
    entries,
  };
  if (typeof data.name === 'string') value.name = data.name;
  if (typeof data.version === 'string') value.version = data.version;
  if (typeof data.packageManager === 'string') value.packageManager = data.packageManager;

  return { ok: true, value, warnings };
}
