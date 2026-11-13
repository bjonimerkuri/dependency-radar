import { displayAdvisoryId, FIX_LIMITS, fixHeadline } from '@dependency-radar/core';
import type { FindingPlan, MultiRemediationPlan, RemediationPlan, RowStatus } from '@dependency-radar/core';

export interface FixFormatOptions {
  subject: string;
  color: boolean;
  usage?: ReadonlyMap<string, { files: readonly string[] }>;
  notes?: readonly string[];
}

const STATUS_LABEL: Record<RowStatus, string> = {
  planned: 'CHANGE',
  'already-fixed': 'OK',
  'not-in-project': 'N/A',
  'no-fixed-version': 'NO FIX',
  manual: 'LOOK',
  duplicate: 'SAME',
  'not-analyzed': 'SKIPPED',
};
const STATUS_CODE: Record<RowStatus, string> = {
  planned: '33',
  'already-fixed': '32',
  'not-in-project': '90',
  'no-fixed-version': '33',
  manual: '33',
  duplicate: '90',
  'not-analyzed': '90',
};

export function formatFixReport(plan: RemediationPlan | MultiRemediationPlan, options: FixFormatOptions): string {
  const paint = (code: string, text: string): string => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const bold = (text: string): string => (options.color ? `\u001b[1m${text}\u001b[0m` : text);
  const headline = fixHeadline(plan);
  const headlineCode = headline.tone === 'green' ? '32' : '33';

  const lines: string[] = [
    bold('Dependency Radar: from ticket to changes'),
    `${options.subject} (${plan.packageManager})`,
    '',
    paint(headlineCode, bold(headline.title)),
    headline.text,
    '',
  ];

  if ('matrix' in plan && plan.matrix.length > 0) {
    lines.push(bold('Which change closes which ticket'));
    for (const row of plan.matrix) {
      const ids = row.ids.length > 0 ? row.ids.map(displayAdvisoryId).join(', ') : 'no id';
      const what = row.closedBy.length > 0 ? row.closedBy.join('; ') : (row.note ?? '');
      lines.push(`  ${paint(STATUS_CODE[row.status], STATUS_LABEL[row.status].padEnd(7))} ${row.ticket} | ${ids} | ${row.packageName || '-'}`);
      if (what !== '') lines.push(`          ${what}`);
    }
    lines.push('');
  }

  for (const finding of plan.findings) lines.push(...findingLines(finding, paint, bold, options));

  if (plan.changed) {
    lines.push(bold('Change to package.json'));
    for (const line of plan.diff.split('\n')) {
      if (line === '') continue;
      if (line.startsWith('+') && !line.startsWith('+++')) lines.push(paint('32', line));
      else if (line.startsWith('-') && !line.startsWith('---')) lines.push(paint('31', line));
      else lines.push(line);
    }
    lines.push('');
  }
  if (plan.commands.length > 0) {
    lines.push(bold('Commands'));
    for (const command of plan.commands) lines.push(`  $ ${command}`);
    lines.push('');
  }
  if (plan.verify.length > 0) {
    lines.push(bold('Check afterwards'));
    for (const step of plan.verify) lines.push(`  - ${step}`);
    lines.push('');
  }

  const notes = [...plan.warnings, ...(options.notes ?? [])];
  if (notes.length > 0) {
    lines.push(bold('Notes'));
    for (const note of notes) lines.push(`  - ${note}`);
    lines.push('');
  }
  lines.push('What this can and cannot do:');
  for (const limit of FIX_LIMITS) lines.push(`  - ${limit}`);
  return `${lines.join('\n')}\n`;
}

function findingLines(
  finding: FindingPlan,
  paint: (code: string, text: string) => string,
  bold: (text: string) => string,
  options: FixFormatOptions,
): string[] {
  const out: string[] = [];
  const severity = finding.finding.severity ? ` ${finding.finding.severity.toUpperCase()}` : '';
  const status = finding.status === 'planned' ? 'change planned' : finding.status.replace(/-/g, ' ');
  out.push(`${bold(finding.finding.packageName)}${severity}  [${status}]`);
  if (finding.finding.ids.length > 0) out.push(`  ${finding.finding.ids.map(displayAdvisoryId).join(', ')}`);
  out.push(`  ${finding.summary}`);
  for (const conflict of finding.conflicts) out.push(`  ${paint('33', `Conflict: ${conflict}`)}`);
  if (options.usage && finding.status === 'planned') {
    const usage = options.usage.get(finding.finding.packageName);
    out.push(
      usage === undefined || usage.files.length === 0
        ? '  Your code: not imported in the scanned files (this does not show whether the vulnerable function is called).'
        : `  Your code: imported in ${usage.files.length} file${usage.files.length === 1 ? '' : 's'}: ${usage.files.slice(0, 5).join(', ')}${usage.files.length > 5 ? ', ...' : ''}`,
    );
  }
  for (const note of finding.notes) out.push(`  Note: ${note}`);
  for (const option of finding.options) {
    out.push(`  ${option.recommended ? '*' : '-'} ${option.title}${option.recommended ? ' (recommended)' : ''}`);
    for (const con of option.cons) out.push(`      ${con}`);
  }
  out.push('');
  return out;
}
