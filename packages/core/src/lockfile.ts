import { isPlainObject, stripBom } from './util.ts';

export interface LockfileIndex {
  lockfileVersion: number;
  installed: Map<string, string>;
}

export type LockfileResult =
  | { ok: true; value: LockfileIndex }
  | { ok: false; code: 'UNSUPPORTED' | 'INVALID'; message: string };

const NODE_MODULES = 'node_modules/';

export function parseLockfile(raw: string): LockfileResult {
  const text = stripBom(raw).trim();
  if (!text.startsWith('{')) {
    return {
      ok: false,
      code: 'UNSUPPORTED',
      message: 'Only package-lock.json is read for now. pnpm-lock.yaml and yarn.lock are not supported yet.',
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, code: 'INVALID', message: 'The lockfile is not valid JSON.' };
  }
  if (!isPlainObject(data) || (!isPlainObject(data.packages) && !isPlainObject(data.dependencies))) {
    return { ok: false, code: 'INVALID', message: 'The file is not a recognized package-lock.json.' };
  }

  const installed = new Map<string, string>();

  if (isPlainObject(data.packages)) {
    for (const [path, info] of Object.entries(data.packages)) {
      if (!path.startsWith(NODE_MODULES)) continue;
      const name = path.slice(NODE_MODULES.length);
      if (name.includes(NODE_MODULES)) continue;
      if (isPlainObject(info) && info.link !== true && typeof info.version === 'string') {
        installed.set(name, info.version);
      }
    }
  } else if (isPlainObject(data.dependencies)) {
    for (const [name, info] of Object.entries(data.dependencies)) {
      if (isPlainObject(info) && typeof info.version === 'string') installed.set(name, info.version);
    }
  }

  const lockfileVersion = typeof data.lockfileVersion === 'number' ? data.lockfileVersion : 1;
  return { ok: true, value: { lockfileVersion, installed } };
}
