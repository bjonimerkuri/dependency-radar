import { escapeHtml, REPORT_STYLE } from './html.ts';
import type { RiskReport, RiskSeverity, RiskSignal } from './risk-types.ts';

export interface RiskHtmlOptions {
  subject: string;
  generatedAt?: string;
  homeHref?: string;
  banner?: string;
}

const e = escapeHtml;

const RISK_STYLE = `
.status{border-radius:10px;padding:16px 18px}
.status h2{margin:0 0 4px;font-size:20px}
.status p{margin:0}
.status.red{background:var(--red-bg);color:var(--red)}
.status.amber{background:var(--amber-bg);color:var(--amber)}
.status.gray{background:var(--surface);border:1px solid var(--line)}
.excerpt{display:block;margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--bg);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.signal p{margin:6px 0 0}
.limits{font-size:14px;color:var(--muted)}
.limits ul{margin:6px 0 0;padding-left:20px}
`;

const TONE: Record<RiskSeverity, string> = { high: 'red', medium: 'amber', low: 'gray', info: 'gray' };

export function riskHeadline(report: RiskReport): { tone: string; title: string; text: string } {
  switch (report.highest) {
    case 'high':
      return {
        tone: 'red',
        title: 'High-risk signals found',
        text: 'Do not install or run this project on your own computer. If you need to look at it, use a disposable environment such as a Codespace, a container or a virtual machine.',
      };
    case 'medium':
      return {
        tone: 'amber',
        title: 'Some signals are worth checking',
        text: 'Read the items below before you install or run this project.',
      };
    default:
      return {
        tone: 'gray',
        title: 'No serious signals found',
        text: 'That does not mean the project is safe. This check only looks for known warning signs.',
      };
  }
}

function card(signal: RiskSignal): string {
  const where = signal.file ? `<p class="where">${e(signal.file)}${signal.line === undefined ? '' : `:${signal.line}`}</p>` : '';
  const excerpt = signal.excerpt ? `<code class="excerpt">${e(signal.excerpt)}</code>` : '';
  return `<article class="card signal"><div class="head"><span class="pkg">${e(signal.title)}</span><span class="badge ${TONE[signal.severity]}">${e(signal.severity)}</span></div>${where}<p>${e(signal.detail)}</p>${excerpt}</article>`;
}

export function formatRiskHtml(report: RiskReport, options: RiskHtmlOptions): string {
  const headline = riskHeadline(report);
  const count = (severity: RiskSeverity): number => report.signals.filter((signal) => signal.severity === severity).length;
  const tiles = (['high', 'medium', 'low', 'info'] as const)
    .map((severity) => `<div class="tile ${TONE[severity]}"><div class="value">${count(severity)}</div><div class="label">${severity}</div></div>`)
    .join('');

  const meta = [
    e(options.subject),
    `Read ${report.scannedFiles} file${report.scannedFiles === 1 ? '' : 's'}, checked ${report.checkedDependencies} dependenc${report.checkedDependencies === 1 ? 'y' : 'ies'}`,
  ];
  if (options.generatedAt) meta.push(`Generated ${e(options.generatedAt)}`);

  const cards = report.signals.length > 0 ? report.signals.map(card).join('') : '<p class="muted">No signals were found.</p>';
  const limits = `<section class="limits"><strong>What this check can and cannot do</strong><ul>${report.limitations.map((text) => `<li>${e(text)}</li>`).join('')}</ul></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Dependency Radar pre-install check</title>
<style>${REPORT_STYLE}${RISK_STYLE}</style>
</head>
<body>
<main>
${options.homeHref ? `<nav class="nav"><a href="${e(options.homeHref)}">&larr; Check another repository</a></nav>` : ''}${options.banner ? `<p class="banner">${e(options.banner)}</p>` : ''}
<header><div class="brand"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="6" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="2" fill="var(--accent)"/></svg>Pre-install check</div><p class="meta">${meta.join(' &middot; ')}</p></header>
<section class="status ${headline.tone}"><h2>${e(headline.title)}</h2><p>${e(headline.text)}</p></section>
<section class="tiles">${tiles}</section>
<section class="cards">${cards}</section>
${limits}
</main>
</body>
</html>
`;
}
