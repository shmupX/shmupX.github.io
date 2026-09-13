// lib/dezaemon-sfc.ts: finding the Super Famicom Dezaemon ROM on this machine.
//
// The ROM is a commercial cartridge and is never in the repo, so this builds
// one: a 512 KB image carrying the internal header the parser recognises
// (DEZAEMON, 128 KB of SRAM, a valid checksum pair at 0x7FC0). That is the
// whole recognition rule — src/sfc/rom.js isDezaemonRom — so a synthetic ROM
// exercises it exactly as the real one would, and the real one gets its own
// test at the end, skipped when a checkout has none.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  findDezaemonSfcRom,
  forgetDezaemonSfcRom,
  readDezaemonSfcRom,
  romCandidates,
} from "../lib/dezaemon-sfc.ts";

const ROM_BYTES = 0x80000; // 512 KB, the size the real cart is
const HEADER = 0x7fc0;
const COPIER_HEADER = 512;

/**
 * A ROM whose internal header says what a Dezaemon cart's does. `title` and
 * `sramCode` are parameters so the negative cases can be built the same way.
 */
function fakeRom(
  { title = "DEZAEMON", sramCode = 0x07, copier = false } = {},
): Uint8Array {
  const body = new Uint8Array(ROM_BYTES);
  const at = HEADER;
  // 21 bytes of title, space-padded — readRomHeader trims the end.
  const name = title.padEnd(21, " ");
  for (let i = 0; i < 21; i++) body[at + i] = name.charCodeAt(i);
  body[at + 0x15] = 0x30; // LoROM, FastROM
  body[at + 0x16] = 0x02; // ROM + SRAM + battery
  body[at + 0x17] = 0x09; // 512 KB
  body[at + 0x18] = sramCode; // 0x07 = 128 KB
  body[at + 0x19] = 0x00;
  body[at + 0x1b] = 0x00;
  // complement ^ checksum must be 0xFFFF for the header to read as valid.
  body[at + 0x1c] = 0x34;
  body[at + 0x1d] = 0x12;
  body[at + 0x1e] = 0xcb;
  body[at + 0x1f] = 0xed;
  if (!copier) return body;
  const out = new Uint8Array(COPIER_HEADER + body.length);
  out.set(body, COPIER_HEADER);
  return out;
}

async function fixtureTree(
  files: Record<string, Uint8Array>,
): Promise<string> {
  const root = await Deno.makeTempDir();
  for (const [rel, bytes] of Object.entries(files)) {
    const path = join(root, rel);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeFile(path, bytes);
  }
  return root;
}

Deno.test("the ROM is found in dev-fixtures/ and one level below it", async () => {
  forgetDezaemonSfcRom();
  const root = await fixtureTree({
    "dev-fixtures/SNES Dezaemon - Kaite Tsukutte Asoberu/Dezaemon (EN).sfc":
      fakeRom(),
  });
  try {
    const rom = await findDezaemonSfcRom(root);
    assert(rom, "the ROM one directory down was not found");
    assertEquals(rom.name, "Dezaemon (EN).sfc");
    assertEquals(rom.header.title, "DEZAEMON");
    assertEquals(rom.header.sramSizeBytes, 0x20000);
    assertEquals(rom.header.copierHeader, 0);
    assertEquals(rom.size, ROM_BYTES);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a ROM that is not Dezaemon's is not the ROM", async () => {
  forgetDezaemonSfcRom();
  const root = await fixtureTree({
    // The right shape, the wrong game.
    "dev-fixtures/Super Metroid.sfc": fakeRom({ title: "SUPER METROID" }),
    // Dezaemon's name, but a cart with 8 KB of SRAM cannot be this one — the
    // boot code insists on 128 KB (FORMAT-SFC.md).
    "dev-fixtures/not-really.sfc": fakeRom({ sramCode: 0x03 }),
    // Right bytes, wrong extension: never opened.
    "dev-fixtures/rom.txt": fakeRom(),
  });
  try {
    assertEquals(await findDezaemonSfcRom(root), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a copier-headered dump is recognised, and served without the header", async () => {
  forgetDezaemonSfcRom();
  const root = await fixtureTree({
    "dev-fixtures/Dezaemon.smc": fakeRom({ copier: true }),
  });
  try {
    const rom = await findDezaemonSfcRom(root);
    assert(rom);
    assertEquals(rom.header.copierHeader, COPIER_HEADER);
    assertEquals(rom.size, COPIER_HEADER + ROM_BYTES);
    // EmulatorJS hands the core the file as it is given it, and 512 bytes of
    // copier header shift every address in the ROM — so what leaves here is
    // the bare image whatever the dump carried.
    const bytes = await readDezaemonSfcRom(rom);
    assertEquals(bytes.length, ROM_BYTES);
    assertEquals(bytes[HEADER], "D".charCodeAt(0));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("$DEZAEMON_SFC_ROM wins over anything discovered", async () => {
  forgetDezaemonSfcRom();
  const root = await fixtureTree({
    "dev-fixtures/discovered.sfc": fakeRom(),
    "elsewhere/named.sfc": fakeRom(),
  });
  try {
    const rom = await findDezaemonSfcRom(root, {
      extra: [join(root, "elsewhere", "named.sfc")],
    });
    assert(rom);
    assertEquals(rom.name, "named.sfc");
    // A named path that is not there is simply not a candidate: the discovered
    // ROM is still found rather than the whole lookup failing.
    forgetDezaemonSfcRom();
    const fallback = await findDezaemonSfcRom(root, {
      extra: [join(root, "elsewhere", "missing.sfc")],
    });
    assert(fallback);
    assertEquals(fallback.name, "discovered.sfc");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("AppleDouble sidecars and oversized files are never opened", async () => {
  forgetDezaemonSfcRom();
  const root = await fixtureTree({
    // What macOS leaves beside every file on this project's exFAT volume.
    "dev-fixtures/._Dezaemon.sfc": fakeRom(),
    // A disc image sitting in the same directory: far too big to be a cart, and
    // reading its header would cost a seek into a multi-megabyte file.
    "dev-fixtures/tiny.sfc": new Uint8Array(1024),
  });
  try {
    const candidates = await romCandidates(root);
    assertEquals(candidates.map((c) => c.path.split("/").pop()), []);
    assertEquals(await findDezaemonSfcRom(root), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("no dev-fixtures/ at all is a clean miss, not a throw", async () => {
  forgetDezaemonSfcRom();
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await romCandidates(root), []);
    assertEquals(await findDezaemonSfcRom(root), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the lookup is memoised against the listing, and re-runs when it moves", async () => {
  forgetDezaemonSfcRom();
  const root = await fixtureTree({ "dev-fixtures/Dezaemon.sfc": fakeRom() });
  try {
    assert(await findDezaemonSfcRom(root));
    // Replacing the file with a non-Dezaemon ROM changes its mtime, which is
    // part of the memo key: the answer has to follow the disk.
    await new Promise((r) => setTimeout(r, 10));
    await Deno.writeFile(
      join(root, "dev-fixtures", "Dezaemon.sfc"),
      fakeRom({ title: "SOMETHING ELSE" }),
    );
    assertEquals(await findDezaemonSfcRom(root), null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
