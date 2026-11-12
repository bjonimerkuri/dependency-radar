export interface TextEdit {
  start: number;
  end: number;
  insert: string;
}

export interface JsonMember {
  key: string;
  keyStart: number;
  keyEnd: number;
  value: JsonNode;
}

export type JsonNode =
  | { type: 'object'; start: number; end: number; members: JsonMember[] }
  | { type: 'array' | 'string' | 'literal'; start: number; end: number };

export function parseJsonOffsets(text: string): JsonNode | undefined {
  let i = 0;

  function skip(): void {
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 32 || code === 9 || code === 10 || code === 13) i++;
      else break;
    }
  }

  function readString(): { value: string; start: number; end: number } {
    const start = i;
    i++;
    while (i < text.length && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
    i++;
    return { value: JSON.parse(text.slice(start, i)) as string, start, end: i };
  }

  function readValue(): JsonNode {
    skip();
    const start = i;
    const char = text.charAt(i);
    if (char === '{') {
      i++;
      const members: JsonMember[] = [];
      skip();
      if (text.charAt(i) === '}') {
        i++;
        return { type: 'object', start, end: i, members };
      }
      for (;;) {
        skip();
        const key = readString();
        skip();
        if (text.charAt(i) !== ':') throw new SyntaxError('expected colon');
        i++;
        const value = readValue();
        members.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value });
        skip();
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        if (text.charAt(i) === '}') {
          i++;
          return { type: 'object', start, end: i, members };
        }
        throw new SyntaxError('expected comma or brace');
      }
    }
    if (char === '[') {
      i++;
      skip();
      if (text.charAt(i) === ']') {
        i++;
        return { type: 'array', start, end: i };
      }
      for (;;) {
        readValue();
        skip();
        if (text.charAt(i) === ',') {
          i++;
          continue;
        }
        if (text.charAt(i) === ']') {
          i++;
          return { type: 'array', start, end: i };
        }
        throw new SyntaxError('expected comma or bracket');
      }
    }
    if (char === '"') {
      readString();
      return { type: 'string', start, end: i };
    }
    while (i < text.length && !',}] \t\r\n'.includes(text.charAt(i))) i++;
    if (i === start) throw new SyntaxError('unexpected character');
    return { type: 'literal', start, end: i };
  }

  try {
    const root = readValue();
    skip();
    return i === text.length ? root : undefined;
  } catch {
    return undefined;
  }
}

export function memberOf(node: JsonNode | undefined, key: string): JsonMember | undefined {
  return node?.type === 'object' ? node.members.find((member) => member.key === key) : undefined;
}

export function detectNewline(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)"/.exec(text.replace(/\r\n/g, '\n'));
  return match ? (match[1] as string) : '  ';
}

function lineIndent(text: string, offset: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : undefined;
}

type Rendered = string | { [key: string]: Rendered };

function render(value: Rendered, indent: string, unit: string, newline: string): string {
  if (typeof value === 'string') return value;
  const entries = Object.entries(value);
  const inner = indent + unit;
  const lines = entries.map(([key, child]) => `${inner}${JSON.stringify(key)}: ${render(child, inner, unit, newline)}`);
  return `{${newline}${lines.join(`,${newline}`)}${newline}${indent}}`;
}

export function setJsonMember(
  text: string,
  path: readonly string[],
  key: string,
  valueText: string,
): TextEdit | undefined {
  const root = parseJsonOffsets(text);
  if (!root || root.type !== 'object') return undefined;

  const newline = detectNewline(text);
  const unit = detectIndentUnit(text);

  let object: Extract<JsonNode, { type: 'object' }> = root;
  let depth = 0;
  let consumed = 0;
  for (const segment of path) {
    const member = memberOf(object, segment);
    if (!member) break;
    if (member.value.type !== 'object') return undefined;
    object = member.value;
    depth++;
    consumed++;
  }

  const missing = path.slice(consumed);
  const existing = missing.length === 0 ? memberOf(object, key) : undefined;
  if (existing) return { start: existing.value.start, end: existing.value.end, insert: valueText };

  let entry: Rendered = valueText;
  const memberKey = missing.length === 0 ? key : (missing[0] as string);
  if (missing.length > 0) {
    let nested: Rendered = { [key]: valueText };
    for (let index = missing.length - 1; index >= 1; index--) nested = { [missing[index] as string]: nested };
    entry = nested;
  }

  const first = object.members[0];
  const memberIndent = first ? (lineIndent(text, first.keyStart) ?? unit.repeat(depth + 1)) : unit.repeat(depth + 1);
  const closingIndent = lineIndent(text, object.end - 1) ?? unit.repeat(depth);
  const memberText = `${JSON.stringify(memberKey)}: ${render(entry, memberIndent, unit, newline)}`;

  const last = object.members[object.members.length - 1];
  if (last) {
    return { start: last.value.end, end: last.value.end, insert: `,${newline}${memberIndent}${memberText}` };
  }
  return { start: object.start + 1, end: object.end - 1, insert: `${newline}${memberIndent}${memberText}${newline}${closingIndent}` };
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let result = text;
  for (const edit of ordered) {
    if (edit.end > previousStart) throw new Error('Edits overlap.');
    result = result.slice(0, edit.start) + edit.insert + result.slice(edit.end);
    previousStart = edit.start;
  }
  return result;
}
