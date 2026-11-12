import semver from 'semver';
import { computeDiff, unifiedDiff } from './diff.ts';
import type { DiffHunk } from './diff.ts';
import { applyEdits, memberOf, parseJsonOffsets, setJsonMember } from './json-edit.ts';
import type { TextEdit } from './json-edit.ts';
import { buildLockGraph } from './lock-graph.ts';
import type { LockGraph } from './lock-graph.ts';
import { parseSpecifier } from './specifier.ts';
import { parseTicket } from './ticket.ts';
import type { TicketFinding } from './ticket.ts';
import { createPositionResolver, isPlainObject, stringRecord } from './util.ts';

export type PackageManager = 'npm' | 'yarn' | 'pnpm';
export type FindingStatus = 'planned' | 'already-fixed' | 'not-in-project' | 'no-fixed-version' | 'manual';
export type FixKind = 'lockfile-update' | 'bump-direct' | 'override';

export interface RemediationInput {
  packageJson: string;
  lockfile?: string;
  ticket: string;
  packageManager?: PackageManager;
  fixedVersions?: Readonly<Record<string, readonly string[]>>;
}

export interface AffectedInstance {
  path: string;
  version: string;
  direct: boolean;
  dev: boolean;
  vulnerable: boolean;
  chains: string[][];
  dependents: Array<{ from: string; range: string }>;
}

export interface FixOption {
  kind: FixKind;
  title: string;
  description: string;
  target: string;
  majorChange: boolean;
  recommended: boolean;
  appliesTo: string[];
  edits: TextEdit[];
  diff: string;
  commands: string[];
  pros: string[];
  cons: string[];
}

export interface FindingPlan {
  finding: TicketFinding;
  status: FindingStatus;
  summary: string;
  fixedVersions: string[];
  fixDerivedFromRange: boolean;
  instances: AffectedInstance[];
  options: FixOption[];
  notes: string[];
}

export interface RemediationPlan {
  ok: true;
  packageManager: PackageManager;
  findings: FindingPlan[];
  originalPackageJson: string;
  newPackageJson: string;
  changed: boolean;
  diff: string;
  hunks: DiffHunk[];
  commands: string[];
  verify: string[];
  warnings: string[];
}

export type RemediationResult =
  | RemediationPlan
  | { ok: false; code: 'INVALID_PACKAGE_JSON' | 'EMPTY_TICKET' | 'NO_FINDINGS'; message: string };

const DIRECT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface Context {
  data: Record<string, unknown>;
  pm: PackageManager;
  graph: LockGraph | undefined;
  directs: Map<string, Array<{ section: (typeof DIRECT_SECTIONS)[number]; spec: string }>>;
  peers: Set<string>;
  fixedVersions: Readonly<Record<string, readonly string[]>>;
}

function deriveFixedFromRange(range: string): string[] {
  try {
    const found = new Set<string>();
    for (const comparators of new semver.Range(range).set) {
      for (const comparator of comparators) {
        if (comparator.operator === '<' && comparator.semver.prerelease.length === 0) found.add(comparator.semver.version);
      }
    }
    return [...found];
  } catch {
    return [];
  }
}

function beforeFix(version: string, fixed: readonly string[]): boolean {
  const sameMajor = fixed.filter((candidate) => semver.major(candidate) === semver.major(version));
  if (sameMajor.length > 0) return semver.lt(version, sameMajor.sort(semver.compare)[0] as string);
  return fixed.some((candidate) => semver.gt(candidate, version));
}

function pickTarget(version: string, fixed: readonly string[]): string | undefined {
  const higher = fixed.filter((candidate) => semver.gt(candidate, version)).sort(semver.compare);
  return higher.find((candidate) => semver.major(candidate) === semver.major(version)) ?? higher[0];
}

function rewriteSpec(old: string, target: string): { spec: string; replacedRange: boolean } | undefined {
  const parsed = parseSpecifier(old);
  if (!parsed.analyzable || parsed.kind === 'alias') return undefined;
  const text = old.trim();
  if (EXACT.test(text)) return { spec: target, replacedRange: false };
  if (text.startsWith('^')) return { spec: `^${target}`, replacedRange: false };
  if (text.startsWith('~')) return { spec: `~${target}`, replacedRange: false };
  if (/^>=\s*\d/.test(text) && !/\s|\|/.test(text.replace(/^>=\s*/, ''))) return { spec: `>=${target}`, replacedRange: false };
  return { spec: `^${target}`, replacedRange: true };
}

function overridePath(pm: PackageManager): string[] {
  return pm === 'yarn' ? ['resolutions'] : pm === 'pnpm' ? ['pnpm', 'overrides'] : ['overrides'];
}

function overrideLabel(pm: PackageManager): string {
  return pm === 'yarn' ? 'resolutions' : pm === 'pnpm' ? 'pnpm.overrides' : 'overrides';
}

function commandsFor(pm: PackageManager) {
  switch (pm) {
    case 'yarn':
      return { install: 'yarn install', update: (names: string) => `yarn upgrade ${names}`, list: (names: string) => `yarn why ${names}`, audit: 'yarn audit' };
    case 'pnpm':
      return { install: 'pnpm install', update: (names: string) => `pnpm update ${names}`, list: (names: string) => `pnpm why ${names}`, audit: 'pnpm audit' };
    default:
      return { install: 'npm install', update: (names: string) => `npm update ${names}`, list: (names: string) => `npm ls ${names}`, audit: 'npm audit' };
  }
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function minVersionOf(spec: string): string | undefined {
  try {
    return semver.validRange(spec) === null ? undefined : (semver.minVersion(spec)?.version ?? undefined);
  } catch {
    return undefined;
  }
}

interface Group {
  target: string;
  direct: boolean;
  instances: AffectedInstance[];
}

function lineOfMember(text: string, section: string, name: string): number | undefined {
  const root = parseJsonOffsets(text);
  const block = memberOf(root, section);
  const member = memberOf(block?.value, name);
  return member ? createPositionResolver(text)(member.keyStart).line : undefined;
}

function buildBump(ctx: Context, name: string, target: string, text: string): { edits: TextEdit[]; specs: string[]; replacedRange: boolean } | undefined {
  const root = parseJsonOffsets(text);
  const edits: TextEdit[] = [];
  const specs: string[] = [];
  let replacedRange = false;
  for (const entry of ctx.directs.get(name) ?? []) {
    const rewritten = rewriteSpec(entry.spec, target);
    if (!rewritten || rewritten.spec === entry.spec) continue;
    const member = memberOf(memberOf(root, entry.section)?.value, name);
    if (!member || member.value.type !== 'string') continue;
    edits.push({ start: member.value.start, end: member.value.end, insert: JSON.stringify(rewritten.spec) });
    specs.push(`${entry.section}: ${rewritten.spec}`);
    replacedRange = replacedRange || rewritten.replacedRange;
  }
  return edits.length > 0 ? { edits, specs, replacedRange } : undefined;
}

function buildOverride(ctx: Context, name: string, target: string, text: string): TextEdit | undefined {
  const reference = ctx.pm === 'npm' && ctx.directs.has(name) ? `$${name}` : target;
  return setJsonMember(text, overridePath(ctx.pm), name, JSON.stringify(reference));
}

function planFinding(ctx: Context, finding: TicketFinding, startText: string): { plan: FindingPlan; text: string } {
  const name = finding.packageName;
  const notes: string[] = [];
  const directs = ctx.directs.get(name) ?? [];

  const provided = (ctx.fixedVersions[name] ?? []).map((version) => semver.valid(version.replace(/^v/, ''))).filter((version): version is string => version !== null);
  let fixed = [...new Set([...finding.fixedVersions, ...provided])];
  let derived = false;
  if (fixed.length === 0 && finding.vulnerableRange !== undefined) {
    fixed = deriveFixedFromRange(finding.vulnerableRange);
    derived = fixed.length > 0;
  }
  fixed.sort(semver.compare);

  const instances: AffectedInstance[] = [];
  const graph = ctx.graph;
  if (graph) {
    for (const node of graph.byName(name)) {
      instances.push({
        path: node.path,
        version: node.version,
        direct: node.path === `node_modules/${name}` && directs.length > 0,
        dev: node.dev,
        vulnerable: false,
        chains: graph.chains(node.path),
        dependents: graph.dependents(node.path).map((dependent) => ({ from: graph.label(dependent.from), range: dependent.range })),
      });
    }
  }
  if (instances.length === 0 && directs.length > 0) {
    const version = finding.installedVersion ?? minVersionOf(directs[0]?.spec ?? '');
    if (version !== undefined) {
      instances.push({ path: `node_modules/${name}`, version, direct: true, dev: directs.every((entry) => entry.section === 'devDependencies'), vulnerable: false, chains: [], dependents: [] });
      notes.push(
        graph
          ? 'The lockfile does not list this package, so the version comes from the ticket or from package.json.'
          : finding.installedVersion !== undefined
            ? 'No lockfile was given, so the installed version comes from the ticket.'
            : 'No lockfile was given, so the lowest version your range allows is assumed.',
      );
    }
  }

  const base = (status: FindingStatus, summary: string, options: FixOption[] = []): { plan: FindingPlan; text: string } => ({
    plan: { finding, status, summary, fixedVersions: fixed, fixDerivedFromRange: derived, instances, options, notes },
    text: startText,
  });

  if (instances.length === 0) {
    if (!graph && ctx.peers.has(name) === false) {
      notes.push('No lockfile was given, so it is not possible to tell whether this package is installed or who needs it.');
      return base('manual', `${name} is not in your package.json. Without a lockfile I cannot see who depends on it.`);
    }
    return base('not-in-project', `${name} is not in your package.json or lockfile, so this ticket does not apply to this project.`);
  }

  if (fixed.length === 0) {
    return base('no-fixed-version', `The ticket does not say which version of ${name} fixes the problem. Look it up in the advisory and run again with that version.`);
  }

  for (const instance of instances) {
    instance.vulnerable = finding.vulnerableRange !== undefined
      ? semver.satisfies(instance.version, finding.vulnerableRange, { includePrerelease: true })
      : beforeFix(instance.version, fixed);
  }
  const vulnerable = instances.filter((instance) => instance.vulnerable);
  if (vulnerable.length === 0) {
    return base('already-fixed', `${name} ${listOf(instances.map((instance) => instance.version))} ${instances.length === 1 ? 'is' : 'are'} not affected by this ticket, so nothing needs to change.`);
  }

  if (derived) notes.push(`The ticket gives only the vulnerable range, so ${listOf(fixed)} is the first version outside it. Check that it exists on npm.`);
  if (vulnerable.every((instance) => instance.dev)) notes.push('It is only used during development, so the exposure in production is lower.');
  if (ctx.peers.has(name)) notes.push('It is also listed in peerDependencies. Peer ranges are not changed automatically.');

  const groups = new Map<string, Group>();
  const unfixable: AffectedInstance[] = [];
  for (const instance of vulnerable) {
    const target = pickTarget(instance.version, fixed);
    if (target === undefined) {
      unfixable.push(instance);
      continue;
    }
    const key = instance.direct ? `direct:${target}` : `nested:${target}`;
    const group = groups.get(key) ?? { target, direct: instance.direct, instances: [] };
    group.instances.push(instance);
    groups.set(key, group);
  }
  if (unfixable.length > 0) {
    notes.push(`No fixed version above ${listOf(unfixable.map((instance) => instance.version))} is listed in the ticket.`);
  }
  if (groups.size === 0) return base('no-fixed-version', `None of the fixed versions in the ticket is newer than the installed ${name}.`);

  const cmd = commandsFor(ctx.pm);
  const nestedTargets = new Set([...groups.values()].filter((group) => !group.direct).map((group) => group.target));
  const options: FixOption[] = [];
  const builders: Array<{ index: number; build: (text: string) => { edits: TextEdit[] } | undefined }> = [];

  for (const group of groups.values()) {
    const sample = group.instances[0] as AffectedInstance;
    const majorChange = semver.major(group.target) > semver.major(sample.version);
    const paths = group.instances.map((instance) => instance.path);
    const majorNote = majorChange ? [`This is a major version change (${sample.version} to ${group.target}). Read the changelog and run your tests.`] : [];

    if (group.direct) {
      const bump = buildBump(ctx, name, group.target, startText);
      const rangesAllow = directs.every((entry) => semver.validRange(entry.spec) !== null && semver.satisfies(group.target, entry.spec));
      if (bump) {
        options.push({
          kind: 'bump-direct',
          title: `Raise ${name} to ${bump.specs.map((item) => item.split(': ')[1]).join(', ')}`,
          description: 'Change the version in package.json so the vulnerable versions can no longer be installed.',
          target: group.target,
          majorChange,
          recommended: true,
          appliesTo: paths,
          edits: bump.edits,
          diff: unifiedDiff('package.json', startText, applyEdits(startText, bump.edits)),
          commands: [cmd.install],
          pros: ['The fix is visible in package.json and survives a fresh install.'],
          cons: [...majorNote, ...(bump.replacedRange ? ['The old version range was replaced with a caret range.'] : [])],
        });
        builders.push({ index: options.length - 1, build: (text) => { const rebuilt = buildBump(ctx, name, group.target, text); return rebuilt ? { edits: rebuilt.edits } : undefined; } });
      }
      if (graph && rangesAllow) {
        options.push({
          kind: 'lockfile-update',
          title: `Update ${name} in the lockfile only`,
          description: `Your range already allows ${group.target}, so installing the newest allowed version is enough.`,
          target: group.target,
          majorChange: false,
          recommended: bump === undefined,
          appliesTo: paths,
          edits: [],
          diff: '',
          commands: [cmd.update(name)],
          pros: ['No change to package.json.'],
          cons: ['package.json would still allow the vulnerable versions.'],
        });
      }
      continue;
    }

    const allowed = sample.dependents.length > 0 && group.instances.every((instance) => instance.dependents.length > 0 && instance.dependents.every((dependent) => semver.validRange(dependent.range) !== null && semver.satisfies(group.target, dependent.range)));
    if (graph && allowed) {
      options.push({
        kind: 'lockfile-update',
        title: `Update ${name} in the lockfile only`,
        description: `Every package that needs ${name} accepts ${group.target} (${listOf([...new Set(group.instances.flatMap((instance) => instance.dependents.map((dependent) => `${dependent.from} asks for ${dependent.range}`)))])}).`,
        target: group.target,
        majorChange,
        recommended: true,
        appliesTo: paths,
        edits: [],
        diff: '',
        commands: [cmd.update(name)],
        pros: ['No change to package.json.'],
        cons: ['If a parent is later updated or removed, the lockfile can change again.'],
      });
    }
    if (nestedTargets.size === 1) {
      const edit = buildOverride(ctx, name, group.target, startText);
      if (edit) {
        options.push({
          kind: 'override',
          title: `Force ${name} to ${group.target} with ${overrideLabel(ctx.pm)}`,
          description: `Tells ${ctx.pm} to use ${group.target} wherever ${name} is needed.`,
          target: group.target,
          majorChange,
          recommended: !(graph && allowed) && graph !== undefined,
          appliesTo: paths,
          edits: [edit],
          diff: unifiedDiff('package.json', startText, applyEdits(startText, [edit])),
          commands: [cmd.install],
          pros: ['Works even when no parent has released an update.'],
          cons: [`Applies to every package that needs ${name}, which can break one that needs an older version.`, ...majorNote],
        });
        builders.push({ index: options.length - 1, build: (text) => { const rebuilt = buildOverride(ctx, name, group.target, text); return rebuilt ? { edits: [rebuilt] } : undefined; } });
      }
    } else {
      notes.push(`${name} appears in several major versions (${listOf([...nestedTargets])} would be needed), so one override cannot fix them all. Update the packages that need it instead.`);
    }
  }

  let text = startText;
  for (const builder of builders) {
    const option = options[builder.index] as FixOption;
    if (!option.recommended) continue;
    const rebuilt = builder.build(text);
    if (!rebuilt) continue;
    const next = applyEdits(text, rebuilt.edits);
    option.edits = rebuilt.edits;
    option.diff = unifiedDiff('package.json', text, next);
    text = next;
  }

  const recommended = options.filter((option) => option.recommended);
  const first = vulnerable[0] as AffectedInstance;
  const chain = first.chains[0];
  const where = first.direct
    ? `It is a direct dependency${directs[0] ? ` (${directs[0].section}${lineOfMember(startText, directs[0].section, name) === undefined ? '' : `, package.json line ${lineOfMember(startText, directs[0].section, name)}`})` : ''}.`
    : chain
      ? `It is pulled in by ${chain.join(' > ')}${first.chains.length > 1 ? ` and ${first.chains.length - 1} other path${first.chains.length === 2 ? '' : 's'}` : ''}.`
      : 'It is installed as a dependency of another package.';
  const fixText = derived ? `The first version outside the vulnerable range is ${listOf(fixed)}.` : `The ticket says it is fixed in ${listOf(fixed)}.`;
  const advice = recommended.length > 0 ? ` Recommended: ${recommended.map((option) => option.title.charAt(0).toLowerCase() + option.title.slice(1)).join(', and ')}.` : ' No automatic fix could be built.';
  const summary = `${name} ${listOf(vulnerable.map((instance) => instance.version))} ${vulnerable.length === 1 ? 'is' : 'are'} affected. ${where} ${fixText}${advice}`;

  const plan: FindingPlan = {
    finding,
    status: recommended.length > 0 ? 'planned' : 'manual',
    summary,
    fixedVersions: fixed,
    fixDerivedFromRange: derived,
    instances,
    options,
    notes,
  };
  return { plan, text };
}

export function planRemediation(input: RemediationInput): RemediationResult {
  let data: unknown;
  try {
    data = JSON.parse(input.packageJson);
  } catch {
    return { ok: false, code: 'INVALID_PACKAGE_JSON', message: 'The package.json is not valid JSON.' };
  }
  if (!isPlainObject(data) || parseJsonOffsets(input.packageJson) === undefined) {
    return { ok: false, code: 'INVALID_PACKAGE_JSON', message: 'The package.json must be a JSON object.' };
  }
  if (input.ticket.trim() === '') return { ok: false, code: 'EMPTY_TICKET', message: 'Paste the text of the security ticket.' };

  const parsed = parseTicket(input.ticket);
  if (parsed.findings.length === 0) {
    return { ok: false, code: 'NO_FINDINGS', message: 'I could not find a package name in the ticket. Include the package name and, if possible, the fixed version.' };
  }

  const directs = new Map<string, Array<{ section: (typeof DIRECT_SECTIONS)[number]; spec: string }>>();
  for (const section of DIRECT_SECTIONS) {
    for (const [name, spec] of Object.entries(stringRecord(data[section]))) {
      const list = directs.get(name) ?? [];
      list.push({ section, spec });
      directs.set(name, list);
    }
  }
  const peers = new Set(Object.keys(stringRecord(data.peerDependencies)));
  const declared = typeof data.packageManager === 'string' ? /^(npm|yarn|pnpm)@/.exec(data.packageManager)?.[1] : undefined;
  const pm = input.packageManager ?? (declared as PackageManager | undefined) ?? 'npm';

  const warnings = [...parsed.warnings];
  let graph: LockGraph | undefined;
  if (input.lockfile !== undefined && input.lockfile.trim() !== '') {
    graph = buildLockGraph(input.lockfile, Object.fromEntries([...directs].map(([name, list]) => [name, list[0]?.spec ?? '*'])));
    if (!graph) warnings.push('The lockfile could not be read. Only package-lock.json is supported, so only direct dependencies can be found.');
  } else {
    warnings.push('No lockfile was given, so packages that you do not depend on directly cannot be traced.');
  }

  const context: Context = { data, pm, graph, directs, peers, fixedVersions: input.fixedVersions ?? {} };
  const findings: FindingPlan[] = [];
  let text = input.packageJson;
  for (const finding of parsed.findings) {
    const result = planFinding(context, finding, text);
    findings.push(result.plan);
    text = result.text;
  }

  const cmd = commandsFor(pm);
  const recommended = findings.flatMap((plan) => plan.options.filter((option) => option.recommended));
  const updates = [...new Set(recommended.filter((option) => option.kind === 'lockfile-update').map((option) => option.commands[0] as string))];
  const names = [...new Set(findings.filter((plan) => plan.status === 'planned').map((plan) => plan.finding.packageName))];
  const edited = text !== input.packageJson;
  const commands = [...(edited ? [cmd.install] : []), ...updates];
  if (commands.length === 0 && recommended.length > 0) commands.push(cmd.install);

  return {
    ok: true,
    packageManager: pm,
    findings,
    originalPackageJson: input.packageJson,
    newPackageJson: text,
    changed: edited,
    diff: unifiedDiff('package.json', input.packageJson, text),
    hunks: computeDiff(input.packageJson, text),
    commands,
    verify: names.length > 0 ? [cmd.list(names.join(' ')), cmd.audit, 'Run your tests.'] : [],
    warnings,
  };
}
