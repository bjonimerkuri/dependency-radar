import { isValidPackageName } from './util.ts';

const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'test',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

export interface ModuleReference {
  packageName: string;
  subpath?: string;
}

export interface SpecifierContext {
  isAlias: (specifier: string) => boolean;
  knownPackages: ReadonlySet<string>;
}

export function resolvePackageReference(specifier: string, context: SpecifierContext): ModuleReference | undefined {
  const spec = specifier.trim();
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#') || spec.includes(':')) {
    return undefined;
  }

  const parts = spec.split('/');
  const scoped = spec.startsWith('@');
  const name = scoped ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
  if (name === undefined || !isValidPackageName(name)) return undefined;

  const rest = parts.slice(scoped ? 2 : 1).join('/');
  const reference: ModuleReference = rest === '' ? { packageName: name } : { packageName: name, subpath: rest };

  if (context.knownPackages.has(name)) return reference;
  if (context.isAlias(spec)) return undefined;
  if (NODE_BUILTINS.has(name)) return undefined;
  return reference;
}
