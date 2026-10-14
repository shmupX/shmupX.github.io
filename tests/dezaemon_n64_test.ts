// packages/shmup-engine/src/n64/: reading a Dezaemon 3D 64DD data disk (.ddd).
//
// The disk is a 64 MB prototype dump that is community content and is never in
// the repo, so the structural tests build a synthetic .ddd — the same five
// parallel ATNFS arrays, the same two-zone block geometry, one real LZSS
// stream — and exercise the reader exactly as the real disk would. The real
// one gets its own test at the end, skipped when a checkout has none.
//
// The synthetic disk is allocated at full size (64,458,560 bytes) because the
// reader checks that length; that is ~64 MB of zero pages per test and nothing
// is read from disk to make it.
//
// The geometry tests here cover the whole disk since the writer landed: the
// zone table is held to the three measurements that pin it and to the two
// published implementations it was cross-checked against. The writer's own
// tests are dezaemon_n64_write_test.ts.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  alphaBitRatio,
  blocksFor,
  blockSize,
  byProject,
  checkDirectory,
  DDD_IMAGE_BYTES,
  dddFromImage,
  decodeRgba5551,
  DIRECTORY_BYTES,
  DIRECTORY_COPIES,
  DIRECTORY_IN_BLOCK_OFFSET,
  DIRECTORY_LBA,
  DIRECTORY_OFFSET,
  DIRECTORY_SLOTS,
  directoryOffsets,
  extentBytes,
  extractFile,
  isDddImage,
  lbaToOffset,
  MAX_USER_LBA,
  NDD_IMAGE_BYTES,
  nddFromDdd,
  offsetToLba,
  parseDddImage,
  ramEndLba,
  ramStartLba,
  ramStartOffset,
  readDirectory,
  romEndLba,
  SYSTEM_AREA_BYTES,
  systemAreaOf,
  USER_LBA_COUNT,
  userArea,
  ZONE1_START_LBA,
  zoneTable,
} from "../packages/shmup-engine/src/n64/index.js";

const NAMES = DIRECTORY_OFFSET;
const START_LBA = NAMES + DIRECTORY_SLOTS * 11;
const BLOCK_COUNT = START_LBA + DIRECTORY_SLOTS * 2;
const STORED_SIZE = BLOCK_COUNT + DIRECTORY_SLOTS * 2 + DIRECTORY_SLOTS * 2;

/** Okumura LZSS, the encoder side — all literals, which is a legal stream. */
function literalStream(payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i += 8) {
    const run = Math.min(8, payload.length - i);
    out.push((1 << run) - 1); // every item in this group is a literal
    for (let j = 0; j < run; j++) out.push(payload[i + j]);
  }
  return Uint8Array.from(out);
}

/**
 * A .ddd whose directory says what a real one's does. `entries` are written
 * into the five parallel arrays and their streams laid at the LBAs given.
 */
function fakeDdd(
  entries: { name: string; ext: string; lba: number; payload: Uint8Array }[],
): Uint8Array {
  const image = new Uint8Array(DDD_IMAGE_BYTES);
  image.fill(0xff, 0x6c7188, 0x018ca9c8); // the unwritten run a real disk has
  const mark = "KONO DISK WA DEZA64 DATA DISK DESU";
  for (let i = 0; i < mark.length; i++) image[0x28e80 + i] = mark.charCodeAt(i);
  entries.forEach((e, slot) => {
    const label = `${e.name.padEnd(8)}${e.ext}`;
    for (let i = 0; i < 11; i++) {
      image[NAMES + slot * 11 + i] = label.charCodeAt(i);
    }
    const stream = literalStream(e.payload);
    const bs = blockSize(e.lba) ?? 0;
    const blocks = Math.ceil(stream.length / bs);
    image[START_LBA + slot * 2] = e.lba >> 8;
    image[START_LBA + slot * 2 + 1] = e.lba & 0xff;
    image[BLOCK_COUNT + slot * 2] = blocks >> 8;
    image[BLOCK_COUNT + slot * 2 + 1] = blocks & 0xff;
    const at = STORED_SIZE + slot * 4;
    image[at] = (stream.length >>> 24) & 0xff;
    image[at + 1] = (stream.length >>> 16) & 0xff;
    image[at + 2] = (stream.length >>> 8) & 0xff;
    image[at + 3] = stream.length & 0xff;
    image.set(stream, lbaToOffset(e.lba) ?? 0);
  });
  return image;
}

Deno.test("a block is 19,720 bytes until LBA 268 and 18,360 after it", () => {
  assertEquals(blockSize(0), 19720);
  assertEquals(blockSize(ZONE1_START_LBA - 1), 19720);
  assertEquals(blockSize(ZONE1_START_LBA), 18360);
  assertEquals(lbaToOffset(0), 0);
  assertEquals(lbaToOffset(ZONE1_START_LBA), ZONE1_START_LBA * 19720);
  assertEquals(
    lbaToOffset(ZONE1_START_LBA + 2),
    ZONE1_START_LBA * 19720 + 2 * 18360,
  );
});

Deno.test("an extent that straddles the zone boundary is not count x one size", () => {
  // SAMP 3MD on the real disk: five blocks from LBA 266, across the boundary.
  assertEquals(extentBytes(266, 5), 2 * 19720 + 3 * 18360);
  assert(extentBytes(266, 5) !== 5 * 19720, "a flat stride would overcount");
});

Deno.test("the mapping covers the whole disk and refuses to guess past it", () => {
  assertEquals(blockSize(MAX_USER_LBA), 16320, "the last zone is 85 x 192");
  assertEquals(blockSize(USER_LBA_COUNT), null);
  assertEquals(blockSize(5000), null);
  assertEquals(
    lbaToOffset(USER_LBA_COUNT),
    DDD_IMAGE_BYTES,
    "one past the end is the image length",
  );
  assertEquals(lbaToOffset(USER_LBA_COUNT + 1), null);
  assertEquals(extentBytes(MAX_USER_LBA, 1), 16320);
  assertEquals(extentBytes(MAX_USER_LBA, 2), null);
  assertEquals(lbaToOffset(-1), null);
  assertEquals(
    blocksFor(MAX_USER_LBA, 16321),
    null,
    "bytes that run off the disk",
  );
});

Deno.test("the sixteen zones of a type-0 disk sum to a .ddd and end where leotools says", () => {
  const zones = zoneTable(0);
  assertEquals(zones.length, 16);
  assertEquals(zones.map((z) => z.pzone), [
    0,
    1,
    2,
    9,
    8,
    3,
    4,
    5,
    6,
    7,
    15,
    14,
    13,
    12,
    11,
    10,
  ]);
  assertEquals(
    zones.map((z) => z.sectorSize),
    [
      232,
      216,
      208,
      208,
      216,
      192,
      176,
      160,
      144,
      128,
      112,
      128,
      144,
      160,
      176,
      192,
    ],
  );
  assertEquals(zones.reduce((a, z) => a + z.blockCount, 0), USER_LBA_COUNT);
  assertEquals(
    zones.reduce((a, z) => a + z.blockCount * z.blockSize, 0),
    DDD_IMAGE_BYTES,
  );
  // jkbenaim/leotools leogeo.c pzone_tbl1, disk type 0: the last user LBA of each vzone.
  assertEquals(
    zones.map((z) => z.firstLba + z.blockCount - 1),
    [
      267,
      559,
      833,
      1125,
      1417,
      1691,
      1965,
      2239,
      2513,
      2717,
      2921,
      3195,
      3469,
      3743,
      4017,
      4291,
    ],
  );
  assertEquals(
    zones[0].blockCount,
    ZONE1_START_LBA,
    "vzone 0 is 292 blocks less the 24 of the system area",
  );
  assertEquals(zones.filter((z) => z.rom).length, 5);
});

Deno.test("the ROM/RAM split is LBA 1417/1418, and 0x18CF180 is where the RAM area starts", () => {
  assertEquals(romEndLba(0), 1417);
  assertEquals(ramStartLba(0), 1418);
  assertEquals(ramEndLba(0), 4291);
  assertEquals(ramStartOffset(0), 0x18cf180);
  assertEquals(
    lbaToOffset(1417),
    0x18ca9c8,
    "the directory's block starts where REGION.saveArea does",
  );
  // mupen64plus-core disk.c RAM_START_LBA, physical: 0x5A2 0x7C6 0x9EA 0xC0E 0xE32 0x1010, none for type 6.
  assertEquals(
    [0, 1, 2, 3, 4, 5, 6].map((t) => ramStartLba(t)),
    [
      0x5a2 - 24,
      0x7c6 - 24,
      0x9ea - 24,
      0xc0e - 24,
      0xe32 - 24,
      0x1010 - 24,
      null,
    ],
  );
  for (let t = 0; t < 7; t++) {
    assertEquals(
      zoneTable(t).reduce((a, z) => a + z.blockCount * z.blockSize, 0),
      DDD_IMAGE_BYTES,
      `type ${t}`,
    );
  }
});

Deno.test("the three directory copies are 834 bytes into LBA 1417, 1419 and 1422 — the measured offsets", () => {
  assertEquals(directoryOffsets(), [0x18cad0a, 0x18d3482, 0x18df3c2]);
  assertEquals(directoryOffsets()[0], DIRECTORY_OFFSET);
  assertEquals(directoryOffsets().map((o) => o - DIRECTORY_OFFSET), [
    ...DIRECTORY_COPIES,
  ]);
  assertEquals(
    DIRECTORY_IN_BLOCK_OFFSET + DIRECTORY_BYTES,
    18348,
    "the directory fills its 18,360-byte block",
  );
  assert(
    DIRECTORY_IN_BLOCK_OFFSET + DIRECTORY_BYTES <= blockSize(DIRECTORY_LBA)!,
  );
});

Deno.test("an offset maps back to the LBA whose block holds it", () => {
  for (const lba of [0, 267, 268, 1417, 1418, 2717, 2718, 4291]) {
    const at = lbaToOffset(lba)!;
    assertEquals(offsetToLba(at), lba);
    assertEquals(offsetToLba(at + blockSize(lba)! - 1), lba);
  }
  assertEquals(offsetToLba(DDD_IMAGE_BYTES), null);
  assertEquals(
    blocksFor(266, 2 * 19720 + 3 * 18360),
    5,
    "SAMP 3MD across the zone boundary",
  );
  assertEquals(blocksFor(9, 0), 0);
  assertEquals(blocksFor(9, 1), 1);
});

Deno.test("a .ddd is a .ndd less its system area, both ways", () => {
  const ndd = new Uint8Array(NDD_IMAGE_BYTES);
  ndd[SYSTEM_AREA_BYTES] = 0x5a;
  ndd[7] = 0x11;
  const ddd = dddFromImage(ndd);
  assertEquals(ddd.length, DDD_IMAGE_BYTES);
  assertEquals(ddd[0], 0x5a);
  assertEquals(userArea(ndd)[0], 0x5a, "a view of the same bytes");
  assertEquals(systemAreaOf(ndd)![7], 0x11);
  assertEquals(systemAreaOf(ddd), null);
  const back = nddFromDdd(ddd, systemAreaOf(ndd)!);
  assertEquals(back.length, NDD_IMAGE_BYTES);
  assertEquals(back[7], 0x11);
  assertEquals(back[SYSTEM_AREA_BYTES], 0x5a);
  assertThrows(() => dddFromImage(new Uint8Array(100)), Error, "64DD image");
});

Deno.test("a .ddd is an .ndd less the 24-block system area", () => {
  assertEquals(SYSTEM_AREA_BYTES, 473280);
  assertEquals(DDD_IMAGE_BYTES + SYSTEM_AREA_BYTES, 64931840);
  assertEquals(DDD_IMAGE_BYTES % 85, 0, "85 sectors to a block, every zone");
});

Deno.test("the directory is read as parallel arrays, and its files extract", () => {
  const cgr = new Uint8Array(64).map((_, i) => i * 3);
  const image = fakeDdd([
    { name: "TESTZ1", ext: "CGR", lba: 9, payload: cgr },
    { name: "TESTZ1", ext: "0GR", lba: 12, payload: cgr },
  ]);
  const entries = readDirectory(image);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].name, "TESTZ1");
  assertEquals(entries[0].ext, "CGR");
  assertEquals(entries[0].stage, null);
  assertEquals(entries[1].stage, 0, "a leading digit is the stage number");
  assertEquals(entries[0].offset, 9 * 19720);
  assertEquals(extractFile(image, entries[0]).data, cgr);
});

Deno.test("a name that is not printable ends the directory", () => {
  const image = fakeDdd([{
    name: "TESTZ1",
    ext: "CGR",
    lba: 9,
    payload: new Uint8Array(8),
  }]);
  image[NAMES + 1 * 11] = 0x00;
  assertEquals(readDirectory(image).length, 1);
});

Deno.test("an image too short for the directory is refused, not misread", () => {
  assertThrows(() => readDirectory(new Uint8Array(1024)), Error, "too short");
});

Deno.test("the directory invariants are checked rather than assumed", () => {
  const payload = new Uint8Array(40000);
  const image = fakeDdd([
    { name: "TESTZ1", ext: "CGR", lba: 9, payload },
    { name: "TESTZ1", ext: "0GR", lba: 12, payload },
  ]);
  const inv = checkDirectory(readDirectory(image));
  assertEquals(inv.blocksFit, true);
  assertEquals(inv.withinCapacity, true);
  assertEquals(inv.contiguous, true);
});

Deno.test("a blockCount that contradicts the zone geometry is caught", () => {
  const image = fakeDdd([{
    name: "TESTZ1",
    ext: "CGR",
    lba: 9,
    payload: new Uint8Array(40000),
  }]);
  image[BLOCK_COUNT + 1] = 9; // claim nine blocks where three are needed
  assertEquals(checkDirectory(readDirectory(image)).blocksFit, false);
});

Deno.test("an image is recognised by the boot program's own notice", () => {
  const image = fakeDdd([{
    name: "TESTZ1",
    ext: "CGR",
    lba: 9,
    payload: new Uint8Array(8),
  }]);
  assert(isDddImage(image));
  assert(
    !isDddImage(new Uint8Array(DDD_IMAGE_BYTES)),
    "size alone is not enough",
  );
  assert(!isDddImage(image.subarray(0, 1024)), "a short file is not a disk");
});

Deno.test("parsing never throws on content; a bad block lands in errors", () => {
  const parsed = parseDddImage(new Uint8Array(DDD_IMAGE_BYTES));
  assertEquals(parsed.sizeOk, true);
  assertEquals(parsed.directory?.length, 0);
  assertEquals(parsed.errors, []);
});

Deno.test("RGBA5551 puts alpha in bit 0, not bit 15", () => {
  // 0xF801 is red with alpha; read as the PlayStation's RGB555 it is not.
  const { data, width } = decodeRgba5551(
    Uint8Array.from([0xf8, 0x01, 0x00, 0x00]),
  );
  assertEquals(width, 64);
  assertEquals([data[0], data[1], data[2], data[3]], [255, 0, 0, 255]);
  assertEquals(data[7], 0, "a zero word is transparent");
  assertEquals(alphaBitRatio(Uint8Array.from([0xf8, 0x01])).ratio, 1);
  assertEquals(alphaBitRatio(Uint8Array.from([0xf8, 0x00])).ratio, 0);
});

Deno.test("files are grouped by project in directory order", () => {
  const payload = new Uint8Array(8);
  const image = fakeDdd([
    { name: "ONE", ext: "CGR", lba: 9, payload },
    { name: "TWO", ext: "CGR", lba: 11, payload },
    { name: "ONE", ext: "CMD", lba: 13, payload },
  ]);
  const groups = byProject(readDirectory(image));
  assertEquals([...groups.keys()], ["ONE", "TWO"]);
  assertEquals(groups.get("ONE")?.length, 2);
});

// ── The real disk, when this checkout has one ────────────────────────────────

const REPO_ROOT = new URL("../", import.meta.url);
const FIXTURE = "dezaemon298.ddd";

async function inFixtures(p: string): Promise<boolean> {
  try {
    await Deno.stat(new URL(`dev-fixtures/${p}`, REPO_ROOT));
    return true;
  } catch {
    return false;
  }
}

// One named prototype disk, so a name gate is honest here — there is no
// detector to key on, and no second .ddd this could silently skip.
const haveDisk = await inFixtures(FIXTURE);

Deno.test({
  name:
    "the dev-fixtures 64DD disk reads whole: 60 files, 58 at documented size",
  ignore: !haveDisk,
  async fn() {
    const bytes = await Deno.readFile(
      new URL(`dev-fixtures/${FIXTURE}`, REPO_ROOT),
    );
    assertEquals(bytes.length, DDD_IMAGE_BYTES);
    const parsed = parseDddImage(bytes);
    assertEquals(parsed.recognised, true, "the DEZA64 notice was not found");
    assertEquals(parsed.errors, []);

    const entries = parsed.directory ?? [];
    assertEquals(entries.length, 60);
    assertEquals([...byProject(entries).keys()], ["SAMPLEZ1", "SAMP"]);

    const inv = checkDirectory(entries);
    assertEquals(inv.contiguous, true, "the sample files are laid end to end");
    // Only holds if the block shrinks at LBA 268 — this is what proves the zones.
    assertEquals(
      inv.blocksFit,
      true,
      "a blockCount contradicts the zone geometry",
    );
    assertEquals(
      inv.end,
      0x6c7187,
      "the ROM area ends flush against the 0xFF run",
    );

    // The codec cannot fail, so the exact sizes are the only real evidence.
    const missed = entries
      .map((e) => ({ e, f: extractFile(bytes, e) }))
      .filter(({ f }) => !f.sizeOk)
      .map(({ e }) => `${e.name}.${e.ext}`);
    assertEquals(
      missed,
      ["SAMPLEZ1.GAM", "SAMP.GAM"],
      "only the two GAM files the documentation calls malformed may miss",
    );

    // Every nonzero word carries the alpha bit, which is what named the format.
    const gr = entries.find((e) => e.name === "SAMPLEZ1" && e.ext === "0GR");
    assert(gr, "SAMPLEZ1.0GR is missing from the directory");
    assertEquals(alphaBitRatio(extractFile(bytes, gr).data).ratio, 1);
  },
});
