// A game written onto the Dezaemon 2 disc as its boot image, with the menu
// patched so the title keeps it. The synthetic disc (test/_iso-synthetic.js)
// carries the files the injection reads and writes; the retail track, when a
// checkout has it, is held to the exact set of sectors the patch may touch.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BOOT_IMAGE_FILE,
  injectGameIntoDisc,
  MENU_FILE,
  menuPatchState,
  patchMenu,
  readDiscGame,
  sampleGameCmp,
  sampleGameImage,
  sampleGameSections,
  SGM_IMAGE_SIZE,
  SGM_MEMORY_ORDER,
  SGM_STAGE_LIMIT,
  staleRingReads,
} from "../src/write/disc-inject.js";
import { listFiles, openDisc, readFile } from "../src/cd/iso9660-read.js";
import { decompressCmp, SECTION_SIZES } from "../src/decompress.js";
import { compressCmp } from "../src/compress.js";
import { isValidMode1Sector, SECTOR_SIZE } from "../src/cd/cd-sector.js";
import {
  dezaemonVolume,
  pattern,
  stockMenuOverlay,
  syntheticSections,
} from "./_iso-synthetic.js";
import { hasDiscImage, loadDiscImage } from "./_fixtures.js";

const sameSections = (a, b) =>
  a.length === b.length &&
  a.every((s, i) =>
    s.length === b[i].length && s.every((v, j) => v === b[i][j])
  );

Deno.test("an SGM image is the eight sections in memory order, and cuts back the same", () => {
  assertEquals(SGM_IMAGE_SIZE, 766596);
  assertEquals(SGM_MEMORY_ORDER, [0, 1, 2, 3, 5, 4, 6, 7]);
  const sections = syntheticSections(5);
  const image = sampleGameImage(sections);
  assertEquals(image.length, SGM_IMAGE_SIZE);
  // sec5 follows sec3, and sec4 follows sec5.
  assertEquals(
    image.subarray(4 * 65536, 4 * 65536 + 16),
    sections[5].subarray(0, 16),
  );
  assertEquals(
    image.subarray(
      4 * 65536 + SECTION_SIZES[5],
      4 * 65536 + SECTION_SIZES[5] + 16,
    ),
    sections[4].subarray(0, 16),
  );
  assert(sameSections(sampleGameSections(image), sections));
  assertThrows(() => sampleGameImage(sections.slice(0, 7)));
  assertThrows(
    () =>
      sampleGameImage(sections.map((s, i) => (i === 6 ? s.subarray(1) : s))),
    Error,
    "sec6",
  );
  assertThrows(() => sampleGameSections(image.subarray(1)));
});

Deno.test("staleRingReads counts copies from ring bytes the Saturn never cleared", () => {
  // One flag byte (eight matches), then a match at 0xFEE, length 3: the three
  // bytes 0xFEE..0xFF0, which the console's decoder leaves as they were.
  const stale = Uint8Array.from([5, 0, 0, 0, 0x00, 0xee, 0xf0, 0x00, 0x00]);
  stale[0] = stale.length - 4;
  assertEquals(staleRingReads(stale), 3);
  // A match at 0x000 copies from the cleared part of the ring.
  const cleared = Uint8Array.from([5, 0, 0, 0, 0x00, 0x00, 0x00, 0x10, 0x00]);
  assertEquals(staleRingReads(cleared), 0);
  // A literal written at 0xFEE first makes a later copy from it safe.
  const written = Uint8Array.from([5, 0, 0, 0, 0x01, 0x41, 0xee, 0xf0]);
  assertEquals(staleRingReads(written), 0);
  // What compress.js produces for real data never reads them.
  for (
    const data of [
      new Uint8Array(70000),
      pattern(40000, 3),
      sampleGameImage(syntheticSections(2)),
    ]
  ) {
    assertEquals(staleRingReads(compressCmp(data)), 0);
  }
});

Deno.test("sampleGameCmp is a .CMP that decodes back to the image and fits the boot load", () => {
  const sections = syntheticSections(9);
  const cmp = sampleGameCmp(sections);
  assertEquals(
    cmp[0] | (cmp[1] << 8) | (cmp[2] << 16) | (cmp[3] << 24),
    cmp.length - 4,
  );
  assertEquals(decompressCmp(cmp), sampleGameImage(sections));
  assert(cmp.length <= SGM_STAGE_LIMIT);
  assertEquals(SGM_STAGE_LIMIT, 226684);
});

Deno.test("the menu patch sets the editor-work flag at boot and nothing else", () => {
  const stock = stockMenuOverlay();
  assertEquals(menuPatchState(stock), "stock");
  const patched = patchMenu(stock);
  assertEquals(menuPatchState(patched), "patched");
  const changed = [];
  for (let i = 0; i < stock.length; i++) {
    if (patched[i] !== stock[i]) changed.push(i);
  }
  // mov #0,r2 -> mov #1,r2; mov r3,r1 -> mov #0,r2; add #1,r1 -> add #1,r3;
  // mov.b r2,@r1 -> mov.b r2,@r3; add #2,r3 -> add #1,r3.
  assertEquals(changed, [0x281b, 0x281e, 0x281f, 0x2820, 0x2822, 0x2825]);
  assertEquals(patchMenu(patched), patched, "patching twice changes nothing");
  assertEquals(stock, stockMenuOverlay(), "the input is not modified");
  const other = Uint8Array.from(stock);
  other[0x281a] = 0x12;
  assertEquals(menuPatchState(other), null);
  assertThrows(() => patchMenu(other), Error, "not the retail overlay");
  assertThrows(
    () => patchMenu(stock.subarray(1)),
    Error,
    "not the retail overlay",
  );
});

Deno.test("a game injected into the synthetic disc is what the disc boots holding", () => {
  const { image } = dezaemonVolume();
  const game = syntheticSections(42);
  const { image: out, report } = injectGameIntoDisc(image, game);
  assertEquals(report.boot.file, BOOT_IMAGE_FILE);
  assertEquals(report.boot.placement, "in-place");
  assertEquals(report.menu.file, MENU_FILE);
  assertEquals(report.menu.state, "patched");
  assertEquals(report.grownBy, 0);
  assertEquals(out.length, image.length);
  const back = readDiscGame(out);
  assert(
    sameSections(back.sections, game),
    "the boot image holds the injected sections",
  );
  assertEquals(back.menu, "patched");
  // Every sector the report names is a valid MODE1 sector; every other one is
  // as it was.
  for (let lba = 0; lba < out.length / SECTOR_SIZE; lba++) {
    const s = out.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE);
    assert(isValidMode1Sector(s, lba), `sector ${lba}`);
    if (!report.touched.includes(lba)) {
      assert(
        s.every((v, i) => v === image[lba * SECTOR_SIZE + i]),
        `sector ${lba} changed`,
      );
    }
  }
  // The other files are untouched, and the directory still lists them all.
  const disc = openDisc(out);
  assertEquals(listFiles(disc).length, 5);
  assertEquals(
    readFile(disc, "GAME.CMP"),
    readFile(openDisc(image), "GAME.CMP"),
  );
});

Deno.test("injecting again replaces the game and leaves an already patched menu alone", () => {
  const first =
    injectGameIntoDisc(dezaemonVolume().image, syntheticSections(1)).image;
  const second = injectGameIntoDisc(first, syntheticSections(2));
  assertEquals(second.report.menu.state, "already patched");
  assert(
    sameSections(readDiscGame(second.image).sections, syntheticSections(2)),
  );
});

Deno.test("menu: false writes only the boot image", () => {
  const { image } = dezaemonVolume();
  const { image: out, report } = injectGameIntoDisc(
    image,
    syntheticSections(3),
    { menu: false },
  );
  assertEquals(report.menu, null);
  assertEquals(readDiscGame(out).menu, "stock");
  assertEquals(
    readFile(openDisc(out), MENU_FILE),
    readFile(openDisc(image), MENU_FILE),
  );
});

Deno.test("a game too big for the boot image's sectors moves to the end of the track", () => {
  // No slack after SGM_INIT and 100 KB of noise in the CG pages: it needs
  // more sectors than the old (small) boot image had, and still fits the
  // boot load's staging.
  const { image, sectors } = dezaemonVolume({
    boot: syntheticSections(1),
    bootSlack: 0,
  });
  const noisy = syntheticSections(8);
  noisy[5].set(pattern(100000, 77));
  const { image: out, report } = injectGameIntoDisc(image, noisy, {
    menu: false,
  });
  assertEquals(report.boot.placement, "relocated");
  assert(report.grownBy > 0);
  assertEquals(out.length, (sectors + report.grownBy) * SECTOR_SIZE);
  assert(sameSections(readDiscGame(out).sections, noisy));

  // The same with the menu patched too: the menu is rewritten on the grown
  // track, after the move, and both land.
  const both = injectGameIntoDisc(image, noisy);
  assertEquals(both.report.boot.placement, "relocated");
  assertEquals(both.report.menu.state, "patched");
  const back = readDiscGame(both.image);
  assert(sameSections(back.sections, noisy));
  assertEquals(back.menu, "patched");
  for (let lba = 0; lba < both.image.length / SECTOR_SIZE; lba++) {
    assert(
      isValidMode1Sector(
        both.image.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE),
        lba,
      ),
      `sector ${lba}`,
    );
  }
});

Deno.test("a disc that is not Dezaemon 2 is refused by name", () => {
  const { image } = dezaemonVolume();
  // Rename SGM_INIT.CMP in the directory: one letter of its record.
  const disc = openDisc(image);
  const out = Uint8Array.from(image);
  const root = 20 * disc.sectorSize + disc.dataOffset;
  const at = out.subarray(root, root + 2048).findIndex((_, i, a) =>
    a[i] === 0x53 && a[i + 1] === 0x47 && a[i + 2] === 0x4d
  ); // "SGM"
  out[root + at] = 0x58;
  assertThrows(
    () => injectGameIntoDisc(out, syntheticSections(1)),
    Error,
    "SGM_INIT.CMP is not on this disc",
  );
  assertThrows(
    () => injectGameIntoDisc(new Uint8Array(100000), syntheticSections(1)),
    Error,
    "no ISO 9660",
  );
});

Deno.test({
  name:
    "on the retail track: the boot image and the menu change, and nothing else",
  ignore: !hasDiscImage(),
  fn() {
    const track = loadDiscImage();
    const disc = openDisc(track);
    // Daioh's sections off the disc itself, as the game to inject: it packs to
    // well under the boot image's 82 sectors.
    const daioh = sampleGameSections(
      decompressCmp(readFile(disc, "SGM_DAIO.CMP")),
    );
    const { image, report } = injectGameIntoDisc(track, daioh);
    assertEquals(
      image.length,
      track.length,
      "the track keeps its length, so the cue and Track 2 hold",
    );
    assertEquals(report.boot.placement, "in-place");
    assertEquals(report.boot.extent, 1416);
    assertEquals(report.boot.allocation, 82);
    assertEquals(report.menu.state, "patched");
    assertEquals(report.menu.extent, 829);
    const back = readDiscGame(image);
    assert(sameSections(back.sections, daioh));
    assertEquals(back.menu, "patched");
    const changed = [];
    for (let lba = 0; lba < track.length / SECTOR_SIZE; lba++) {
      const s = image.subarray(lba * SECTOR_SIZE, (lba + 1) * SECTOR_SIZE);
      if (s.some((v, i) => v !== track[lba * SECTOR_SIZE + i])) {
        changed.push(lba);
        assert(
          isValidMode1Sector(s, lba),
          `sector ${lba} is not a valid MODE1 sector`,
        );
      }
    }
    // The root directory sectors (the two records), D2MENU's nine sectors and
    // SGM_INIT's eighty-two; nothing outside them.
    const allowed = (lba) =>
      (lba >= 20 && lba <= 25) || (lba >= 829 && lba <= 837) ||
      (lba >= 1416 && lba <= 1497);
    assertEquals(changed.filter((lba) => !allowed(lba)), []);
    assert(changed.some((lba) => lba >= 1416 && lba <= 1497));
    // The stock disc's menu reads as stock, and its boot image is Gust.
    assertEquals(
      menuPatchState(decompressCmp(readFile(disc, MENU_FILE))),
      "stock",
    );
  },
});

Deno.test({
  name:
    "on the retail track: a game past 82 sectors moves to the end of the data track",
  ignore: !hasDiscImage(),
  fn() {
    const track = loadDiscImage();
    const disc = openDisc(track);
    // Ramsie, re-packed by compress.js, comes out a little over the boot
    // image's 82 sectors (the Saturn's own encoder fit it in 167,362 bytes).
    const ramsie = sampleGameSections(
      decompressCmp(readFile(disc, "SGM_RAMS.CMP")),
    );
    const { image, report } = injectGameIntoDisc(track, ramsie, {
      menu: false,
    });
    assertEquals(report.boot.placement, "relocated");
    assertEquals(
      report.boot.extent,
      3101,
      "after the last file, where the postgap was",
    );
    assertEquals(image.length, track.length + report.grownBy * SECTOR_SIZE);
    assert(sameSections(readDiscGame(image).sections, ramsie));
    // Everything before the old boot image is as it was but the directory and
    // the volume descriptor.
    for (let lba = 0; lba < 1416; lba++) {
      if (lba === 16 || (lba >= 20 && lba <= 25)) continue;
      const at = lba * SECTOR_SIZE;
      assert(
        image.subarray(at, at + SECTOR_SIZE).every((v, i) =>
          v === track[at + i]
        ),
        `sector ${lba} changed`,
      );
    }
  },
});
