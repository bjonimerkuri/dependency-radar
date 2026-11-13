export interface CliArgs {
  path: string;
  lockfile?: string;
  html?: string;
  json: boolean;
  noColor: boolean;
  all: boolean;
  noScan: boolean;
  noChangelog: boolean;
  noAi: boolean;
  failOnMajor: boolean;
  failOnBreaking: boolean;
  help: boolean;
  error?: string;
}

export const HELP = `Usage: dependency-radar [path/to/package.json] [options]
       dependency-radar check [folder] [options]   (look for warning signs before installing a project)
       dependency-radar fix --ticket <file> [package.json] [options]   (turn a security ticket into changes)

Checks every dependency against the npm registry and tells you which updates are safe, which need a look, and which are major version changes. It also reads the source code next to package.json to show where each package is used, and reads changelogs from GitHub to check whether the names you import changed.

Environment:
  GITHUB_TOKEN       Raises the GitHub rate limit for changelog lookups
  RADAR_AI_BASE_URL, RADAR_AI_KEY, RADAR_AI_MODEL
                     Optional. An OpenAI-compatible endpoint that explains changelogs

Options:
  --lockfile <path>  Read installed versions from this package-lock.json
                     (default: package-lock.json next to package.json)
  --all              Also list safe, up to date and skipped packages
  --no-scan          Do not read the source code next to package.json
  --json             Print the full result as JSON
  --html <path>      Also write a self-contained HTML report to this file
  --no-changelog     Do not read changelogs from GitHub
  --no-ai            Do not ask an AI to explain changelogs
  --fail-on-breaking Exit with code 2 if an update breaks code that uses it
  --fail-on-major    Exit with code 2 if any major update is found
  --no-color         Disable colors
  -h, --help         Show this help`;

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    path: 'package.json',
    json: false,
    noColor: false,
    all: false,
    noScan: false,
    noChangelog: false,
    noAi: false,
    failOnMajor: false,
    failOnBreaking: false,
    help: false,
  };
  let positionals = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--no-scan':
        args.noScan = true;
        break;
      case '--no-changelog':
        args.noChangelog = true;
        break;
      case '--no-ai':
        args.noAi = true;
        break;
      case '--fail-on-breaking':
        args.failOnBreaking = true;
        break;
      case '--fail-on-major':
        args.failOnMajor = true;
        break;
      case '--html': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          args.error = '--html needs a file path';
          return args;
        }
        args.html = value;
        i++;
        break;
      }
      case '--lockfile': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          args.error = '--lockfile needs a path';
          return args;
        }
        args.lockfile = value;
        i++;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          args.error = `Unknown option: ${arg}`;
          return args;
        }
        if (positionals > 0) {
          args.error = 'Only one package.json path is accepted';
          return args;
        }
        args.path = arg;
        positionals++;
    }
  }
  return args;
}

export interface CheckArgs {
  dir: string;
  json: boolean;
  html?: string;
  noColor: boolean;
  all: boolean;
  stats: boolean;
  failOn?: 'high' | 'medium';
  help: boolean;
  error?: string;
}

export const CHECK_HELP = `Usage: dependency-radar check [folder] [options]

Looks for warning signs in a project you have downloaded but not installed yet, for example one sent to you as a coding test: install scripts that download code, files that run when a folder is opened, look-alike package names, obfuscated code and more.

It only reads files. Nothing in the project is run or installed. Finding no signals does not mean a project is safe.

Options:
  --all              Also list informational notes
  --stats            Look up weekly downloads on npm for look-alike package names
  --html <path>      Also write a self-contained HTML report to this file
  --json             Print the full result as JSON
  --fail-on <level>  Exit with code 2 if a signal of this level (high or medium) or above is found
  --no-color         Disable colors
  -h, --help         Show this help`;

export function parseCheckArgs(argv: readonly string[]): CheckArgs {
  const args: CheckArgs = { dir: '.', json: false, noColor: false, all: false, stats: false, help: false };
  let positionals = 0;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--stats':
        args.stats = true;
        break;
      case '--html': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) {
          args.error = '--html needs a file path';
          return args;
        }
        args.html = value;
        i++;
        break;
      }
      case '--fail-on': {
        const value = argv[i + 1];
        if (value !== 'high' && value !== 'medium') {
          args.error = '--fail-on needs high or medium';
          return args;
        }
        args.failOn = value;
        i++;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          args.error = `Unknown option: ${arg}`;
          return args;
        }
        if (positionals > 0) {
          args.error = 'Only one folder is accepted';
          return args;
        }
        args.dir = arg;
        positionals++;
    }
  }
  return args;
}

export interface FixArgs {
  path: string;
  tickets: string[];
  lockfile?: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  fixed: Record<string, string[]>;
  noLookup: boolean;
  noScan: boolean;
  noChangelog: boolean;
  json: boolean;
  html?: string;
  patch?: string;
  pr?: string;
  prFormat: 'markdown' | 'jira';
  lang: 'en' | 'sq';
  failIfChanges: boolean;
  noColor: boolean;
  help: boolean;
  error?: string;
}

export const FIX_HELP = `Usage: dependency-radar fix --ticket <file> [path/to/package.json] [options]

Turns the text of a security ticket (Snyk, Dependabot, Trivy, npm audit or an internal ticket) into concrete changes: which package, which line of package.json, which version and why. It reads package.json and package-lock.json and never runs or installs anything.

Several tickets can be in one file, separated by a line of three or more dashes (---), or you can repeat --ticket. You then get one diff and a table that shows which change closes which ticket.

Options:
  --ticket <file>    The ticket text. Use - to read it from standard input. Can be repeated
  --lockfile <path>  Read the dependency tree from this package-lock.json
                     (default: package-lock.json next to package.json)
  --pm <name>        npm, yarn or pnpm. Decides which override key and commands are used
                     (default: the packageManager field, then npm)
  --fixed <pkg@ver>  A fixed version you know, when the ticket does not list one. Can be repeated
  --patch <path>     Also write the change to package.json as a unified diff
  --pr <path>        Write a description for the pull request or Jira ticket. Use - to print
                     only the description on standard output
  --pr-format <f>    markdown (GitHub, default) or jira (plain text)
  --lang <code>      Language of the description: en (default) or sq
  --html <path>      Also write a self-contained HTML report to this file
  --json             Print the full result as JSON
  --offline          Do not contact any service (same as --no-lookup --no-changelog)
  --no-lookup        Do not ask the OSV advisory database for missing fixed versions
  --no-changelog     Do not read changelogs for major version fixes
  --no-scan          Do not read the source code next to package.json
  --fail-if-changes  Exit with code 2 if any package needs a change
  --no-color         Disable colors
  -h, --help         Show this help

Exit codes: 0 done, 1 error, 2 a change is needed (only with --fail-if-changes).

Your code is only read on your computer. When a fixed version is missing, only the advisory id and package name are sent to api.osv.dev. Do not put confidential information in a ticket that you paste into a description.`;

export function parseFixArgs(argv: readonly string[]): FixArgs {
  const args: FixArgs = {
    path: 'package.json',
    tickets: [],
    fixed: {},
    noLookup: false,
    noScan: false,
    noChangelog: false,
    json: false,
    prFormat: 'markdown',
    lang: 'en',
    failIfChanges: false,
    noColor: false,
    help: false,
  };
  let positionals = 0;
  const value = (index: number, flag: string, what: string): string | undefined => {
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith('-') && next !== '-')) {
      args.error = `${flag} needs ${what}`;
      return undefined;
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-color':
        args.noColor = true;
        break;
      case '--no-lookup':
        args.noLookup = true;
        break;
      case '--no-scan':
        args.noScan = true;
        break;
      case '--no-changelog':
        args.noChangelog = true;
        break;
      case '--offline':
        args.noLookup = true;
        args.noChangelog = true;
        break;
      case '--fail-if-changes':
        args.failIfChanges = true;
        break;
      case '--ticket':
      case '--lockfile':
      case '--html':
      case '--patch':
      case '--pr': {
        const next = value(i, arg, arg === '--ticket' ? 'a file (or - for standard input)' : 'a path');
        if (next === undefined) return args;
        if (arg === '--ticket') args.tickets.push(next);
        else if (arg === '--lockfile') args.lockfile = next;
        else if (arg === '--html') args.html = next;
        else if (arg === '--patch') args.patch = next;
        else args.pr = next;
        i++;
        break;
      }
      case '--pm': {
        const next = value(i, arg, 'npm, yarn or pnpm');
        if (next === undefined) return args;
        if (next !== 'npm' && next !== 'yarn' && next !== 'pnpm') {
          args.error = '--pm needs npm, yarn or pnpm';
          return args;
        }
        args.packageManager = next;
        i++;
        break;
      }
      case '--pr-format': {
        const next = value(i, arg, 'markdown or jira');
        if (next === undefined) return args;
        if (next !== 'markdown' && next !== 'jira') {
          args.error = '--pr-format needs markdown or jira';
          return args;
        }
        args.prFormat = next;
        i++;
        break;
      }
      case '--lang': {
        const next = value(i, arg, 'en or sq');
        if (next === undefined) return args;
        if (next !== 'en' && next !== 'sq') {
          args.error = '--lang needs en or sq';
          return args;
        }
        args.lang = next;
        i++;
        break;
      }
      case '--fixed': {
        const next = value(i, arg, 'a value like lodash@4.17.21');
        if (next === undefined) return args;
        const at = next.lastIndexOf('@');
        const name = at > 0 ? next.slice(0, at) : '';
        const version = at > 0 ? next.slice(at + 1) : '';
        if (name === '' || !/^v?\d+\.\d+\.\d+/.test(version)) {
          args.error = '--fixed needs a value like lodash@4.17.21';
          return args;
        }
        (args.fixed[name] ??= []).push(version);
        i++;
        break;
      }
      default:
        if (arg.startsWith('-')) {
          args.error = `Unknown option: ${arg}`;
          return args;
        }
        if (positionals > 0) {
          args.error = 'Only one package.json path is accepted';
          return args;
        }
        args.path = arg;
        positionals++;
    }
  }
  return args;
}
