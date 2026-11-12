import { describeImpact } from './impact.ts';
import type { ProjectAnalysis, UpdateAnalysis } from './analyze.ts';

export type Tone = 'red' | 'yellow' | 'green' | 'gray';

export interface ScanInfo {
  scannedFiles: number;
  unsupportedFiles: number;
  truncated: boolean;
}

export interface Classification {
  label: string;
  tone: Tone;
  rank: number;
  attention: boolean;
}

export interface SummaryCount {
  label: string;
  value: number;
  tone: Tone;
}

const MAX_REASONS = 3;
const ROUTINE_REASON = /^(?:Major version change|Minor update|Patch update|Already at the latest|The installed version .* is ahead)/;

export function classify(result: UpdateAnalysis): Classification {
  if (result.status === 'error') return { label: 'ERROR', tone: 'red', rank: 4, attention: true };
  if (result.status === 'skipped') return { label: 'SKIP', tone: 'gray', rank: 6, attention: false };
  if (result.kind === 'none') return { label: 'OK', tone: 'gray', rank: 7, attention: false };

  if (result.verdict) {
    switch (result.verdict.level) {
      case 'breaking':
        return { label: 'BREAKING', tone: 'red', rank: 0, attention: true };
      case 'review':
        return result.kind === 'major'
          ? { label: 'MAJOR', tone: 'yellow', rank: 1, attention: true }
          : { label: 'REVIEW', tone: 'yellow', rank: 2, attention: true };
      case 'safe':
        return { label: 'SAFE', tone: 'green', rank: 5, attention: false };
      default:
        return { label: 'UNKNOWN', tone: 'gray', rank: 3, attention: true };
    }
  }

  switch (result.preliminary) {
    case 'breaking-candidate':
      return { label: 'MAJOR', tone: 'red', rank: 1, attention: true };
    case 'review':
      return { label: 'REVIEW', tone: 'yellow', rank: 2, attention: true };
    case 'safe':
      return { label: 'SAFE', tone: 'green', rank: 5, attention: false };
    default:
      return { label: 'UNKNOWN', tone: 'gray', rank: 3, attention: true };
  }
}

export function summaryCounts(analysis: ProjectAnalysis): SummaryCount[] {
  const summary = analysis.summary;
  const analyzed = analysis.results.filter((result) => result.status === 'analyzed');
  const withVerdicts = analyzed.length > 0 && analyzed.every((result) => result.verdict !== undefined);

  if (withVerdicts) {
    const open = analyzed.filter((result) => result.kind !== 'none');
    const count = (level: string): number => open.filter((result) => result.verdict?.level === level).length;
    const counts: SummaryCount[] = [
      { label: 'breaking', value: count('breaking'), tone: 'red' },
      { label: 'to review', value: count('review'), tone: 'yellow' },
      { label: 'safe', value: count('safe'), tone: 'green' },
      { label: 'up to date', value: summary.upToDate, tone: 'gray' },
    ];
    if (count('unknown') > 0) counts.push({ label: 'unknown', value: count('unknown'), tone: 'gray' });
    return counts;
  }

  const counts: SummaryCount[] = [
    { label: 'major', value: summary.breakingCandidate, tone: 'red' },
    { label: 'review', value: summary.review, tone: 'yellow' },
    { label: 'safe', value: summary.safe, tone: 'green' },
    { label: 'up to date', value: summary.upToDate, tone: 'gray' },
  ];
  if (summary.unknown > 0) counts.push({ label: 'unknown', value: summary.unknown, tone: 'gray' });
  return counts;
}

export function reasonLines(result: UpdateAnalysis): string[] {
  const own = result.reasons.filter(
    (reason) => !reason.startsWith('No lockfile') && !(result.verdict && ROUTINE_REASON.test(reason)),
  );
  return [...new Set([...(result.verdict?.reasons ?? []), ...own])].slice(0, MAX_REASONS);
}

export function excerptText(text: string): string {
  return text.replace(/^[-*+]\s+/, '');
}

export { describeImpact };
