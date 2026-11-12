import ts from 'typescript';
import { isPlainObject } from './util.ts';

export function readTsconfigAliasKeys(text: string): string[] {
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text);
  if (parsed.error || !isPlainObject(parsed.config)) return [];
  const options = parsed.config.compilerOptions;
  if (!isPlainObject(options) || !isPlainObject(options.paths)) return [];
  return Object.keys(options.paths);
}

export function createAliasMatcher(keys: readonly string[]): (specifier: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1) exact.add(key);
    else if (star > 0) prefixes.push(key.slice(0, star));
  }
  return (specifier) => exact.has(specifier) || prefixes.some((prefix) => specifier.startsWith(prefix));
}
