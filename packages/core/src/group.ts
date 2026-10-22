import type { DependencyEntry, DependencyGroup } from './types.ts';

export function groupByName(entries: readonly DependencyEntry[]): DependencyGroup[] {
  const groups = new Map<string, DependencyEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.name);
    if (list) list.push(entry);
    else groups.set(entry.name, [entry]);
  }
  return Array.from(groups, ([name, list]) => ({ name, entries: list }));
}
