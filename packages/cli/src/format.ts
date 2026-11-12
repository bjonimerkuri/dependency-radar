import { classify, describeImpact, excerptText, reasonLines, summaryCounts } from '@dependency-radar/core';
import type { DependencyEntry, ProjectAnalysis, ScanInfo, Tone, UpdateAnalysis, Warning } from '@dependency-radar/core';

export interface FormatOptions {
  color: boolean;
  showAll: boolean;
  fileName: string;
  lockfileName?: string;
  scan?: ScanInfo;
}

const CODES: Record<Tone, string> = { red: '31', yellow: '33', green: '32', gray: '90' };
const MAX_NAME_WIDTH = 32;
const MAX_MENTIONS = 2;
const MAX_STEPS = 3;

interface Row {
  result: UpdateAnalysis;
  entry: DependencyEntry | undefined;
  label: string;
  tone: Tone;
  rank: number;
  attention: boolean;
}

function detail(result: UpdateAnalysis): string {
  if (result.status !== 'analyzed') return result.reasons[0] ?? '';
  if (result.current !== undefined && result.target !== undefined) {
    return result.kind === 'none' ? `${result.current} (latest)` : `${result.current} -> ${result.target}`;
  }
  return result.target !== undefined ? `? -> ${result.target}` : '';
}

function summaryLine(analysis: ProjectAnalysis): string {
  const summary = analysis.summary;
  const counts = summaryCounts(analysis).map((entry) => `${entry.value} ${entry.label}`);
  return `${summary.analyzed} analyzed: ${counts.join(', ')}. ${summary.skipped} skipped, ${summary.errors} errors.`;
}

function quote(text: string, limit = 120): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function extraLines(result: UpdateAnalysis, showAll: boolean, attention: boolean): string[] {
  if (result.status !== 'analyzed' || !(showAll || attention)) return [];
  const lines: string[] = [];

  for (const reason of reasonLines(result)) lines.push(`        - ${reason}`);

  if (result.impact) lines.push(`        > ${describeImpact(result.impact)}`);

  const changelog = result.changelog;
  if (changelog) {
    if (changelog.status === 'found') {
      for (const mention of changelog.mentions.slice(0, MAX_MENTIONS)) {
        const excerpt = mention.excerpts[0];
        if (excerpt) lines.push(`        # ${mention.symbol}: "${quote(excerptText(excerpt.text))}" (${excerpt.version})`);
      }
      if (changelog.mentions.length === 0) {
        lines.push(`        # Read ${changelog.sections} changelog version${changelog.sections === 1 ? '' : 's'}; none mention the names you import.`);
      }
    } else {
      lines.push(`        # No changelog used: ${changelog.message ?? changelog.status}`);
    }
  }

  if (result.explanation) {
    lines.push(`        AI: ${quote(result.explanation.summary, 300)}`);
    for (const step of result.explanation.steps.slice(0, MAX_STEPS)) lines.push(`          * ${quote(step, 200)}`);
  } else if (result.explanationError) {
    lines.push(`        AI unavailable: ${result.explanationError}`);
  }
  return lines;
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
    .filter((row) => options.showAll || row.attention)
    .sort((a, b) => a.rank - b.rank || a.result.name.localeCompare(b.result.name));
  const hidden = rows.length - visible.length;

  const lines: string[] = [
    bold('Dependency Radar'),
    `${options.fileName} (${options.lockfileName ?? 'no lockfile'})`,
  ];
  if (options.scan) {
    const { scannedFiles, unsupportedFiles, truncated } = options.scan;
    const parts = [`Scanned ${scannedFiles} source file${scannedFiles === 1 ? '' : 's'}`];
    if (unsupportedFiles > 0) {
      parts.push(`${unsupportedFiles} Vue, Svelte or Astro file${unsupportedFiles === 1 ? '' : 's'} not analyzed`);
    }
    if (truncated) parts.push('the folder was too large to read completely');
    lines.push(`${parts.join('; ')}.`);
  }
  lines.push('', summaryLine(analysis), '');

  const width = Math.min(MAX_NAME_WIDTH, Math.max(0, ...visible.map((row) => row.result.name.length)));
  for (const row of visible) {
    const position = row.entry?.position;
    const where = position ? `  ${paint('gray', `${options.fileName}:${position.line}`)}` : '';
    lines.push(
      `${paint(row.tone, row.label.padEnd(8))} ${row.result.name.padEnd(width)}  ${detail(row.result)}${where}`,
    );
    lines.push(...extraLines(row.result, options.showAll, row.attention));
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
