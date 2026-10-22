import type { ParsedSpecifier } from './types.ts';

const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_CHARS = /^[0-9A-Za-z\s.^~<>=|*+-]+$/;
const RANGE_START = /^(?:[\^~<>=]|v?\d|[xX*]\b)/;
const TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/;
const GIT_PREFIXES = ['git+', 'git://', 'git@', 'github:', 'gitlab:', 'bitbucket:', 'gist:'];
const LOCAL_PREFIXES = ['file:', 'link:', 'portal:'];

export function parseSpecifier(raw: string): ParsedSpecifier {
  const spec = raw.trim();

  if (spec === '' || spec === '*' || spec.toLowerCase() === 'x') {
    return { kind: 'any', raw, analyzable: true };
  }
  if (spec.startsWith('workspace:')) {
    return {
      kind: 'workspace',
      raw,
      analyzable: false,
      reason: 'Workspace dependency, resolved inside the monorepo',
    };
  }
  if (LOCAL_PREFIXES.some((prefix) => spec.startsWith(prefix))) {
    return { kind: 'local', raw, analyzable: false, reason: 'Local path dependency' };
  }
  if (GIT_PREFIXES.some((prefix) => spec.startsWith(prefix)) || GITHUB_SHORTHAND.test(spec)) {
    return { kind: 'git', raw, analyzable: false, reason: 'Git dependency, not in the npm registry' };
  }
  if (/^https?:\/\//i.test(spec)) {
    return { kind: 'url', raw, analyzable: false, reason: 'Tarball URL dependency, not in the npm registry' };
  }
  if (spec.startsWith('npm:')) {
    const target = spec.slice(4);
    const at = target.lastIndexOf('@');
    const aliasOf = at > 0 ? target.slice(0, at) : target;
    const aliasRange = at > 0 ? target.slice(at + 1) : 'latest';
    if (aliasOf === '') {
      return { kind: 'unknown', raw, analyzable: false, reason: 'Alias without a package name' };
    }
    return { kind: 'alias', raw, analyzable: true, aliasOf, aliasRange };
  }
  if (EXACT.test(spec)) {
    return { kind: 'exact', raw, analyzable: true };
  }
  if (RANGE_START.test(spec) && RANGE_CHARS.test(spec)) {
    return { kind: 'range', raw, analyzable: true };
  }
  if (TAG.test(spec)) {
    return { kind: 'tag', raw, analyzable: true };
  }
  return { kind: 'unknown', raw, analyzable: false, reason: 'Unrecognized version specifier' };
}
