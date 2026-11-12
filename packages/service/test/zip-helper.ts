import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data?: string | Uint8Array;
  method?: 0 | 8;
  flags?: number;
  crc?: number;
  declaredSize?: number;
  utf8?: boolean;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

export function makeZip(entries: readonly ZipEntry[], comment = ''): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, entry.utf8 === false ? 'latin1' : 'utf8');
    const flags = (entry.flags ?? 0) | (entry.utf8 === false ? 0 : 0x800);
    const crc = entry.crc ?? crc32(raw);
    const size = entry.declaredSize ?? raw.length;

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(body.length), u32(size),
      u16(name.length), u16(0), name, body,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc), u32(body.length), u32(size),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const directory = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset),
    u16(commentBytes.length), commentBytes,
  ]);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
