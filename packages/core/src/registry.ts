import semver from 'semver';
import { isPlainObject, isValidPackageName, stringRecord } from './util.ts';

export interface VersionInfo {
  deprecated?: string;
  peerDependencies: Record<string, string>;
}

export interface Packument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, VersionInfo>;
}

export type RegistryErrorCode =
  | 'INVALID_NAME'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'TOO_LARGE';

export type FetchPackumentResult =
  | { ok: true; packument: Packument }
  | { ok: false; code: RegistryErrorCode; message: string };

export interface RegistryClient {
  getPackument(name: string): Promise<FetchPackumentResult>;
}

export interface RegistryClientOptions {
  fetch?: typeof fetch;
  registryUrl?: string;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const ALLOWED_REGISTRY_HOSTS: readonly string[] = ['registry.npmjs.org'];

const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';
const MAX_DEPRECATION_LENGTH = 300;

export function normalizePackument(raw: unknown): Packument | undefined {
  if (!isPlainObject(raw) || typeof raw.name !== 'string' || !isPlainObject(raw.versions)) return undefined;

  const distTags: Record<string, string> = {};
  if (isPlainObject(raw['dist-tags'])) {
    for (const [tag, version] of Object.entries(raw['dist-tags'])) {
      if (tag === '__proto__' || typeof version !== 'string' || semver.valid(version) !== version) continue;
      distTags[tag] = version;
    }
  }

  const versions: Record<string, VersionInfo> = {};
  for (const [version, info] of Object.entries(raw.versions)) {
    if (semver.valid(version) !== version || !isPlainObject(info)) continue;
    const entry: VersionInfo = { peerDependencies: stringRecord(info.peerDependencies) };
    if (typeof info.deprecated === 'string' && info.deprecated.trim() !== '') {
      entry.deprecated = info.deprecated.trim().slice(0, MAX_DEPRECATION_LENGTH);
    }
    versions[version] = entry;
  }

  return { name: raw.name, distTags, versions };
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const base = new URL(options.registryUrl ?? 'https://registry.npmjs.org');
  if (base.protocol !== 'https:' || !ALLOWED_REGISTRY_HOSTS.includes(base.host)) {
    throw new Error(`Registry host not allowed: ${base.host}`);
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 30_000_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function getPackument(name: string): Promise<FetchPackumentResult> {
    if (!isValidPackageName(name)) {
      return { ok: false, code: 'INVALID_NAME', message: `"${name}" is not a valid package name.` };
    }
    const url = `${base.origin}/${name.replace('/', '%2F')}`;
    let failure: { code: RegistryErrorCode; message: string } = {
      code: 'UNAVAILABLE',
      message: 'The npm registry could not be reached.',
    };
    let requestedDelay: number | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const backoff = baseDelayMs * 2 ** (attempt - 1);
        await sleep(Math.min(requestedDelay ?? backoff, maxDelayMs));
        requestedDelay = undefined;
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          headers: { accept: ABBREVIATED_ACCEPT },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        failure = { code: 'UNAVAILABLE', message: 'The npm registry could not be reached.' };
        continue;
      }

      if (response.status === 404) {
        return { ok: false, code: 'NOT_FOUND', message: `"${name}" was not found in the npm registry.` };
      }
      if (response.status === 429 || response.status >= 500) {
        failure =
          response.status === 429
            ? { code: 'RATE_LIMITED', message: 'The npm registry is rate limiting requests.' }
            : { code: 'UNAVAILABLE', message: `The npm registry returned HTTP ${response.status}.` };
        requestedDelay = retryAfterMs(response);
        continue;
      }
      if (!response.ok) {
        return { ok: false, code: 'UNAVAILABLE', message: `The npm registry returned HTTP ${response.status}.` };
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        failure = { code: 'UNAVAILABLE', message: 'The npm registry response was interrupted.' };
        continue;
      }
      if (text.length > maxBytes) {
        return { ok: false, code: 'TOO_LARGE', message: `The registry response for "${name}" is too large.` };
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, code: 'INVALID_RESPONSE', message: 'The registry response is not valid JSON.' };
      }
      const packument = normalizePackument(raw);
      if (!packument) {
        return { ok: false, code: 'INVALID_RESPONSE', message: 'The registry response has an unexpected shape.' };
      }
      return { ok: true, packument };
    }

    return { ok: false, ...failure };
  }

  return { getPackument };
}
