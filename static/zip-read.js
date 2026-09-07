// A ZIP reader for the browser, with nothing to install.
//
// The eShop installs a web game by fetching its build as one zip (a GitHub
// codeload zipball through /api/eshop/zip, or a committed release zip) and
// filing every entry in Cache Storage (static/eshop-library.js). The old
// launcher pulled JSZip off a CDN for that step, which made an install depend
// on a third origin being up; this is the part of JSZip the install actually
// uses, on the platform's own DecompressionStream. lib/ps2/zip.ts is the
// matching WRITER, and tests/zip_read_test.ts reads its archives back through
// here.
//
// Scope: PKZip 2.0 — stored (0) and deflated (8) entries, read through the
// central directory (the local headers are consulted only for where each
// entry's bytes start, so an archive that streamed its sizes into data
// descriptors reads fine: the central copy is authoritative). Zip64 and
// encrypted entries are refused with a message that says so rather than
// misread. Paths come back normalised for use as cache keys: forward
// slashes, no leading "./" or "/", and any entry that climbs with ".." is
// dropped — a key under /eshop/<id>/ must stay under it.
//
// Environment-neutral ESM: Deno runs the tests, the browser runs the install.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
// The end record is 22 bytes plus a comment of at most 65535.
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as ZIP records it — checked on every entry, so a truncated or
 * corrupted download fails the install instead of caching broken files. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("unzip: expected an ArrayBuffer, Uint8Array or Blob");
}

/** Inflate one method-8 body. A copy is handed to Blob so a view into the
 * archive is not what the stream holds on to. */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The archive's path, as a cache key: "/"-separated, relative, and inside
 * the archive's root. Null when the entry climbs out with "..".
 */
export function normalizeZipPath(name) {
  let path = String(name).replace(/\\/g, "/");
  // Strip every leading "./" and "/" — "././a" and "//a" both mean "a".
  while (path.startsWith("./") || path.startsWith("/")) {
    path = path.startsWith("./") ? path.slice(2) : path.slice(1);
  }
  const parts = path.split("/");
  if (parts.some((p) => p === "..")) return null;
  // A stray "." segment in the middle ("a/./b") is the same file as "a/b"; a
  // trailing "" (from "dir/") survives, since that is what marks a directory.
  return parts.filter((p) => p !== ".").join("/");
}

/** Find the end-of-central-directory record, scanning back over any comment. */
function findEocd(bytes, view) {
  const stop = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let at = bytes.length - EOCD_MIN; at >= stop; at--) {
    if (view.getUint32(at, true) !== EOCD_SIG) continue;
    // The comment length has to reach exactly the end of the file, or this is
    // the signature bytes of something else (an entry's data, say).
    if (at + EOCD_MIN + view.getUint16(at + 20, true) === bytes.length) {
      return at;
    }
  }
  return -1;
}

/**
 * Read `input` (ArrayBuffer | Uint8Array | Blob) as a ZIP archive.
 *
 * Resolves to every entry, in central-directory order:
 *   { path, dir, data }
 * where `dir` marks a directory entry (its `data` is empty) and `data` is the
 * entry's bytes, inflated. Entries whose path escapes the archive root are
 * omitted. Rejects on anything that is not a PKZip 2.0 archive this reader
 * covers, with a message naming the reason.
 */
export async function unzip(input) {
  const bytes = await toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < EOCD_MIN) throw new Error("unzip: not a zip archive");

  const eocd = findEocd(bytes, view);
  if (eocd < 0) {
    throw new Error("unzip: not a zip archive (no end-of-central-directory)");
  }
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    count === 0xffff || centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG)
  ) {
    throw new Error("unzip: zip64 archives are not supported");
  }
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true)) {
    throw new Error("unzip: multi-disk archives are not supported");
  }
  if (centralOffset + centralSize > eocd) {
    throw new Error("unzip: the central directory runs past the end record");
  }

  const utf8 = new TextDecoder("utf-8");
  const entries = [];
  let at = centralOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new Error(`unzip: bad central directory entry ${n}`);
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLen);
    // cp437 names (no UTF-8 flag) are decoded as UTF-8 too: ASCII, which is
    // what every build tool emits, reads identically either way.
    const name = utf8.decode(rawName);
    at += 46 + nameLen + extraLen + commentLen;

    if (flags & FLAG_ENCRYPTED) {
      throw new Error(`unzip: "${name}" is encrypted`);
    }
    if (
      compressedSize === 0xffffffff || size === 0xffffffff ||
      offset === 0xffffffff
    ) {
      throw new Error("unzip: zip64 archives are not supported");
    }
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw new Error(
        `unzip: "${name}" uses compression method ${method} (only stored and deflate are supported)`,
      );
    }

    const path = normalizeZipPath(name);
    if (path === null || path === "") continue; // climbs out, or the root itself
    const dir = path.endsWith("/");
    if (dir) {
      entries.push({ path, dir: true, data: new Uint8Array(0) });
      continue;
    }

    // The local header only tells us where the bytes start: its own name and
    // extra field may differ in length from the central copy (zip tools pad
    // the local extra field), so they are measured here rather than assumed.
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== LOCAL_SIG) {
      throw new Error(`unzip: "${name}" has no local header at ${offset}`);
    }
    const dataAt = offset + 30 + view.getUint16(offset + 26, true) +
      view.getUint16(offset + 28, true);
    if (dataAt + compressedSize > bytes.length) {
      throw new Error(`unzip: "${name}" is truncated`);
    }
    const body = bytes.subarray(dataAt, dataAt + compressedSize);
    const data = method === METHOD_DEFLATE ? await inflateRaw(body) : body.slice();
    if (data.length !== size) {
      throw new Error(
        `unzip: "${name}" inflated to ${data.length} bytes, expected ${size}`,
      );
    }
    if (crc32(data) !== crc) {
      throw new Error(`unzip: "${name}" failed its CRC check`);
    }
    entries.push({ path, dir: false, data });
  }
  return entries;
}
