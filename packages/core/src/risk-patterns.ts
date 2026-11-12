import type { RiskConfidence, RiskSeverity } from './risk-types.ts';

export interface PatternMatch {
  id: string;
  severity: RiskSeverity;
  confidence: RiskConfidence;
  title: string;
  detail: string;
  line: number;
  excerpt: string;
}

export interface TextScanOptions {
  executable: boolean;
}

const MAX_SCANNED_LINE = 2000;
const LONG_LINE = 2000;
const EXCERPT_LENGTH = 160;

const DECODE_EVAL = /\b(?:eval|Function)\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent)\s*\(/;
const EVAL = /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.run(?:InNewContext|InThisContext|InContext)\s*\(/;
const CHILD_PROCESS = /require\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]|\bexecSync\s*\(|\bspawnSync\s*\(/;
const NETWORK = /\b(?:https?\.(?:get|request)|fetch|axios(?:\.\w+)?|got|XMLHttpRequest)\s*\(|new\s+(?:XMLHttpRequest|WebSocket)\b|require\(\s*['"](?:node:)?(?:https?|net|dgram|tls)['"]\s*\)|from\s+['"](?:node:)?(?:https?|net|dgram|tls)['"]/;
const WEBHOOK = /discord(?:app)?\.com\/api\/webhooks\/|api\.telegram\.org\/bot/i;
const IP_URL = /https?:\/\/((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?/;
const DROP_SITES = /pastebin\.com\/raw|paste\.ee\/r\/|transfer\.sh|anonfiles|file\.io\/|ngrok\.(?:io|app)|trycloudflare\.com|serveo\.net/i;
const BASE64_BLOB = /['"`][A-Za-z0-9+/]{300,}={0,2}['"`]/;
const FROM_CHAR_CODE = /String\.fromCharCode\s*\([^)]{60,}\)/;
const ENV_DUMP = /JSON\.stringify\(\s*process\.env\s*\)|Object\.(?:entries|keys|values)\(\s*process\.env\s*\)/;
const OBFUSCATED_ID = /\b_0x[0-9a-f]{4,6}\b/g;
const HEX_ESCAPE = /\\x[0-9a-fA-F]{2}/g;

export const CREDENTIAL_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
  ['.ssh', /(?:^|[\s'"/~\\])\.ssh(?:[/\\'"\s]|$)/],
  ['id_rsa', /\bid_(?:rsa|ed25519|ecdsa)\b/],
  ['aws credentials', /\.aws[/\\]credentials/],
  ['npmrc', /\.npmrc\b/],
  ['kube config', /\.kube[/\\]config/],
  ['docker config', /\.docker[/\\]config\.json/],
  ['wallet', /\bwallet\.dat\b|\bExodus\b|\bMetaMask\b|\bElectrum\b|\.config[/\\]solana|\.bitcoin\b|\.ethereum\b/i],
  ['browser data', /Login Data|Local State|\bCookies\b.*sqlite|User Data[/\\]Default/],
  ['keychain', /\bkeychain\b|login\.keychain|secret-tool|gnome-keyring/i],
];

function isPrivateIp(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function excerptOf(line: string): string {
  const compact = line.replace(/\s+/g, ' ').trim();
  return compact.length > EXCERPT_LENGTH ? `${compact.slice(0, EXCERPT_LENGTH - 1)}…` : compact;
}

export function scanTextForRisks(text: string, options: TextScanOptions): PatternMatch[] {
  const matches = new Map<string, PatternMatch>();
  const executable = options.executable;
  const lines = text.split('\n');

  function add(match: PatternMatch): void {
    if (!matches.has(match.id)) matches.set(match.id, match);
  }

  function hit(
    index: number,
    line: string,
    id: string,
    severity: RiskSeverity,
    confidence: RiskConfidence,
    title: string,
    detail: string,
  ): void {
    add({ id, severity, confidence, title, detail, line: index + 1, excerpt: excerptOf(line) });
  }

  for (let index = 0; index < lines.length; index++) {
    const full = lines[index] as string;
    if (full.length > LONG_LINE) {
      hit(index, full, 'code-long-line', 'medium', 'low', 'Very long line', `A line has ${full.length} characters, which is typical of obfuscated or minified code.`);
    }
    const line = full.length > MAX_SCANNED_LINE ? full.slice(0, MAX_SCANNED_LINE) : full;

    if (DECODE_EVAL.test(line)) {
      hit(index, line, 'code-decode-eval', 'high', 'high', 'Runs decoded text as code', 'The code decodes a string and runs it, a common way to hide what a script does.');
    } else if (executable && EVAL.test(line)) {
      hit(index, line, 'code-eval', 'medium', 'medium', 'Runs text as code', 'A file that runs when you build or start the project uses eval or Function.');
    }
    if (executable && CHILD_PROCESS.test(line)) {
      hit(index, line, 'code-child-process', 'medium', 'medium', 'Starts other programs', 'A file that runs when you build or start the project can run system commands.');
    }
    if (executable && NETWORK.test(line)) {
      hit(index, line, 'code-network', 'medium', 'medium', 'Uses the network', 'A file that runs when you build or start the project makes network connections.');
    }
    if (WEBHOOK.test(line)) {
      hit(index, line, 'code-webhook', executable ? 'high' : 'medium', 'medium', 'Sends data to a chat webhook', 'Discord and Telegram bot addresses are often used to send stolen data out.');
    }
    const ip = IP_URL.exec(line);
    if (ip && !isPrivateIp(ip[1] as string)) {
      hit(index, line, 'code-ip-url', 'medium', 'medium', 'Connects to a raw IP address', 'Legitimate projects rarely call a bare IP address.');
    }
    if (DROP_SITES.test(line)) {
      hit(index, line, 'code-drop-site', executable ? 'medium' : 'low', 'medium', 'Uses a file-drop or tunnel service', 'Pastebin-style, file-sharing and tunnel addresses are often used to fetch or send payloads.');
    }
    if (BASE64_BLOB.test(line)) {
      hit(index, line, 'code-base64-blob', 'medium', 'medium', 'Large encoded string', 'A long base64-like string can hide a payload.');
    }
    if (FROM_CHAR_CODE.test(line)) {
      hit(index, line, 'code-char-codes', 'medium', 'medium', 'Builds text from character codes', 'Building strings from numbers is a way to hide commands and addresses.');
    }
    if (ENV_DUMP.test(line) && !matches.has('code-env-dump')) {
      hit(index, line, 'code-env-dump', 'low', 'low', 'Reads all environment variables', 'Dumping every environment variable can leak secrets if it is sent anywhere.');
    }
  }

  const obfuscated = text.match(OBFUSCATED_ID);
  if (obfuscated && obfuscated.length >= 5) {
    const first = lines.findIndex((line) => /\b_0x[0-9a-f]{4,6}\b/.test(line));
    hit(Math.max(0, first), lines[Math.max(0, first)] ?? '', 'code-obfuscated', 'high', 'high', 'Obfuscated code', `Found ${obfuscated.length} names like _0x1a2b3c, the signature of common JavaScript obfuscators.`);
  }
  const hex = text.match(HEX_ESCAPE);
  if (hex && hex.length >= 40) {
    const first = lines.findIndex((line) => /\\x[0-9a-fA-F]{2}/.test(line));
    hit(Math.max(0, first), lines[Math.max(0, first)] ?? '', 'code-hex-escapes', 'medium', 'medium', 'Many hex escapes', `Found ${hex.length} escaped characters, often used to hide text.`);
  }

  const found = CREDENTIAL_TOKENS.filter(([, pattern]) => pattern.test(text));
  if (found.length >= 2 || (executable && found.length === 1)) {
    const names = found.map(([name]) => name);
    const first = lines.findIndex((line) => found.some(([, pattern]) => pattern.test(line)));
    hit(
      Math.max(0, first),
      lines[Math.max(0, first)] ?? '',
      'code-credentials',
      found.length >= 2 ? 'high' : 'medium',
      found.length >= 2 ? 'medium' : 'low',
      'Looks for credentials or wallets',
      `Mentions ${names.join(', ')}. Build and start scripts have no reason to read these.`,
    );
  }

  if (matches.has('code-base64-blob') && (matches.has('code-decode-eval') || /\b(?:eval|Function)\s*\(/.test(text))) {
    const blob = matches.get('code-base64-blob') as PatternMatch;
    matches.set('code-base64-blob', { ...blob, severity: 'high', confidence: 'high', detail: 'A long encoded string appears in a file that also runs text as code.' });
  }

  return [...matches.values()];
}
