import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipFile {
  path: string;
  content: string;
}

export interface ReadZipOptions {
  maxZipBytes?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  include?: (path: string, size: number) => boolean;
}

export type ZipErrorCode = 'NOT_A_ZIP' | 'TOO_LARGE' | 'TOO_MANY_ENTRIES' | 'ZIP64' | 'CORRUPT';

export type ReadZipResult =
  | { ok: true; files: ZipFile[]; names: string[]; skipped: number; truncated: boolean }
  | { ok: false; code: ZipErrorCode; message: string };

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

function fail(code: ZipErrorCode, message: string): ReadZipResult {
  return { ok: false, code, message };
}

function normalizePath(name: string): string | undefined {
  const path = name.replace(/\\/g, '/');
  if (path === '' || path.startsWith('/') || path.includes('\0') || /^[A-Za-z]:/.test(path)) return undefined;
  if (path.split('/').some((segment) => segment === '..')) return undefined;
  return path;
}

export function readZip(data: Uint8Array, options: ReadZipOptions = {}): ReadZipResult {
  const maxZipBytes = options.maxZipBytes ?? 25_000_000;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const maxTotalBytes = options.maxTotalBytes ?? 30_000_000;

  if (data.length > maxZipBytes) return fail('TOO_LARGE', 'The zip file is too large.');
  if (data.length < EOCD_MIN_LENGTH) return fail('NOT_A_ZIP', 'The file is not a zip archive.');

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  const lowest = Math.max(0, data.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let i = data.length - EOCD_MIN_LENGTH; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return fail('NOT_A_ZIP', 'The file is not a zip archive.');

  const totalEntries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return fail('ZIP64', 'Zip64 archives are not supported.');
  }
  if (totalEntries > maxEntries) return fail('TOO_MANY_ENTRIES', 'The zip file has too many entries.');
  if (directoryOffset + directorySize > eocd) return fail('CORRUPT', 'The zip directory is damaged.');

  const files: ZipFile[] = [];
  const names: string[] = [];
  let skipped = 0;
  let truncated = false;
  let totalBytes = 0;
  let position = directoryOffset;

  for (let index = 0; index < totalEntries; index++) {
    if (position + 46 > data.length || view.getUint32(position, true) !== CENTRAL_SIGNATURE) {
      return fail('CORRUPT', 'The zip directory is damaged.');
    }
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const expectedCrc = view.getUint32(position + 16, true);
    const compressedSize = view.getUint32(position + 20, true);
    const size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const localOffset = view.getUint32(position + 42, true);

    const nameStart = position + 46;
    if (nameStart + nameLength > data.length) return fail('CORRUPT', 'The zip directory is damaged.');
    const nameBytes = data.subarray(nameStart, nameStart + nameLength);
    position = nameStart + nameLength + extraLength + commentLength;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      return fail('ZIP64', 'Zip64 archives are not supported.');
    }

    const rawName = new TextDecoder((flags & 0x800) !== 0 ? 'utf-8' : 'latin1').decode(nameBytes);
    if (rawName.endsWith('/')) continue;
    const path = normalizePath(rawName);
    if (path === undefined) {
      skipped++;
      continue;
    }
    names.push(path);
    if (options.include && !options.include(path, size)) continue;
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || size > maxFileBytes) {
      skipped++;
      continue;
    }
    if (totalBytes + size > maxTotalBytes) {
      truncated = true;
      break;
    }

    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      skipped++;
      continue;
    }
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > data.length) {
      skipped++;
      continue;
    }

    let content: Uint8Array;
    try {
      const stored = data.subarray(dataStart, dataEnd);
      content = method === 0 ? stored : inflateRawSync(stored, { maxOutputLength: size + 1 });
    } catch {
      skipped++;
      continue;
    }
    if (content.length !== size || crc32(content) !== expectedCrc) {
      skipped++;
      continue;
    }

    totalBytes += size;
    files.push({ path, content: new TextDecoder('utf-8').decode(content) });
  }

  return { ok: true, files, names, skipped, truncated };
}
