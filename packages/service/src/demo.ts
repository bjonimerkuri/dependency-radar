import {
  analyzeProject,
  attachImpact,
  buildUsageIndex,
  enrichWithChangelogs,
  parseVersionSections,
  readProject,
  scanProject,
  sectionsBetween,
} from '@dependency-radar/core';
import type {
  AiProvider,
  ChangelogSource,
  FetchManifestResult,
  FetchPackumentResult,
  ManifestClient,
  RegistryClient,
  SourceFile,
} from '@dependency-radar/core';
import type { AnalysisReport } from './service.ts';

export const DEMO_PACKAGE_JSON = JSON.stringify(
  {
    name: 'demo-shop',
    version: '1.0.0',
    scripts: { build: 'demo-build build', lint: 'demo-lint .' },
    dependencies: {
      'demo-router': '^2.4.0',
      'demo-schema': '^1.8.0',
      'demo-http': '^0.33.0',
      'demo-dates': '^2.30.0',
      'demo-utils': '^4.17.21',
    },
    devDependencies: { 'demo-build': '^5.2.0', 'demo-lint': '^8.57.0' },
  },
  null,
  2,
);

const INSTALLED: Record<string, string> = {
  'demo-router': '2.4.0',
  'demo-schema': '1.8.0',
  'demo-http': '0.33.2',
  'demo-dates': '2.30.0',
  'demo-utils': '4.17.21',
  'demo-build': '5.2.0',
  'demo-lint': '8.57.0',
};

export const DEMO_LOCKFILE = JSON.stringify({
  name: 'demo-shop',
  lockfileVersion: 3,
  packages: {
    '': { name: 'demo-shop' },
    ...Object.fromEntries(Object.entries(INSTALLED).map(([name, version]) => [`node_modules/${name}`, { version }])),
  },
});

export const DEMO_SOURCES: SourceFile[] = [
  {
    path: 'src/router.tsx',
    content:
      "import { createRouter, json, redirect } from 'demo-router';\n\nexport const router = createRouter([]);\nexport const loadData = () => json({ ok: true });\nexport const goHome = () => redirect('/');\n",
  },
  { path: 'src/schema.ts', content: "import { object, string } from 'demo-schema';\n\nexport const user = object({ name: string() });\n" },
  { path: 'src/api.ts', content: "import client from 'demo-http';\n\nexport const get = (url: string) => client.get(url);\n" },
  { path: 'src/dates.ts', content: "import { parse } from 'demo-dates';\n\nexport const when = (value: string) => parse(value);\n" },
  { path: 'src/format.ts', content: "import { clamp } from 'demo-utils';\n\nexport const pct = (value: number) => clamp(value, 0, 100);\n" },
];

const LATEST: Record<string, string[]> = {
  'demo-router': ['2.4.0', '2.5.0', '3.0.0'],
  'demo-schema': ['1.8.0', '1.9.2'],
  'demo-http': ['0.33.2', '0.34.1'],
  'demo-dates': ['2.30.0', '3.0.0'],
  'demo-utils': ['4.17.21'],
  'demo-build': ['5.2.0', '5.4.2'],
  'demo-lint': ['8.57.0', '9.12.0'],
};

const CHANGELOGS: Record<string, string> = {
  'demo-router': `# Changelog

## 3.0.0

### Major Changes

- Removed the \`json\` helper. Return plain objects from loaders instead.
- Renamed \`createRouter\` options: \`basename\` is now \`base\`.

### Minor Changes

- Added \`redirect\` options.

## 2.5.0

- Added a new \`prefetch\` option.
`,
  'demo-http': `# Changelog

## 0.34.0

- Added retry support.
- Improved error messages.
`,
  'demo-dates': `# Changelog

## 3.0.0

- Updated the documentation for \`parse\`.
- Added \`formatRelative\`.
`,
};

function packument(name: string) {
  const versions = LATEST[name] ?? [];
  const built: Record<string, { peerDependencies: Record<string, string> }> = {};
  for (const version of versions) built[version] = { peerDependencies: {} };
  return { name, distTags: { latest: versions[versions.length - 1] ?? '0.0.0' }, versions: built };
}

const demoRegistry: RegistryClient = {
  async getPackument(name): Promise<FetchPackumentResult> {
    return name in LATEST
      ? { ok: true, packument: packument(name) }
      : { ok: false, code: 'NOT_FOUND', message: `"${name}" was not found.` };
  },
};

const demoManifests: ManifestClient = {
  async getManifest(name): Promise<FetchManifestResult> {
    return { ok: true, manifest: { repository: `github:demo/${name}` } };
  },
};

const demoChangelogs: ChangelogSource = {
  async fetchChangelog(_repository, request) {
    const text = CHANGELOGS[request.packageName];
    if (text === undefined) return { ok: false, code: 'NOT_FOUND', message: 'No changelog file or GitHub releases were found.' };
    const sections = sectionsBetween(parseVersionSections(text, request.packageName), request.from, request.to);
    return sections.length > 0
      ? { ok: true, source: 'file', path: 'CHANGELOG.md', sections }
      : { ok: false, code: 'NO_MATCHING_VERSIONS', message: 'The changelog has no entries between these versions.' };
  },
};

const demoAi: AiProvider = {
  async complete(request) {
    const line = /^(L\d+) .*Removed the `json` helper/m.exec(request.user);
    if (!line) {
      return {
        ok: true,
        text: JSON.stringify({ summary: 'The changelog does not describe a change that affects the names you import.', confidence: 'low', unknown: true, findings: [], steps: [] }),
      };
    }
    return {
      ok: true,
      text: JSON.stringify({
        summary: 'The json helper was removed in 3.0.0. Loaders now return plain objects.',
        confidence: 'high',
        unknown: false,
        findings: [{ kind: 'breaking', symbol: 'json', description: 'The json helper was removed.', evidence: [line[1]] }],
        steps: ['Replace json(value) with value in your loaders.', 'Rename the basename option to base if you set it.', 'Run your route tests.'],
      }),
    };
  },
};

export async function buildDemoReport(now: Date = new Date()): Promise<AnalysisReport> {
  const parsed = readProject({ packageJson: DEMO_PACKAGE_JSON, lockfile: DEMO_LOCKFILE });
  if (!parsed.ok) throw new Error('The demo project is invalid.');

  const analysis = await analyzeProject(parsed.value.entries, { registry: demoRegistry });
  const scan = scanProject(DEMO_SOURCES, { knownPackages: parsed.value.entries.map((entry) => entry.name) });
  attachImpact(analysis.results, buildUsageIndex(scan.imports), parsed.value.scripts);
  await enrichWithChangelogs(analysis.results, { manifests: demoManifests, changelogs: demoChangelogs, ai: demoAi });

  return {
    source: 'demo',
    fileName: 'package.json',
    lockfileName: 'package-lock.json',
    generatedAt: now.toISOString(),
    entries: parsed.value.entries,
    analysis,
    warnings: parsed.warnings,
    scan: { scannedFiles: scan.scannedFiles, unsupportedFiles: 0, truncated: false },
    notes: ['This is sample data for a made-up project. Nothing was sent to npm or GitHub.'],
  };
}

export const demoDeps = {
  registry: demoRegistry,
  manifests: demoManifests,
  changelogs: demoChangelogs,
  ai: demoAi,
};
