import { escapeHtml, REPORT_STYLE } from '@dependency-radar/core';

export const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export interface HomeValues {
  packageJson?: string;
  lockfile?: string;
  githubUrl?: string;
  path?: string;
  aiMode?: string;
  aiBaseUrl?: string;
  aiModel?: string;
}

export interface HomeOptions {
  serverAiEnabled: boolean;
  error?: string;
  values?: HomeValues;
}

const e = escapeHtml;

const FORM_STYLE = `
.page-main{max-width:1080px;gap:30px}
.site-nav{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.site-brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);font-size:16px;font-weight:700;text-decoration:none}
.site-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--accent);color:#fff;font-size:18px}
.site-links{display:flex;flex-wrap:wrap;gap:8px 20px}
.site-links a{color:var(--muted);font-size:14px;text-decoration:none}
.site-links a:hover,.site-links a:focus-visible{color:var(--accent)}
.hero{max-width:790px;padding:22px 0 4px}
.eyebrow{margin:0 0 10px;color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}
h1{margin:0;font-size:clamp(32px,5vw,48px);line-height:1.08;letter-spacing:-.04em}
.lead{max-width:680px;margin:14px 0 0;color:var(--muted);font-size:17px;line-height:1.65}
.form-card{padding:clamp(18px,3vw,30px);background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 24px rgb(20 30 60 / .05)}
form{display:flex;flex-direction:column;gap:20px}
label{display:flex;flex-direction:column;gap:7px;font-weight:600}
label small,.hint{font-weight:400;color:var(--muted);font-size:13px;line-height:1.55}
input[type=text],input[type=password],input[type=url],select,textarea{width:100%;min-height:46px;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
textarea{min-height:190px;resize:vertical;line-height:1.55}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.field-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(180px,1fr);gap:16px;align-items:end}
.section-label{margin:0 0 12px;font-size:15px;font-weight:700}
.divider{display:flex;align-items:center;gap:14px;color:var(--muted);font-size:13px}
.divider:before,.divider:after{content:'';height:1px;flex:1;background:var(--line)}
.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
button,.button{min-height:46px;padding:0 20px;border-radius:9px;border:0;background:var(--accent);color:#fff;font:650 15px ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;transition:transform .15s ease,filter .15s ease}
button:hover,.button:hover{filter:brightness(1.08);transform:translateY(-1px)}
.button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
.button.primary{box-shadow:0 5px 14px color-mix(in srgb,var(--accent) 24%,transparent)}
.error{margin:0;padding:13px 16px;border-radius:10px;background:var(--red-bg);color:var(--red)}
.hint{margin:0}
.helper{display:flex;gap:10px;align-items:flex-start;padding:13px 15px;border-radius:10px;background:var(--bg);color:var(--muted);font-size:13px;line-height:1.55}
.helper strong{color:var(--ink)}
details{padding:14px 16px}
details summary{display:list-item}
.advanced{display:flex;flex-direction:column;gap:16px}
fieldset{border:1px solid var(--line);border-radius:11px;padding:16px;margin:0;display:flex;flex-direction:column;gap:12px}
legend{font-weight:700;padding:0 7px}
.radio{flex-direction:row;align-items:flex-start;gap:9px;font-weight:400}
.radio input{margin:4px 0 0;accent-color:var(--accent)}
.workflow-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.workflow-card{display:flex;flex-direction:column;gap:9px;min-height:155px;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);text-decoration:none;transition:border-color .15s ease,transform .15s ease}
.workflow-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.workflow-card strong{font-size:16px}
.workflow-card span{color:var(--muted);font-size:14px;line-height:1.55}
.workflow-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--gray-bg);color:var(--accent);font-size:17px;font-weight:700}
.or{color:var(--muted);text-align:center;font-size:14px}
.page-footer{padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.6}
@media(max-width:700px){.page-main{padding:20px 16px 36px;gap:23px}.site-nav{align-items:flex-start;flex-direction:column}.site-links{gap:8px 16px}.hero{padding-top:8px}.lead{font-size:16px}.field-row,.workflow-grid{grid-template-columns:1fr}.form-card{border-radius:14px}.actions>*{width:100%}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important}}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f6f5f1">
<title>${e(title)}</title>
<style>${REPORT_STYLE}${FORM_STYLE}</style>
</head>
<body>
<main class="page-main">
<nav class="site-nav" aria-label="Main navigation"><a class="site-brand" href="/"><span class="site-mark" aria-hidden="true">◎</span><span>Dependency Radar</span></a><div class="site-links"><a href="/demo">Demo</a><a href="/check">Pre-install check</a><a href="/fix">Fix a security ticket</a></div></nav>
${body}
<footer class="page-footer">Dependency Radar provides evidence-based signals to help you decide what to review. It does not guarantee that a project or update is safe.</footer>
</main>
</body>
</html>
`;
}

export function renderHomePage(options: HomeOptions): string {
  const values = options.values ?? {};
  const mode = values.aiMode ?? 'none';
  const radio = (value: string, label: string, disabled = false): string =>
    `<label class="radio"><input type="radio" name="ai_mode" value="${value}"${mode === value ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${e(label)}</label>`;

  const error = options.error ? `<p class="error" role="alert">${e(options.error)}</p>` : '';
  const server = options.serverAiEnabled
    ? radio('server', 'Use the free AI of this server (limited per day)')
    : radio('server', 'Use the free AI of this server (not enabled)', true);

  return layout(
    'Dependency Radar',
    `<section class="hero"><p class="eyebrow">Dependency update intelligence</p><h1>Know what an update could break.</h1><p class="lead">See which packages need attention, why they matter, and how your code uses them—before you update.</p></section>
${error}
<section class="form-card" aria-labelledby="analyze-title">
<form method="post" action="/report">
<div><h2 id="analyze-title" class="section-label">Analyze a project</h2><p class="hint">Start with a public GitHub repository for the most complete analysis.</p></div>
<label>Public GitHub repository <small>We read the repository to scan imports and find package usage. Public repositories only.</small>
<input type="url" name="githubUrl" placeholder="https://github.com/owner/repo" value="${e(values.githubUrl ?? '')}" autocomplete="url"></label>
<div class="field-row"><label>Folder inside repository <small>Optional; useful for monorepos.</small>
<input type="text" name="path" placeholder="packages/web" value="${e(values.path ?? '')}" autocomplete="off"></label><p class="hint">Example: <code>packages/web</code></p></div>
<div class="divider">or analyze pasted files</div>
<details class="advanced-input"${values.packageJson ? ' open' : ''}><summary>Paste a package.json instead</summary><div class="advanced">
<label>package.json<textarea name="packageJson" spellcheck="false" placeholder="{ &quot;dependencies&quot;: { ... } }">${e(values.packageJson ?? '')}</textarea></label>
<details${values.lockfile ? ' open' : ''}><summary>package-lock.json (optional; adds exact installed versions)</summary><label><textarea name="lockfile" spellcheck="false" placeholder="Paste package-lock.json">${e(values.lockfile ?? '')}</textarea></label></details>
</div></details>
<details class="advanced-input"${mode === 'byok' ? ' open' : ''}><summary>Optional: add an AI explanation</summary><div class="advanced">
<p class="hint">AI can explain changelog details. It never decides the verdict.</p>
<fieldset><legend>Explanation provider</legend>
${radio('none', 'No AI (recommended default)')}
${server}
${radio('byok', 'Use my own key for this request')}
</fieldset>
<label>Service address <small>Supported: api.openai.com, generativelanguage.googleapis.com, api.groq.com or openrouter.ai.</small>
<input type="text" name="ai_baseUrl" placeholder="https://api.groq.com/openai/v1" value="${e(values.aiBaseUrl ?? '')}" autocomplete="url"></label>
<label>Model <input type="text" name="ai_model" value="${e(values.aiModel ?? '')}" autocomplete="off"></label>
<label>API key <small>Used for this request only; never paste a key you cannot revoke.</small>
<input type="password" name="ai_apiKey" autocomplete="new-password"></label>
<p class="hint">Changelog text is sent to the AI service you choose. Your key is not stored or logged.</p>
</div></details>
<div class="actions"><button class="primary" type="submit">Analyze dependencies</button><a class="button secondary" href="/demo">View sample report</a></div>
<p class="helper"><span aria-hidden="true">i</span><span><strong>Privacy:</strong> submitted files are used for this analysis and are not stored. Public package metadata is looked up from npm.</span></p>
</form>
</section>
<section aria-labelledby="more-tools-title"><h2 id="more-tools-title" class="section-label">More developer tools</h2><div class="workflow-grid">
<a class="workflow-card" href="/check"><span class="workflow-icon" aria-hidden="true">✓</span><strong>Pre-install check</strong><span>Look for suspicious signals in an unfamiliar repository before running its code.</span></a>
<a class="workflow-card" href="/fix"><span class="workflow-icon" aria-hidden="true">↗</span><strong>Fix from a security ticket</strong><span>Turn advisory details into a proposed dependency change and reviewable diff.</span></a>
</div></section>`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return layout(title, `<header><h1>${e(title)}</h1></header><p class="error" role="alert">${e(message)}</p><p><a class="button secondary" href="/">Back</a></p>`);
}

export function renderCheckPage(options: { error?: string; githubUrl?: string } = {}): string {
  const error = options.error ? `<p class="error" role="alert">${e(options.error)}</p>` : '';
  return layout(
    'Pre-install check',
    `<section class="hero"><p class="eyebrow">Review before you run</p><h1>Check an unfamiliar project first.</h1><p class="lead">Inspect a public repository for suspicious signals before installing dependencies or running its code.</p></section>
${error}
<section class="form-card"><form method="post" action="/check">
<label>Public GitHub repository <small>Paste the repository URL. This check reads files but does not run them.</small>
<input type="url" name="githubUrl" placeholder="https://github.com/owner/repo" value="${e(options.githubUrl ?? '')}" autocomplete="url" required></label>
<div class="actions"><button class="primary" type="submit">Check repository</button><a class="button secondary" href="/">Back to analysis</a></div>
<p class="helper"><span aria-hidden="true">i</span><span><strong>What to expect:</strong> the check looks for known warning signs, such as risky install scripts, look-alike packages and obfuscated code. It is heuristic—not a malware scanner. Finding no signals does not mean a repository is safe.</span></p>
</form></section>`,
  );
}

export interface FixPageValues {
  ticket?: string;
  packageJson?: string;
  lockfile?: string;
  githubUrl?: string;
  path?: string;
  packageManager?: string;
  language?: string;
}

export function renderFixPage(options: { error?: string; values?: FixPageValues } = {}): string {
  const values = options.values ?? {};
  const error = options.error ? `<p class="error" role="alert">${e(options.error)}</p>` : '';
  const option = (value: string, label: string, current: string | undefined, fallback = ''): string =>
    `<option value="${value}"${(current ?? fallback) === value ? ' selected' : ''}>${e(label)}</option>`;
  return layout(
    'From ticket to changes',
    `<section class="hero"><p class="eyebrow">Security-ticket workflow</p><h1>Turn an advisory into a reviewable change.</h1><p class="lead">Add the ticket and project details. Get a proposed version update, the reason behind it, and a diff to review.</p></section>
${error}
<section class="form-card"><form method="post" action="/fix">
<div><h2 class="section-label">1. Add the security ticket</h2><p class="hint">Paste a Snyk, Dependabot, Trivy, npm audit or internal ticket. Separate multiple tickets with a line containing ---.</p></div>
<label>Ticket details<textarea name="ticket" spellcheck="false" placeholder="Affected package: lodash&#10;Installed version: 4.17.20&#10;Fixed in: 4.17.21&#10;CVE-2021-23337">${e(values.ticket ?? '')}</textarea></label>
<div><h2 class="section-label">2. Add the project to inspect</h2><p class="hint">Use a public GitHub repository, or paste the project files below.</p></div>
<label>Public GitHub repository <small>Optional. Also scans source files to show where packages are used.</small>
<input type="url" name="githubUrl" placeholder="https://github.com/owner/repo" value="${e(values.githubUrl ?? '')}" autocomplete="url"></label>
<div class="field-row"><label>Folder inside repository <small>Optional for monorepos.</small>
<input type="text" name="path" placeholder="packages/web" value="${e(values.path ?? '')}" autocomplete="off"></label><p class="hint">Example: <code>packages/web</code></p></div>
<details class="advanced-input"${values.packageJson ? ' open' : ''}><summary>Or paste package.json${values.packageJson ? ' (provided)' : ''}</summary><div class="advanced">
<label>package.json<textarea name="packageJson" spellcheck="false" placeholder="{ &quot;dependencies&quot;: { ... } }">${e(values.packageJson ?? '')}</textarea></label>
<details${values.lockfile ? ' open' : ''}><summary>package-lock.json (optional; helps trace transitive dependencies)</summary><label><textarea name="lockfile" spellcheck="false" placeholder="Paste package-lock.json">${e(values.lockfile ?? '')}</textarea></label></details>
</div></details>
<details class="advanced-input"><summary>Options</summary><div class="advanced">
<label>Package manager <select name="packageManager">${option('', 'Detect from package.json (npm if unknown)', values.packageManager)}${option('npm', 'npm', values.packageManager)}${option('yarn', 'Yarn', values.packageManager)}${option('pnpm', 'pnpm', values.packageManager)}</select></label>
<label>Pull request description language <select name="language">${option('en', 'English', values.language, 'en')}${option('sq', 'Shqip', values.language, 'en')}</select></label>
</div></details>
<div class="actions"><button class="primary" type="submit">Build proposed changes</button><a class="button secondary" href="/fix/example">Load example</a><a class="button secondary" href="/fix/demo">View sample result</a></div>
<p class="helper"><span aria-hidden="true">i</span><span><strong>Privacy:</strong> do not paste confidential information. Ticket and project files are used to build the result, not stored. If a ticket omits the fixed version, its advisory ID and package name may be looked up in OSV.</span></p>
</form></section>`,
  );
}
