// Super Mario SP is the first game in this repo that ships a console ROM and
// the emulator that runs it, in one folder, playable from two different URLs.
// Three things about that are easy to break and slow to notice, so they are
// checked here rather than trusted:
//
//   1. The .sfc really is a SNES image. It is linked by ca65/ld65 from a
//      vendored engine; a LoROM/HiROM mismatch or an unpatched checksum both
//      present as a black screen with no error anywhere.
//   2. The player page holds no root-relative URL. The same bytes are served at
//      /games/super-mario-sp/ and, after an eShop install, at
//      /eshop/super-mario-sp/. A leading slash resolves to the origin root at
//      both, the 404 arrives as text/html, and the browser reports a MIME error
//      rather than a missing file. This is the failure that would ship, because
//      it is invisible until someone installs the game.
//   3. The archive is shaped the way installWebGame can act on it. stripWrapper
//      only unwraps a GitHub zipball's folder and returns early for an entry
//      with no repo -- which this one has none of -- so a wrapper folder is
//      never removed, and an AppleDouble sidecar from this exFAT checkout would
//      ride into every player's Cache Storage.

import { assert, assertEquals } from "@std/assert";
import { unzip } from "../static/zip-read.js";
import { gameEntries } from "../scripts/super-mario-sp/build-zip.ts";

const GAME = new URL("../static/games/super-mario-sp/", import.meta.url);
const ROM = new URL("super-mario-sp.sfc", GAME);
const TITLE = "SUPER MARIO SP";

Deno.test("the ROM is the SNES image its own header describes", async () => {
  const rom = await Deno.readFile(ROM);

  // A 512-byte copier header is the classic way a ROM stops booting, and it is
  // exactly what breaks this divisibility.
  assertEquals(
    rom.length % 32768,
    0,
    "size is not a whole number of 32 KB banks",
  );

  const h = 0xFFC0; // HiROM puts the header here; LoROM at $7FC0
  const title = new TextDecoder().decode(rom.subarray(h, h + 21));
  assertEquals(title.trimEnd(), TITLE, "header title");
  assertEquals(title.length, 21, "the title field is a fixed 21 bytes");

  assertEquals(
    rom[h + 0x15] & 0x0F,
    1,
    `map mode $${
      rom[h + 0x15].toString(16)
    } is not HiROM -- a LoROM link boots to black`,
  );
  assertEquals(1024 << rom[h + 0x17], rom.length, "the header's ROM-size code");

  // The header stores the checksum and its complement precisely so that one
  // number can check the other.
  const complement = rom[h + 0x1c] | (rom[h + 0x1d] << 8);
  const checksum = rom[h + 0x1e] | (rom[h + 0x1f] << 8);
  assertEquals(
    checksum ^ complement,
    0xFFFF,
    "checksum/complement pair is inconsistent",
  );
  let sum = 0;
  for (const b of rom) sum += b;
  assertEquals(
    sum & 0xFFFF,
    checksum,
    "the checksum does not match the bytes -- tools/fixchecksum.py did not run",
  );

  const reset = rom[0xFFFC] | (rom[0xFFFD] << 8);
  assert(reset >= 0x8000, `reset vector $${reset.toString(16)} is not in ROM`);
});

Deno.test("the folder holds everything an offline boot needs", async () => {
  for (
    const rel of [
      "index.html",
      "super-mario-sp.sfc",
      "codemonkey.json",
      "emulatorjs/loader.js",
      "emulatorjs/emulator.min.js",
      "emulatorjs/emulator.min.css",
      "emulatorjs/compression/extract7z.js",
      "emulatorjs/cores/reports/snes9x.json",
      // The core EmulatorJS actually fetches by default: it picks the -legacy
      // build unless the core's own report sets defaultWebGL2, and snes9x's
      // does not. The non-legacy one is only reached through the settings menu.
      "emulatorjs/cores/snes9x-legacy-wasm.data",
      "emulatorjs/cores/snes9x-wasm.data",
    ]
  ) {
    const stat = await Deno.stat(new URL(rel, GAME));
    assertEquals(stat.isFile, true, rel);
    assert(stat.size > 0, `${rel} is empty`);
  }
});

Deno.test("the player page resolves its assets from wherever it is served", async () => {
  const page = await Deno.readTextFile(new URL("index.html", GAME));

  const rooted = page.match(/(?:src|href)="\/[^/]/g) ?? [];
  assertEquals(
    rooted,
    [],
    "a root-relative URL works at /games/<id>/ and breaks at /eshop/<id>/",
  );
  assertEquals(
    page.includes("<base"),
    false,
    "a <base> element re-breaks both mounts",
  );
  assert(
    /EJS_pathtodata\s*=\s*"emulatorjs\/"/.test(page),
    'EJS_pathtodata must be the relative "emulatorjs/" -- left unset, loader.js ' +
      "bakes in an absolute path from its own script src",
  );
  assert(
    /EJS_gameUrl\s*=\s*"super-mario-sp\.sfc"/.test(page),
    "EJS_gameUrl must be relative",
  );
  assertEquals(
    page.includes("cdn.emulatorjs.org"),
    false,
    "the page must not reach the CDN -- an install has to run offline",
  );
});

Deno.test("the page cannot ask for a threaded core it can never have", async () => {
  const page = await Deno.readTextFile(new URL("index.html", GAME));
  // eshopFile in static/emu-sw.js stamps no COOP/COEP and ISOLATED_PLAYERS in
  // main.ts covers only /ps2/ and /switch/, so SharedArrayBuffer is never
  // exposed here and downloadGameCore() turns threads:true into a start error.
  assert(/EJS_threads\s*=\s*false/.test(page), "EJS_threads must be false");
  // Without this EmulatorJS HEADs the ROM to compare content-length against its
  // IndexedDB copy. The eShop branch of the worker answers GET only, so that
  // HEAD escapes to the origin and 404s, and the second run hangs reading a
  // property of undefined inside an un-awaited promise.
  assert(
    /EJS_disableDatabases\s*=\s*true/.test(page),
    "EJS_disableDatabases must be true -- see the comment beside it",
  );
});

Deno.test("the archive is what installWebGame can act on", async () => {
  const entries = await gameEntries();

  assert(
    entries.some((e) => e.path === "index.html"),
    "index.html must be at the archive ROOT: stripWrapper returns early for an " +
      "entry that tracks no GitHub repo, so a wrapper folder is never removed",
  );
  assertEquals(
    entries.filter((e) => e.path.split("/").some((s) => s.startsWith("._")))
      .map((e) => e.path),
    [],
    "AppleDouble sidecars must not ride into every player's Cache Storage",
  );
  assertEquals(
    entries.filter((e) => e.path.endsWith(".zip")).map((e) => e.path),
    [],
    "the archive must not contain itself",
  );

  // The bytes have to survive the repo's own reader, which is what the
  // installer uses in the browser.
  const { buildZip } = await import("@shmupx/shmup-harbor/zip");
  const zip = await buildZip(entries, new Date("2026-09-13T00:00:00Z"));
  const read = (await unzip(zip)).filter((f: { dir: boolean }) => !f.dir);
  assertEquals(read.length, entries.length, "round-trip lost files");

  const rom = read.find((f: { path: string }) =>
    f.path === "super-mario-sp.sfc"
  );
  if (!rom) throw new Error("the ROM must be in the archive");
  assertEquals(
    rom.data,
    await Deno.readFile(ROM),
    "the archived ROM differs from the one served at /games/",
  );

  // main.ts stamps the launcher marker into /games/* HTML, but emu-sw.js serves
  // the installed copy from Cache Storage untouched -- so the archive carries it.
  const page = read.find((f: { path: string }) => f.path === "index.html");
  if (!page) throw new Error("index.html must be in the archive");
  assert(
    new TextDecoder().decode(page.data).includes('id="cmg-launcher-marker"'),
    "the archived index.html must already carry the launcher marker",
  );
});
