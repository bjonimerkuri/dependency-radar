import semver from 'semver';

export interface VersionSection {
  version: string;
  heading: string;
  body: string;
}

export interface ChangelogLine {
  id: string;
  text: string;
  version: string;
  section: string;
  breaking: boolean;
}

export interface SymbolMention {
  symbol: string;
  inBreaking: boolean;
  excerpts: Array<{ id: string; version: string; text: string }>;
}

export interface PromptSelection {
  lines: ChangelogLine[];
  truncated: boolean;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)(?![\w])/;
const PACKAGE_VERSION = /((?:@[\w.-]+\/)?[\w.-]+)@v?\d+\.\d+\.\d+/;
const BREAKING_HEADING = /break|major|migrat|removed|removal|deprecat|incompatib/i;
const BREAKING_TEXT =
  /\bbreaking\b|\bremoved?\b|\bremoval\b|\brenamed?\b|\bno longer\b|\bdrop(?:s|ped)?\b|\bdeprecat\w*|\breplaced?\b|\bincompatible\b|\bmigrat\w*|\bchanged? (?:the )?default\b/i;
const MAX_LINE_LENGTH = 400;
const MIN_SYMBOL_LENGTH = 3;
const MAX_EXCERPTS = 3;
const IGNORED_SYMBOLS: ReadonlySet<string> = new Set(['default', '*']);

function versionOf(text: string): string | undefined {
  const match = VERSION.exec(text);
  return match ? (semver.valid(match[1] as string) ?? undefined) : undefined;
}

function isForeignPackage(heading: string, packageName: string | undefined): boolean {
  if (packageName === undefined) return false;
  const match = PACKAGE_VERSION.exec(heading);
  if (!match) return false;
  const name = match[1] as string;
  return name !== packageName && name !== packageName.split('/').pop();
}

export function parseVersionSections(markdown: string, packageName?: string): VersionSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: VersionSection[] = [];
  let current: { version: string; heading: string; level: number; body: string[]; foreign: boolean } | undefined;
  let inFence = false;

  function flush(): void {
    if (current && !current.foreign) {
      sections.push({ version: current.version, heading: current.heading, body: current.body.join('\n') });
    }
    current = undefined;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      current?.body.push(line);
      continue;
    }

    let heading: { level: number; text: string } | undefined;
    if (!inFence) {
      const atx = HEADING.exec(line);
      if (atx) {
        heading = { level: (atx[1] as string).length, text: atx[2] as string };
      } else {
        const underline = lines[i + 1];
        if (underline !== undefined && /^(?:=|-){3,}\s*$/.test(underline) && VERSION.test(line) && !/^\s*[-*+]\s/.test(line)) {
          heading = { level: underline.startsWith('=') ? 1 : 2, text: line.trim() };
          i++;
        }
      }
    }

    if (heading) {
      const version = versionOf(heading.text);
      if (version !== undefined && (current === undefined || heading.level <= current.level)) {
        flush();
        current = {
          version,
          heading: heading.text,
          level: heading.level,
          body: [],
          foreign: isForeignPackage(heading.text, packageName),
        };
        continue;
      }
    }
    current?.body.push(line);
  }
  flush();
  return sections;
}

export function sectionsBetween(sections: readonly VersionSection[], from: string, to: string): VersionSection[] {
  const seen = new Set<string>();
  const result: VersionSection[] = [];
  for (const section of sections) {
    if (seen.has(section.version)) continue;
    if (!semver.gt(section.version, from) || !semver.lte(section.version, to)) continue;
    if (semver.prerelease(section.version) !== null) continue;
    seen.add(section.version);
    result.push(section);
  }
  return result.sort((a, b) => semver.rcompare(a.version, b.version));
}

function cleanBody(body: string): string[] {
  const cleaned: string[] = [];
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of withoutComments.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(raw)) continue;
    if (/^\[[^\]]+\]:\s*\S+/.test(raw.trim())) continue;
    if (/^\s*\**full changelog\**\s*:/i.test(raw)) continue;
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) continue;
    const text = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LINE_LENGTH);
    if (text !== '') cleaned.push(text);
  }
  return cleaned;
}

export function buildChangelogLines(sections: readonly VersionSection[]): ChangelogLine[] {
  const lines: ChangelogLine[] = [];
  let counter = 0;

  for (const section of sections) {
    let subheading = '';
    const push = (text: string, breaking: boolean): void => {
      counter++;
      lines.push({ id: `L${counter}`, text, version: section.version, section: subheading, breaking });
    };

    push(`## ${section.version}`, false);
    for (const text of cleanBody(section.body)) {
      const heading = HEADING.exec(text);
      if (heading) {
        subheading = heading[2] as string;
        push(text, false);
      } else {
        push(text, BREAKING_HEADING.test(subheading) || BREAKING_TEXT.test(text));
      }
    }
  }
  return lines;
}

function lineCost(line: ChangelogLine): number {
  return line.text.length + line.id.length + 3;
}

export function selectForPrompt(lines: readonly ChangelogLine[], maxChars: number): PromptSelection {
  const total = lines.reduce((sum, line) => sum + lineCost(line), 0);
  if (total <= maxChars) return { lines: [...lines], truncated: false };

  const chosen = new Set<string>();
  let used = 0;
  const take = (line: ChangelogLine, limit: number): void => {
    const cost = lineCost(line);
    if (!chosen.has(line.id) && used + cost <= limit) {
      chosen.add(line.id);
      used += cost;
    }
  };
  for (const line of lines) if (line.breaking) take(line, Math.floor(maxChars * 0.7));
  for (const line of lines) take(line, maxChars);

  return { lines: lines.filter((line) => chosen.has(line.id)), truncated: true };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findSymbolMentions(lines: readonly ChangelogLine[], symbols: Iterable<string>): SymbolMention[] {
  const mentions: SymbolMention[] = [];
  for (const symbol of new Set(symbols)) {
    if (symbol.length < MIN_SYMBOL_LENGTH || IGNORED_SYMBOLS.has(symbol)) continue;
    const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
    const matched = lines.filter((line) => pattern.test(line.text));
    if (matched.length === 0) continue;
    const ordered = [...matched.filter((line) => line.breaking), ...matched.filter((line) => !line.breaking)];
    mentions.push({
      symbol,
      inBreaking: matched.some((line) => line.breaking),
      excerpts: ordered.slice(0, MAX_EXCERPTS).map((line) => ({ id: line.id, version: line.version, text: line.text })),
    });
  }
  return mentions.sort((a, b) => Number(b.inBreaking) - Number(a.inBreaking) || a.symbol.localeCompare(b.symbol));
}
