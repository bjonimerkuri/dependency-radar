import type { ProjectAnalysis, UpdateAnalysis } from './analyze.ts';
import { classify, describeImpact, excerptText, reasonLines, summaryCounts } from './report.ts';
import type { ScanInfo, Tone } from './report.ts';
import type { DependencyEntry, Warning } from './types.ts';

export interface HtmlOptions {
  fileName: string;
  lockfileName?: string;
  scan?: ScanInfo;
  generatedAt?: string;
  banner?: string;
  homeHref?: string;
  notes?: readonly string[];
}

const TONE_CLASS: Record<Tone, string> = { red: 'red', yellow: 'amber', green: 'green', gray: 'gray' };
const MAX_MENTIONS = 3;
const MAX_STEPS = 4;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

export const REPORT_STYLE = `
:root{color-scheme:light dark;--bg:#F6F5F1;--surface:#FFFFFF;--line:#E2DFD6;--ink:#16181D;--muted:#5B6070;--accent:#3B5BDB;--red-bg:#FBE4E4;--red:#9B1C1C;--amber-bg:#FCEFD0;--amber:#7A4A06;--green-bg:#DDF3E7;--green:#14633F;--gray-bg:#ECEBE6;--gray:#4B5060}
@media (prefers-color-scheme:dark){:root{--bg:#14161A;--surface:#1C1F25;--line:#2D323B;--ink:#ECEDEF;--muted:#A3A9B6;--accent:#8EA2FF;--red-bg:#3A1C1C;--red:#FFB4B4;--amber-bg:#3A2D12;--amber:#F5D08A;--green-bg:#17332A;--green:#9BE3BC;--gray-bg:#262A32;--gray:#B8BDC9}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5}
main{max-width:1100px;margin:0 auto;padding:32px 20px 48px;display:flex;flex-direction:column;gap:24px}
header .brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600}
header .meta{margin:6px 0 0;color:var(--muted);font-size:14px}
code,.mono{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.tile{border-radius:10px;padding:16px 18px;background:var(--surface);border:1px solid var(--line)}
.tile .value{font-size:32px;font-weight:600;line-height:1.1}
.tile .label{font-size:14px}
.tile.red{background:var(--red-bg);border-color:transparent;color:var(--red)}
.tile.amber{background:var(--amber-bg);border-color:transparent;color:var(--amber)}
.tile.green{background:var(--green-bg);border-color:transparent;color:var(--green)}
.tile.gray{color:var(--muted)}
.cards{display:flex;flex-direction:column;gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px}
.card .head{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between}
.card .pkg{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:17px;font-weight:500}
.card .ver{font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted);margin-left:12px}
.badge{font-size:12px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;padding:4px 10px;border-radius:999px}
.badge.red{background:var(--red-bg);color:var(--red)}
.badge.amber{background:var(--amber-bg);color:var(--amber)}
.badge.green{background:var(--green-bg);color:var(--green)}
.badge.gray{background:var(--gray-bg);color:var(--gray)}
.where{margin:4px 0 0;font-family:'IBM Plex Mono',ui-monospace,Menlo,monospace;font-size:13px;color:var(--muted)}
.card ul,.card ol{margin:10px 0 0;padding-left:20px}
.card li{margin:2px 0}
.impact{margin:10px 0 0;font-size:14px}
.evidence{font-size:14px}
.evidence q{quotes:none}
.muted{color:var(--muted)}
.ai{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:14px}
.ai p{margin:4px 0 0}
details{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 18px}
summary{cursor:pointer;font-weight:500}
table{width:100%;border-collapse:collapse;margin-top:10px;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500}
.notes{font-size:14px;color:var(--muted)}
.nav a{color:var(--accent);text-decoration:none;font-size:14px}
.banner{margin:0;padding:10px 14px;border-radius:8px;background:var(--amber-bg);color:var(--amber);font-size:14px}
.notes ul{margin:6px 0 0;padding-left:20px}
footer{font-size:13px;color:var(--muted)}
`;

function versionText(result: UpdateAnalysis): string {
  if (result.status !== 'analyzed') return '';
  if (result.current !== undefined && result.target !== undefined) {
    return result.kind === 'none' ? `${result.current} (latest)` : `${result.current} \u2192 ${result.target}`;
  }
  return result.target !== undefined ? `? \u2192 ${result.target}` : '';
}

function list(items: readonly string[], tag: 'ul' | 'ol' = 'ul'): string {
  return items.length === 0 ? '' : `<${tag}>${items.map((item) => `<li>${e(item)}</li>`).join('')}</${tag}>`;
}

function card(result: UpdateAnalysis, entry: DependencyEntry | undefined, fileName: string): string {
  const { label, tone } = classify(result);
  const position = entry?.position;
  const where = position ? `<p class="where">${e(fileName)}:${position.line}</p>` : '';

  const parts: string[] = [];
  if (result.status === 'analyzed') {
    parts.push(list(reasonLines(result)));
    if (result.impact) parts.push(`<p class="impact">${e(describeImpact(result.impact))}</p>`);

    const changelog = result.changelog;
    if (changelog?.status === 'found') {
      const items = changelog.mentions.slice(0, MAX_MENTIONS).flatMap((mention) => {
        const excerpt = mention.excerpts[0];
        return excerpt
          ? [`<li><code>${e(mention.symbol)}</code> <q>${e(excerptText(excerpt.text))}</q> <span class="muted">(${e(excerpt.version)})</span></li>`]
          : [];
      });
      parts.push(
        items.length > 0
          ? `<ul class="evidence">${items.join('')}</ul>`
          : `<p class="impact muted">Read ${changelog.sections} changelog version${changelog.sections === 1 ? '' : 's'}; none mention the names you import.</p>`,
      );
    } else if (changelog) {
      parts.push(`<p class="impact muted">No changelog used: ${e(changelog.message ?? changelog.status)}</p>`);
    }

    if (result.explanation) {
      parts.push(
        `<div class="ai"><strong>AI explanation</strong><p>${e(result.explanation.summary)}</p>${list(result.explanation.steps.slice(0, MAX_STEPS), 'ol')}</div>`,
      );
    } else if (result.explanationError) {
      parts.push(`<p class="impact muted">AI unavailable: ${e(result.explanationError)}</p>`);
    }
  } else {
    parts.push(list(result.reasons.slice(0, 1)));
  }

  return `<article class="card"><div class="head"><div><span class="pkg">${e(result.name)}</span><span class="ver">${e(versionText(result))}</span></div><span class="badge ${TONE_CLASS[tone]}">${e(label)}</span></div>${where}${parts.join('')}</article>`;
}

export function formatHtml(
  entries: readonly DependencyEntry[],
  analysis: ProjectAnalysis,
  warnings: readonly Warning[],
  options: HtmlOptions,
): string {
  const rows = analysis.results.map((result, index) => ({ result, entry: entries[index], ...classify(result) }));
  const attention = rows
    .filter((row) => row.attention)
    .sort((a, b) => a.rank - b.rank || a.result.name.localeCompare(b.result.name));
  const others = rows
    .filter((row) => !row.attention)
    .sort((a, b) => a.rank - b.rank || a.result.name.localeCompare(b.result.name));

  const meta = [`${e(options.fileName)} (${e(options.lockfileName ?? 'no lockfile')})`];
  if (options.scan) {
    const { scannedFiles, unsupportedFiles, truncated } = options.scan;
    let scanText = `Scanned ${scannedFiles} source file${scannedFiles === 1 ? '' : 's'}`;
    if (unsupportedFiles > 0) scanText += `; ${unsupportedFiles} Vue, Svelte or Astro file${unsupportedFiles === 1 ? '' : 's'} not analyzed`;
    if (truncated) scanText += '; the folder was too large to read completely';
    meta.push(e(`${scanText}.`));
  }
  if (options.generatedAt) meta.push(`Generated ${e(options.generatedAt)}`);

  const tiles = summaryCounts(analysis)
    .map(
      (count) =>
        `<div class="tile ${TONE_CLASS[count.tone]}"><div class="value">${count.value}</div><div class="label">${e(count.label)}</div></div>`,
    )
    .join('');

  const cards =
    attention.length > 0
      ? attention.map((row) => card(row.result, row.entry, options.fileName)).join('')
      : '<p class="muted">Nothing needs attention.</p>';

  const otherTable =
    others.length > 0
      ? `<details><summary>${others.length} more package${others.length === 1 ? '' : 's'} (safe, up to date or skipped)</summary><table><thead><tr><th>Status</th><th>Package</th><th>Version</th></tr></thead><tbody>${others
          .map(
            (row) =>
              `<tr><td><span class="badge ${TONE_CLASS[row.tone]}">${e(row.label)}</span></td><td class="mono">${e(row.result.name)}</td><td class="mono muted">${e(row.result.status === 'analyzed' ? versionText(row.result) : (row.result.reasons[0] ?? ''))}</td></tr>`,
          )
          .join('')}</tbody></table></details>`
      : '';

  const notes = [...new Set([...(options.notes ?? []), ...warnings.map((warning) => warning.message)])];
  const notesHtml = notes.length > 0 ? `<section class="notes"><strong>Notes</strong>${list(notes)}</section>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Dependency Radar report</title>
<style>${REPORT_STYLE}</style>
</head>
<body>
<main>
${options.homeHref ? `<nav class="nav"><a href="${e(options.homeHref)}">&larr; Analyze another project</a></nav>` : ''}${options.banner ? `<p class="banner">${e(options.banner)}</p>` : ''}
<header><div class="brand"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="6" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="2" fill="var(--accent)"/></svg>Dependency Radar</div><p class="meta">${meta.join(' &middot; ')}</p></header>
<section class="tiles">${tiles}</section>
<section class="cards">${cards}</section>
${otherTable}
${notesHtml}
<footer>A breaking verdict means your code uses a name the changelog marks as changed or removed. It is a signal, not a guarantee.</footer>
</main>
</body>
</html>
`;
}
