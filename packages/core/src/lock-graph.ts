import { isPlainObject, stringRecord } from './util.ts';

export interface LockNode {
  path: string;
  name: string;
  version: string;
  dev: boolean;
  optional: boolean;
  dependencies: Record<string, string>;
}

export interface Dependent {
  from: string;
  range: string;
}

export interface LockGraph {
  lockfileVersion: number;
  nodes: ReadonlyMap<string, LockNode>;
  byName(name: string): LockNode[];
  dependents(path: string): Dependent[];
  chains(path: string, max?: number): string[][];
  label(path: string): string;
}

const MAX_NODES = 60_000;
const NODE_MODULES = 'node_modules/';

function nameFromPath(path: string, declared: unknown): string {
  if (typeof declared === 'string' && declared !== '' && !path.includes(NODE_MODULES)) return declared;
  const index = path.lastIndexOf(NODE_MODULES);
  return index === -1 ? path : path.slice(index + NODE_MODULES.length);
}

function mergeDeps(info: Record<string, unknown>, includeDev: boolean): Record<string, string> {
  const merged: Record<string, string> = {
    ...stringRecord(info.peerDependencies),
    ...stringRecord(info.optionalDependencies),
    ...stringRecord(info.dependencies),
  };
  if (includeDev) Object.assign(merged, stringRecord(info.devDependencies));
  return merged;
}

export function buildLockGraph(text: string, rootDependencies: Readonly<Record<string, string>> = {}): LockGraph | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(data)) return undefined;

  const nodes = new Map<string, LockNode>();
  const lockfileVersion = typeof data.lockfileVersion === 'number' ? data.lockfileVersion : 1;

  if (isPlainObject(data.packages)) {
    for (const [path, info] of Object.entries(data.packages)) {
      if (nodes.size >= MAX_NODES) break;
      if (!isPlainObject(info) || info.link === true) continue;
      if (path === '') {
        nodes.set('', { path: '', name: '', version: typeof info.version === 'string' ? info.version : '0.0.0', dev: false, optional: false, dependencies: mergeDeps(info, true) });
        continue;
      }
      if (typeof info.version !== 'string') continue;
      nodes.set(path, {
        path,
        name: nameFromPath(path, info.name),
        version: info.version,
        dev: info.dev === true,
        optional: info.optional === true,
        dependencies: mergeDeps(info, false),
      });
    }
  } else if (isPlainObject(data.dependencies)) {
    const walk = (dependencies: Record<string, unknown>, prefix: string): void => {
      for (const [name, info] of Object.entries(dependencies)) {
        if (nodes.size >= MAX_NODES) return;
        if (!isPlainObject(info) || typeof info.version !== 'string') continue;
        const path = `${prefix}${NODE_MODULES}${name}`;
        nodes.set(path, { path, name, version: info.version, dev: info.dev === true, optional: info.optional === true, dependencies: stringRecord(info.requires) });
        if (isPlainObject(info.dependencies)) walk(info.dependencies, `${path}/`);
      }
    };
    walk(data.dependencies, '');
    nodes.set('', { path: '', name: '', version: '0.0.0', dev: false, optional: false, dependencies: { ...rootDependencies } });
  } else {
    return undefined;
  }
  if (!nodes.has('')) nodes.set('', { path: '', name: '', version: '0.0.0', dev: false, optional: false, dependencies: { ...rootDependencies } });

  function resolve(from: string, name: string): string | undefined {
    let base = from;
    for (;;) {
      const candidate = base === '' ? `${NODE_MODULES}${name}` : `${base}/${NODE_MODULES}${name}`;
      if (nodes.has(candidate)) return candidate;
      if (base === '') return undefined;
      const index = base.lastIndexOf(`/${NODE_MODULES}`);
      base = index === -1 ? '' : base.slice(0, index);
    }
  }

  const reverse = new Map<string, Dependent[]>();
  const forward = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const [dependency, range] of Object.entries(node.dependencies)) {
      const target = resolve(node.path, dependency);
      if (target === undefined || target === node.path) continue;
      const list = reverse.get(target) ?? [];
      list.push({ from: node.path, range });
      reverse.set(target, list);
      const next = forward.get(node.path) ?? [];
      if (!next.includes(target)) next.push(target);
      forward.set(node.path, next);
    }
  }

  const byName = new Map<string, LockNode[]>();
  for (const node of nodes.values()) {
    if (node.path === '') continue;
    const list = byName.get(node.name) ?? [];
    list.push(node);
    byName.set(node.name, list);
  }

  function label(path: string): string {
    const node = nodes.get(path);
    return path === '' || !node ? 'project' : `${node.name}@${node.version}`;
  }

  function chains(path: string, max = 3): string[][] {
    if (!nodes.has(path)) return [];
    const distance = new Map<string, number>([['', 0]]);
    const queue = [''];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head] as string;
      for (const next of forward.get(current) ?? []) {
        if (!distance.has(next)) {
          distance.set(next, (distance.get(current) as number) + 1);
          queue.push(next);
        }
      }
    }
    if (!distance.has(path)) return [];

    const found: string[][] = [];
    const walk = (current: string, trail: string[]): void => {
      if (found.length >= max) return;
      if (current === '') {
        found.push([...trail].reverse().map(label));
        return;
      }
      const here = distance.get(current) as number;
      for (const parent of reverse.get(current) ?? []) {
        if (distance.get(parent.from) === here - 1) walk(parent.from, [...trail, parent.from]);
      }
    };
    walk(path, [path]);
    return found;
  }

  return {
    lockfileVersion,
    nodes,
    byName: (name) => byName.get(name) ?? [],
    dependents: (path) => reverse.get(path) ?? [],
    chains,
    label,
  };
}
