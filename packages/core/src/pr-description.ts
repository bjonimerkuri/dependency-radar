import semver from 'semver';
import { memberOf, parseJsonOffsets } from './json-edit.ts';
import type { FindingPlan, FixOption, MultiRemediationPlan, RemediationPlan } from './remediate.ts';
import { createPositionResolver, displayAdvisoryId, isPlainObject, stringRecord } from './util.ts';

export type PrFormat = 'markdown' | 'jira';
export type PrLanguage = 'en' | 'sq';

export interface UsageLike {
  files: readonly string[];
  typeOnly?: boolean;
  unusedOnly?: boolean;
}

export interface PrOptions {
  format?: PrFormat;
  language?: PrLanguage;
  usage?: ReadonlyMap<string, UsageLike>;
  maxChars?: number;
}

export interface PrDescription {
  format: PrFormat;
  language: PrLanguage;
  title: string;
  body: string;
  truncated: boolean;
  warnings: string[];
}

export const PR_MAX_CHARS: Record<PrFormat, number> = { markdown: 60_000, jira: 30_000 };

interface Words {
  title(names: string): string;
  summary(count: number, multi: boolean): string;
  changes: string;
  why: string;
  risk: string;
  verify: string;
  references: string;
  notChanged: string;
  noChanges: string;
  bump(name: string, from: string, to: string, line: number | undefined): string;
  override(name: string, label: string, to: string): string;
  lockfile(name: string, command: string, to: string): string;
  advisory(name: string, ids: string, fixed: string): string;
  major(name: string, from: string, to: string): string;
  notMajor(names: string): string;
  usedIn(name: string, count: number, files: string): string;
  notImported(name: string): string;
  usageUnknown: string;
  devOnly(name: string): string;
  noTicketId: string;
  alreadyFixed(name: string): string;
  notInProject(name: string): string;
  noFix(name: string): string;
  manual(name: string): string;
  notAnalyzed(label: string, reason: string): string;
  duplicate(label: string, of: string): string;
  runTests: string;
  confidential: string;
  truncated: string;
  more(count: number): string;
}

const EN: Words = {
  title: (names) => `Security: update ${names}`,
  summary: (count, multi) => `Updates ${count} package${count === 1 ? '' : 's'} named in the security ticket${multi ? 's' : ''}.`,
  changes: 'What changes',
  why: 'Why',
  risk: 'Risk',
  verify: 'How to verify',
  references: 'References',
  notChanged: 'Not changed',
  noChanges: 'No change to package.json or the lockfile is needed for these tickets.',
  bump: (name, from, to, line) => `${name}: ${from} → ${to}${line === undefined ? '' : ` (package.json line ${line})`}`,
  override: (name, label, to) => `${name}: added to ${label} with version ${to}`,
  lockfile: (name, command, to) => `${name}: refresh the lockfile (${command}) so that ${to} is installed; package.json stays the same`,
  advisory: (name, ids, fixed) => `${name}${ids === '' ? '' : ` (${ids})`}: according to the advisory it is fixed in ${fixed}; verify with npm audit.`,
  major: (name, from, to) => `${name}: major version change (${from} → ${to}). Read the changelog and run the tests.`,
  notMajor: (names) => `Not a major version change for ${names}.`,
  usedIn: (name, count, files) => `${name} is imported in ${count} file${count === 1 ? '' : 's'}: ${files}`,
  notImported: (name) => `${name} is not imported in the scanned files. This only shows imports, not whether the vulnerable function is called.`,
  usageUnknown: 'Code impact was not checked because no source code was scanned.',
  devOnly: (name) => `${name} is only a development dependency.`,
  noTicketId: 'no ticket ID in the text, add it here',
  alreadyFixed: (name) => `${name}: the installed version is not affected, nothing to change.`,
  notInProject: (name) => `${name}: not in this project.`,
  noFix: (name) => `${name}: no fixed version is known yet, so nothing was changed.`,
  manual: (name) => `${name}: needs a manual look (see the report).`,
  notAnalyzed: (label, reason) => `${label}: not analyzed (${reason})`,
  duplicate: (label, of) => `${label}: same text as ${of}, so it was merged.`,
  runTests: 'Run the tests.',
  confidential: 'Check that this text contains no confidential information (internal names, links or secrets) before you paste it.',
  truncated: '(Shortened to fit the length limit.)',
  more: (count) => `and ${count} more`,
};

const SQ: Words = {
  title: (names) => `Siguria: përditëso ${names}`,
  summary: (count, multi) => `Përditëson ${count} ${count === 1 ? 'paketë e përmendur' : 'paketa të përmendura'} në ${multi ? 'ticket-et' : 'ticket-in'} e sigurisë.`,
  changes: 'Çfarë ndryshon',
  why: 'Pse',
  risk: 'Rreziku',
  verify: 'Si verifikohet',
  references: 'Referenca',
  notChanged: 'Pa ndryshim',
  noChanges: 'Për këto ticket-e nuk nevojitet ndryshim në package.json as në lockfile.',
  bump: (name, from, to, line) => `${name}: ${from} → ${to}${line === undefined ? '' : ` (package.json, rreshti ${line})`}`,
  override: (name, label, to) => `${name}: u shtua te ${label} me versionin ${to}`,
  lockfile: (name, command, to) => `${name}: rifresko lockfile-in (${command}) që të instalohet ${to}; package.json mbetet i njëjtë`,
  advisory: (name, ids, fixed) => `${name}${ids === '' ? '' : ` (${ids})`}: sipas këshillës rregullohet në ${fixed}; verifiko me npm audit.`,
  major: (name, from, to) => `${name}: ndryshim major (${from} → ${to}). Lexo changelog-un dhe ekzekuto testet.`,
  notMajor: (names) => `Nuk është ndryshim major për ${names}.`,
  usedIn: (name, count, files) => `${name} importohet në ${count} ${count === 1 ? 'skedar' : 'skedarë'}: ${files}`,
  notImported: (name) => `${name} nuk importohet në skedarët e skanuar. Kjo tregon vetëm importet, jo nëse thirret funksioni i cenueshëm.`,
  usageUnknown: 'Ndikimi në kod nuk u kontrollua, sepse nuk u skanua kodi.',
  devOnly: (name) => `${name} është vetëm varësi zhvillimi.`,
  noTicketId: 'ticket-i nuk ka ID në tekst, shtoje këtu',
  alreadyFixed: (name) => `${name}: versioni i instaluar nuk preket, nuk ka çfarë të ndryshohet.`,
  notInProject: (name) => `${name}: nuk është në këtë projekt.`,
  noFix: (name) => `${name}: nuk njihet ende version i rregulluar, ndaj nuk u ndryshua asgjë.`,
  manual: (name) => `${name}: kërkon kontroll me dorë (shih raportin).`,
  notAnalyzed: (label, reason) => `${label}: nuk u analizua (${reason})`,
  duplicate: (label, of) => `${label}: teksti është i njëjtë me ${of}, ndaj u bashkua.`,
  runTests: 'Ekzekuto testet.',
  confidential: 'Kontrollo që ky tekst nuk përmban informacion konfidencial (emra të brendshëm, lidhje ose sekrete) para se ta ngjitësh.',
  truncated: '(U shkurtua për të respektuar kufirin e gjatësisë.)',
  more: (count) => `dhe ${count} të tjera`,
};

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface Change {
  packageName: string;
  text: string;
  major: boolean;
  from: string;
  to: string;
}

function clean(text: string, max = 80): string {
  return text.replace(/[\x60\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function lineOf(text: string, section: string, name: string): number | undefined {
  const member = memberOf(memberOf(parseJsonOffsets(text), section)?.value, name);
  return member ? createPositionResolver(text)(member.keyStart).line : undefined;
}

function overrideRoot(pm: RemediationPlan['packageManager']): string[] {
  return pm === 'yarn' ? ['resolutions'] : pm === 'pnpm' ? ['pnpm', 'overrides'] : ['overrides'];
}

function overrideLabel(pm: RemediationPlan['packageManager']): string {
  return pm === 'yarn' ? 'resolutions' : pm === 'pnpm' ? 'pnpm.overrides' : 'overrides';
}

function recommended(finding: FindingPlan): FixOption[] {
  return finding.options.filter((option) => option.recommended);
}

function collectChanges(plan: RemediationPlan, words: Words): Change[] {
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(plan.originalPackageJson);
    after = JSON.parse(plan.newPackageJson);
  } catch {
    return [];
  }
  const changes: Change[] = [];
  for (const finding of plan.findings) {
    const name = finding.finding.packageName;
    const affected = finding.instances.filter((instance) => instance.vulnerable).map((instance) => instance.version);
    const from = [...new Set(affected)].sort(semver.compare).join(', ') || '?';
    for (const option of recommended(finding)) {
      const major = option.majorChange;
      if (option.kind === 'bump-direct') {
        for (const section of SECTIONS) {
          const oldSpec = isPlainObject(before) ? stringRecord(before[section])[name] : undefined;
          const newSpec = isPlainObject(after) ? stringRecord(after[section])[name] : undefined;
          if (oldSpec === undefined || newSpec === undefined || oldSpec === newSpec) continue;
          changes.push({ packageName: name, text: words.bump(name, oldSpec, newSpec, lineOf(plan.originalPackageJson, section, name)), major, from, to: option.target });
        }
      } else if (option.kind === 'override') {
        let value: unknown = after;
        for (const key of overrideRoot(plan.packageManager)) value = isPlainObject(value) ? value[key] : undefined;
        const set = isPlainObject(value) && typeof value[name] === 'string' ? (value[name] as string) : option.target;
        changes.push({ packageName: name, text: words.override(name, overrideLabel(plan.packageManager), set), major, from, to: option.target });
      } else {
        changes.push({ packageName: name, text: words.lockfile(name, option.commands[0] ?? 'npm install', option.target), major, from, to: option.target });
      }
    }
  }
  return changes;
}

function notChangedLines(plan: RemediationPlan, words: Words): string[] {
  const lines: string[] = [];
  for (const finding of plan.findings) {
    const name = finding.finding.packageName;
    switch (finding.status) {
      case 'already-fixed':
        lines.push(words.alreadyFixed(name));
        break;
      case 'not-in-project':
        lines.push(words.notInProject(name));
        break;
      case 'no-fixed-version':
        lines.push(words.noFix(name));
        break;
      case 'manual':
        lines.push(words.manual(name));
        break;
      default:
        break;
    }
  }
  const multi = plan as Partial<MultiRemediationPlan>;
  for (const ticket of multi.tickets ?? []) {
    if (ticket.status === 'not-analyzed') lines.push(words.notAnalyzed(clean(ticket.label, 60), ticket.reason ?? '?'));
    if (ticket.status === 'duplicate') lines.push(words.duplicate(clean(ticket.label, 60), clean(ticket.duplicateOf ?? '?', 60)));
  }
  return lines;
}

function referenceLines(plan: RemediationPlan, words: Words): string[] {
  const multi = plan as Partial<MultiRemediationPlan>;
  if (multi.tickets !== undefined) {
    return multi.tickets
      .filter((ticket) => ticket.status === 'analyzed')
      .map((ticket) => `${clean(ticket.label, 60)}: ${ticket.ids.length > 0 ? ticket.ids.map(displayAdvisoryId).join(', ') : `(${words.noTicketId})`}`);
  }
  const ids = [...new Set(plan.findings.flatMap((finding) => finding.finding.ids))];
  return [ids.length > 0 ? ids.map(displayAdvisoryId).join(', ') : `(${words.noTicketId})`];
}

export function buildPrDescription(plan: RemediationPlan | MultiRemediationPlan, options: PrOptions = {}): PrDescription {
  const format: PrFormat = options.format ?? 'markdown';
  const language: PrLanguage = options.language ?? 'en';
  const words = language === 'sq' ? SQ : EN;
  const markdown = format === 'markdown';
  const limit = options.maxChars ?? PR_MAX_CHARS[format];
  const multi = 'tickets' in plan && plan.tickets.length > 1;

  const code = (text: string): string => (markdown ? `\`${text.replace(/`/g, '')}\`` : text);
  const bullet = (text: string): string => `- ${text}`;
  const heading = (text: string): string => (markdown ? `## ${text}` : `${text.toUpperCase()}`);

  const changes = collectChanges(plan, words);
  const planned = plan.findings.filter((finding) => recommended(finding).length > 0);
  const names = [...new Set(planned.map((finding) => finding.finding.packageName))];
  const shown = names.slice(0, 3).join(', ');
  const title = names.length === 0 ? words.title(plan.findings.map((finding) => finding.finding.packageName).slice(0, 3).join(', ') || '-').replace(/^(.*)$/, '$1') : words.title(names.length > 3 ? `${shown} ${words.more(names.length - 3)}` : shown);

  const blocks: string[] = [];
  blocks.push(names.length > 0 ? words.summary(names.length, multi) : words.noChanges);

  if (changes.length > 0) {
    blocks.push([heading(words.changes), ...changes.map((change) => bullet(markdown ? change.text.replace(/^([^:]+):/, (_, name: string) => `${code(name)}:`) : change.text))].join('\n'));
  }

  const why: string[] = [];
  for (const finding of planned) {
    const fixed = finding.fixedVersions.length > 0 ? finding.fixedVersions.join(', ') : '?';
    const ids = finding.finding.ids.map(displayAdvisoryId).join(', ');
    why.push(bullet(words.advisory(finding.finding.packageName, ids, fixed)));
    if (finding.instances.length > 0 && finding.instances.filter((instance) => instance.vulnerable).every((instance) => instance.dev)) {
      why.push(bullet(words.devOnly(finding.finding.packageName)));
    }
  }
  if (why.length > 0) blocks.push([heading(words.why), ...why].join('\n'));

  const risk: string[] = [];
  const majors = changes.filter((change) => change.major);
  for (const change of majors) risk.push(bullet(words.major(change.packageName, change.from, change.to)));
  const minorNames = [...new Set(changes.filter((change) => !change.major).map((change) => change.packageName))];
  if (minorNames.length > 0) risk.push(bullet(words.notMajor(minorNames.join(', '))));
  if (planned.length > 0) {
    if (options.usage === undefined) risk.push(bullet(words.usageUnknown));
    else {
      for (const finding of planned) {
        const name = finding.finding.packageName;
        const usage = options.usage.get(name);
        if (usage === undefined || usage.files.length === 0) risk.push(bullet(words.notImported(name)));
        else {
          const list = usage.files.slice(0, 8).join(', ');
          const extra = usage.files.length > 8 ? ` ${words.more(usage.files.length - 8)}` : '';
          risk.push(bullet(words.usedIn(name, usage.files.length, `${list}${extra}`)));
        }
      }
    }
  }
  if (risk.length > 0) blocks.push([heading(words.risk), ...risk].join('\n'));

  const checks = [...plan.commands.map((command) => (markdown ? `- [ ] ${code(command)}` : `[ ] ${command}`))];
  for (const step of plan.verify) {
    const text = step === 'Run your tests.' ? words.runTests : step;
    checks.push(step === 'Run your tests.' ? (markdown ? `- [ ] ${text}` : `[ ] ${text}`) : markdown ? `- [ ] ${code(text)}` : `[ ] ${text}`);
  }
  if (checks.length > 0) blocks.push([heading(words.verify), ...checks].join('\n'));

  const notChanged = notChangedLines(plan, words);
  if (notChanged.length > 0) blocks.push([heading(words.notChanged), ...notChanged.map(bullet)].join('\n'));

  blocks.push([heading(words.references), ...referenceLines(plan, words).map(bullet)].join('\n'));

  let body = blocks.join('\n\n') + '\n';
  let truncated = false;
  if (body.length > limit) {
    const note = `\n${words.truncated}\n`;
    const cut = body.slice(0, Math.max(0, limit - note.length));
    const lastBreak = cut.lastIndexOf('\n');
    body = `${lastBreak > 0 ? cut.slice(0, lastBreak) : cut}${note}`;
    truncated = true;
  }

  return { format, language, title, body, truncated, warnings: [words.confidential] };
}
