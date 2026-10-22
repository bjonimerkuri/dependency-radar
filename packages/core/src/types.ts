export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export type SpecKind =
  | 'exact'
  | 'range'
  | 'any'
  | 'tag'
  | 'alias'
  | 'workspace'
  | 'local'
  | 'git'
  | 'url'
  | 'unknown';

export interface Position {
  line: number;
  column: number;
}

export interface ParsedSpecifier {
  kind: SpecKind;
  raw: string;
  analyzable: boolean;
  reason?: string;
  aliasOf?: string;
  aliasRange?: string;
}

export interface DependencyEntry {
  name: string;
  section: DependencySection;
  spec: string;
  kind: SpecKind;
  analyzable: boolean;
  reason?: string;
  aliasOf?: string;
  aliasRange?: string;
  installed?: string;
  position?: Position;
}

export interface ParsedPackage {
  name?: string;
  version?: string;
  private: boolean;
  packageManager?: string;
  engines: Record<string, string>;
  scripts: Record<string, string>;
  workspaces: string[];
  entries: DependencyEntry[];
}

export type WarningCode =
  | 'NO_LOCKFILE'
  | 'LOCKFILE_UNSUPPORTED'
  | 'LOCKFILE_INVALID'
  | 'LOCKFILE_TOO_LARGE'
  | 'MONOREPO'
  | 'UNSAFE_NAME'
  | 'INVALID_NAME'
  | 'INVALID_SPEC'
  | 'INVALID_SECTION'
  | 'CONFLICTING_SPEC'
  | 'NO_DEPENDENCIES';

export interface Warning {
  code: WarningCode;
  message: string;
  name?: string;
  section?: DependencySection;
}

export type ErrorCode = 'EMPTY' | 'TOO_LARGE' | 'INVALID_JSON' | 'NOT_AN_OBJECT';

export interface ParseError {
  code: ErrorCode;
  message: string;
  position?: Position;
}

export interface ReadProjectInput {
  packageJson: string;
  lockfile?: string;
}

export interface ReadProjectOptions {
  maxPackageJsonBytes?: number;
  maxLockfileBytes?: number;
}

export type ReadProjectResult =
  | { ok: true; value: ParsedPackage; warnings: Warning[] }
  | { ok: false; error: ParseError };

export interface DependencyGroup {
  name: string;
  entries: DependencyEntry[];
}
