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
main{max-width:780px}
form{display:flex;flex-direction:column;gap:18px}
label{display:flex;flex-direction:column;gap:6px;font-weight:500}
label small,.hint{font-weight:400;color:var(--muted);font-size:13px}
textarea,input[type=text],input[type=password],input[type=url]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);font:14px 'IBM Plex Mono',ui-monospace,Menlo,monospace}
textarea{min-height:220px;resize:vertical}
fieldset{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0;display:flex;flex-direction:column;gap:10px}
legend{font-weight:500;padding:0 6px}
.radio{flex-direction:row;align-items:center;gap:8px;font-weight:400}
.actions{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
button,.button{min-height:44px;padding:0 20px;border-radius:8px;border:0;background:var(--accent);color:#fff;font:600 15px 'IBM Plex Sans',ui-sans-serif,system-ui,sans-serif;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.button.secondary{background:transparent;color:var(--accent);border:1px solid var(--line)}
.error{margin:0;padding:12px 14px;border-radius:8px;background:var(--red-bg);color:var(--red)}
h1{margin:0;font-size:26px}
.lead{margin:6px 0 0;color:var(--muted)}
.or{color:var(--muted);text-align:center;font-size:14px}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${REPORT_STYLE}${FORM_STYLE}</style>
</head>
<body>
<main>
${body}
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
    `<header><h1>Dependency Radar</h1><p class="lead">Find out which dependency updates will actually break your code, not just which ones exist.</p></header>
${error}
<form method="post" action="/report">
<label>Public GitHub repository <small>Best option: it also scans your code to show where each package is used.</small>
<input type="url" name="githubUrl" placeholder="https://github.com/owner/repo" value="${e(values.githubUrl ?? '')}" autocomplete="off"></label>
<label>Folder inside the repository <small>Optional, for monorepos, for example packages/web.</small>
<input type="text" name="path" placeholder="packages/web" value="${e(values.path ?? '')}" autocomplete="off"></label>
<p class="or">or paste a package.json</p>
<label>package.json
<textarea name="packageJson" spellcheck="false" placeholder="{ &quot;dependencies&quot;: { ... } }">${e(values.packageJson ?? '')}</textarea></label>
<details><summary>package-lock.json (optional, gives exact installed versions)</summary>
<label><textarea name="lockfile" spellcheck="false">${e(values.lockfile ?? '')}</textarea></label></details>
<fieldset>
<legend>AI explanations (optional)</legend>
${radio('none', 'No AI (the verdict never depends on AI anyway)')}
${server}
${radio('byok', 'Use my own key')}
<label>Address <small>An https address on api.openai.com, generativelanguage.googleapis.com, api.groq.com or openrouter.ai</small>
<input type="text" name="ai_baseUrl" placeholder="https://api.groq.com/openai/v1" value="${e(values.aiBaseUrl ?? '')}" autocomplete="off"></label>
<label>Model <input type="text" name="ai_model" value="${e(values.aiModel ?? '')}" autocomplete="off"></label>
<label>Key <small>Used for this request only. It is not stored or logged. Prefer a key you can revoke.</small>
<input type="password" name="ai_apiKey" autocomplete="off"></label>
<p class="hint">AI explanations send parts of the changelog to the service you choose.</p>
</fieldset>
<div class="actions"><button type="submit">Analyze</button><a class="button secondary" href="/demo">See a sample report</a><a class="button secondary" href="/check">Check a repository before installing it</a><a class="button secondary" href="/fix">Turn a security ticket into changes</a></div>
<p class="hint">Your package.json is used to look up public packages and is not stored. Only public repositories are supported.</p>
</form>`,
  );
}

export function renderErrorPage(title: string, message: string): string {
  return layout(title, `<header><h1>${e(title)}</h1></header><p class="error" role="alert">${e(message)}</p><p><a class="button secondary" href="/">Back</a></p>`);
}

export function renderCheckPage(options: { error?: string; githubUrl?: string } = {}): string {
  const error = options.error ? `<p class="error" role="alert">${e(options.error)}</p>` : '';
  return layout(
    'Pre-install check',
    `<header><h1>Pre-install check</h1><p class="lead">Got a project from someone you do not know, for example as a coding test? Check it for warning signs before you run npm install.</p></header>
${error}
<form method="post" action="/check">
<label>Public GitHub repository
<input type="url" name="githubUrl" placeholder="https://github.com/owner/repo" value="${e(options.githubUrl ?? '')}" autocomplete="off" required></label>
<div class="actions"><button type="submit">Check</button><a class="button secondary" href="/">Back</a></div>
<p class="hint">It looks for install scripts that download code, files that run when a folder is opened, look-alike package names, obfuscated code and more. It only reads files and never runs them. Finding no signals does not mean a repository is safe.</p>
</form>`,
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
    `<header><h1>From ticket to changes</h1><p class="lead">Paste a security ticket and your package.json. You get what to change, on which line, to which version, and why.</p></header>
${error}
<form method="post" action="/fix">
<label>Security ticket <small>From Snyk, Dependabot, Trivy, npm audit or your own team. For several tickets, separate them with a line of three dashes (---).</small>
<textarea name="ticket" spellcheck="false" placeholder="Affected package: lodash&#10;Installed version: 4.17.20&#10;Fixed in: 4.17.21&#10;CVE-2021-23337">${e(values.ticket ?? '')}</textarea></label>
<label>package.json
<textarea name="packageJson" spellcheck="false" placeholder="{ &quot;dependencies&quot;: { ... } }">${e(values.packageJson ?? '')}</textarea></label>
<details><summary>package-lock.json (optional, needed to trace packages that you do not depend on directly)</summary>
<label><textarea name="lockfile" spellcheck="false">${e(values.lockfile ?? '')}</textarea></label></details>
<p class="or">or use a public GitHub repository instead of pasting the files</p>
<label>Public GitHub repository <small>It also shows which files use each package.</small>
<input type="url" name="githubUrl" placeholder="https://github.com/owner/repo" value="${e(values.githubUrl ?? '')}" autocomplete="off"></label>
<label>Folder inside the repository <small>Optional, for monorepos.</small>
<input type="text" name="path" placeholder="packages/web" value="${e(values.path ?? '')}" autocomplete="off"></label>
<fieldset>
<legend>Options</legend>
<label>Package manager <select name="packageManager">${option('', 'Detect from package.json (npm if unknown)', values.packageManager)}${option('npm', 'npm', values.packageManager)}${option('yarn', 'Yarn', values.packageManager)}${option('pnpm', 'pnpm', values.packageManager)}</select></label>
<label>Language of the pull request description <select name="language">${option('en', 'English', values.language, 'en')}${option('sq', 'Shqip', values.language, 'en')}</select></label>
</fieldset>
<div class="actions"><button type="submit">Make the changes</button><a class="button secondary" href="/fix/example">Fill in an example</a><a class="button secondary" href="/fix/demo">See a sample result</a><a class="button secondary" href="/">Back</a></div>
<p class="hint">Do not paste confidential information. The ticket and your files are used to build the answer and are not stored. When a ticket has no fixed version, its advisory id and package name are sent to the OSV advisory database.</p>
</form>`,
  );
}
