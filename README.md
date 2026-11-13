# Dependency Radar

Tells you which dependency updates will break your code.



## Requirements

Node.js 22.18 or newer. The tests run TypeScript directly with Node's built-in type stripping.

## Try it on a project

```
npm run radar -- path/to/package.json
```

It reads the package-lock.json next to it when there is one. It also reads the source code in the same folder and shows where each package is used. Options: `--all`, `--json`, `--html <path>`, `--fail-on-breaking`, `--fail-on-major`, `--lockfile <path>`, `--no-scan`, `--no-changelog`, `--no-ai`, `--no-color`.

`--html report.html` also writes a self-contained report page (no scripts, no external requests, light and dark mode) that you can open in a browser or screenshot.

Changelogs come from GitHub without a token for up to 60 requests per hour. Set `GITHUB_TOKEN` to raise that limit.

### Optional AI explanations

Set an OpenAI-compatible endpoint and key (for example a free-tier key):

```
RADAR_AI_BASE_URL=https://api.groq.com/openai/v1 RADAR_AI_KEY=... RADAR_AI_MODEL=... npm run radar -- path/to/package.json
```

Allowed hosts: api.openai.com, generativelanguage.googleapis.com, api.groq.com, openrouter.ai. The key is only sent in the Authorization header and is never printed. Changelog text is sent to that service, so do not use it for private packages you cannot share.

## Pre-install check

For a project you have downloaded but not installed, for example one sent to you as a coding test:

```
npm run radar -- check ../the-project --html report.html
```

In the web service, open `/check` and enter a public GitHub repository address (`POST /api/check` returns JSON). It only reads files and never runs them.

It looks for: install scripts (`preinstall`, `install`, `postinstall`, `prepare`) that download and run code, use encoded commands, run hidden files or files that are not in the repository, and for anything such a script runs (including `npm run` chains and the files they start); VS Code tasks that run when the folder is opened, dev container commands and the setting that allows them; dependencies installed from web addresses or git, aliases that swap a popular name for another package, and look-alike names of popular packages (`crossenv`, `lodahs`); lockfiles that download from other hosts; other registries, `script-shell` and committed credentials in `.npmrc` (credentials are never shown); Yarn paths and plugins; code that decodes and runs text, obfuscated code, chat webhooks, raw IP addresses, file-drop services and code that looks for SSH keys or wallets; and committed `node_modules` or program files.

The verdict is always worded as signals. A result with no signals says so plainly and never says a project is safe. With `--stats` (CLI) or in the web service, look-alike names are checked against their weekly downloads on npm to tell a typo-squat from a real small package.

Known limits: it is a heuristic check, not a malware scanner, so expect both false alarms and misses. Packages are only compared with a built-in list of about 250 popular names. Only text files are read. Files in `node_modules`, `dist` and similar folders are skipped. Open unknown projects in a disposable environment (a Codespace, a container or a virtual machine) even when nothing is found.

## From a security ticket to changes

Paste the text of a security ticket (Snyk, Dependabot, Trivy, `npm audit` or an internal ticket) together with your package.json and package-lock.json. You get what to change, on which line, to which version and why, as a ready patch.

```
npm run radar -- fix --ticket ticket.txt ../the-project/package.json --html fix.html --pr pr.md
```

In the web service, open `/fix` (`/fix/example` fills the form with an example, `/fix/demo` shows a sample result built offline, `POST /api/fix` returns JSON). You can paste the files or give a public GitHub repository.

How it works:

1. The facts are read from the ticket: package, affected version, fixed version, CVE or GHSA id, severity. When no fixed version is given, the advisory id is looked up in the OSV database (`api.osv.dev`, added to the allow-list). `--offline` or `--no-lookup` turns this off, and only the id and the package name are ever sent.
2. The package is found in the project: direct or indirect, and with the lockfile the path that pulls it in (`project > express@4.17.1 > qs@6.7.0`). Every installed copy is listed with its own path.
3. Options are built: raise the direct dependency, update inside the existing range (`npm update`), or an override (`overrides`, `resolutions` or `pnpm.overrides`, decided by the package manager). The recommended option is applied to a copy of package.json by editing the text, so the formatting is kept and the diff only has the changed lines. The line number comes from the JSON structure, not from AI.
4. For a major fix, the cost is shown before the recommendation, and the changelog between the two versions is checked against the names your code imports (parts 3 and 4). When the changelog cannot be found the answer is "I am not sure".
5. The output is the diff, the commands to refresh the lockfile and a list of checks (`npm ls <package>`, `npm audit`, your tests).

The wording never says a vulnerability is fixed. It says "according to the advisory it is fixed in X; verify with npm audit".

Cases it handles: several copies of one package in different versions, a ticket without any fixed version ("no fix", nothing is invented), a package that is only a dev dependency, a fix that is already installed, a package that is not in the project, a missing or unsupported lockfile (then only direct dependencies are found), an existing override that blocks the fixed version, a direct dependency that clashes with a nested copy, `npm audit fix --force` or a suggested downgrade (flagged as a risk and not used), and tickets for other ecosystems (not recognised, so reported as not analyzed).

### Several tickets at once

Put several tickets in one file separated by a line of three dashes (or repeat `--ticket`, or paste them in the web form separated the same way). The result is one diff and a table that shows which change closes which ticket. Two tickets for the same package with different fixed versions get the lowest version that satisfies both, and the cost is shown if that is a major version. A repeated advisory or an identical ticket is merged. A ticket that cannot be read is listed as "not analyzed" with the reason and does not stop the others. At most 20 tickets and about 200 000 characters are read.

### Description for the pull request or Jira

`--pr pr.md` (or `--pr -` to print only the description) writes a description with a one-line title, what changes (package, from which version to which, the package.json line), why (advisory ids and the careful wording above), the risk (a major change, and which files import the package), the checks, the references and what was left unchanged. `--pr-format jira` gives plain text, `--lang sq` gives Albanian, and the text is shortened to the limits of GitHub (60 000 characters) and Jira (30 000). If the ticket has no id the field says so and nothing is invented. The web result shows both versions as text that can be selected with one click, because the pages have no scripts. A warning reminds you to check for confidential text before pasting.

### In a CI job

`--fail-if-changes` exits with code 2 when any package needs a change, 0 when nothing does and 1 on an error. Reading your files, the import scan and the diff happen on your computer. There is no GitHub Action or `npx` package yet (part 9.3 of the plan is intentionally left for later).

Known limits of this part: the text of the ticket is trusted as written (a wrong fixed version in the ticket gives a wrong plan, so run `npm audit` afterwards); reachability is not checked, only whether a package is imported; only package-lock.json is read; and the ticket text is treated as data, never as instructions.

## Web service

```
npm start
```

Open http://localhost:8080. Paste a package.json or enter a public GitHub repository address (optionally a folder for monorepos, or a `/tree/branch/folder` address). `/demo` shows a sample report built offline from made-up packages, `/health` is for uptime checks, `/check` is the pre-install check, `/fix` turns security tickets into changes, and `/api/analyze`, `/api/demo`, `/api/check` and `/api/fix` return JSON.

What it does for safety: every outgoing request goes to an allow-list of hosts (npm, GitHub, the OSV advisory database and the supported AI hosts), repositories are read as zip files in memory with limits on size, entries and decompressed bytes (code is never executed or written to disk), requests are limited per address, the AI has a daily budget and a cap per analysis, a visitor's own AI key is used for one request only and is never stored, logged or sent back, and every page has a strict content security policy with no scripts.

Settings (environment variables): `PORT`, `HOST`, `TRUST_PROXY=1` (only behind a proxy you control, it uses the last X-Forwarded-For entry), `RATE_LIMIT_PER_HOUR` (default 20), `GITHUB_TOKEN`, and `RADAR_AI_BASE_URL`, `RADAR_AI_KEY`, `RADAR_AI_MODEL` plus `DAILY_AI_BUDGET` (default 100) to offer a free server-side AI. There is a `Dockerfile` and a `docker-compose.yml`.

The server is plain Node.js with no framework, so it runs without installing anything else. Caches are in memory and reset on restart. Analyses run inside the request (a typical project takes a few seconds, a large one up to a minute).

## Run

```
npm install
npm test
npm run typecheck
```

## Usage

```ts
import { readProject } from '@dependency-radar/core';

const result = readProject({ packageJson, lockfile });
if (result.ok) {
  console.log(result.value.entries, result.warnings);
} else {
  console.error(result.error.message, result.error.position);
}
```

```ts
import { analyzeProject, createMemoryCache, createRegistryClient, readProject, withCache } from '@dependency-radar/core';

const registry = withCache(createRegistryClient(), createMemoryCache());
const parsed = readProject({ packageJson, lockfile });
if (parsed.ok) {
  const { results, summary } = await analyzeProject(parsed.value.entries, { registry });
}
```

- Part 3: reads the source code with the TypeScript parser and shows where each package is used: which files, which imported names, and which members are accessed (for example `rr.json`). It understands static imports, `require`, dynamic `import()`, re-exports, `import x = require()` and type imports, ignores relative paths, tsconfig path aliases and Node built-ins, and also looks at package.json scripts.

- Part 4: finds the changelog (CHANGELOG.md in the package's GitHub repository, or its GitHub releases), keeps only the versions between yours and the latest, and checks whether the names your code imports are mentioned as changed or removed. This decides the final verdict: breaking, review, safe or unknown. An optional AI step explains the changelog, but it can only add a verified explanation: every finding must cite changelog lines that really contain the name it talks about, and it can never lower a verdict.

A "breaking candidate" is only a major version change. It becomes a real "breaking" verdict only when your code uses a name the changelog marks as changed or removed. A major update is never reported as safe automatically: without evidence it stays "review" with a confidence level.

## Known limits

- Only package-lock.json is read. pnpm-lock.yaml and yarn.lock are reported as unsupported.
- Monorepos: only the given package.json is analyzed.
- Registry lookups use the abbreviated npm metadata, so release dates are not available.
- The web service accepts public GitHub repositories only, up to about 25 MB compressed, and pasted files only up to the size limits. It has no accounts, no history and no database.
- At most 300 packages are analyzed per project.
- Changelogs: only GitHub repositories. Headings must contain a three-part version (for example 7.0.0). Release notes that do not name the changed API cannot produce a "breaking" verdict, so they end as "review".
- Only major and 0.x updates and other "review" cases are checked against changelogs, to save requests.
- The AI output is limited in size, is shown as plain text, and a claim without matching changelog lines is dropped. Changelog text is treated as data, but no prompt can be made completely injection-proof.
- Code scan: only .js, .jsx, .mjs, .cjs, .ts, .tsx, .mts and .cts files. Vue, Svelte and Astro files are reported as not analyzed. node_modules, dist, build and similar folders are skipped, and there are limits on the number and size of files.
- The scan never runs your code. "Appears unused" is a heuristic based on names, so shadowed variables can hide an unused import.
- Packages used only by JSON or YAML config (for example an .eslintrc.json) are reported as not imported. tsconfig `baseUrl` and `extends` are not followed.
- Git, URL, local and workspace dependencies are listed but marked as not analyzable.
