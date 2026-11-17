// A disc built over another one (iso9660.ts `base`), the way the FreeDVDBoot
// disc carries a game: every byte of the base stays put except the primary
// volume descriptor, and the rebuilt ISO 9660 side lists both the base's own
// files and the new ones.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { buildIso, readIsoFiles } from "../lib/ps2/iso9660.ts";
import { FREEDVDBOOT_AUDSRV_PREAMBLE } from "../lib/ps2/freedvdboot.ts";
import { openDisc, readFile } from "@shmupx/shmup-engine/iso9660-read";

const SECTOR = 2048;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DATE = new Date("2000-03-04T00:00:00Z");

// Stands in for a FreeDVDBoot image: an ISO 9660 disc with a UDF bridge's
// volume recognition sequence in sectors 18-20 and a "payload" sector past
// the end of its ISO 9660 volume, which nothing in its file tree points at.
function fakeFreeDvdBoot(): Uint8Array {
  // A system area, a bare PVD and terminator, and the VRS — then the "DVD"
  // files laid after it by the overlay itself, as genisoimage -udf would.
  const head = new Uint8Array(24 * SECTOR);
  const ids: [number, number, string][] = [
    [16, 1, "CD001"],
    [17, 0xff, "CD001"],
    [18, 0, "BEA01"],
    [19, 0, "NSR02"],
    [20, 0, "TEA01"],
  ];
  for (const [sector, type, id] of ids) {
    const at = sector * SECTOR;
    head[at] = type;
    for (let i = 0; i < 5; i++) head[at + 1 + i] = id.charCodeAt(i);
    head[at + 6] = 1;
  }
  // genisoimage's own system identifier, as on FreeDVDBoot's images.
  head.set(encoder.encode("LINUX".padEnd(32, " ")), 16 * SECTOR + 8);
  const iso = buildIso({
    volumeId: "CDROM",
    base: head,
    files: [
      { path: "VIDEO_TS/VIDEO_TS.IFO", data: encoder.encode("DVDVIDEO-VMG") },
      {
        path: "VIDEO_TS/BOOT.ELF",
        data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 0xff),
      },
    ],
    date: DATE,
  });
  const base = new Uint8Array(iso.length + 2 * SECTOR);
  base.set(iso);
  base.fill(0xab, iso.length, iso.length + SECTOR); // the raw payload
  return base;
}

function overlay(base: Uint8Array) {
  return buildIso({
    volumeId: "SQUAD",
    base,
    placed: readIsoFiles(base),
    files: [
      { path: "ATHENA.ELF", data: encoder.encode("\x7fELF athena") },
      { path: "main.js", data: encoder.encode("console.log('squad')") },
      { path: "assets/game.json", data: encoder.encode('{"ok":true}') },
    ],
    date: DATE,
  });
}

Deno.test("readIsoFiles lists a disc's files with where their data lies", () => {
  const base = fakeFreeDvdBoot();
  const files = readIsoFiles(base);
  assertEquals(files.map((f) => f.path).sort(), [
    "VIDEO_TS/BOOT.ELF",
    "VIDEO_TS/VIDEO_TS.IFO",
  ]);
  const ifo = files.find((f) => f.path.endsWith(".IFO"))!;
  assertEquals(
    decoder.decode(
      base.subarray(ifo.extent * SECTOR, ifo.extent * SECTOR + ifo.length),
    ),
    "DVDVIDEO-VMG",
  );
});

Deno.test("every base byte but the primary volume descriptor is kept", () => {
  const base = fakeFreeDvdBoot();
  const disc = overlay(base);
  assert(disc.length > base.length);
  assertEquals(
    decoder.decode(disc.subarray(19 * SECTOR + 1, 19 * SECTOR + 6)),
    "NSR02",
  );
  for (let sector = 0; sector < base.length / SECTOR; sector++) {
    if (sector === 16) continue;
    const a = base.subarray(sector * SECTOR, (sector + 1) * SECTOR);
    const b = disc.subarray(sector * SECTOR, (sector + 1) * SECTOR);
    assert(
      a.every((byte, i) => byte === b[i]),
      `sector ${sector} of the base changed`,
    );
  }
});

Deno.test("the new tree lists the game and the base's own files", () => {
  const disc = overlay(fakeFreeDvdBoot());
  const open = openDisc(disc);
  assert(open, "the overlaid disc is not readable as ISO 9660");
  assertEquals(
    decoder.decode(readFile(open, "main.js")!),
    "console.log('squad')",
  );
  assertEquals(
    decoder.decode(readFile(open, "assets/game.json")!),
    '{"ok":true}',
  );
  assertEquals(
    decoder.decode(readFile(open, "VIDEO_TS/VIDEO_TS.IFO")!),
    "DVDVIDEO-VMG",
  );
  assertEquals(readFile(open, "VIDEO_TS/BOOT.ELF")!.length, 5000);
  // Still the base's identifier: not "PLAYSTATION", the mark of a PS2 disc.
  assertEquals(
    decoder.decode(disc.subarray(16 * SECTOR + 8, 16 * SECTOR + 40)).trim(),
    "LINUX",
  );
  // The descriptor now spans the whole image, payload sectors included.
  const view = new DataView(disc.buffer);
  assertEquals(view.getUint32(16 * SECTOR + 80, true), disc.length / SECTOR);
});

Deno.test("a base that is not an ISO 9660 image is refused", () => {
  assertThrows(
    () =>
      buildIso({ volumeId: "X", base: new Uint8Array(40 * SECTOR), files: [] }),
    Error,
    "primary volume descriptor",
  );
});

Deno.test("the FreeDVDBoot preamble loads audsrv and survives a missing IOP", () => {
  // Under the web host, and in this test, there is no IOP global at all.
  new Function(FREEDVDBOOT_AUDSRV_PREAMBLE)();
  const asked: string[] = [];
  const g = globalThis as { IOP?: unknown };
  g.IOP = { loadModule: (name: string) => asked.push(name) };
  try {
    new Function(FREEDVDBOOT_AUDSRV_PREAMBLE)();
  } finally {
    delete g.IOP;
  }
  assertEquals(asked, ["audsrv"]);
});
