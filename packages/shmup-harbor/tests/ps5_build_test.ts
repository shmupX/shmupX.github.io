// The PS5 build's own pieces: the per-level serial, the disc's file list and
// the PS4 artwork. The PS2 export underneath has tests of its own.

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  bootName,
  composeArt,
  contentId,
  discFiles,
  levelSerialNumber,
  serialId,
  systemCnf,
} from "../lib/ps5/build.ts";
import { newRaster } from "../lib/ps2/png.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

Deno.test("a level's serial is stable, unique to it, and never the PS2 build's", () => {
  assertEquals(levelSerialNumber("squad"), levelSerialNumber("squad"));
  assertNotEquals(levelSerialNumber("squad"), levelSerialNumber("shmupX"));
  for (const name of ["squad", "shmupX", "foo", "Master Arena Mod", ""]) {
    const number = levelSerialNumber(name);
    assert(number >= 2 && number <= 99999, `${name}: ${number}`);
  }
});

Deno.test("the serial in each of its spellings", () => {
  assertEquals(bootName(12345), "SHMP_123.45");
  assertEquals(bootName(42), "SHMP_000.42");
  assertEquals(serialId(42), "SHMP00042");
  // XXXXXX-XXXXNNNNN_00-<16 characters>.
  const id = contentId(12345);
  assertEquals(id, "UP9000-CUSA12345_00-SHMP123450000001");
  assertEquals(id.split("-")[2].length, 16);
  assert(/^[A-Z]{4}_\d{3}\.\d{2}$/.test(bootName(levelSerialNumber("squad"))));
});

Deno.test("SYSTEM.CNF boots the level's own executable", () => {
  assertEquals(
    systemCnf("SHMP_123.45"),
    "BOOT2 = cdrom0:\\SHMP_123.45;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n",
  );
});

Deno.test("the disc renames the ELF and ini and replaces SYSTEM.CNF", () => {
  const files = discFiles([
    {
      path: "SYSTEM.CNF",
      data: encoder.encode("BOOT2 = cdrom0:\\SHMP_000.01;1"),
    },
    { path: "athena.elf", data: encoder.encode("elf") },
    { path: "athena.ini", data: encoder.encode("ini") },
    { path: "main.js", data: encoder.encode("js") },
    { path: "assets/level.json", data: encoder.encode("{}") },
  ], "SHMP_123.45");
  assertEquals(files.map((file) => file.path), [
    "SYSTEM.CNF",
    "SHMP_123.45",
    "ATHENA.INI",
    "main.js",
    "assets/level.json",
  ]);
  assertEquals(decoder.decode(files[0].data), systemCnf("SHMP_123.45"));
  assertEquals(decoder.decode(files[1].data), "elf");
});

Deno.test("a build with no ELF is refused", () => {
  assertThrows(
    () =>
      discFiles([{ path: "main.js", data: encoder.encode("") }], "SHMP_123.45"),
    Error,
    "athena.elf",
  );
});

Deno.test("artwork is the requested size, opaque, with the backdrop centred", () => {
  const backdrop = newRaster(256, 480);
  backdrop.data.fill(255);
  const art = composeArt({ backdrop, logo: null }, 1920, 1080);
  assertEquals([art.width, art.height], [1920, 1080]);
  const at = (x: number, y: number) =>
    art.data.slice((y * 1920 + x) * 4, (y * 1920 + x) * 4 + 4);
  assertEquals([...at(960, 540)], [255, 255, 255, 255]); // backdrop, x2
  assertEquals([...at(10, 540)], [0, 0, 0, 255]); // black either side
  const icon = composeArt({ backdrop: null, logo: null }, 512, 512);
  assertEquals([icon.width, icon.height], [512, 512]);
  assertEquals(icon.data[3], 255);
});
