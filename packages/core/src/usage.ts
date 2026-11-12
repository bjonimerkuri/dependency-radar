import type { ImportRecord } from './scan-file.ts';

export interface PackageUsage {
  packageName: string;
  files: string[];
  importCount: number;
  symbols: string[];
  members: string[];
  subpaths: string[];
  typeOnly: boolean;
  unusedOnly: boolean;
  dynamic: boolean;
}

export type ImpactLevel = 'used' | 'type-only' | 'unused' | 'scripts-only' | 'not-found';

export interface PackageImpact {
  level: ImpactLevel;
  fileCount: number;
  files: string[];
  symbols: string[];
  members: string[];
  inScripts: boolean;
  dynamic: boolean;
}

const MAX_LISTED = 200;
const MAX_FILES_IN_IMPACT = 20;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].slice(0, MAX_LISTED);
}

export function buildUsageIndex(imports: readonly ImportRecord[]): Map<string, PackageUsage> {
  const grouped = new Map<string, ImportRecord[]>();
  for (const record of imports) {
    const list = grouped.get(record.packageName);
    if (list) list.push(record);
    else grouped.set(record.packageName, [record]);
  }

  const index = new Map<string, PackageUsage>();
  for (const [packageName, records] of grouped) {
    index.set(packageName, {
      packageName,
      files: [...new Set(records.map((record) => record.filePath))].sort(),
      importCount: records.length,
      symbols: unique(records.flatMap((record) => record.symbols.map((entry) => entry.imported))),
      members: unique(records.flatMap((record) => record.members)),
      subpaths: unique(records.flatMap((record) => (record.subpath === undefined ? [] : [record.subpath]))),
      typeOnly: records.every((record) => record.typeOnly),
      unusedOnly: records.every((record) => record.appearsUnused),
      dynamic: records.some((record) => record.kind === 'dynamic'),
    });
  }
  return index;
}

function typesTarget(name: string): string | undefined {
  if (!name.startsWith('@types/')) return undefined;
  const rest = name.slice('@types/'.length);
  return rest.includes('__') ? `@${rest.replace('__', '/')}` : rest;
}

export function isInScripts(name: string, scripts: Readonly<Record<string, string>>): boolean {
  for (const command of Object.values(scripts)) {
    for (const token of command.split(/[\s;&|()<>"'`=]+/)) {
      if (token === name || token.endsWith(`/${name}`)) return true;
    }
  }
  return false;
}

export function computeImpact(
  name: string,
  index: ReadonlyMap<string, PackageUsage>,
  scripts: Readonly<Record<string, string>>,
): PackageImpact {
  const usage = index.get(typesTarget(name) ?? name);
  const inScripts = isInScripts(name, scripts);
  if (!usage) {
    return {
      level: inScripts ? 'scripts-only' : 'not-found',
      fileCount: 0,
      files: [],
      symbols: [],
      members: [],
      inScripts,
      dynamic: false,
    };
  }
  return {
    level: usage.typeOnly ? 'type-only' : usage.unusedOnly ? 'unused' : 'used',
    fileCount: usage.files.length,
    files: usage.files.slice(0, MAX_FILES_IN_IMPACT),
    symbols: usage.symbols,
    members: usage.members,
    inScripts,
    dynamic: usage.dynamic,
  };
}
