export type HttpErrorCode = 'NOT_FOUND' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'TOO_LARGE' | 'BLOCKED';

export type HttpTextResult =
  | { ok: true; text: string }
  | { ok: false; code: HttpErrorCode; message: string };

export interface HttpTextOptions {
  fetch: typeof fetch;
  allowedHosts: readonly string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxChars?: number;
}

function hostAllowed(url: string, allowed: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && allowed.includes(parsed.host);
  } catch {
    return false;
  }
}

export async function getText(url: string, options: HttpTextOptions): Promise<HttpTextResult> {
  if (!hostAllowed(url, options.allowedHosts)) {
    return { ok: false, code: 'BLOCKED', message: 'The address is not on the list of allowed hosts.' };
  }

  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: options.headers ?? {},
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'The request could not be completed.' };
  }

  if (response.url !== '' && !hostAllowed(response.url, options.allowedHosts)) {
    return { ok: false, code: 'BLOCKED', message: 'The request was redirected to a host that is not allowed.' };
  }
  if (response.status === 404) return { ok: false, code: 'NOT_FOUND', message: 'Not found.' };
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return { ok: false, code: 'RATE_LIMITED', message: 'The rate limit was reached.' };
  }
  if (!response.ok) {
    return { ok: false, code: 'UNAVAILABLE', message: `The server returned HTTP ${response.status}.` };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'The response was interrupted.' };
  }
  if (text.length > (options.maxChars ?? 3_000_000)) {
    return { ok: false, code: 'TOO_LARGE', message: 'The response is too large.' };
  }
  return { ok: true, text };
}

export type HttpBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: HttpErrorCode; message: string };

export interface HttpBytesOptions {
  fetch: typeof fetch;
  allowedHosts: readonly string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function getBytes(url: string, options: HttpBytesOptions): Promise<HttpBytesResult> {
  if (!hostAllowed(url, options.allowedHosts)) {
    return { ok: false, code: 'BLOCKED', message: 'The address is not on the list of allowed hosts.' };
  }
  const maxBytes = options.maxBytes ?? 25_000_000;

  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: options.headers ?? {},
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'The request could not be completed.' };
  }

  if (response.url !== '' && !hostAllowed(response.url, options.allowedHosts)) {
    return { ok: false, code: 'BLOCKED', message: 'The request was redirected to a host that is not allowed.' };
  }
  if (response.status === 404) return { ok: false, code: 'NOT_FOUND', message: 'Not found.' };
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return { ok: false, code: 'RATE_LIMITED', message: 'The rate limit was reached.' };
  }
  if (!response.ok) {
    return { ok: false, code: 'UNAVAILABLE', message: `The server returned HTTP ${response.status}.` };
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, code: 'TOO_LARGE', message: 'The download is too large.' };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, code: 'UNAVAILABLE', message: 'The response had no body.' };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, code: 'TOO_LARGE', message: 'The download is too large.' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'The response was interrupted.' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
