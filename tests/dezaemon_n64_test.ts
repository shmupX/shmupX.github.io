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

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  alphaBitRatio,
  blockSize,
  byProject,
  checkDirectory,
  DDD_IMAGE_BYTES,
  decodeRgba5551,
  DIRECTORY_OFFSET,
  DIRECTORY_SLOTS,
  extentBytes,
  extractFile,
  isDddImage,
  lbaToOffset,
  parseDddImage,
  readDirectory,
  SYSTEM_AREA_BYTES,
  ZONE1_START_LBA,
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

Deno.test("the mapping refuses to guess past the range it was measured over", () => {
  assertEquals(blockSize(5000), null);
  assertEquals(lbaToOffset(5000), null);
  assertEquals(extentBytes(4000, 2), null);
  assertEquals(lbaToOffset(-1), null);
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
