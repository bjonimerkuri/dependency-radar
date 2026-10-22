export interface CliArgs {
  path: string;
  lockfile?: string;
  json: boolean;
  noColor: boolean;
  all: boolean;
  failOnMajor: boolean;
  help: boolean;
  error?: string;
}

export const HELP = `Usage: dependency-radar [path/to/package.json] [options]

Checks every dependency against the npm registry and tells you which updates are safe, which need a look, and which are major version changes.

Options:
  --lockfile <path>  Read installed versions from this package-lock.json
                     (default: package-lock.json next to package.json)
  --all              Also list safe, up to date and skipped packages
  --json             Print the full result as JSON
  --fail-on-major    Exit with code 2 if any major update is found
  --no-color         Disable colors
  -h, --help         Show this help`;

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    path: 'package.json',
    json: false,
    noColor: false,
    all: false,
    failOnMajor: false,
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
      case '--fail-on-major':
        args.failOnMajor = true;
        break;
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
