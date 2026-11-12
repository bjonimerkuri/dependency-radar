import { riskHeadline } from '@dependency-radar/core';
import type { RiskReport, RiskSeverity } from '@dependency-radar/core';

export interface RiskFormatOptions {
  subject: string;
  color: boolean;
  showAll: boolean;
}

const CODES: Record<RiskSeverity, string> = { high: '31', medium: '33', low: '90', info: '90' };

export function formatRiskReport(report: RiskReport, options: RiskFormatOptions): string {
  const paint = (code: string, text: string): string => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const bold = (text: string): string => (options.color ? `\u001b[1m${text}\u001b[0m` : text);

  const headline = riskHeadline(report);
  const headlineCode = headline.tone === 'red' ? '31' : headline.tone === 'amber' ? '33' : '90';
  const count = (severity: RiskSeverity): number => report.signals.filter((signal) => signal.severity === severity).length;
  const hiddenInfo = options.showAll ? 0 : count('info');
  const visible = report.signals.filter((signal) => options.showAll || signal.severity !== 'info');

  const lines: string[] = [
    bold('Dependency Radar: pre-install check'),
    options.subject,
    `Read ${report.scannedFiles} file${report.scannedFiles === 1 ? '' : 's'}, checked ${report.checkedDependencies} dependenc${report.checkedDependencies === 1 ? 'y' : 'ies'}.`,
    '',
    paint(headlineCode, bold(headline.title)),
    headline.text,
    '',
    `${count('high')} high, ${count('medium')} medium, ${count('low')} low, ${count('info')} info`,
    '',
  ];

  for (const signal of visible) {
    const where = signal.file ? `${signal.file}${signal.line === undefined ? '' : `:${signal.line}`}` : '';
    lines.push(`${paint(CODES[signal.severity], signal.severity.toUpperCase().padEnd(7))} ${signal.title}`);
    if (where) lines.push(`        ${where}`);
    lines.push(`        ${signal.detail}`);
    if (signal.excerpt) lines.push(`        > ${signal.excerpt}`);
    lines.push('');
  }
  if (visible.length === 0) lines.push('No signals to show.', '');
  if (hiddenInfo > 0) lines.push(`${hiddenInfo} informational note${hiddenInfo === 1 ? '' : 's'} hidden. Run with --all to see them.`, '');

  lines.push('What this check can and cannot do:');
  for (const limit of report.limitations) lines.push(`  - ${limit}`);
  return `${lines.join('\n')}\n`;
}
