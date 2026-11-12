import type { UpdateAnalysis } from './analyze.ts';
import { computeImpact } from './usage.ts';
import type { PackageImpact, PackageUsage } from './usage.ts';

export function attachImpact(
  results: readonly UpdateAnalysis[],
  index: ReadonlyMap<string, PackageUsage>,
  scripts: Readonly<Record<string, string>>,
): void {
  for (const result of results) {
    if (result.status === 'analyzed') result.impact = computeImpact(result.name, index, scripts);
  }
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function listed(values: readonly string[], limit: number): string {
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown} (+${values.length - limit} more)` : shown;
}

export function describeImpact(impact: PackageImpact): string {
  switch (impact.level) {
    case 'used': {
      const names = [...impact.symbols.filter((name) => name !== 'default' && name !== '*'), ...impact.members];
      const files = `Used in ${plural(impact.fileCount, 'file')}: ${listed(impact.files, 3)}`;
      return names.length > 0 ? `${files}. Uses: ${listed([...new Set(names)], 6)}` : files;
    }
    case 'type-only':
      return `Only imported as types in ${plural(impact.fileCount, 'file')}: ${listed(impact.files, 3)}`;
    case 'unused':
      return `Imported in ${plural(impact.fileCount, 'file')}, but the imported names appear unused: ${listed(impact.files, 3)}`;
    case 'scripts-only':
      return 'Not imported in code, but used in package.json scripts';
    default:
      return 'Not imported in any scanned file (it may still be used by tooling or config files)';
  }
}
