import { CREDENTIAL_TOKENS } from './risk-patterns.ts';
import type { RiskConfidence, RiskSeverity } from './risk-types.ts';

export const LIFECYCLE_SCRIPTS: readonly string[] = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
];

export interface CommandFinding {
  id: string;
  severity: RiskSeverity;
  confidence: RiskConfidence;
  title: string;
  detail: string;
}

const DOWNLOAD_PIPE = /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b[^|;&\n]{0,400}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|node|python3?|perl|ruby|iex|invoke-expression|powershell|pwsh)\b/i;
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/;
const ENCODED_POWERSHELL = /\b(?:powershell|pwsh)(?:\.exe)?\b[^;&|\n]{0,200}\s-(?:e|ec|enc|encodedcommand)\b/i;
const POWERSHELL_BYPASS = /-executionpolicy\s+bypass|-ep\s+bypass|set-executionpolicy/i;
const BASE64_DECODE = /\bbase64\s+(?:-d|--decode|-D)\b|\bcertutil\b[^;&|\n]{0,100}-decode|\[Convert\]::FromBase64String|\batob\b/i;
const INLINE_CODE = /\bnode(?:\.exe)?\s+(?:-e|--eval|-p|--print)\b|\bpython3?\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b/;
const NETWORK_TOOL = /\b(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod|nc|ncat|netcat|scp|ssh|ftp|tftp)\b/i;
const URL = /https?:\/\/[^\s'"]+/i;
const IP_URL = /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}\b/;
const DESTRUCTIVE = /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:~|\/(?:\s|$)|\$HOME|%USERPROFILE%)/i;
const SUDO = /(?:^|[\s;&|])sudo\s/;
const CHMOD_EXEC = /\bchmod\s+\+?[ugoa]*x\b/;
const CMD_C = /\bcmd(?:\.exe)?\s+\/c\b/i;

const BENIGN: readonly RegExp[] = [
  /^(?:npx\s+)?husky(?:\s+install)?(?:\s+[\w./-]+)?$/i,
  /^(?:is-ci|\w+)\s*\|\|\s*(?:npx\s+)?husky(?:\s+install)?(?:\s+[\w./-]+)?$/i,
  /^node-gyp\s+rebuild$/i,
  /^prisma\s+generate(?:\s+--[\w-]+(?:=\S+)?)*$/i,
  /^patch-package$/i,
  /^simple-git-hooks$/i,
  /^lefthook\s+install$/i,
  /^tsc(?:\s+-p\s+[\w./-]+)?$/i,
  /^(?:npm|pnpm|yarn)\s+(?:run\s+)?[\w:.-]+$/i,
  /^electron-builder\s+install-app-deps$/i,
  /^opencollective-postinstall$/i,
  /^node-pre-gyp\s+install\s+--fallback-to-build$/i,
  /^echo\s+[\w\s.:'"-]+$/i,
];

const INTERPRETERS: ReadonlySet<string> = new Set([
  'node', 'node.exe', 'nodejs', 'sh', 'bash', 'zsh', 'python', 'python3', 'ruby', 'perl', 'tsx', 'ts-node', 'nodemon', 'bun', 'deno',
]);
const PRELOAD_FLAGS: ReadonlySet<string> = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);
const ALLOWED_HIDDEN: ReadonlySet<string> = new Set(['.bin', '.husky', '.yarn', '.cache']);

function segments(command: string): string[] {
  return command.split(/[;&|]+/).map((part) => part.trim()).filter(Boolean);
}

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

function interpreterIndex(parts: readonly string[]): number {
  for (let i = 0; i < parts.length; i++) {
    const token = (parts[i] as string).replace(/^['"]|['"]$/g, '');
    const name = token.split('/').pop() as string;
    if (token === 'npx' || token === 'sudo' || token === 'env') continue;
    return INTERPRETERS.has(name) ? i : -1;
  }
  return -1;
}

export function isBenignCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed !== '' && BENIGN.some((pattern) => pattern.test(trimmed));
}

export function referencedScriptFiles(command: string): string[] {
  const files: string[] = [];
  for (const segment of segments(command)) {
    const parts = tokens(segment);
    const start = interpreterIndex(parts);
    if (start === -1) continue;
    for (let i = start + 1; i < parts.length; i++) {
      const token = (parts[i] as string).replace(/^['"]|['"]$/g, '');
      if (PRELOAD_FLAGS.has(token)) {
        const value = (parts[i + 1] ?? '').replace(/^['"]|['"]$/g, '');
        if (value && !value.startsWith('-')) files.push(value);
        i++;
        continue;
      }
      if (token.startsWith('-')) continue;
      if (/^https?:/i.test(token)) break;
      files.push(token);
      break;
    }
  }
  return [...new Set(files.map((file) => file.replace(/^\.\//, '')))].filter((file) => file !== '' && !file.includes('$') && !file.includes('*'));
}

export function referencedScriptNames(command: string): string[] {
  const names = new Set<string>();
  for (const match of command.matchAll(/\b(?:npm|pnpm)\s+(?:run|run-script)\s+([\w:.-]+)/g)) names.add(match[1] as string);
  for (const match of command.matchAll(/\b(?:yarn|pnpm)\s+(?!run\b|install\b|add\b|dlx\b|exec\b)([\w:.-]+)/g)) names.add(match[1] as string);
  return [...names];
}

function runsHiddenFile(command: string): boolean {
  for (const file of referencedScriptFiles(command)) {
    const hidden = file
      .split('/')
      .filter((part) => part !== '' && part !== '.' && part !== '..')
      .some((part) => part.startsWith('.') && !ALLOWED_HIDDEN.has(part));
    if (hidden) return true;
  }
  return false;
}

export function analyzeCommand(command: string): CommandFinding[] {
  const text = command.length > 4000 ? command.slice(0, 4000) : command;
  const findings: CommandFinding[] = [];
  const add = (id: string, severity: RiskSeverity, confidence: RiskConfidence, title: string, detail: string): void => {
    findings.push({ id, severity, confidence, title, detail });
  };

  if (DOWNLOAD_PIPE.test(text) || PIPE_TO_SHELL.test(text)) {
    add('script-download-exec', 'high', 'high', 'Downloads and runs code', 'The command pipes something into a shell or interpreter, so whatever it fetches is run immediately.');
  }
  if (ENCODED_POWERSHELL.test(text)) {
    add('script-encoded', 'high', 'high', 'Runs an encoded PowerShell command', 'Encoded commands hide what actually runs.');
  }
  if (DESTRUCTIVE.test(text)) {
    add('script-destructive', 'high', 'medium', 'Deletes important folders', 'The command removes a home or root folder.');
  }
  if (CREDENTIAL_TOKENS.some(([, pattern]) => pattern.test(text))) {
    add('script-credentials', 'high', 'medium', 'Touches credentials', 'The command mentions SSH keys, cloud credentials, wallets or browser data.');
  }
  if (POWERSHELL_BYPASS.test(text)) {
    add('script-bypass', 'medium', 'medium', 'Turns off PowerShell protections', 'It changes the PowerShell execution policy.');
  }
  if (BASE64_DECODE.test(text)) {
    add('script-decode', 'medium', 'medium', 'Decodes hidden text', 'The command decodes base64 text, which is often used to hide payloads.');
  }
  if (INLINE_CODE.test(text)) {
    add('script-inline-code', 'medium', 'medium', 'Runs inline code', 'The command runs a code string instead of a file you can read.');
  }
  if (NETWORK_TOOL.test(text) || IP_URL.test(text)) {
    add('script-network', 'medium', 'medium', 'Uses the network', 'The command downloads from or connects to another machine.');
  } else if (URL.test(text)) {
    add('script-url', 'low', 'low', 'Mentions a web address', 'The command contains a URL.');
  }
  if (runsHiddenFile(text)) {
    add('script-hidden-file', 'medium', 'medium', 'Runs a hidden file', 'The command runs a file or folder whose name starts with a dot.');
  }
  if (SUDO.test(text)) {
    add('script-sudo', 'medium', 'medium', 'Asks for administrator rights', 'Installing or building a project should not need sudo.');
  }
  if (CHMOD_EXEC.test(text)) {
    add('script-chmod', 'low', 'low', 'Makes a file executable', 'The command changes a file so it can be run.');
  }
  if (CMD_C.test(text)) {
    add('script-cmd', 'low', 'low', 'Runs a Windows shell command', 'The command starts cmd.exe.');
  }
  return findings;
}
