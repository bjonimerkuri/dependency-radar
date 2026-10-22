import type { Position } from './types.ts';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function createPositionResolver(text: string): (index: number) => Position {
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((lineStarts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: index - (lineStarts[low] ?? 0) + 1 };
  };
}

export const UNSAFE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const MAX_PACKAGE_NAME_LENGTH = 214;
const VALID_PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;

export function isValidPackageName(name: string): boolean {
  return name.length <= MAX_PACKAGE_NAME_LENGTH && VALID_PACKAGE_NAME.test(name);
}

export function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isPlainObject(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_NAMES.has(key) || typeof item !== 'string') continue;
    result[key] = item;
  }
  return result;
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index] as T);
    }
  });
  await Promise.all(workers);
}
