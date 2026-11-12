import ts from 'typescript';
import { findLookalike, isPopularPackage } from './risk-lookalike.ts';
import { scanTextForRisks } from './risk-patterns.ts';
import { analyzeCommand, isBenignCommand, LIFECYCLE_SCRIPTS, referencedScriptFiles, referencedScriptNames } from './risk-scripts.ts';
import type { CommandFinding } from './risk-scripts.ts';
import { lowerSeverity, SEVERITY_RANK } from './risk-types.ts';
import type { RiskConfidence, RiskReport, RiskSeverity, RiskSignal } from './risk-types.ts';
import { IGNORED_DIRECTORIES } from './scan-project.ts';
import type { SourceFile } from './scan-project.ts';
import { parseSpecifier } from './specifier.ts';
import { createPositionResolver, isPlainObject, isValidPackageName, stringRecord } from './util.ts';

export interface RepositoryInput {
  files: readonly SourceFile[];
  names?: readonly string[];
}

export interface AssessOptions {
  maxFiles?: number;
  maxFileChars?: number;
  maxSignals?: number;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const SHELL_FILE = /\.(?:sh|bash|ps1|bat|cmd)$/i;
const CONFIG_FILE = /(?:^|\/)(?:(?:next|nuxt|vite|vitest|webpack|rollup|jest|babel|eslint|tailwind|postcss|svelte|astro|metro|craco|vue)\.config\.[cm]?[jt]s|(?:gulpfile|Gruntfile)\.[cm]?[jt]s|\.(?:babelrc|eslintrc|prettierrc)\.[cm]?js)$/;
const QUIET_PATH = /(?:^|\/)(?:__tests__|tests?|spec|fixtures?|__mocks__|docs?|examples?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;
const STRONG_BINARIES: ReadonlySet<string> = new Set(['exe', 'dll', 'scr', 'msi', 'vbs', 'jar', 'com']);
const WEAK_BINARIES: ReadonlySet<string> = new Set(['bat', 'cmd', 'ps1', 'dmg', 'pkg', 'apk', 'deb', 'rpm']);
const DEVCONTAINER_KEYS: readonly string[] = ['initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand', 'postStartCommand', 'postAttachCommand'];
const TRUSTED_LOCK_HOSTS: ReadonlySet<string> = new Set(['registry.npmjs.org', 'registry.yarnpkg.com', 'github.com', 'codeload.github.com']);
const MAX_PACKAGE_FILES = 25;
const MAX_GENERAL_FILES = 400;
const MAX_LOCK_ENTRIES = 20_000;

const BASE_LIMITATIONS: readonly string[] = [
  'This is a heuristic check, not a malware scan. Finding no signals does not mean a repository is safe.',
  'Files are only read as text. Binary files are not inspected, and the code is never run.',
  'Open unknown repositories only in a disposable environment (a Codespace, a container or a virtual machine), not on your own computer.',
];

function extensionOf(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? (match[1] as string).toLowerCase() : '';
}

function inIgnoredDirectory(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function shorten(text: string, limit = 200): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function summarizeSignals(report: RiskReport): void {
  report.signals.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.id.localeCompare(b.id),
  );
  let highest: RiskSeverity | 'none' = 'none';
  for (const signal of report.signals) {
    if (highest === 'none' || SEVERITY_RANK[signal.severity] > SEVERITY_RANK[highest]) highest = signal.severity;
  }
  report.highest = highest;
}

function flattenCommand(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').join(' ');
  if (isPlainObject(value)) return Object.values(value).map(flattenCommand).join(' ; ');
  return '';
}

function hostOf(value: string): string | undefined {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return undefined;
  }
}

export function assessRepository(input: RepositoryInput, options: AssessOptions = {}): RiskReport {
  const maxFiles = options.maxFiles ?? 800;
  const maxFileChars = options.maxFileChars ?? 400_000;
  const maxSignals = options.maxSignals ?? 200;
  const limitations = [...BASE_LIMITATIONS];

  const signals: RiskSignal[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let checkedDependencies = 0;

  function add(signal: RiskSignal): void {
    const key = `${signal.id}|${signal.file ?? ''}|${signal.line ?? ''}|${signal.subject ?? ''}|${signal.title}`;
    if (seen.has(key)) return;
    if (signals.length >= maxSignals) {
      truncated = true;
      return;
    }
    seen.add(key);
    signals.push(signal);
  }

  const files = new Map<string, string>();
  const sorted = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  let skippedLarge = 0;
  for (const file of sorted) {
    const path = file.path.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (inIgnoredDirectory(path)) continue;
    if (files.size >= maxFiles) {
      truncated = true;
      continue;
    }
    if (file.content.length > maxFileChars) {
      skippedLarge++;
      continue;
    }
    files.set(path, file.content);
  }
  if (skippedLarge > 0) limitations.push(`${skippedLarge} file${skippedLarge === 1 ? ' was' : 's were'} too large to read.`);

  const executable = new Map<string, { script: string; lifecycle: boolean }>();

  function analyzePackage(path: string, text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!isPlainObject(data)) return;

    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const resolve = createPositionResolver(text);
    const lineOf = (key: string): number | undefined => {
      const match = new RegExp(`"${escapeRegExp(key)}"\\s*:`).exec(text);
      return match ? resolve(match.index).line : undefined;
    };
    const place = (key: string): { file: string; line?: number } => {
      const line = lineOf(key);
      return line === undefined ? { file: path } : { file: path, line };
    };

    const scripts = stringRecord(data.scripts);

    function commandsFor(command: string, depth = 0, visited = new Set<string>()): string[] {
      const all = [command];
      if (depth >= 3) return all;
      for (const name of referencedScriptNames(command)) {
        const nested = scripts[name];
        if (nested !== undefined && !visited.has(name)) {
          visited.add(name);
          all.push(...commandsFor(nested, depth + 1, visited));
        }
      }
      return all;
    }

    for (const [name, command] of Object.entries(scripts)) {
      const lifecycle = LIFECYCLE_SCRIPTS.includes(name);
      const commands = commandsFor(command);
      const findings = new Map<string, CommandFinding>();
      for (const item of commands) for (const finding of analyzeCommand(item)) if (!findings.has(finding.id)) findings.set(finding.id, finding);

      if (lifecycle && findings.size === 0) {
        const benign = commands.every(isBenignCommand);
        add({
          id: 'lifecycle-script',
          severity: benign ? 'info' : 'low',
          confidence: 'high',
          title: `Runs "${name}" automatically on npm install`,
          detail: benign
            ? 'This script runs when you install the project. It looks like a common tool.'
            : 'This script runs when you install the project, before you can read the code it starts.',
          ...place(name),
          excerpt: shorten(command),
        });
      }

      for (const finding of findings.values()) {
        let severity: RiskSeverity | undefined = finding.severity;
        if (!lifecycle) severity = lowerSeverity(finding.severity);
        if (severity === undefined) continue;
        add({
          id: finding.id,
          severity,
          confidence: finding.confidence,
          title: `${finding.title} in "${name}"`,
          detail: lifecycle ? `${finding.detail} It runs automatically when you install the project.` : finding.detail,
          ...place(name),
          excerpt: shorten(command),
        });
      }

      for (const item of commands) {
        for (const reference of referencedScriptFiles(item)) {
          const target = normalizePath(`${dir}${reference}`);
          if (target === undefined || inIgnoredDirectory(target)) continue;
          if (files.has(target)) {
            if (!executable.has(target) || (lifecycle && !executable.get(target)?.lifecycle)) executable.set(target, { script: name, lifecycle });
          } else if (lifecycle && (CODE_FILE.test(target) || SHELL_FILE.test(target))) {
            add({
              id: 'script-missing-file',
              severity: 'medium',
              confidence: 'medium',
              title: `"${name}" runs a file that is not in the repository`,
              detail: 'The file may be created or downloaded during install, so you cannot read it beforehand.',
              ...place(name),
              excerpt: shorten(item),
              subject: target,
            });
          }
        }
      }
    }

    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const block = data[section];
      if (!isPlainObject(block)) continue;
      for (const [name, spec] of Object.entries(block)) {
        if (typeof spec !== 'string' || !isValidPackageName(name)) continue;
        checkedDependencies++;
        const parsed = parseSpecifier(spec);
        const where = place(name);

        if (parsed.kind === 'url' || parsed.kind === 'git') {
          const host = hostOf(spec.replace(/^git\+/, '')) ?? '';
          const risky = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(host) || /^http:/i.test(spec) || /bit\.ly|tinyurl|t\.co|goo\.gl/i.test(host);
          const github = host === 'github.com' || /^(?:github:|[\w.-]+\/[\w.-]+(?:#.*)?$)/.test(spec);
          add({
            id: 'non-registry-dependency',
            severity: risky ? 'high' : github ? 'low' : 'medium',
            confidence: risky ? 'high' : 'medium',
            title: `"${name}" is installed from outside the npm registry`,
            detail: 'It comes straight from a web address or a git repository, so it was not reviewed by the registry and can change at any time.',
            ...where,
            excerpt: `${name}: ${shorten(spec, 120)}`,
            subject: name,
          });
        } else if (parsed.kind === 'alias' && isPopularPackage(name) && parsed.aliasOf !== name) {
          add({
            id: 'dependency-alias',
            severity: 'medium',
            confidence: 'medium',
            title: `"${name}" actually installs a different package`,
            detail: `The popular name "${name}" is an alias for "${parsed.aliasOf}".`,
            ...where,
            excerpt: `${name}: ${shorten(spec, 120)}`,
            subject: name,
          });
        }

        const lookalike = findLookalike(name);
        if (lookalike) {
          const strong = lookalike.kind !== 'edit';
          add({
            id: 'dependency-lookalike',
            severity: strong ? 'medium' : 'low',
            confidence: strong ? 'medium' : 'low',
            title: `"${name}" looks like the popular package "${lookalike.popular}"`,
            detail: 'Packages with names almost identical to popular ones are a common way to spread malware. Check that this is the package you intend.',
            ...where,
            excerpt: `${name}: ${shorten(spec, 120)}`,
            subject: name,
          });
        }
      }
    }
  }

  function analyzeLockfile(path: string, text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!isPlainObject(data)) return;
    const hosts = new Map<string, { count: number; examples: string[] }>();
    let processed = 0;
    const note = (name: string, resolved: unknown): void => {
      if (typeof resolved !== 'string' || processed++ > MAX_LOCK_ENTRIES) return;
      const host = hostOf(resolved.replace(/^git\+/, ''));
      if (host === undefined || TRUSTED_LOCK_HOSTS.has(host)) return;
      const entry = hosts.get(host) ?? { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(name);
      hosts.set(host, entry);
    };
    if (isPlainObject(data.packages)) {
      for (const [key, value] of Object.entries(data.packages)) if (isPlainObject(value)) note(key.replace(/^.*node_modules\//, ''), value.resolved);
    } else if (isPlainObject(data.dependencies)) {
      for (const [key, value] of Object.entries(data.dependencies)) if (isPlainObject(value)) note(key, value.resolved);
    }
    for (const [host, entry] of hosts) {
      const risky = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?$/.test(host) || /^http:/i.test(text.slice(text.indexOf(host) - 8, text.indexOf(host)));
      add({
        id: 'lockfile-host',
        severity: risky ? 'high' : 'medium',
        confidence: risky ? 'high' : 'low',
        title: `The lockfile downloads ${entry.count} package${entry.count === 1 ? '' : 's'} from ${host}`,
        detail: 'Lockfiles normally point to the npm registry. A different host can be a private registry, or a way to swap in different code.',
        file: path,
        excerpt: `For example: ${entry.examples.join(', ')}`,
        subject: host,
      });
    }
  }

  function analyzeCommandsIn(path: string, text: string, id: string, label: string, baseline: RiskSeverity | undefined, line: number | undefined): void {
    const findings = analyzeCommand(text);
    if (baseline !== undefined && findings.length === 0) {
      add({
        id,
        severity: baseline,
        confidence: 'high',
        title: label,
        detail: 'This command runs automatically, without you choosing to run it.',
        file: path,
        ...(line === undefined ? {} : { line }),
        excerpt: shorten(text),
      });
    }
    for (const finding of findings) {
      add({
        id: finding.id,
        severity: finding.severity,
        confidence: finding.confidence,
        title: `${finding.title} (${label})`,
        detail: finding.detail,
        file: path,
        ...(line === undefined ? {} : { line }),
        excerpt: shorten(text),
      });
    }
  }

  function analyzeJsonc(text: string): Record<string, unknown> | undefined {
    const parsed = ts.parseConfigFileTextToJson('config.json', text);
    return !parsed.error && isPlainObject(parsed.config) ? parsed.config : undefined;
  }

  function analyzeVscodeTasks(path: string, text: string): void {
    const resolve = createPositionResolver(text);
    const auto = /["']runOn["']\s*:\s*["']folderOpen["']/.exec(text);
    if (auto) {
      add({
        id: 'vscode-auto-task',
        severity: 'high',
        confidence: 'high',
        title: 'A VS Code task runs as soon as the folder is opened',
        detail: 'This is a known way to run code on your computer just by opening the project in VS Code.',
        file: path,
        line: resolve(auto.index).line,
        excerpt: shorten(auto[0]),
      });
    }
    const config = analyzeJsonc(text);
    const tasks = Array.isArray(config?.tasks) ? config.tasks : [];
    for (const task of tasks) {
      if (!isPlainObject(task)) continue;
      const command = [flattenCommand(task.command), flattenCommand(task.args)].join(' ').trim();
      if (command === '') continue;
      const index = text.indexOf(typeof task.command === 'string' ? task.command : '');
      analyzeCommandsIn(path, command, 'vscode-task-command', 'VS Code task', undefined, index >= 0 ? resolve(index).line : undefined);
    }
  }

  function analyzeVscodeSettings(path: string, text: string): void {
    const match = /["']task\.allowAutomaticTasks["']\s*:\s*["']on["']/.exec(text);
    if (match) {
      add({
        id: 'vscode-allow-auto-tasks',
        severity: 'medium',
        confidence: 'high',
        title: 'Turns on automatic VS Code tasks',
        detail: 'This setting lets tasks run on folder open without asking.',
        file: path,
        line: createPositionResolver(text)(match.index).line,
        excerpt: shorten(match[0]),
      });
    }
  }

  function analyzeDevcontainer(path: string, text: string): void {
    const config = analyzeJsonc(text);
    if (!config) return;
    const resolve = createPositionResolver(text);
    for (const key of DEVCONTAINER_KEYS) {
      if (config[key] === undefined) continue;
      const command = flattenCommand(config[key]);
      const index = text.indexOf(`"${key}"`);
      const line = index >= 0 ? resolve(index).line : undefined;
      analyzeCommandsIn(path, command, 'devcontainer-command', `devcontainer ${key}`, key === 'initializeCommand' ? 'medium' : 'low', line);
    }
  }

  function analyzeNpmrc(path: string, text: string): void {
    const lines = text.split('\n');
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
      const equals = line.indexOf('=');
      if (equals === -1) return;
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim().replace(/^["']|["']$/g, '');
      const place = { file: path, line: index + 1 };
      if (key === 'registry' || /^@[\w.-]+:registry$/.test(key)) {
        const host = hostOf(value);
        if (host !== undefined && host !== 'registry.npmjs.org') {
          add({ id: 'npmrc-registry', severity: 'medium', confidence: 'medium', title: `Uses a different package registry (${host})`, detail: 'Packages are downloaded from this address instead of the public npm registry.', ...place, excerpt: shorten(line), subject: key });
        }
      } else if (key === 'script-shell') {
        add({ id: 'npmrc-script-shell', severity: 'medium', confidence: 'medium', title: 'Changes the shell used for scripts', detail: 'npm runs project scripts with this program.', ...place, excerpt: shorten(line) });
      } else if (/_authToken$|_auth$|_password$/.test(key) && value !== '' && !value.startsWith('${')) {
        add({ id: 'npmrc-token', severity: 'low', confidence: 'medium', title: 'Contains what looks like a credential', detail: 'A secret is committed in this file. Do not reuse it, and tell its owner.', ...place, excerpt: `${key}=<hidden>` });
      }
    });
  }

  function analyzeYarnrc(path: string, text: string): void {
    text.split('\n').forEach((raw, index) => {
      const line = raw.trim();
      const place = { file: path, line: index + 1 };
      const yarnPath = /^yarnPath:\s*["']?([^"'\s]+)/.exec(line);
      if (yarnPath) {
        const normal = /^\.yarn\/releases\/yarn-[\w.-]+\.c?js$/.test(yarnPath[1] as string);
        add({ id: 'yarn-path', severity: normal ? 'info' : 'medium', confidence: 'medium', title: 'Yarn runs a script from the repository', detail: normal ? 'This is the usual way to pin a Yarn version.' : 'The package manager itself is a file in this repository, so it runs code each time you use yarn.', ...place, excerpt: shorten(line) });
      }
      const registry = /^npmRegistryServer:\s*["']?([^"'\s]+)/.exec(line);
      if (registry && hostOf(registry[1] as string) !== 'registry.yarnpkg.com' && hostOf(registry[1] as string) !== 'registry.npmjs.org') {
        add({ id: 'npmrc-registry', severity: 'medium', confidence: 'medium', title: 'Uses a different package registry', detail: 'Packages are downloaded from this address instead of the public registry.', ...place, excerpt: shorten(line), subject: 'yarnrc' });
      }
      if (/^-?\s*spec:\s*["']?https?:/.test(line)) {
        add({ id: 'yarn-plugin-url', severity: 'medium', confidence: 'medium', title: 'Yarn downloads a plugin from a web address', detail: 'Plugins run code inside the package manager.', ...place, excerpt: shorten(line) });
      }
    });
  }

  let packageFiles = 0;
  for (const [path, text] of files) {
    const base = path.split('/').pop() as string;
    if (base === 'package.json') {
      if (packageFiles++ < MAX_PACKAGE_FILES) analyzePackage(path, text);
    } else if (base === 'package-lock.json') {
      analyzeLockfile(path, text);
    } else if (/(?:^|\/)\.vscode\/tasks\.json$/.test(path)) {
      analyzeVscodeTasks(path, text);
    } else if (/(?:^|\/)\.vscode\/settings\.json$/.test(path)) {
      analyzeVscodeSettings(path, text);
    } else if (/(?:^|\/)\.devcontainer(?:\/devcontainer)?\.json$/.test(path)) {
      analyzeDevcontainer(path, text);
    } else if (base === '.npmrc') {
      analyzeNpmrc(path, text);
    } else if (base === '.yarnrc.yml') {
      analyzeYarnrc(path, text);
    }
  }
  if (packageFiles > MAX_PACKAGE_FILES) {
    truncated = true;
    limitations.push(`Only the first ${MAX_PACKAGE_FILES} package.json files were checked.`);
  }

  let general = 0;
  for (const [path, text] of files) {
    const reference = executable.get(path);
    const isCode = CODE_FILE.test(path) && !DECLARATION_FILE.test(path);
    const isShell = SHELL_FILE.test(path);
    if (!isCode && !isShell) continue;

    const isExecutable = reference !== undefined || CONFIG_FILE.test(path);
    if (!isExecutable) {
      if (QUIET_PATH.test(path)) continue;
      if (general++ >= MAX_GENERAL_FILES) {
        truncated = true;
        continue;
      }
    }
    const via = reference ? ` (runs from "${reference.script}")` : '';
    if (isShell) {
      text.split('\n').slice(0, 2000).forEach((raw, index) => {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('REM ') || line.startsWith('::')) return;
        for (const finding of analyzeCommand(line)) {
          const severity: RiskSeverity | undefined = isExecutable && (reference?.lifecycle ?? false) ? finding.severity : lowerSeverity(finding.severity);
          if (severity === undefined) continue;
          add({ id: finding.id, severity, confidence: finding.confidence, title: `${finding.title}${via}`, detail: finding.detail, file: path, line: index + 1, excerpt: shorten(line) });
        }
      });
      continue;
    }

    const matches = scanTextForRisks(text, { executable: isExecutable });
    if (reference?.lifecycle && matches.some((match) => match.id === 'code-network') && matches.some((match) => match.id === 'code-child-process')) {
      const first = matches.find((match) => match.id === 'code-network') as (typeof matches)[number];
      add({
        id: 'code-network-exec',
        severity: 'high',
        confidence: 'medium',
        title: `Connects to the network and starts programs${via}`,
        detail: 'A script that runs on install both reaches out to another machine and runs system commands. That is the usual shape of a downloader.',
        file: path,
        line: first.line,
        excerpt: first.excerpt,
      });
    }
    for (const match of matches) {
      add({
        id: match.id,
        severity: match.severity,
        confidence: match.confidence as RiskConfidence,
        title: `${match.title}${via}`,
        detail: match.detail,
        file: path,
        line: match.line,
        excerpt: match.excerpt,
      });
    }
  }

  const names = input.names ?? [...files.keys()];
  const committed = names.find((name) => name.split('/').includes('node_modules'));
  if (committed !== undefined) {
    add({
      id: 'committed-node-modules',
      severity: 'medium',
      confidence: 'medium',
      title: 'node_modules is committed to the repository',
      detail: 'Committed dependencies can contain code that was never installed from the registry, and it runs without an install step.',
      file: committed.split('/node_modules/')[0] === committed ? 'node_modules' : committed.slice(0, committed.indexOf('node_modules') + 'node_modules'.length),
    });
  }
  const binaries = new Map<string, string[]>();
  for (const name of names) {
    const extension = extensionOf(name);
    if (!STRONG_BINARIES.has(extension) && !WEAK_BINARIES.has(extension)) continue;
    if (inIgnoredDirectory(name)) continue;
    const list = binaries.get(extension) ?? [];
    list.push(name);
    binaries.set(extension, list);
  }
  for (const [extension, list] of binaries) {
    add({
      id: 'binary-file',
      severity: STRONG_BINARIES.has(extension) ? 'medium' : 'low',
      confidence: 'medium',
      title: `${list.length} .${extension} file${list.length === 1 ? '' : 's'} in the repository`,
      detail: 'Program files cannot be read or reviewed, and a project that ships its own program deserves a closer look.',
      file: list[0] as string,
      excerpt: list.slice(0, 3).join(', '),
      subject: extension,
    });
  }

  const report: RiskReport = {
    signals,
    highest: 'none',
    scannedFiles: files.size,
    checkedDependencies,
    truncated,
    limitations,
  };
  if (truncated) report.limitations.push('The repository was too large to check completely.');
  summarizeSignals(report);
  return report;
}
