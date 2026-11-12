export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

type Op = { type: 'context' | 'add' | 'remove'; text: string };

const MAX_CELLS = 16_000_000;

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const ops: Op[] = a.slice(0, prefix).map((text) => ({ type: 'context' as const, text }));

  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) ops.push({ type: 'remove', text });
    for (const text of midB) ops.push({ type: 'add', text });
  } else {
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * width + j + 1] as number) + 1
            : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'context', text: midA[i] as string });
        i++;
        j++;
      } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
        ops.push({ type: 'remove', text: midA[i] as string });
        i++;
      } else {
        ops.push({ type: 'add', text: midB[j] as string });
        j++;
      }
    }
    while (i < midA.length) ops.push({ type: 'remove', text: midA[i++] as string });
    while (j < midB.length) ops.push({ type: 'add', text: midB[j++] as string });
  }

  for (const text of a.slice(a.length - suffix)) ops.push({ type: 'context', text });
  return ops;
}

export function computeDiff(oldText: string, newText: string, context = 3): DiffHunk[] {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  const numbered: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const op of ops) {
    if (op.type === 'context') {
      oldNumber++;
      newNumber++;
      numbered.push({ type: 'context', text: op.text, oldNumber, newNumber });
    } else if (op.type === 'remove') {
      oldNumber++;
      numbered.push({ type: 'remove', text: op.text, oldNumber });
    } else {
      newNumber++;
      numbered.push({ type: 'add', text: op.text, newNumber });
    }
  }

  const changed = numbered.flatMap((line, index) => (line.type === 'context' ? [] : [index]));
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(numbered.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = end;
    else ranges.push([start, end]);
  }

  return ranges.map(([start, end]) => {
    const lines = numbered.slice(start, end + 1);
    const olds = lines.filter((line) => line.type !== 'add');
    const news = lines.filter((line) => line.type !== 'remove');
    const first = lines[0] as DiffLine;
    return {
      oldStart: olds.length > 0 ? (olds[0]?.oldNumber as number) : Math.max(0, (first.oldNumber ?? first.newNumber ?? 1) - 1),
      oldLines: olds.length,
      newStart: news.length > 0 ? (news[0]?.newNumber as number) : Math.max(0, (first.newNumber ?? 1) - 1),
      newLines: news.length,
      lines,
    };
  });
}

export function unifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  const hunks = computeDiff(oldText, newText, context);
  if (hunks.length === 0) return '';
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      out.push(`${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`);
    }
  }
  return `${out.join('\n')}\n`;
}
