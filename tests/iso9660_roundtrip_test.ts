// The ISO 9660 writer and reader, against each other.
//
// lib/ps2/iso9660.ts builds the PS2 export's disc; the engine's
// src/cd/iso9660-read.js opens a Dezaemon 2 disc to pull SNDPAC.BIN out of it.
// They were written for opposite ends of the project, which makes them a
// useful pair of witnesses: a disc one produces must be one the other can
// read, all the way down to the nested assets/sounds/tonebank/ path the tone
// bank lands in.

import { assert, assertEquals } from "@std/assert";
import { buildIso } from "../lib/ps2/iso9660.ts";
import {
  findEntry,
  listFiles,
  openDisc,
  readFile,
} from "../packages/shmup-engine/src/cd/iso9660-read.js";

const encoder = new TextEncoder();

function disc() {
  const iso = buildIso({
    volumeId: "TESTDISC",
    files: [
      {
        path: "SYSTEM.CNF",
        data: encoder.encode("BOOT2 = cdrom0:\\A.ELF;1\n"),
      },
      { path: "main.js", data: encoder.encode("console.log(1)") },
      {
        path: "assets/sounds/tonebank/tb00.adp",
        data: Uint8Array.from({ length: 300 }, (_, i) => i & 0xff),
      },
      {
        path: "assets/sounds/tonebank/tonebank.json",
        data: encoder.encode('{"slices":[]}'),
      },
    ],
    date: new Date("2000-03-04T00:00:00Z"),
  });
  const open = openDisc(iso);
  assert(open, "the writer's own output is not recognisably ISO 9660");
  return open;
}

Deno.test("a written disc opens as 2048-byte cooked sectors", () => {
  const d = disc();
  assertEquals(d.sectorSize, 2048);
  assertEquals(d.dataOffset, 0);
});

Deno.test("the root directory lists what was staged, in its own case", () => {
  // Case is preserved rather than folded to upper: the runtime opens
  // `assets/game_ui.png`, so that is the name that has to be on the disc. A
  // working AthenaEnv disc keeps its lowercase names the same way.
  const names = listFiles(disc()).map((e) => e.name).sort();
  assertEquals(names, ["SYSTEM.CNF;1", "assets", "main.js;1"]);
});

Deno.test("nested paths resolve past the mangled directory names", () => {
  const d = disc();
  const dir = findEntry(d, "assets/sounds/tonebank");
  assert(dir?.isDir, "assets/sounds/tonebank is not a directory");
  const names = listFiles(d, dir).map((e) => e.name).sort();
  assertEquals(names, ["tb00.adp;1", "tonebank.json;1"]);
});

Deno.test("file contents survive the round trip byte for byte", () => {
  const d = disc();
  const adp = readFile(d, "assets/sounds/tonebank/tb00.adp");
  assertEquals(adp?.length, 300);
  for (let i = 0; i < 300; i++) assertEquals(adp![i], i & 0xff);
  assertEquals(
    new TextDecoder().decode(readFile(d, "MAIN.JS")!),
    "console.log(1)",
  );
});

Deno.test("a missing file reads as null rather than throwing", () => {
  const d = disc();
  assertEquals(readFile(d, "nope.bin"), null);
  assertEquals(readFile(d, "assets/sounds/tonebank/tb99.adp"), null);
  assertEquals(findEntry(d, "assets/sounds"), findEntry(d, "ASSETS/SOUNDS"));
});

Deno.test("openDisc rejects bytes that are not a filesystem", () => {
  assertEquals(openDisc(new Uint8Array(0)), null);
  assertEquals(openDisc(new Uint8Array(1 << 18)), null);
});

Deno.test("MODE1/2352 raw sectors are detected", () => {
  // Re-wrap the cooked image the way a CD ripper would: 16 bytes of
  // sync+header, the 2048 bytes of user data, then 288 of EDC/ECC.
  const cooked = buildIso({
    volumeId: "RAWDISC",
    files: [{ path: "hello.txt", data: encoder.encode("hi") }],
    date: new Date("2000-03-04T00:00:00Z"),
  });
  const sectors = cooked.length / 2048;
  const raw = new Uint8Array(sectors * 2352);
  for (let i = 0; i < sectors; i++) {
    raw.set(cooked.subarray(i * 2048, (i + 1) * 2048), i * 2352 + 16);
  }
  const d = openDisc(raw);
  assert(d, "raw 2352-byte sectors were not detected");
  assertEquals(d.sectorSize, 2352);
  assertEquals(d.dataOffset, 16);
  assertEquals(new TextDecoder().decode(readFile(d, "hello.txt")!), "hi");
});

Deno.test("the volume does not declare itself expired", () => {
  // ECMA-119 8.4.28: sixteen ASCII zeros mean "no expiration". A real date
  // means the volume is obsolete after it — and this wrote the Unix epoch,
  // stamping every disc as having expired in 1970. genisoimage leaves the
  // field unspecified, and so does a PS2 disc that boots.
  const iso = buildIso({
    volumeId: "TESTDISC",
    files: [{ path: "SYSTEM.CNF", data: encoder.encode("BOOT2 = x\n") }],
    date: new Date("2000-03-04T00:00:00Z"),
  });
  const pvd = iso.subarray(16 * 2048, 17 * 2048);
  assertEquals(
    new TextDecoder().decode(pvd.subarray(847, 863)),
    "0000000000000000",
  );
  assertEquals(pvd[863], 0, "the offset byte after an unset date is zero");
  // The dates that ARE specified still are.
  assertEquals(
    new TextDecoder().decode(pvd.subarray(813, 829)),
    "2000030400000000",
  );
});
