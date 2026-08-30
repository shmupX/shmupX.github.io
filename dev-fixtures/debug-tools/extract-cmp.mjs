// Extract a file from the Dezaemon 2 disc image (Track 1, MODE1/2352 raw
// sectors) and, for .CMP files, decompress it: a .CMP is a 4-byte
// little-endian stream-length header followed by the same Okumura LZSS the
// save sections use. GAME.CMP decompresses to the 165,628-byte play-mode
// engine that all the FORMAT.md traces reference (file offset = RAM address
// - 0x06064000). Skipping the header "works" but corrupts the ring phase —
// the output is subtly wrong everywhere, so this always validates length.
//
//   node dev-fixtures/debug-tools/extract-cmp.mjs [NAME.CMP] [--out dir]
//
// With no name, lists the disc's files. Default out dir: alongside this
// script's cwd as ./NAME and ./NAME.bin (decompressed).
//
// The decoder lives in the 2019-es7 sibling checkout; point somewhere else
// with CMG_ES7_ROOT.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CMG_ROOT = path.resolve(HERE, "..", "..");
const ES7_ROOT = process.env.CMG_ES7_ROOT ??
  ["2019-es7", "2019-es7-0822"]
    .map((d) => path.resolve(CMG_ROOT, "..", d))
    .find((d) =>
      fs.existsSync(path.join(d, "tools", "dezaemon-import", "lib"))
    );
if (!ES7_ROOT) {
  console.error("2019-es7 checkout not found — set CMG_ES7_ROOT");
  process.exit(1);
}
const { decompress } = await import(
  path.join(ES7_ROOT, "tools/dezaemon-import/lib/decompress.js")
);

const TRACK = path.join(
  CMG_ROOT,
  "dev-fixtures",
  "Dezaemon 2 (Japan) (Track 1).bin",
);
if (!fs.existsSync(TRACK)) {
  console.error(`disc image not found: ${TRACK}`);
  process.exit(1);
}
const raw = fs.readFileSync(TRACK);
const SECTOR = 2352, DATA_OFF = 16, DATA = 2048;
const sector = (n) =>
  raw.subarray(n * SECTOR + DATA_OFF, n * SECTOR + DATA_OFF + DATA);

const pvd = sector(16);
if (pvd[0] !== 1 || pvd.toString("latin1", 1, 6) !== "CD001") {
  console.error("no ISO9660 PVD at sector 16 — not a MODE1/2352 track?");
  process.exit(1);
}
const rootExtent = pvd.readUInt32LE(156 + 2);
const rootSize = pvd.readUInt32LE(156 + 10);

function listDir(extent, size) {
  const entries = [];
  for (let s = 0; s < Math.ceil(size / DATA); s++) {
    const d = sector(extent + s);
    let o = 0;
    while (o < DATA) {
      const len = d[o];
      if (!len) {
        o++;
        continue;
      }
      const nameLen = d[o + 32];
      const name = d.toString("latin1", o + 33, o + 33 + nameLen).split(";")[0];
      // 0x00/0x01 names are the "." and ".." self-references
      if (name.length && name.charCodeAt(0) >= 32) {
        entries.push({
          name,
          extent: d.readUInt32LE(o + 2),
          size: d.readUInt32LE(o + 10),
          dir: (d[o + 25] & 2) !== 0,
        });
      }
      o += len;
    }
  }
  return entries;
}

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outDir = outAt >= 0 ? args.splice(outAt, 2)[1] : ".";
const want = args[0] ? args[0].toUpperCase() : null;

const files = listDir(rootExtent, rootSize).filter((e) => !e.dir);
if (!want) {
  for (const e of files) console.log(e.name.padEnd(14), e.size, "B");
  process.exit(0);
}

const hit = files.find((e) => e.name.toUpperCase() === want);
if (!hit) {
  console.error(`${want} not on the disc (run without arguments to list)`);
  process.exit(1);
}
const buf = Buffer.alloc(hit.size);
for (let s = 0; s < Math.ceil(hit.size / DATA); s++) {
  sector(hit.extent + s).copy(
    buf,
    s * DATA,
    0,
    Math.min(DATA, hit.size - s * DATA),
  );
}
fs.mkdirSync(outDir, { recursive: true });
const rawOut = path.join(outDir, hit.name);
fs.writeFileSync(rawOut, buf);
console.log(`wrote ${rawOut} (${hit.size} B)`);

if (hit.name.toUpperCase().endsWith(".CMP")) {
  const streamLen = buf.readUInt32LE(0);
  if (streamLen !== buf.length - 4) {
    console.error(
      `header says ${streamLen} stream bytes but file holds ${
        buf.length - 4
      } — not decompressing`,
    );
    process.exit(1);
  }
  const out = decompress(buf.subarray(4));
  const binOut = rawOut.replace(/\.cmp$/i, "") + ".bin";
  fs.writeFileSync(binOut, out);
  console.log(`wrote ${binOut} (${out.length} B decompressed)`);
}
