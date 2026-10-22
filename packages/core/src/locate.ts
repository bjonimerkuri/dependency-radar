import type { Position } from './types.ts';
import { createPositionResolver } from './util.ts';

export function dependencyKey(section: string, name: string): string {
  return `${section}\u0000${name}`;
}

export function locateDependencyKeys(text: string, sections: readonly string[]): Map<string, Position> {
  const resolve = createPositionResolver(text);
  const found = new Map<string, Position>();
  let i = 0;

  function skipWhitespace(): void {
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 9 || code === 10 || code === 13) i++;
      else break;
    }
  }

  function readString(): string {
    const start = i;
    i++;
    while (i < text.length && text.charCodeAt(i) !== 34) {
      i += text.charCodeAt(i) === 92 ? 2 : 1;
    }
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  }

  function readLiteral(): void {
    while (i < text.length && !',}] \t\r\n'.includes(text.charAt(i))) i++;
  }

  function readValue(path: readonly string[]): void {
    skipWhitespace();
    const char = text.charAt(i);
    if (char === '{') readObject(path);
    else if (char === '[') readArray(path);
    else if (char === '"') readString();
    else readLiteral();
  }

  function readObject(path: readonly string[]): void {
    i++;
    skipWhitespace();
    if (text.charAt(i) === '}') {
      i++;
      return;
    }
    while (i < text.length) {
      skipWhitespace();
      const keyStart = i;
      const key = readString();
      skipWhitespace();
      i++;
      const section = path[0];
      if (path.length === 1 && section !== undefined && sections.includes(section)) {
        found.set(dependencyKey(section, key), resolve(keyStart));
      }
      readValue([...path, key]);
      skipWhitespace();
      if (text.charAt(i) === ',') {
        i++;
        continue;
      }
      i++;
      return;
    }
  }

  function readArray(path: readonly string[]): void {
    i++;
    skipWhitespace();
    if (text.charAt(i) === ']') {
      i++;
      return;
    }
    while (i < text.length) {
      readValue([...path, '#']);
      skipWhitespace();
      if (text.charAt(i) === ',') {
        i++;
        continue;
      }
      i++;
      return;
    }
  }

  readValue([]);
  return found;
}
