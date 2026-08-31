// The `.zip` half of the PS2 export — the USB folder as one file.
//
// A PS2 build's folder artifact is a dozen small files (athena.elf, main.js,
// assets/*), which is exactly the shape that travels badly: a browser download,
// a chat attachment and a USB stick all want one blob. `--zip` writes the same
// tree as a ZIP whose entries are prefixed with the folder name, so unpacking
// anywhere reproduces the folder the loader expects.
//
// Deflate comes from the platform's own CompressionStream (see deflate.ts), so
// like the ISO writer next door this needs nothing installed. Entries are
// stored rather than deflated when compression does not actually pay — mostly
// the .adp/.ogg audio, which is already compressed.

import { type Bytes, deflateRaw } from "./deflate.ts";

export interface ZipEntry {
  /** Path inside the archive, `/`-separated. */
  path: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
// PKZip 2.0 — deflate. Nothing here needs a later feature.
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date and time, the only timestamp a plain ZIP entry carries. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (Math.floor(date.getUTCSeconds() / 2)) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCHours() << 11),
    date: date.getUTCDate() |
      ((date.getUTCMonth() + 1) << 5) |
      ((date.getUTCFullYear() - 1980) << 9),
  };
}

/** One entry's bytes, compressed only when that is actually smaller. */
async function pack(
  data: Uint8Array,
): Promise<{ method: number; body: Uint8Array }> {
  if (data.length === 0) return { method: METHOD_STORE, body: data };
  const copy = new Uint8Array(data.length) as Bytes;
  copy.set(data);
  const deflated = await deflateRaw(copy);
  return deflated.length < data.length
    ? { method: METHOD_DEFLATE, body: deflated }
    : { method: METHOD_STORE, body: data };
}

/**
 * Write `entries` as a ZIP archive.
 *
 * `date` is fixed by the caller rather than read from the clock, so rebuilding
 * the same export twice produces the same bytes — the same discipline the ISO
 * writer follows.
 */
export async function buildZip(
  entries: ZipEntry[],
  date: Date,
): Promise<Uint8Array> {
  const stamp = dosStamp(date);
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const { method, body } = await pack(entry.data);
    const sum = crc32(entry.data);

    const header = new Uint8Array(30 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, LOCAL_SIG, true);
    hv.setUint16(4, VERSION, true);
    hv.setUint16(6, 0, true); // flags
    hv.setUint16(8, method, true);
    hv.setUint16(10, stamp.time, true);
    hv.setUint16(12, stamp.date, true);
    hv.setUint32(14, sum, true);
    hv.setUint32(18, body.length, true);
    hv.setUint32(22, entry.data.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true); // extra field
    header.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const rv = new DataView(record.buffer);
    rv.setUint32(0, CENTRAL_SIG, true);
    rv.setUint16(4, VERSION, true); // version made by
    rv.setUint16(6, VERSION, true); // version needed
    rv.setUint16(8, 0, true);
    rv.setUint16(10, method, true);
    rv.setUint16(12, stamp.time, true);
    rv.setUint16(14, stamp.date, true);
    rv.setUint32(16, sum, true);
    rv.setUint32(20, body.length, true);
    rv.setUint32(24, entry.data.length, true);
    rv.setUint16(28, name.length, true);
    rv.setUint16(30, 0, true); // extra
    rv.setUint16(32, 0, true); // comment
    rv.setUint16(34, 0, true); // disk number
    rv.setUint16(36, 0, true); // internal attributes
    rv.setUint32(38, 0, true); // external attributes
    rv.setUint32(42, offset, true);
    record.set(name, 46);

    local.push(header, body);
    central.push(record);
    offset += header.length + body.length;
  }

  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with the central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // archive comment

  const parts = [...local, ...central, end];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
