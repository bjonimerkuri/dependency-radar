import type { DependencyEntry, ProjectAnalysis, UpdateAnalysis, Warning } from '@dependency-radar/core';

export interface FormatOptions {
  color: boolean;
  showAll: boolean;
  fileName: string;
  lockfileName?: string;
}

type Tone = 'red' | 'yellow' | 'green' | 'gray';

const CODES: Record<Tone, string> = { red: '31', yellow: '33', green: '32', gray: '90' };
const MAX_REASONS = 3;
const MAX_NAME_WIDTH = 32;

interface Row {
  result: UpdateAnalysis;
  entry: DependencyEntry | undefined;
  label: string;
  tone: Tone;
  rank: number;
}

function classify(result: UpdateAnalysis): { label: string; tone: Tone; rank: number } {
  if (result.status === 'error') return { label: 'ERROR', tone: 'red', rank: 4 };
  if (result.status === 'skipped') return { label: 'SKIP', tone: 'gray', rank: 5 };
  if (result.kind === 'none') return { label: 'OK', tone: 'gray', rank: 6 };
  switch (result.preliminary) {
    case 'breaking-candidate':
      return { label: 'MAJOR', tone: 'red', rank: 0 };
    case 'review':
      return { label: 'REVIEW', tone: 'yellow', rank: 1 };
    case 'safe':
      return { label: 'SAFE', tone: 'green', rank: 3 };
    default:
      return { label: 'UNKNOWN', tone: 'gray', rank: 2 };
  }
}

function detail(result: UpdateAnalysis): string {
  if (result.status !== 'analyzed') return result.reasons[0] ?? '';
  if (result.current !== undefined && result.target !== undefined) {
    return result.kind === 'none' ? `${result.current} (latest)` : `${result.current} -> ${result.target}`;
  }
  return result.target !== undefined ? `? -> ${result.target}` : '';
}

export function formatReport(
  entries: readonly DependencyEntry[],
  analysis: ProjectAnalysis,
  warnings: readonly Warning[],
  options: FormatOptions,
): string {
  const paint = (tone: Tone, text: string): string =>
    options.color ? `\u001b[${CODES[tone]}m${text}\u001b[0m` : text;
  const bold = (text: string): string => (options.color ? `\u001b[1m${text}\u001b[0m` : text);

  const rows: Row[] = analysis.results.map((result, index) => ({
    result,
    entry: entries[index],
    ...classify(result),
  }));
  const visible = rows
    .filter((row) => options.showAll || row.rank <= 2 || row.rank === 4)
    .sort((a, b) => a.rank - b.rank || a.result.name.localeCompare(b.result.name));
  const hidden = rows.length - visible.length;

  const summary = analysis.summary;
  const counts = [
    `${summary.breakingCandidate} major`,
    `${summary.review} review`,
    `${summary.safe} safe`,
    `${summary.upToDate} up to date`,
  ];
  if (summary.unknown > 0) counts.push(`${summary.unknown} unknown`);

  const lines: string[] = [
    bold('Dependency Radar'),
    `${options.fileName} (${options.lockfileName ?? 'no lockfile'})`,
    '',
    `${summary.analyzed} analyzed: ${counts.join(', ')}. ${summary.skipped} skipped, ${summary.errors} errors.`,
    '',
  ];

  const width = Math.min(MAX_NAME_WIDTH, Math.max(0, ...visible.map((row) => row.result.name.length)));
  for (const row of visible) {
    const position = row.entry?.position;
    const where = position ? `  ${paint('gray', `${options.fileName}:${position.line}`)}` : '';
    lines.push(
      `${paint(row.tone, row.label.padEnd(7))} ${row.result.name.padEnd(width)}  ${detail(row.result)}${where}`,
    );
    if (row.result.status === 'analyzed' && (options.showAll || row.rank <= 2)) {
      const reasons = row.result.reasons.filter((reason) => !reason.startsWith('No lockfile'));
      for (const reason of reasons.slice(0, MAX_REASONS)) lines.push(`        - ${reason}`);
    }
  }

  if (visible.length === 0) lines.push('Nothing needs attention.');
  if (hidden > 0) {
    lines.push('', `${hidden} more hidden (safe, up to date or skipped). Run with --all to see them.`);
  }

  const notes = [...new Set(warnings.map((warning) => warning.message))];
  if (notes.length > 0) {
    lines.push('', 'Notes:');
    for (const note of notes) lines.push(`  - ${note}`);
  }

  return `${lines.join('\n')}\n`;
}
