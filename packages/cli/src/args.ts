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
