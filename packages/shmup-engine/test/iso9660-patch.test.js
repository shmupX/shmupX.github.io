// Replacing one file on a mastered ISO 9660 track: in place while it fits,
// moved to the end of the track when it does not, and nothing else on the
// volume touched either way. The volumes are synthetic (test/_iso-synthetic.js)
// and are read back through iso9660-read.js, the reader everything else uses.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  directoryRecords,
  replaceFile,
  setBoth32,
} from "../src/cd/iso9660-patch.js";
import { listFiles, openDisc, readFile } from "../src/cd/iso9660-read.js";
import {
  buildMode1Sector,
  isValidMode1Sector,
  SECTOR_SIZE,
  USER_SIZE,
} from "../src/cd/cd-sector.js";
import { buildVolume, pattern } from "./_iso-synthetic.js";

const A = pattern(3000, 1); // 2 sectors, then 1 of slack
const B = pattern(100, 2);
const C = pattern(5000, 3); // the last file: 3 sectors

function volume(raw = true) {
  return buildVolume([
    { name: "A.BIN", data: A, slack: 1 },
    { name: "B.BIN", data: B },
    { name: "C.BIN", data: C },
  ], { raw, postgap: 4 });
}

const sectorOf = (image, lba) =>
  image.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE);
const sameSector = (a, b, lba) =>
  sectorOf(a, lba).every((v, i) => v === sectorOf(b, lba)[i]);
const pvdVolumeSize = (image) => {
  const disc = openDisc(image);
  const at = 16 * disc.sectorSize + disc.dataOffset + 80;
  return image[at] | (image[at + 1] << 8) | (image[at + 2] << 16) |
    (image[at + 3] << 24);
};

Deno.test("the synthetic volume reads back through the ordinary reader", () => {
  const { image } = volume();
  const disc = openDisc(image);
  assertEquals(disc.sectorSize, SECTOR_SIZE);
  assertEquals(listFiles(disc).map((f) => f.name), [
    "A.BIN;1",
    "B.BIN;1",
    "C.BIN;1",
  ]);
  assertEquals(readFile(disc, "B.BIN"), B);
  assertEquals(directoryRecords(image).map((r) => r.path), [
    "A.BIN",
    "B.BIN",
    "C.BIN",
  ]);
});

Deno.test("a smaller file is written in place, its slack zeroed, everything else untouched", () => {
  const { image, layout } = volume();
  const before = Uint8Array.from(image);
  const small = pattern(10, 9);
  const r = replaceFile(image, "A.BIN", small);
  assertEquals(r.placement, "in-place");
  assertEquals(r.extent, layout[0].extent);
  assertEquals(r.allocation, 3, "two sectors of file and one of slack");
  assertEquals(r.grownBy, 0);
  assertEquals(r.image.length, image.length, "the track keeps its length");
  assertEquals(image, before, "the input image is not modified");
  const disc = openDisc(r.image);
  assertEquals(readFile(disc, "A.BIN"), small);
  assertEquals(readFile(disc, "B.BIN"), B);
  assertEquals(readFile(disc, "C.BIN"), C);
  // The rewritten sectors: the extent's three, and the directory's.
  assertEquals(r.touched, [20, 21, 22, 23]);
  for (let lba = 0; lba < r.image.length / SECTOR_SIZE; lba++) {
    assert(isValidMode1Sector(sectorOf(r.image, lba), lba), `sector ${lba}`);
    if (!r.touched.includes(lba)) {
      assert(sameSector(r.image, before, lba), `sector ${lba} changed`);
    }
  }
  const tail = r.image.subarray(
    22 * SECTOR_SIZE + 16,
    22 * SECTOR_SIZE + 16 + USER_SIZE,
  );
  assert(tail.every((b) => b === 0), "the old second sector is zero now");
});

Deno.test("a file may grow into the slack before the next extent", () => {
  const { image, layout } = volume();
  const grown = pattern(3 * USER_SIZE, 5);
  const r = replaceFile(image, "A.BIN", grown);
  assertEquals(r.placement, "in-place");
  assertEquals(r.extent, layout[0].extent);
  assertEquals(readFile(openDisc(r.image), "A.BIN"), grown);
  assertEquals(readFile(openDisc(r.image), "B.BIN"), B);
});

Deno.test("a file that does not fit moves past the last extent and the track grows", () => {
  const { image, layout, sectors } = volume();
  const big = pattern(5 * USER_SIZE + 7, 6);
  const r = replaceFile(image, "B.BIN", big, { postgap: 4 });
  const lastEnd = layout[2].extent + layout[2].sectors;
  assertEquals(r.placement, "relocated");
  assertEquals(r.extent, lastEnd);
  // Six sectors of file and four of postgap after the last extent, where four
  // of postgap were before.
  assertEquals(r.grownBy, lastEnd + 6 + 4 - sectors);
  assertEquals(r.image.length, (sectors + r.grownBy) * SECTOR_SIZE);
  assertEquals(
    pvdVolumeSize(r.image),
    sectors + r.grownBy,
    "the volume space grows with it",
  );
  const disc = openDisc(r.image);
  assertEquals(readFile(disc, "B.BIN"), big);
  assertEquals(readFile(disc, "A.BIN"), A);
  assertEquals(readFile(disc, "C.BIN"), C);
  const old = r.image.subarray(
    layout[1].extent * SECTOR_SIZE + 16,
    layout[1].extent * SECTOR_SIZE + 16 + USER_SIZE,
  );
  assert(old.every((b) => b === 0), "the old allocation is cleared");
  for (let lba = 0; lba < r.image.length / SECTOR_SIZE; lba++) {
    assert(isValidMode1Sector(sectorOf(r.image, lba), lba), `sector ${lba}`);
  }
  // The moved record still reads both-endian-consistent.
  assertEquals(
    directoryRecords(r.image).find((x) => x.path === "B.BIN").extent,
    lastEnd,
  );
});

Deno.test("relocate: false turns a move into an error", () => {
  const { image } = volume();
  assertThrows(
    () =>
      replaceFile(image, "B.BIN", pattern(3 * USER_SIZE, 1), {
        relocate: false,
      }),
    Error,
    "sectors",
  );
});

Deno.test("a move is refused when the track's tail holds something the directory does not name", () => {
  const { image, sectors } = volume();
  const dirty = Uint8Array.from(image);
  dirty[(sectors - 1) * SECTOR_SIZE + 16 + 5] = 1;
  assertThrows(
    () => replaceFile(dirty, "C.BIN", pattern(9 * USER_SIZE, 1)),
    Error,
    "does not name",
  );
});

Deno.test("names are matched without their version suffix and case, and must exist", () => {
  const { image } = volume();
  assertEquals(
    readFile(
      openDisc(replaceFile(image, "b.bin", B.slice(0, 50)).image),
      "B.BIN",
    ),
    B.slice(0, 50),
  );
  assertThrows(() => replaceFile(image, "NOPE.BIN", B), Error, "no such file");
});

Deno.test("a cooked 2048-byte image is patched the same way, with no sector framing", () => {
  const { image } = volume(false);
  assertEquals(openDisc(image).sectorSize, USER_SIZE);
  const small = pattern(77, 8);
  const r = replaceFile(image, "C.BIN", small);
  assertEquals(r.image.length, image.length);
  assertEquals(readFile(openDisc(r.image), "C.BIN"), small);
  assertEquals(readFile(openDisc(r.image), "A.BIN"), A);
});

/** The volume with one record's extent and size rewritten, as a different
 * master might have written them. */
function withRecord(image, path, { extent, size }) {
  const out = Uint8Array.from(image);
  const r = directoryRecords(out).find((x) => x.path === path);
  const disc = openDisc(out);
  const at = r.dirLba * disc.sectorSize + disc.dataOffset;
  const user = out.slice(at, at + USER_SIZE);
  if (extent !== undefined) setBoth32(user, r.offset + 2, extent);
  if (size !== undefined) setBoth32(user, r.offset + 10, size);
  if (disc.sectorSize === SECTOR_SIZE) {
    buildMode1Sector(
      r.dirLba,
      user,
      out.subarray(r.dirLba * SECTOR_SIZE, (r.dirLba + 1) * SECTOR_SIZE),
    );
  } else out.set(user, at);
  return out;
}

Deno.test("an empty file owns no sectors: it moves rather than writing over the next file", () => {
  const { image, layout } = volume();
  // A master gives an empty file the next free block — B's.
  const emptyA = withRecord(image, "A.BIN", {
    extent: layout[1].extent,
    size: 0,
  });
  const r = replaceFile(emptyA, "A.BIN", pattern(100, 4));
  assertEquals(r.placement, "relocated");
  assertEquals(r.allocation, 0);
  const disc = openDisc(r.image);
  assertEquals(readFile(disc, "B.BIN"), B, "B is untouched");
  assertEquals(readFile(disc, "A.BIN"), pattern(100, 4));
});

Deno.test("two records sharing one extent: replacing one leaves the other's bytes alone", () => {
  const { image, layout } = volume();
  // C stored once for two names: B's record points at C's data.
  const shared = withRecord(image, "B.BIN", {
    extent: layout[2].extent,
    size: C.length,
  });
  const r = replaceFile(shared, "B.BIN", pattern(50, 5));
  assertEquals(r.placement, "relocated");
  assertEquals(readFile(openDisc(r.image), "C.BIN"), C);
  assertEquals(readFile(openDisc(r.image), "B.BIN"), pattern(50, 5));
});

Deno.test("a file whose extent lies in the volume descriptors is refused", () => {
  const { image } = volume();
  const low = withRecord(image, "A.BIN", { extent: 16 });
  assertThrows(
    () => replaceFile(low, "A.BIN", pattern(10, 1)),
    Error,
    "volume descriptors",
  );
  // An empty file at extent 0 (an old libisofs habit) owns nothing and moves.
  const zero = withRecord(image, "B.BIN", { extent: 0, size: 0 });
  const r = replaceFile(zero, "B.BIN", pattern(10, 2));
  assertEquals(r.placement, "relocated");
  assert(openDisc(r.image), "the system area and descriptors are intact");
});

Deno.test("an empty file sharing its neighbour's extent does not cost the neighbour its sectors", () => {
  const { image, layout } = volume();
  const emptyA = withRecord(image, "A.BIN", {
    extent: layout[1].extent,
    size: 0,
  });
  const r = replaceFile(emptyA, "B.BIN", pattern(50, 3));
  assertEquals(r.placement, "in-place");
  assertEquals(r.extent, layout[1].extent);
  assertEquals(readFile(openDisc(r.image), "B.BIN"), pattern(50, 3));
});

Deno.test("a directory naming sectors past the image's end is refused before anything moves", () => {
  const { image, sectors } = volume();
  const past = withRecord(image, "C.BIN", { size: (sectors + 5) * USER_SIZE });
  assertThrows(
    () => replaceFile(past, "A.BIN", pattern(20000, 1)),
    Error,
    "whole data track",
  );
});
