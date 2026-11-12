import semver from 'semver';
import { isPlainObject, isValidPackageName } from './util.ts';

export type TicketSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface TicketFinding {
  packageName: string;
  installedVersion?: string;
  vulnerableRange?: string;
  fixedVersions: string[];
  ids: string[];
  severity?: TicketSeverity;
  sources: string[];
}

export interface ParsedTicket {
  findings: TicketFinding[];
  warnings: string[];
  truncated: boolean;
}

export interface ParseTicketOptions {
  maxChars?: number;
  maxFindings?: number;
}

const SEVERITY_ORDER: readonly TicketSeverity[] = ['low', 'medium', 'high', 'critical'];
const NAME = String.raw`(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*`;
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?`;
const ID_PATTERN = /\b(?:CVE-\d{4}-\d{4,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|SNYK-[A-Z]+-[A-Z0-9_]+-\d+)\b/gi;
const BUMP = new RegExp(String.raw`\b(?:bump|upgrade|update)\s+(?:the\s+)?(?:package\s+)?[\x60'"]?(${NAME})[\x60'"]?(?:@v?(${VERSION})|\s+from\s+v?(${VERSION}))?\s+to\s+(?:version\s+)?(?:\1@)?v?(${VERSION})`, 'gi');
const BUMP_AT = new RegExp(String.raw`\b(?:upgrade|update)\s+[\x60'"]?(${NAME})@v?(${VERSION})[\x60'"]?\s+to\s+[\x60'"]?(?:${NAME}@)?v?(${VERSION})`, 'gi');
const ARROW = new RegExp(String.raw`(?<![\w@./-])[\x60'"]?(${NAME})[\x60'"]?\s+v?(${VERSION})\s*(?:->|→|=>)\s*v?(${VERSION})`, 'gi');
const VULNERABLE_AT = new RegExp(String.raw`(?<![\w@./-])[\x60'"]?(${NAME})@v?(${VERSION})[\x60'"]?\s+(?:is|are)\s+(?:vulnerable|affected)`, 'gi');
const FIXED_IN = new RegExp(String.raw`\b(?:fixed|patched|resolved)\s+in\s+(?:version\s+)?[\x60'"]?(?:${NAME}@)?v?(${VERSION})`, 'gi');
const ANY_VERSION = new RegExp(VERSION, 'g');

const PACKAGE_LABEL = /^(?:affected\s+packages?|vulnerable\s+(?:package|module|dependency)s?|package(?:\s+name)?|module\s+name|library)$/i;
const INSTALLED_LABEL = /^(?:installed|current|detected|your)\s+version$|^version\s+in\s+use$/i;
const RANGE_LABEL = /^(?:affected|vulnerable)\s+versions?(?:\s+range)?$|^vulnerable\s+range$|^affected\s+range$|^versions?\s+affected$/i;
const FIXED_LABEL = /^(?:fixed(?:\s+in)?(?:\s+versions?)?|patched(?:\s+versions?)?|first\s+patched\s+version|fix\s+version|recommended\s+version|upgrade\s+to|resolved\s+in|safe\s+version|remediation)$/i;
const SEVERITY_LABEL = /^(?:severity|risk)$/i;

interface Draft {
  packageName: string;
  installedVersion?: string;
  vulnerableRange?: string;
  fixed: Set<string>;
  ids: Set<string>;
  severity?: TicketSeverity;
  sources: Set<string>;
}

function cleanVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^v/i, '').replace(/[.,;)\]]+$/, '');
  return semver.valid(trimmed) ?? undefined;
}

function cleanRange(value: string): string | undefined {
  const compact = value
    .replace(/[\x60'"]/g, '')
    .replace(/\s+and\s+/gi, ' ')
    .replace(/,/g, ' ')
    .replace(/([<>=~^]+)\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return compact !== '' && semver.validRange(compact) !== null ? compact : undefined;
}

function versionsIn(text: string): string[] {
  return [...text.matchAll(ANY_VERSION)].map((match) => cleanVersion(match[0])).filter((version): version is string => version !== undefined);
}

function severityIn(text: string): TicketSeverity | undefined {
  const match = /\b(critical|high|moderate|medium|low)\b/i.exec(text);
  if (!match) return undefined;
  const word = (match[1] as string).toLowerCase();
  return word === 'moderate' ? 'medium' : (word as TicketSeverity);
}

function higher(a: TicketSeverity | undefined, b: TicketSeverity | undefined): TicketSeverity | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;
}

export function parseTicket(text: string, options: ParseTicketOptions = {}): ParsedTicket {
  const maxChars = options.maxChars ?? 100_000;
  const maxFindings = options.maxFindings ?? 100;
  const warnings: string[] = [];
  let truncated = false;
  let input = text.replace(/\r\n?/g, '\n').split('\n').map((line) => (line.length > 2000 ? line.slice(0, 2000) : line)).join('\n');
  if (input.length > maxChars) {
    input = input.slice(0, maxChars);
    truncated = true;
    warnings.push('The ticket is very long, so only the first part was read.');
  }

  const drafts = new Map<string, Draft>();

  function draft(name: string, source: string): Draft | undefined {
    if (!isValidPackageName(name)) return undefined;
    let entry = drafts.get(name);
    if (!entry) {
      if (drafts.size >= maxFindings) {
        truncated = true;
        return undefined;
      }
      entry = { packageName: name, fixed: new Set(), ids: new Set(), sources: new Set() };
      drafts.set(name, entry);
    }
    entry.sources.add(source);
    return entry;
  }

  function fill(entry: Draft, fields: { installed?: string | undefined; range?: string | undefined; fixed?: readonly string[]; ids?: readonly string[]; severity?: TicketSeverity | undefined }): void {
    if (fields.installed !== undefined && entry.installedVersion === undefined) entry.installedVersion = fields.installed;
    if (fields.range !== undefined && entry.vulnerableRange === undefined) entry.vulnerableRange = fields.range;
    for (const version of fields.fixed ?? []) entry.fixed.add(version);
    for (const id of fields.ids ?? []) entry.ids.add(id.toUpperCase());
    const severity = higher(entry.severity, fields.severity);
    if (severity !== undefined) entry.severity = severity;
  }

  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = undefined;
    }
    if (data !== undefined) readJson(data, draft, fill);
  }

  if (drafts.size === 0) {
    readTables(input, draft, fill);
    readBlocks(input, drafts, draft, fill);
  }

  const findings: TicketFinding[] = [...drafts.values()].map((entry) => {
    const finding: TicketFinding = {
      packageName: entry.packageName,
      fixedVersions: [...entry.fixed].sort(semver.compare),
      ids: [...entry.ids].sort(),
      sources: [...entry.sources].sort(),
    };
    if (entry.installedVersion !== undefined) finding.installedVersion = entry.installedVersion;
    if (entry.vulnerableRange !== undefined) finding.vulnerableRange = entry.vulnerableRange;
    if (entry.severity !== undefined) finding.severity = entry.severity;
    return finding;
  });
  if (findings.length === 0) warnings.push('No packages could be read from the ticket.');
  return { findings, warnings, truncated };
}

type DraftFn = (name: string, source: string) => Draft | undefined;
type FillFn = (entry: Draft, fields: { installed?: string | undefined; range?: string | undefined; fixed?: readonly string[]; ids?: readonly string[]; severity?: TicketSeverity | undefined }) => void;

function readJson(data: unknown, draft: DraftFn, fill: FillFn): void {
  if (Array.isArray(data)) {
    for (const alert of data) {
      if (!isPlainObject(alert)) continue;
      const vulnerability = isPlainObject(alert.security_vulnerability) ? alert.security_vulnerability : undefined;
      const advisory = isPlainObject(alert.security_advisory) ? alert.security_advisory : undefined;
      const pkg = vulnerability && isPlainObject(vulnerability.package) ? vulnerability.package : undefined;
      if (!pkg || typeof pkg.name !== 'string') continue;
      const entry = draft(pkg.name, 'github-alert');
      if (!entry) continue;
      const patched = isPlainObject(vulnerability?.first_patched_version) ? vulnerability.first_patched_version.identifier : undefined;
      fill(entry, {
        range: typeof vulnerability?.vulnerable_version_range === 'string' ? cleanRange(vulnerability.vulnerable_version_range) : undefined,
        fixed: typeof patched === 'string' ? versionsIn(patched) : [],
        ids: [advisory?.ghsa_id, advisory?.cve_id].filter((id): id is string => typeof id === 'string'),
        severity: typeof advisory?.severity === 'string' ? severityIn(advisory.severity) : undefined,
      });
    }
    return;
  }
  if (!isPlainObject(data)) return;

  if (isPlainObject(data.vulnerabilities)) {
    for (const [name, value] of Object.entries(data.vulnerabilities)) {
      if (!isPlainObject(value)) continue;
      const via = Array.isArray(value.via) ? value.via : [];
      const advisories = via.filter(isPlainObject);
      if (advisories.length === 0) continue;
      const entry = draft(name, 'npm-audit');
      if (!entry) continue;
      const fixAvailable = isPlainObject(value.fixAvailable) ? value.fixAvailable : undefined;
      fill(entry, {
        range: typeof value.range === 'string' ? cleanRange(value.range) : undefined,
        fixed: fixAvailable && fixAvailable.name === name && typeof fixAvailable.version === 'string' ? versionsIn(fixAvailable.version) : [],
        ids: advisories.flatMap((advisory) => (typeof advisory.url === 'string' ? (advisory.url.match(ID_PATTERN) ?? []) : [])),
        severity: typeof value.severity === 'string' ? severityIn(value.severity) : undefined,
      });
    }
    return;
  }

  if (isPlainObject(data.advisories)) {
    for (const advisory of Object.values(data.advisories)) {
      if (!isPlainObject(advisory) || typeof advisory.module_name !== 'string') continue;
      const entry = draft(advisory.module_name, 'npm-audit');
      if (!entry) continue;
      fill(entry, {
        range: typeof advisory.vulnerable_versions === 'string' ? cleanRange(advisory.vulnerable_versions) : undefined,
        fixed: typeof advisory.patched_versions === 'string' ? versionsIn(advisory.patched_versions) : [],
        ids: Array.isArray(advisory.cves) ? advisory.cves.filter((id): id is string => typeof id === 'string') : [],
        severity: typeof advisory.severity === 'string' ? severityIn(advisory.severity) : undefined,
      });
    }
  }
}

function cells(line: string): string[] {
  return line
    .split(/[|│┃]/)
    .map((cell) => cell.replace(/[\x60*]/g, '').trim());
}

function readTables(text: string, draft: DraftFn, fill: FillFn): void {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index] as string;
    if (!/[|│┃]/.test(header) || !/library|package/i.test(header) || !/vulnerab/i.test(header)) continue;
    const names = cells(header).map((cell) => cell.toLowerCase());
    const column = (test: (name: string) => boolean): number => names.findIndex(test);
    const pkgColumn = column((name) => name === 'library' || name === 'package');
    const idColumn = column((name) => name.includes('vulnerability'));
    const severityColumn = column((name) => name.includes('severity'));
    const installedColumn = column((name) => name.includes('installed'));
    const fixedColumn = column((name) => name.includes('fixed'));
    if (pkgColumn === -1) continue;

    let last: string | undefined;
    for (let row = index + 1; row < lines.length; row++) {
      const line = lines[row] as string;
      if (!/[|│┃┼├┤]/.test(line)) break;
      if (/^[\s|│┃┼┌┐└┘├┤┬┴─━═+-]+$/.test(line)) continue;
      const values = cells(line);
      const nameCell = values[pkgColumn] ?? '';
      const name = nameCell !== '' ? nameCell.split(/\s+/)[0] : last;
      if (!name) continue;
      last = name;
      const entry = draft(name, 'table');
      if (!entry) continue;
      const fixedCell = fixedColumn >= 0 ? (values[fixedColumn] ?? '') : '';
      fill(entry, {
        installed: installedColumn >= 0 ? cleanVersion(values[installedColumn]) : undefined,
        fixed: versionsIn(fixedCell),
        ids: idColumn >= 0 ? (values[idColumn] ?? '').match(ID_PATTERN) ?? [] : [],
        severity: severityColumn >= 0 ? severityIn(values[severityColumn] ?? '') : undefined,
      });
    }
  }
}

function labeled(line: string): { label: string; value: string } | undefined {
  const cleaned = line.replace(/^[\s>*\-•]+/, '').replace(/\*\*/g, '').replace(/[\x60]/g, '').trim();
  const match = /^([A-Za-z][A-Za-z ()/]{2,40}?)\s*[:：]\s*(.+)$/.exec(cleaned);
  return match ? { label: (match[1] as string).replace(/\s+/g, ' ').trim(), value: (match[2] as string).trim() } : undefined;
}

function readBlocks(text: string, drafts: ReadonlyMap<string, Draft>, draft: DraftFn, fill: FillFn): void {
  const blocks: string[][] = [[]];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if ((blocks[blocks.length - 1] as string[]).length > 0) blocks.push([]);
      continue;
    }
    const field = labeled(line);
    const current = blocks[blocks.length - 1] as string[];
    if (field && PACKAGE_LABEL.test(field.label) && current.some((previous) => {
      const other = labeled(previous);
      return other !== undefined && PACKAGE_LABEL.test(other.label);
    })) {
      blocks.push([line]);
      continue;
    }
    current.push(line);
  }

  for (const block of blocks) {
    if (block.length === 0) continue;
    const joined = block.join('\n');
    const ids = joined.match(ID_PATTERN) ?? [];
    const severity = severityIn(
      (/\bseverity\W+(\w+)/i.exec(joined)?.[1] ?? '') + ' ' + (/\b(critical|high|medium|moderate|low)\s+severity\b/i.exec(joined)?.[1] ?? ''),
    );

    const packages = new Set<string>();
    let installed: string | undefined;
    let range: string | undefined;
    const fixed: string[] = [];

    for (const line of block) {
      const field = labeled(line);
      if (!field) continue;
      if (PACKAGE_LABEL.test(field.label)) {
        for (const part of field.value.split(/[,;]/)) {
          const name = part.trim();
          if (name === '' || /\s/.test(name)) continue;
          const cleaned = name.replace(/[.)]+$/, '').replace(/@v?\d[\w.+-]*$/, '');
          if (isValidPackageName(cleaned)) packages.add(cleaned);
        }
      } else if (INSTALLED_LABEL.test(field.label)) {
        installed = cleanVersion(field.value.split(/\s+/)[0]) ?? installed;
      } else if (RANGE_LABEL.test(field.label)) {
        const single = cleanVersion(field.value);
        if (single !== undefined) installed = installed ?? single;
        else range = cleanRange(field.value) ?? range;
      } else if (FIXED_LABEL.test(field.label)) {
        fixed.push(...versionsIn(field.value));
      }
    }

    for (const match of joined.matchAll(BUMP)) {
      const entry = draft(match[1] as string, 'bump');
      if (entry) fill(entry, { installed: cleanVersion(match[2] ?? match[3]), fixed: [cleanVersion(match[4]) ?? ''].filter(Boolean), ids, severity });
    }
    for (const match of joined.matchAll(BUMP_AT)) {
      const entry = draft(match[1] as string, 'bump');
      if (entry) fill(entry, { installed: cleanVersion(match[2]), fixed: [cleanVersion(match[3]) ?? ''].filter(Boolean), ids, severity });
    }
    for (const match of joined.matchAll(ARROW)) {
      const entry = draft(match[1] as string, 'arrow');
      if (entry) fill(entry, { installed: cleanVersion(match[2]), fixed: [cleanVersion(match[3]) ?? ''].filter(Boolean), ids, severity });
    }
    for (const match of joined.matchAll(VULNERABLE_AT)) {
      const entry = draft(match[1] as string, 'sentence');
      if (entry) fill(entry, { installed: cleanVersion(match[2]), ids, severity });
    }

    for (const line of block) {
      const audit = new RegExp(String.raw`^\s*(${NAME})\s+((?:[<>]=?|=|~|\^)\s*\d[^\n]*)$`, 'i').exec(line);
      if (audit && /severity/i.test(joined)) {
        const cleanedRange = cleanRange(audit[2] as string);
        if (cleanedRange !== undefined) {
          const entry = draft(audit[1] as string, 'npm-audit');
          if (entry) fill(entry, { range: cleanedRange, ids, severity });
        }
      }
    }

    if (packages.size > 0) {
      for (const name of packages) {
        const entry = draft(name, 'labeled');
        if (entry) fill(entry, { installed, range, fixed, ids: packages.size === 1 ? ids : [], severity });
      }
    }

    const candidates = new Set<string>([...packages]);
    for (const entry of drafts.values()) if (entry.sources.size > 0 && joined.includes(entry.packageName)) candidates.add(entry.packageName);
    if (candidates.size === 1) {
      const entry = drafts.get([...candidates][0] as string);
      if (entry) {
        const found = [...joined.matchAll(FIXED_IN)].map((match) => cleanVersion(match[1])).filter((version): version is string => version !== undefined);
        fill(entry, { fixed: found, ids, severity });
      }
    }
  }
}
