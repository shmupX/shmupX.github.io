// Vendor the EmulatorJS player that boots static/games/super-mario-sp.
//
// Every other console in this project is an OPT-IN DOWNLOAD: static/emu-sw.js
// mirrors a core's paths from the cmg origin the first time a player asks for
// it, and this repo ships no emulator of its own ("Nothing is vendored here").
// Super Mario SP is the exception, deliberately, for two reasons:
//
//   1. It is ours. Every other core here runs somebody else's cartridge, so the
//      ROM has to come off the operator's own disk and the core is worth an
//      opt-in. This ROM is MIT homebrew we built, so the game is only a game if
//      it plays on sight.
//   2. An eShop "web" game is installed by unzipping it into Cache Storage and
//      serving it from /eshop/<id>/. That install has to be self-contained --
//      it is what makes the game work offline -- so the core has to be inside
//      the folder, not mirrored from anywhere.
//
// It cannot live under /snes/ instead. That prefix IS in emu-sw.js's MIRRORABLE
// list, so once a player installs the Super Famicom core every /snes/* request
// is answered from the cmg origin, which has never heard of this file. A local
// page there would be shadowed by the mirror. /games/ is outside MIRRORABLE,
// which is why the game folder is the only safe home.
//
// Pinned to an exact version, never "stable": emulator.min.js checks each core's
// build.json against its own ejs_version and hard-errors on a mismatch, so the
// loader and the core have to move together or not at all.
//
//   deno task super-mario-sp:vendor
//
// Writes static/games/super-mario-sp/emulatorjs/ and prints a sha256 table for
// VENDOR.md, so a re-vendor is a diff rather than an act of faith.

import { encodeHex } from "@std/encoding/hex";

const VERSION = "4.2.3";
const BASE = `https://cdn.emulatorjs.org/${VERSION}/data/`;

// Why each file, so nobody prunes one and finds out in a player's browser:
//
//   loader.js                     the entry point index.html loads; pulls the rest
//   emulator.min.js               the emulator itself
//   emulator.min.css              its UI; no external url() references
//   compression/extract7z.js      the core .data files are 7z archives (37 7a bc af),
//                                 and isCompressed() routes them here
//   cores/reports/snes9x.json     fetched BEFORE the core; its options.defaultWebGL2
//                                 is what picks legacy vs non-legacy
//   cores/snes9x-legacy-wasm.data the core actually fetched by default, because
//                                 that report sets no defaultWebGL2
//   cores/snes9x-wasm.data        the one fetched instead if a player turns WebGL2
//                                 on in EmulatorJS's own settings menu
//
// Not vendored: version.json (only fetched on localhost, by checkForUpdates),
// localization/* (suppressed by EJS_disableAutoLang), extractzip.js/libunrar
// (only for zipped ROMs -- ours ships raw), and src/*.js + socket.io (debug and
// netplay, both off).
const FILES = [
  "loader.js",
  "emulator.min.js",
  "emulator.min.css",
  "compression/extract7z.js",
  "cores/reports/snes9x.json",
  "cores/snes9x-legacy-wasm.data",
  "cores/snes9x-wasm.data",
];

const outDir = new URL(
  "../static/games/super-mario-sp/emulatorjs/",
  import.meta.url,
);

async function sha256(bytes: Uint8Array): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

const rows: string[] = [];
let total = 0;

for (const rel of FILES) {
  const url = BASE + rel;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`${url} -> HTTP ${res.status}`);
    Deno.exit(1);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const dest = new URL(rel, outDir);
  await Deno.mkdir(new URL(".", dest), { recursive: true });
  await Deno.writeFile(dest, bytes);
  total += bytes.length;
  rows.push(
    `| \`${rel}\` | ${bytes.length.toLocaleString("en-US")} | \`${await sha256(
      bytes,
    )}\` |`,
  );
  console.log(`  ${rel.padEnd(32)} ${String(bytes.length).padStart(9)} bytes`);
}

console.log(
  `\nEmulatorJS ${VERSION}: ${FILES.length} files, ${
    (total / 1048576).toFixed(2)
  } MiB\n`,
);
console.log("| file | bytes | sha256 |");
console.log("| --- | --- | --- |");
for (const row of rows) console.log(row);
