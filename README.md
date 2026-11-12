# Dependency Radar

Tells you which dependency updates will break your code.

## Status

Parts 1 to 4 and 7 are done in `@dependency-radar/core`, `@dependency-radar/cli` prints the result in the terminal, and `@dependency-radar/service` is a web service that serves the same analysis in a browser.

- Part 1: reads and validates a package.json (and an optional package-lock.json), classifies every version specifier, and records the exact line and column of each dependency.
- Part 2: looks up each package in the npm registry (retries, backoff, timeouts, host allow-list, cache) and gives every dependency a preliminary verdict from semver: safe, review or breaking candidate, with a confidence level and the reasons.

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

## Web service

```
npm start
```

Open http://localhost:8080. Paste a package.json or enter a public GitHub repository address (optionally a folder for monorepos, or a `/tree/branch/folder` address). `/demo` shows a sample report built offline from made-up packages, `/health` is for uptime checks, and `/api/analyze` and `/api/demo` return JSON.

What it does for safety: every outgoing request goes to an allow-list of hosts (npm, GitHub, and the supported AI hosts), repositories are read as zip files in memory with limits on size, entries and decompressed bytes (code is never executed or written to disk), requests are limited per address, the AI has a daily budget and a cap per analysis, a visitor's own AI key is used for one request only and is never stored, logged or sent back, and every page has a strict content security policy with no scripts.

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
