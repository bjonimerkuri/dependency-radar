import { escapeHtml, REPORT_STYLE } from './html.ts';
import type { PrDescription } from './pr-description.ts';
import type { FindingPlan, FindingStatus, FixOption, MultiRemediationPlan, RemediationPlan, RowStatus } from './remediate.ts';
import type { DiffHunk } from './diff.ts';
import type { TicketSeverity } from './ticket.ts';
import { displayAdvisoryId } from './util.ts';

export interface FixHtmlOptions {
  subject?: string;
  generatedAt?: string;
  homeHref?: string;
  banner?: string;
  notes?: readonly string[];
  pr?: { markdown: PrDescription; jira: PrDescription };
}

const e = escapeHtml;

const FIX_STYLE = `
.status{border-radius:10px;padding:16px 18px}
.status h2{margin:0 0 4px;font-size:20px}
.status p{margin:0}
.status.red{background:var(--red-bg);color:var(--red)}
.status.amber{background:var(--amber-bg);color:var(--amber)}
.status.green{background:var(--green-bg);color:var(--green)}
.status.gray{background:var(--surface);border:1px solid var(--line)}
.diff{border:1px solid var(--line);border-radius:8px;overflow:auto;background:var(--surface)}
.diff table{margin:0;width:100%;font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:13px;border-collapse:collapse}
.diff td{border:0;padding:0 8px;white-space:pre;vertical-align:top}
.diff td.no{width:1%;text-align:right;color:var(--muted);user-select:none}
.diff tr.add{background:var(--green-bg);color:var(--green)}
.diff tr.remove{background:var(--red-bg);color:var(--red)}
.diff tr.hunk td{background:var(--bg);color:var(--muted)}
pre.block{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--bg);border:1px solid var(--line);font-size:13px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
pre.copy{user-select:all}
.option{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.option h4{margin:0 0 4px;font-size:15px}
.option p{margin:4px 0}
.pros,.cons{font-size:14px;margin:6px 0 0;padding-left:20px}
.conflict{margin:10px 0 0;padding:10px 12px;border-radius:8px;background:var(--amber-bg);color:var(--amber);font-size:14px}
.table-wrap{overflow:auto}
.limits{font-size:14px;color:var(--muted)}
.limits ul{margin:6px 0 0;padding-left:20px}
h3{margin:0;font-size:17px}
.ids{font-size:13px;color:var(--muted);margin:4px 0 0}
`;

const SEVERITY_TONE: Record<TicketSeverity, string> = { critical: 'red', high: 'red', medium: 'amber', low: 'gray' };
const STATUS_TONE: Record<RowStatus, string> = {
  planned: 'amber',
  'already-fixed': 'green',
  'not-in-project': 'gray',
  'no-fixed-version': 'amber',
  manual: 'amber',
  duplicate: 'gray',
  'not-analyzed': 'gray',
};
const STATUS_LABEL: Record<RowStatus, string> = {
  planned: 'change planned',
  'already-fixed': 'not affected',
  'not-in-project': 'not in project',
  'no-fixed-version': 'no fixed version',
  manual: 'needs a look',
  duplicate: 'duplicate',
  'not-analyzed': 'not analyzed',
};

export const FIX_LIMITS: readonly string[] = [
  'The facts (versions, paths, line numbers) come from your files and from the ticket. AI is not used to decide what to change.',
  'The text of the ticket and the advisory is trusted as written. If it names the wrong fixed version, the plan will too. Check with npm audit after you change anything.',
  'Reachability is not checked. When your code is scanned, this only shows whether a package is imported, not whether the vulnerable function is called.',
  'Only package-lock.json is read. pnpm-lock.yaml and yarn.lock are not supported yet, so for those projects only direct dependencies are found.',
  'Tickets about other ecosystems (Java, Python, Docker) are out of scope.',
  'Nothing from your project is run or installed.',
];

function diffTable(hunks: readonly DiffHunk[]): string {
  if (hunks.length === 0) return '<p class="muted">package.json does not change.</p>';
  const rows: string[] = [];
  for (const hunk of hunks) {
    rows.push(`<tr class="hunk"><td class="no"></td><td class="no"></td><td>@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</td></tr>`);
    for (const line of hunk.lines) {
      const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      rows.push(`<tr class="${line.type}"><td class="no">${line.oldNumber ?? ''}</td><td class="no">${line.newNumber ?? ''}</td><td>${sign}${e(line.text)}</td></tr>`);
    }
  }
  return `<div class="diff"><table><tbody>${rows.join('')}</tbody></table></div>`;
}

function optionHtml(option: FixOption): string {
  const badge = option.recommended ? '<span class="badge green">recommended</span>' : '<span class="badge gray">alternative</span>';
  const major = option.majorChange ? ' <span class="badge amber">major version</span>' : '';
  const list = (items: readonly string[], cls: string): string => (items.length > 0 ? `<ul class="${cls}">${items.map((item) => `<li>${e(item)}</li>`).join('')}</ul>` : '');
  const diff = option.diff !== '' ? `<pre class="block">${e(option.diff)}</pre>` : '';
  const commands = option.commands.length > 0 ? `<pre class="block">${e(option.commands.join('\n'))}</pre>` : '';
  return `<div class="option"><h4>${e(option.title)} ${badge}${major}</h4><p>${e(option.description)}</p>${list(option.pros, 'pros')}${list(option.cons, 'cons')}${diff}${commands}</div>`;
}

function instancesTable(finding: FindingPlan): string {
  if (finding.instances.length === 0) return '';
  const rows = finding.instances
    .map((instance) => {
      const kind = instance.direct ? 'direct' : 'indirect';
      const chain = instance.chains[0]?.join(' > ') ?? (instance.direct ? 'project' : '');
      return `<tr><td class="mono">${e(instance.path)}</td><td class="mono">${e(instance.version)}</td><td>${kind}${instance.dev ? ', dev' : ''}</td><td>${instance.vulnerable ? 'affected' : 'not affected'}</td><td class="mono">${e(chain)}</td></tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table><thead><tr><th>Where</th><th>Version</th><th>Type</th><th>By this ticket</th><th>Pulled in by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function findingCard(finding: FindingPlan): string {
  const status = finding.status as FindingStatus;
  const severity = finding.finding.severity;
  const badges = [
    severity ? `<span class="badge ${SEVERITY_TONE[severity]}">${e(severity)}</span>` : '',
    `<span class="badge ${STATUS_TONE[status]}">${e(STATUS_LABEL[status])}</span>`,
  ].join(' ');
  const ids = finding.finding.ids.length > 0 ? `<p class="ids">${finding.finding.ids.map((id) => e(displayAdvisoryId(id))).join(', ')}</p>` : '';
  const conflicts = finding.conflicts.map((text) => `<p class="conflict">${e(text)}</p>`).join('');
  const notes = finding.notes.length > 0 ? `<ul>${finding.notes.map((note) => `<li>${e(note)}</li>`).join('')}</ul>` : '';
  return `<article class="card"><div class="head"><span class="pkg">${e(finding.finding.packageName)}</span><span>${badges}</span></div>${ids}<p>${e(finding.summary)}</p>${conflicts}${instancesTable(finding)}${notes}${finding.options.map(optionHtml).join('')}</article>`;
}

function matrixHtml(plan: MultiRemediationPlan): string {
  const rows = plan.matrix
    .map((row) => {
      const ids = row.ids.length > 0 ? row.ids.map((id) => e(displayAdvisoryId(id))).join(', ') : '<span class="muted">none in the text</span>';
      const change = row.closedBy.length > 0 ? row.closedBy.map((text) => e(text)).join('<br>') : `<span class="muted">${e(row.note ?? '')}</span>`;
      const severity = row.severity ? ` <span class="badge ${SEVERITY_TONE[row.severity]}">${e(row.severity)}</span>` : '';
      return `<tr><td>${e(row.ticket)}</td><td>${ids}</td><td class="mono">${e(row.packageName)}${severity}</td><td><span class="badge ${STATUS_TONE[row.status]}">${e(STATUS_LABEL[row.status])}</span></td><td>${change}</td></tr>`;
    })
    .join('');
  return `<section class="card"><h3>Which change closes which ticket</h3><div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Advisory</th><th>Package</th><th>Result</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function prBlock(description: PrDescription, title: string): string {
  const note = description.truncated ? '<p class="muted">The text was shortened to fit the length limit.</p>' : '';
  return `<details><summary>${e(title)}</summary><p class="muted">Click the text once to select it all, then copy it.</p><pre class="block copy">${e(`${description.title}\n\n${description.body}`)}</pre>${note}</details>`;
}

export function fixHeadline(plan: RemediationPlan): { tone: string; title: string; text: string } {
  const planned = plan.findings.filter((finding) => finding.status === 'planned').length;
  const attention = plan.findings.filter((finding) => finding.status === 'manual' || finding.status === 'no-fixed-version').length;
  if (planned > 0) {
    return {
      tone: 'amber',
      title: planned === 1 ? 'One package needs a change' : `${planned} packages need a change`,
      text: 'These steps follow the advisory text in your ticket. They are suggestions: check them, then run npm audit and your tests.',
    };
  }
  if (attention > 0) {
    return { tone: 'amber', title: 'No automatic change could be built', text: 'Read the notes below. Some tickets need a fixed version or a manual look.' };
  }
  return { tone: 'green', title: 'Nothing to change for these tickets', text: 'The installed versions are not affected, or the packages are not in this project. Run npm audit to confirm.' };
}

export function formatFixHtml(plan: RemediationPlan | MultiRemediationPlan, options: FixHtmlOptions = {}): string {
  const headline = fixHeadline(plan);
  const count = (...statuses: FindingStatus[]): number => plan.findings.filter((finding) => statuses.includes(finding.status)).length;
  const tiles = [
    ['amber', count('planned'), 'to change'],
    ['green', count('already-fixed'), 'not affected'],
    ['gray', count('not-in-project'), 'not in project'],
    ['amber', count('manual', 'no-fixed-version'), 'need a look'],
  ] as const;
  const tileHtml = tiles.map(([tone, value, label]) => `<div class="tile ${tone}"><div class="value">${value}</div><div class="label">${label}</div></div>`).join('');

  const meta = [options.subject ? e(options.subject) : 'package.json', `${plan.findings.length} package${plan.findings.length === 1 ? '' : 's'} in the ticket${'tickets' in plan && plan.tickets.length > 1 ? 's' : ''}`];
  if (options.generatedAt) meta.push(`Generated ${e(options.generatedAt)}`);

  const warnings = [...plan.warnings, ...(options.notes ?? [])];
  const warningHtml = warnings.length > 0 ? `<section class="notes"><strong>Notes</strong><ul>${warnings.map((text) => `<li>${e(text)}</li>`).join('')}</ul></section>` : '';

  const commands = plan.commands.length > 0 ? `<section class="card"><h3>Commands</h3><pre class="block">${e(plan.commands.join('\n'))}</pre></section>` : '';
  const verify = plan.verify.length > 0 ? `<section class="card"><h3>Check afterwards</h3><ul>${plan.verify.map((text) => `<li>${e(text)}</li>`).join('')}</ul></section>` : '';
  const diff = `<section class="card"><h3>package.json</h3>${diffTable(plan.hunks)}</section>`;
  const matrix = 'matrix' in plan && plan.matrix.length > 0 ? matrixHtml(plan) : '';
  const cards = plan.findings.map(findingCard).join('');
  const pr = options.pr
    ? `<section class="card"><h3>Description for the pull request or Jira ticket</h3><p class="muted">Check that it contains no confidential information before you paste it.</p>${prBlock(options.pr.markdown, 'Markdown for GitHub')}${prBlock(options.pr.jira, 'Plain text for Jira')}</section>`
    : '';
  const limits = `<section class="limits"><strong>What this can and cannot do</strong><ul>${FIX_LIMITS.map((text) => `<li>${e(text)}</li>`).join('')}</ul></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Dependency Radar: from ticket to changes</title>
<style>${REPORT_STYLE}${FIX_STYLE}</style>
</head>
<body>
<main>
${options.homeHref ? `<nav class="nav"><a href="${e(options.homeHref)}">&larr; Fix another ticket</a></nav>` : ''}${options.banner ? `<p class="banner">${e(options.banner)}</p>` : ''}
<header><div class="brand"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="6" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="2" fill="var(--accent)"/></svg>From ticket to changes</div><p class="meta">${meta.join(' &middot; ')}</p></header>
<section class="status ${headline.tone}"><h2>${e(headline.title)}</h2><p>${e(headline.text)}</p></section>
<section class="tiles">${tileHtml}</section>
${warningHtml}
${matrix}
${diff}
${commands}
${verify}
<section class="cards">${cards}</section>
${pr}
${limits}
</main>
</body>
</html>
`;
}
