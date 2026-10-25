// packages/shmup-engine/src/n64/: writing a Dezaemon 3D 64DD data disk.
//
// The writer is judged by the reader. Every disk built here is read back
// through parseDddImage / readDirectory / extractFile — the code that reads
// the prototype disk and lands 58 of its 60 files on their documented sizes —
// and the system area through readSystemArea, which checks what an emulator
// checks before it mounts an image. The disks are synthetic; the one test that
// needs the real prototype (rebuilding it from its own files and getting the
// same bytes) is ignore:-gated on dev-fixtures/dezaemon298.ddd and skips when
// a checkout has none.
//
// Every disk is allocated at full size (64 MB, 65 for an .ndd), so the tests
// here cost a few hundred milliseconds each in zero pages.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BLANK_BYTE,
  buildCmdFile,
  buildDisk,
  buildN64ProjectFromLevel,
  buildStageBl,
  buildSystemArea,
  checkDirectory,
  checkSystemData,
  convertDisk,
  DDD_IMAGE_BYTES,
  dddFileName,
  decodeDiskId,
  decodeGam,
  decodeRgba5551,
  decodeSystemData,
  DEZA64_NOTICE_OFFSET,
  dezaemonFreeArea,
  DIRECTORY_BYTES,
  DIRECTORY_LBA,
  directoryOffsets,
  DISK_ID_LBAS,
  DOCUMENTED_SIZES,
  EFFECT_COMMANDS,
  encodeDirectory,
  encodeDiskId,
  encodeGam,
  encodeRgba5551,
  encodeSystemData,
  exportLevelToDdd,
  extractFile,
  FIRST_FILE_LBA,
  imageFormat,
  isDddImage,
  isDezaemonDiskId,
  layoutFiles,
  lbaToOffset,
  N64_CGR_TEXTURES,
  N64_ENEMY_NUMBER_BASE,
  N64_GR_TEXTURE_BASE,
  N64_GR_TEXTURES,
  N64_MD_MODELS,
  N64_MODEL_NUMBER_BASE,
  N64_PORTRAIT_CLEAR,
  N64_PORTRAIT_MAX_TEXTURE,
  N64_SCROLL_PER_ROW,
  N64_SCROLL_RATE,
  N64_SCROLL_START,
  N64_SPRITE_SCALE,
  N64_STAGE_SCENE,
  N64_STORY_MIN_FRAMES,
  N64_TEXTURE_BYTES,
  N64_UNITS_PER_PIXEL,
  NDD_IMAGE_BYTES,
  normalizeProjectName,
  packProject,
  parseCbl,
  parseCmdFile,
  parseDddImage,
  parseMdFile,
  parseStageBl,
  portraitPosition,
  projectExts,
  PROTOTYPE_GAM_BYTES,
  PROTOTYPE_GAM_GAP,
  putProject,
  ramStartOffset,
  readDirectory,
  readProjects,
  readSystemArea,
  removeProject,
  spriteAtlasTexel,
  spriteModel,
  STAGES,
  storyFrames,
  storyScreen,
  SYSTEM_AREA_BYTES,
  SYSTEM_BLOCK_BYTES,
  SYSTEM_DATA_LBAS,
  systemAreaOf,
  templateFromDisk,
  textureGrid,
  TextureSheet,
  userArea,
  writeDirectory,
} from "../packages/shmup-engine/src/n64/index.js";
import { decompress } from "../packages/shmup-engine/src/decompress.js";

// deno-lint-ignore no-explicit-any
type Any = any;

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deterministic bytes that compress somewhat, so sizes are not trivial. */
function pattern(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = i % 7 === 0 ? (x >> 16) & 0xff : (i >> 3) & 0xff;
  }
  return out;
}

function solid(w: number, h: number, [r, g, b]: number[], a = 255) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, a], i * 4);
  return { w, h, rgba };
}

/** A project of the thirty files, each at its documented size, filled with `fill`. */
function fullProject(name: string, fill = 0x11) {
  return {
    name,
    files: projectExts().map((ext, i) => ({
      ext,
      data: new Uint8Array(
        DOCUMENTED_SIZES[
          ext.replace(/^\d/, "") as keyof typeof DOCUMENTED_SIZES
        ],
      ).fill((fill + i) & 0xff),
    })),
  };
}

// ── the system area ─────────────────────────────────────────────────────────

Deno.test("a system data record round-trips and is one an emulator accepts", () => {
  const bytes = encodeSystemData({});
  assertEquals(bytes.length, 0xe8);
  const sys = decodeSystemData(bytes);
  assertEquals(sys.region, 0xe848d316);
  assertEquals(sys.format, 0x10);
  assertEquals(sys.retail, true);
  assertEquals(sys.diskType, 0);
  assertEquals(sys.iplLoadBlocks, 9);
  assertEquals(sys.iplLoadAddress, 0x80000400);
  assertEquals([sys.romEndLba, sys.ramStartLba, sys.ramEndLba], [
    1417,
    1418,
    4291,
  ]);
  assertEquals(checkSystemData(sys), []);
  assertEquals(bytes[5], 0x10, "retail bit over type 0");
  const t6 = decodeSystemData(encodeSystemData({ diskType: 6 }));
  assertEquals([t6.romEndLba, t6.ramStartLba, t6.ramEndLba], [
    4291,
    0xffff,
    0xffff,
  ], "type 6 has no RAM area");
  assertThrows(
    () => encodeSystemData({ iplLoadBlocks: 0 }),
    Error,
    "refuses 0",
  );
  assertThrows(
    () => encodeSystemData({ iplLoadAddress: 0x70000000 }),
    Error,
    "0x80000000",
  );
  assertThrows(() => encodeSystemData({ diskType: 7 }), Error, "0..6");
  const bad = decodeSystemData(encodeSystemData({ region: 0x12345678 }));
  assertEquals(checkSystemData(bad).length, 1);
});

Deno.test("a disk ID round-trips with its BCD timestamp", () => {
  const date = new Date(1998, 1, 23, 19, 24, 25);
  const bytes = encodeDiskId({ date, companyCode: "01", version: 2 });
  assertEquals(bytes.length, 0x20);
  assertEquals(Array.from(bytes.subarray(0x11, 0x18)), [
    0x19,
    0x98,
    0x02,
    0x23,
    0x19,
    0x24,
    0x25,
  ]);
  const id = decodeDiskId(bytes);
  assertEquals(id.initialCode, "DEZA");
  assertEquals(id.version, 2);
  assertEquals(id.ramUse, 1);
  assertEquals(id.companyCode, "01");
  assertEquals(id.freeArea, "ATNFS0");
  // What the cartridge checks a disk ID for (LuigiBlood's 64dd wiki): Athena's
  // company code E7 and ATNFS followed by the disk type — the defaults.
  const own = decodeDiskId(encodeDiskId({ date: null }));
  assertEquals(own.companyCode, "E7");
  assertEquals(own.freeArea, "ATNFS0");
  assert(isDezaemonDiskId(own));
  assert(!isDezaemonDiskId(own, 1), "a type-1 disk's free area is ATNFS1");
  assert(!isDezaemonDiskId(id), "a company code of 01 is not Athena's");
  assertEquals(decodeDiskId(encodeDiskId({ diskType: 3 })).freeArea, "ATNFS3");
  assertEquals(dezaemonFreeArea(6), "ATNFS6");
  assertThrows(() => dezaemonFreeArea(7), Error, "0..6");
  assertEquals(id.date?.getTime(), date.getTime());
  assertEquals(decodeDiskId(encodeDiskId({ date: null })).date, null);
  assertThrows(
    () => encodeDiskId({ initialCode: "TOOLONG" }),
    Error,
    "four characters",
  );
  assertThrows(() => encodeDiskId({ freeArea: "SEVENCH" }), Error, "at most 6");
});

Deno.test("a built system area is read back from LBA 0 and 14, every sector agreeing", () => {
  const area = buildSystemArea({
    diskId: { date: new Date(2026, 9, 14, 12, 0, 0) },
  });
  assertEquals(area.length, SYSTEM_AREA_BYTES);
  const r = readSystemArea(area);
  assertEquals(r.errors, []);
  assertEquals(r.systemLba, 0);
  assertEquals(r.development, false);
  assertEquals(r.diskIdLba, 14);
  assertEquals(r.diskId?.initialCode, "DEZA");
  assert(
    isDezaemonDiskId(r.diskId!),
    "the ID the cartridge accepts: E7 and ATNFS0",
  );
  assertEquals(r.systemData?.iplLoadBlocks, 9);
  // the free area follows the system data's disk type
  const t2 = readSystemArea(buildSystemArea({ systemData: { diskType: 2 } }));
  assertEquals(t2.diskId?.freeArea, "ATNFS2");
  assert(isDezaemonDiskId(t2.diskId!, 2));
  // the copies in 1, 8, 9 and 15 are byte-identical to the first
  for (const lba of SYSTEM_DATA_LBAS.slice(1)) {
    assert(
      same(
        area.subarray(lba * SYSTEM_BLOCK_BYTES, (lba + 1) * SYSTEM_BLOCK_BYTES),
        area.subarray(0, SYSTEM_BLOCK_BYTES),
      ),
      `LBA ${lba}`,
    );
  }
  assert(
    same(
      area.subarray(15 * SYSTEM_BLOCK_BYTES, 16 * SYSTEM_BLOCK_BYTES),
      area.subarray(14 * SYSTEM_BLOCK_BYTES, 15 * SYSTEM_BLOCK_BYTES),
    ),
  );
  // one sector of the system block disagreeing is what an emulator rejects
  const broken = area.slice();
  broken[232 * 3 + 5] ^= 0xff;
  for (const lba of SYSTEM_DATA_LBAS) {
    broken.set(
      broken.subarray(0, SYSTEM_BLOCK_BYTES),
      lba * SYSTEM_BLOCK_BYTES,
    );
  }
  assertEquals(readSystemArea(broken).systemLba, null);
  // an all-zero area has no system data an emulator accepts; its zero ID
  // block does "agree" sector to sector, which is all an emulator checks
  const zero = readSystemArea(new Uint8Array(SYSTEM_AREA_BYTES));
  assertEquals(zero.errors.length, 1);
  assertEquals(zero.systemData, null);
  assertEquals(zero.diskId?.initialCode, "    ");
  assertEquals(DISK_ID_LBAS, [14, 15]);
});

// ── the directory ───────────────────────────────────────────────────────────

Deno.test("a directory encodes as the five arrays and reads back entry for entry", () => {
  const entries = layoutFiles([
    { name: "ONE", ext: "GAM", storedSize: 1000 },
    { name: "ONE", ext: "0GR", storedSize: 19720 * 2 + 1 },
    { name: "TWO", ext: "GAM", storedSize: 5 },
  ]);
  assertEquals(entries.map((e) => [e.startLba, e.blockCount]), [
    [9, 1],
    [10, 3],
    [13, 1],
  ]);
  const bytes = encodeDirectory(entries);
  assertEquals(bytes.length, DIRECTORY_BYTES);
  assertEquals(String.fromCharCode(...bytes.subarray(0, 11)), "ONE     GAM");
  assertEquals(String.fromCharCode(...bytes.subarray(11, 22)), "ONE     0GR");
  assertEquals(
    bytes[33],
    0,
    "the unused slot after the last entry is zero, which ends the directory",
  );
  const user = new Uint8Array(DDD_IMAGE_BYTES);
  writeDirectory(user, entries);
  const back = readDirectory(user);
  assertEquals(back.length, 3);
  assertEquals(
    back.map((e) => [e.name, e.ext, e.startLba, e.blockCount, e.storedSize]),
    entries.map((e) => [e.name, e.ext, e.startLba, e.blockCount, e.storedSize]),
  );
  assertEquals(checkDirectory(back), {
    contiguous: true,
    blocksFit: true,
    withinCapacity: true,
    end: lbaToOffset(13)! + 5,
  });
  for (const at of directoryOffsets()) {
    assert(
      same(user.subarray(at, at + DIRECTORY_BYTES), bytes),
      `copy at 0x${at.toString(16)}`,
    );
  }
  assertThrows(
    () =>
      encodeDirectory([{
        name: "TOO LONG NAME",
        ext: "GAM",
        startLba: 9,
        blockCount: 1,
        storedSize: 1,
      }]),
    Error,
  );
  assertThrows(
    () =>
      encodeDirectory([{
        name: "A",
        ext: "GAME",
        startLba: 9,
        blockCount: 1,
        storedSize: 1,
      }]),
    Error,
    "3 characters",
  );
});

Deno.test("files are laid end to end, block counts follow the zone, and the ROM area has an end", () => {
  // a file that starts at 266 and spans the zone boundary takes 5 blocks, as SAMP 3MD does
  const lead = lbaToOffset(266)! - lbaToOffset(9)!;
  const entries = layoutFiles([
    { name: "A", ext: "GAM", storedSize: lead },
    { name: "A", ext: "3MD", storedSize: 2 * 19720 + 3 * 18360 },
  ]);
  assertEquals(entries[1].startLba, 266);
  assertEquals(entries[1].blockCount, 5);
  assertEquals(entries[1].capacity, 2 * 19720 + 3 * 18360);
  const room = lbaToOffset(DIRECTORY_LBA)! - lbaToOffset(FIRST_FILE_LBA)!;
  assertEquals(
    layoutFiles([{ name: "A", ext: "GAM", storedSize: room }])[0].blockCount,
    DIRECTORY_LBA - FIRST_FILE_LBA,
    "the whole ROM area is one file's worth",
  );
  assertThrows(
    () => layoutFiles([{ name: "A", ext: "GAM", storedSize: room + 1 }]),
    Error,
    "ROM area is full",
  );
});

Deno.test("a project name is letters and digits, upper case, eight at most", () => {
  assertEquals(normalizeProjectName("my game 2!"), "MYGAME2");
  assertEquals(normalizeProjectName("samplez1"), "SAMPLEZ1");
  assertEquals(normalizeProjectName("a very long title"), "AVERYLON");
  assertThrows(() => normalizeProjectName("!!!"), Error, "no letters");
});

Deno.test("packProject orders the thirty files as the directory does and compresses each", () => {
  const packed = packProject({
    name: "x",
    files: [
      { ext: "8gr", data: pattern(100) },
      { ext: "GAM", data: pattern(50) },
      { ext: "ZZZ", data: pattern(10) },
      { ext: "0BL", data: pattern(20) },
    ],
  });
  assertEquals(packed.map((f) => f.ext), ["GAM", "0BL", "8GR", "ZZZ"]);
  assertEquals(packed[0].name, "X");
  for (const f of packed) {
    assert(same(Uint8Array.from(decompress(f.stream)), f.raw), f.ext);
  }
  assertThrows(
    () =>
      packProject({
        name: "x",
        files: [{ ext: "GAM", data: pattern(5) }, {
          ext: "gam",
          data: pattern(5),
        }],
      }),
    Error,
    "twice",
  );
  assertThrows(
    () =>
      packProject({
        name: "x",
        files: [{ ext: "GAM", data: new Uint8Array(0) }],
      }),
    Error,
    "non-empty",
  );
  assertThrows(
    () => packProject({ name: "x", files: [] }),
    Error,
    "at least one",
  );
});

// ── disks ───────────────────────────────────────────────────────────────────

Deno.test("a disk built from nothing reads back through the reader whole", () => {
  const one = fullProject("ONE");
  const built = buildDisk({ projects: [one] });
  assertEquals(built.format, "ddd");
  assertEquals(built.image.length, DDD_IMAGE_BYTES);
  assertEquals(built.warnings, []);
  assert(
    isDddImage(built.image),
    "the notice makes it a DEZA64 data disk to the reader",
  );
  assertEquals(built.image[DEZA64_NOTICE_OFFSET], "K".charCodeAt(0));
  const parsed = parseDddImage(built.image);
  assertEquals(parsed.errors, []);
  assertEquals(parsed.directory?.length, 30);
  assertEquals(parsed.directory?.map((e) => e.ext), projectExts());
  assertEquals(parsed.directory?.[0].startLba, FIRST_FILE_LBA);
  assertEquals(parsed.invariants, {
    ...parsed.invariants,
    contiguous: true,
    blocksFit: true,
    withinCapacity: true,
  });
  for (const e of parsed.directory!) {
    const f = extractFile(built.image, e);
    assertEquals(
      f.sizeOk,
      true,
      `${e.ext} decompresses to its documented size`,
    );
    assert(
      same(f.data, one.files.find((x) => x.ext === e.ext)!.data),
      `${e.ext} is the bytes given`,
    );
  }
  // 0xFF from the last file to the directory's block, nothing but zero after the directory
  const last = parsed.directory![29];
  const end = last.offset! + last.storedSize;
  assertEquals(built.report.romEnd, end);
  const tail = built.image.subarray(end, lbaToOffset(DIRECTORY_LBA)!);
  assert(tail.every((b) => b === BLANK_BYTE), "unwritten media is 0xFF");
  assert(
    built.image.subarray(
      lbaToOffset(DIRECTORY_LBA)!,
      lbaToOffset(DIRECTORY_LBA)! + 834,
    ).every((b) => b === 0),
  );
  const ram = built.image.subarray(ramStartOffset(0)!);
  const copies = directoryOffsets().slice(1).map((o) => o - ramStartOffset(0)!);
  let nonzero = 0;
  for (let i = 0; i < ram.length; i++) {
    if (ram[i] === 0) continue;
    if (copies.some((c) => i >= c && i < c + DIRECTORY_BYTES)) continue;
    nonzero++;
  }
  assertEquals(
    nonzero,
    0,
    "the RAM area holds the two directory copies and nothing else",
  );
  assertEquals(
    built.report.projects.map((
      p: { name: string; kept: boolean },
    ) => [p.name, p.kept]),
    [["ONE", false]],
  );
  assert(built.report.romFree > 20_000_000);
});

Deno.test("a disk built as an .ndd carries a system area an emulator would mount", () => {
  const built = buildDisk({
    projects: [{ name: "A", files: [{ ext: "GAM", data: pattern(0x559) }] }],
    format: "ndd",
  });
  assertEquals(built.image.length, NDD_IMAGE_BYTES);
  const r = readSystemArea(built.image);
  assertEquals(r.errors, []);
  assertEquals(r.systemData?.diskType, 0);
  assertEquals(r.diskId?.initialCode, "DEZA");
  assert(isDezaemonDiskId(r.diskId!), "company code E7, free area ATNFS0");
  const user = userArea(built.image);
  assert(isDddImage(user));
  assertEquals(readDirectory(user).length, 1);
  assertEquals(imageFormat(built.image), "ndd");
  assertEquals(imageFormat(user), "ddd");
  assertEquals(imageFormat(new Uint8Array(3)), null);
});

Deno.test("putProject keeps every other project's stream byte for byte and the RAM area verbatim", () => {
  const base = buildDisk({
    projects: [fullProject("ONE", 0x20), fullProject("TWO", 0x40)],
  }).image;
  // scribble on the RAM area where nothing of ours lives, as a cartridge's save would
  const marker = ramStartOffset(0)! + 20 * 16320 + 7;
  base[marker] = 0xab;
  base[marker + 1] = 0xcd;
  // and on the boot area
  base[0x1000] = 0x99;
  const before = readProjects(base);
  const built = putProject(base, {
    name: "NEW",
    files: [{ ext: "GAM", data: pattern(0x559, 9) }, {
      ext: "CGR",
      data: pattern(0x28000, 3),
    }],
  });
  assertEquals(
    built.report.projects.map((
      p: { name: string; kept: boolean },
    ) => [p.name, p.kept]),
    [["ONE", true], ["TWO", true], ["NEW", false]],
  );
  const after = readProjects(built.image);
  assertEquals(after.map((p) => p.name), ["ONE", "TWO", "NEW"]);
  for (let i = 0; i < 2; i++) {
    assertEquals(after[i].files.length, 30);
    after[i].files.forEach((f, k) => {
      assert(
        same(f.stream, before[i].files[k].stream),
        `${after[i].name}.${f.ext} stream unchanged`,
      );
      assertEquals(
        f.startLba,
        before[i].files[k].startLba,
        "nothing before the new project moved",
      );
    });
  }
  assertEquals(built.image[marker], 0xab);
  assertEquals(built.image[marker + 1], 0xcd);
  assertEquals(built.image[0x1000], 0x99);
  assertEquals(readDirectory(built.image).length, 62);
  // replacing by name re-lays what follows
  const replaced = putProject(built.image, {
    name: "one",
    files: [{ ext: "GAM", data: pattern(10) }],
  });
  const names = readProjects(replaced.image);
  assertEquals(names.map((p) => [p.name, p.files.length]), [["ONE", 1], [
    "TWO",
    30,
  ], ["NEW", 2]]);
  assertEquals(
    names[1].files[0].startLba,
    10,
    "TWO moved up behind the one-file ONE",
  );
  assert(
    same(names[1].files[5].stream, before[1].files[5].stream),
    "and its streams came along untouched",
  );
  assertEquals(replaced.image[marker], 0xab, "the RAM area again");
});

Deno.test("removeProject drops a project and says so when there was none", () => {
  const base =
    buildDisk({ projects: [fullProject("ONE"), fullProject("TWO")] }).image;
  const less = removeProject(base, "one");
  assertEquals(readProjects(less.image).map((p) => p.name), ["TWO"]);
  assertEquals(less.warnings, []);
  assertEquals(readDirectory(less.image)[0].startLba, FIRST_FILE_LBA);
  const none = removeProject(less.image, "NOPE");
  assertEquals(none.warnings.length, 1);
  assertEquals(readProjects(none.image).map((p) => p.name), ["TWO"]);
  // put it back: the original directory order is not restored (TWO stays first), but every byte of TWO is
  const back = putProject(none.image, fullProject("ONE"));
  assertEquals(readProjects(back.image).map((p) => p.name), ["TWO", "ONE"]);
});

Deno.test("a base disk whose directory contradicts the geometry is refused", () => {
  const base = buildDisk({ projects: [fullProject("ONE")] }).image;
  const at = directoryOffsets()[0] + 834 * 11 + 834 * 2; // blockCount array, slot 0
  base[at + 1] = 99;
  assertThrows(
    () => putProject(base, fullProject("TWO")),
    Error,
    "does not agree",
  );
  assertThrows(
    () => buildDisk({ base: new Uint8Array(10) }),
    Error,
    "base disk is",
  );
  assertThrows(
    () => buildDisk({ projects: [fullProject("A")], format: "iso" as "ddd" }),
    Error,
    "ddd",
  );
  assertThrows(
    () => buildDisk({ projects: [fullProject("A"), fullProject("a")] }),
    Error,
    "twice",
  );
});

Deno.test("convertDisk goes .ddd -> .ndd -> .ddd without touching the user area", () => {
  const ddd = buildDisk({ projects: [fullProject("ONE")] }).image;
  const ndd = convertDisk(ddd, "ndd");
  assertEquals(ndd.length, NDD_IMAGE_BYTES);
  assertEquals(readSystemArea(ndd).errors, []);
  assert(same(userArea(ndd), ddd));
  const back = convertDisk(ndd, "ddd");
  assert(same(back, ddd));
  // an .ndd rebuilt as an .ndd keeps its own system area
  const area = systemAreaOf(ndd)!.slice();
  area[100] = 0x77;
  const own = convertDisk(nddFromDddFor(ddd, area), "ndd");
  assertEquals(systemAreaOf(own)![100], 0x77);
  const rebuilt = buildDisk({ base: own, projects: [fullProject("TWO")] });
  assertEquals(rebuilt.format, "ndd", "the base's format");
  assertEquals(
    systemAreaOf(rebuilt.image)![100],
    0x77,
    "and the base's system area",
  );
  assertThrows(() => convertDisk(ddd, "d64" as "ddd"), Error);
});

function nddFromDddFor(ddd: Uint8Array, area: Uint8Array): Uint8Array {
  const out = new Uint8Array(NDD_IMAGE_BYTES);
  out.set(area);
  out.set(ddd, SYSTEM_AREA_BYTES);
  return out;
}

// ── the project out of a level ──────────────────────────────────────────────

Deno.test("RGBA5551 encodes the way graphics.js decodes it", () => {
  const f = {
    w: 2,
    h: 1,
    rgba: Uint8Array.from([255, 0, 0, 255, 10, 20, 30, 0]),
  };
  const bytes = encodeRgba5551(f);
  assertEquals(
    Array.from(bytes),
    [0xf8, 0x01, 0, 0],
    "red with alpha; a transparent pixel is a zero word",
  );
  const back = decodeRgba5551(bytes);
  assertEquals([back.data[0], back.data[1], back.data[2], back.data[3]], [
    255,
    0,
    0,
    255,
  ]);
  assertEquals(back.data[7], 0);
  // every 8-bit value survives a round trip to within a five-bit step
  for (const v of [0, 8, 123, 200, 255]) {
    const out = decodeRgba5551(
      encodeRgba5551({ w: 1, h: 1, rgba: Uint8Array.from([v, v, v, 255]) }),
    ).data[0];
    assert(Math.abs(out - v) <= 4, `${v} -> ${out}`);
  }
  assertEquals(
    encodeRgba5551({
      w: 1,
      h: 1,
      rgba: Uint8Array.from([255, 255, 255, 127]),
    })[1] & 1,
    0,
    "half-transparent is clear at the default cutoff",
  );
  assertEquals(
    encodeRgba5551(
      { w: 1, h: 1, rgba: Uint8Array.from([255, 255, 255, 127]) },
      { alphaCutoff: 1 },
    )[1] & 1,
    1,
  );
});

Deno.test("a frame is cut into 64x32 textures top-left aligned, 1:1", () => {
  const small = textureGrid(solid(32, 32, [0, 255, 0]));
  assertEquals([small.cols, small.rows, small.tiles.length], [1, 1, 1]);
  const t = decodeRgba5551(small.tiles[0]);
  assertEquals(t.data[(0 * 64 + 31) * 4 + 1], 255, "pixel 31,0 is green");
  assertEquals(
    t.data[(0 * 64 + 32) * 4 + 3],
    0,
    "pixel 32,0 is clear: the frame was 32 wide",
  );
  assertEquals(t.data[(31 * 64 + 0) * 4 + 1], 255);
  const boss = textureGrid(solid(128, 128, [9, 9, 9]));
  assertEquals([boss.cols, boss.rows, boss.tiles.length], [2, 4, 8]);
  assertEquals(boss.tiles[7].length, N64_TEXTURE_BYTES);
  const odd = textureGrid(solid(65, 33, [9, 9, 9]));
  assertEquals([odd.cols, odd.rows], [2, 2]);
});

Deno.test("a sheet lays frames into blank textures only, in runs, and refuses when full", () => {
  const template = new Uint8Array(N64_CGR_TEXTURES * N64_TEXTURE_BYTES);
  template[0] = 0xf8; // texture 0 is painted
  template[1] = 0x01;
  template[3 * N64_TEXTURE_BYTES + 100] = 1; // and 3
  const sheet = new TextureSheet(N64_CGR_TEXTURES, template);
  assertEquals(sheet.painted, 2);
  assertEquals(sheet.free, 38);
  assertEquals(
    sheet.place("a", textureGrid(solid(32, 32, [1, 2, 3]))),
    1,
    "the first blank",
  );
  assertEquals(
    sheet.place("b", textureGrid(solid(128, 32, [1, 2, 3]))),
    4,
    "two in a row: 2 alone would not do",
  );
  assertEquals(
    sheet.place("c", textureGrid(solid(32, 32, [1, 2, 3]))),
    2,
    "the single gap takes a single",
  );
  assertEquals(sheet.bytes[0], 0xf8, "the template's texture is untouched");
  assertEquals(
    sheet.place("huge", textureGrid(solid(64 * 40, 32, [1, 2, 3]))),
    null,
    "no run of 40 blanks",
  );
  assertEquals(sheet.placed.map((p) => p.key), ["a", "b", "c"]);
  assertThrows(
    () => new TextureSheet(10, new Uint8Array(5)),
    Error,
    "template",
  );
});

function tinyLevel() {
  return {
    name: "Tiny game!",
    width: 3,
    enemylist: [["A0", "00", "B1"], ["00", "C0", "00"]],
    enemyData: {
      enemyA: {
        name: "ant",
        texture: ["a0.png", "a1.png", "a2.png", "a3.png", "a4.png", "a5.png"],
        projectileData: { texture: ["shot.png"] },
      },
      enemyB: { name: "bee", texture: ["big.png"] },
      // enemyC has no record: warned about, not drawn
    },
    bossData: { boss0: { anim: { idle: ["boss.png"] } } },
    playerData: { texture: ["ship0.png", "ship1.png"] },
  };
}
function tinyArt() {
  const art: Record<string, { w: number; h: number; rgba: Uint8Array }> = {};
  for (let i = 0; i < 6; i++) art[`a${i}.png`] = solid(32, 32, [i * 40, 0, 0]);
  art["shot.png"] = solid(8, 8, [255, 255, 0]);
  art["big.png"] = solid(96, 48, [0, 0, 255]);
  art["boss.png"] = solid(128, 128, [0, 255, 255]);
  art["ship0.png"] = solid(32, 32, [255, 255, 255]);
  art["ship1.png"] = solid(32, 32, [200, 200, 200]);
  art["powerupBig0.png"] = solid(16, 16, [255, 0, 255]);
  return art;
}

Deno.test("a project from a level is thirty files at documented sizes with the art in its sheets", () => {
  const p = buildN64ProjectFromLevel(tinyLevel(), tinyArt(), {
    title1: solid(300, 100, [1, 1, 1]),
  });
  assertEquals(p.name, "TINYGAME");
  assertEquals(p.files.map((f) => f.ext), projectExts());
  for (const f of p.files) {
    assertEquals(
      f.data.length,
      DOCUMENTED_SIZES[
        f.ext.replace(/^\d/, "") as keyof typeof DOCUMENTED_SIZES
      ],
      f.ext,
    );
  }
  const s0 = p.report.stages[0];
  assertEquals(s0.stage, 0);
  assertEquals(s0.enemies, ["A", "B", "C"]);
  assertEquals(
    s0.textures.map((
      t: { key: string; index: number; textures: number },
    ) => [t.key.split(":")[0], t.index, t.textures]),
    [
      ["enemyA", 0, 1],
      ["enemyA", 1, 1],
      ["enemyA", 2, 1],
      ["enemyA", 3, 1],
      ["enemyB", 4, 1],
      ["boss0", 5, 1],
    ],
    "four of the six ant frames, the bee and the boss one texture each — a model shows one",
  );
  assertEquals(
    s0.scaled,
    ["enemyB:0:big.png", "boss0:0:boss.png"],
    "the 96x48 bee and the 128x128 boss were shrunk to fit",
  );
  assertEquals(s0.used, 6);
  assertEquals(s0.free, N64_GR_TEXTURES - 6);
  assertEquals(p.warnings.length, 1);
  assert(p.warnings[0].includes("enemyC"));
  // the common sheet: the title fitted to 2x2, the ship's two frames, one item
  const common = p.report.common.textures.map((
    t: { key: string; textures: number },
  ) => [t.key.split(":")[0], t.textures]);
  assertEquals(common, [["title1", 4], ["ship", 1], ["ship", 1], ["item", 1]]);
  assertEquals(p.report.ship, "level");
  assertEquals(
    p.report.common.models.map((
      m: { slot: number; texture: number },
    ) => [m.slot, m.texture]),
    [[10, 4], [12, 6]],
    "the ship is common model 10 on its first texture, the item model 12",
  );
  assertEquals(
    p.report.files.filter((f: { source: string }) => f.source === "art").length,
    1 + 1,
    "CGR and the one stage's GR",
  );
  assertEquals(
    p.report.files.filter((f: { source: string }) => f.source === "records")
      .map((f: { ext: string }) => f.ext),
    ["GAM", "CMD", "CBL", "ULB", "MUS", "0BL", "0MD"],
    "the records of the one stage and the common files are built",
  );
  assertEquals(
    p.report.files.filter((f: { source: string }) => f.source === "blank")
      .length,
    21,
    "the seven other stages are zero",
  );
  // the stage sheet decodes to the art: the first texture's top-left pixel is ant frame 0's colour (0,0,0) and opaque
  const gr = p.files.find((f) => f.ext === "0GR")!.data;
  assertEquals((gr[0] << 8 | gr[1]) & 1, 1);
  const bee = decodeRgba5551(
    gr.subarray(4 * N64_TEXTURE_BYTES, 5 * N64_TEXTURE_BYTES),
  );
  assertEquals([bee.data[0], bee.data[1], bee.data[2]], [0, 0, 255]);

  // the records: an entry per enemy (B's cell carries drop 1, the shot item), the boss with the stage-clear flag
  assertEquals(s0.records.entries, 3);
  assertEquals(s0.records.models, 6);
  assertEquals(s0.records.placements, 3);
  assertEquals(s0.records.bossEntry, 2);
  const bl = parseStageBl(p.files.find((f) => f.ext === "0BL")!.data) as Any;
  const ant = bl.enemies[0];
  assertEquals(ant.animation.models, [
    N64_MODEL_NUMBER_BASE,
    N64_MODEL_NUMBER_BASE + 1,
    N64_MODEL_NUMBER_BASE + 2,
    N64_MODEL_NUMBER_BASE + 3,
  ]);
  assertEquals(
    ant.animation.disabled,
    true,
    "the ant names no frameRate, so its frames do not cycle",
  );
  assertEquals(
    ant.shots[0].variant,
    0,
    "the ant has no interval, so it does not fire",
  );
  assertEquals(ant.item.enabled, false);
  const beeEntry = bl.enemies[1];
  assertEquals(beeEntry.animation.models, [
    N64_MODEL_NUMBER_BASE + 4,
    N64_MODEL_NUMBER_BASE + 4,
    N64_MODEL_NUMBER_BASE + 4,
    N64_MODEL_NUMBER_BASE + 4,
  ]);
  assertEquals(
    beeEntry.item,
    { enabled: true, value: 0 },
    "B1: drop digit 1 is the shot item",
  );
  assertEquals(beeEntry.hit.size, 6, "96 px across");
  assertEquals(
    beeEntry.scale,
    N64_SPRITE_SCALE,
    "the ship's scale: they fly in its plane",
  );
  const bossEntry = bl.enemies[2];
  assertEquals(bossEntry.hit.stageClear, true);
  assertEquals(bossEntry.hit.lockOn, true);
  assertEquals(bossEntry.motion.type, 1, "a boss holds its place");
  assertEquals(bossEntry.hp, 15);
  assertEquals(
    bl.enemies[3].animation.models,
    [0xff, 0xff, 0xff, 0xff],
    "the fourth entry is the plain default",
  );
  // the layout: the grid's last row scrolls in first; x across the ship's
  // reach; every enemy and the boss at the ship's height; descending
  // frames; the boss last
  assertEquals(bl.layout.a, []);
  assertEquals(bl.layout.b, []);
  assertEquals(
    bl.layout.map.map((e: Any) => [e.enemy, e.x, e.y, e.frame]),
    [[20, -220, 800, -3200], [21, 220, 800, -3200], [22, 0, 800, -7040]],
    "entries numbered from 20, after the common enemies; 160 of scroll a row",
  );
  assertEquals(N64_SCROLL_PER_ROW, 160);
  assertEquals(bl.tail.firstA, 4);
  assertEquals(bl.tail.firstB, 5);
  // the opening scene and nothing else: altitude, fog and a neutral camera
  assertEquals(bl.tail.totalEffects, N64_STAGE_SCENE.length);
  assertEquals(
    bl.effects.map((e: Any) => [e.frame, EFFECT_COMMANDS[e.command], e.values]),
    N64_STAGE_SCENE.map((e) => [e.frame, e.command, [...e.values]]),
  );
  assertEquals(
    bl.effects.map((e: Any) => EFFECT_COMMANDS[e.command]),
    ["altitude", "fog", "cameraZoom", "cameraAngle", "cameraRotation"],
  );
  assertEquals(
    bl.mapSettings,
    { scale: 5, loopStart: 0, loopEnd: 3 },
    "the sample game's map settings",
  );
  assertEquals(
    bl.map.every((m: Any) => m.texture === 150),
    true,
    "no template: the map is unset",
  );
  // the models: a billboard per placed frame on its texture
  const md = parseMdFile(p.files.find((f) => f.ext === "0MD")!.data) as Any;
  assertEquals(md.models.filter(Boolean).length, 6);
  assertEquals(
    md.textureIndices.slice(0, 7),
    [40, 41, 42, 43, 44, 45, 0],
    "a stage model names #GR tile k as texture 40 + k",
  );
  const quad = md.models[0]!;
  assertEquals(quad.vertexCount, 4);
  assertEquals(quad.faceCount, 2);
  assertEquals(N64_UNITS_PER_PIXEL, 10);
  assertEquals(quad.vertices.slice(0, 4).map((v: Any) => [v.x, v.y, v.z]), [
    [-160, 0, 160],
    [160, 0, 160],
    [160, 0, -160],
    [-160, 0, -160],
  ], "a 32x32 sprite is a 320-unit quad on the ground plane");
  assertEquals(
    quad.faces[0].uv,
    [[0, 32], [32, 32], [32, 0]],
    "the sprite's own texels, its top row at the far edge",
  );
  assertEquals(quad.faces[1].uv, [[0, 32], [32, 0], [0, 0]]);
  assertEquals(quad.faces[0].tile, 1);
  assertEquals(
    [quad.tiles[1].widthPower, quad.tiles[1].heightPower],
    [5, 6],
    "the tile is the whole 64x32 texture",
  );
  const beeModel = md.models[4]!;
  assertEquals(
    beeModel.faces[0].uv,
    [[0, 32], [64, 32], [64, 0]],
    "the bee was shrunk to 64x32",
  );
  assertEquals(
    [
      beeModel.vertices[1].x - beeModel.vertices[0].x,
      beeModel.vertices[0].z - beeModel.vertices[3].z,
    ],
    [960, 480],
    "and keeps its 96x48 size on screen",
  );
  // the common records: the ship as model 10, the item as model 12, the shot item entry pointing at it, the final stage
  const cmd = parseCmdFile(p.files.find((f) => f.ext === "CMD")!.data) as Any;
  assertEquals(
    cmd.models.map((m: Any, i: number) => (m ? i : -1)).filter((i: number) =>
      i >= 0
    ),
    [
      10,
      12,
    ],
  );
  assertEquals(cmd.textureIndices[10], 4);
  assertEquals(cmd.textureIndices[12], 6);
  const cbl = parseCbl(p.files.find((f) => f.ext === "CBL")!.data) as Any;
  assertEquals(cbl.items.shot.animation.models, [12, 12, 12, 12]);
  assertEquals(cbl.items.shot.hit.hpMode, 2, "an item cannot be shot down");
  assertEquals(
    cbl.items.laser.animation.models,
    [0xff, 0xff, 0xff, 0xff],
    "one item icon: the other items show nothing",
  );
  assertEquals(
    decodeGam(p.files.find((f) => f.ext === "GAM")!.data).finalStage,
    0,
  );
  assertEquals(p.report.finalStage, 0);
});

// ── a stage's story ─────────────────────────────────────────────────────────

/** A story size: a `w` x `h` picture of distinct colours, so no two cells match. */
function storyVariant(label: string, w: number, h: number) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      rgba.set(
        [(x * 7) & 0xff, (y * 5) & 0xff, (x + y) & 0xff, 255],
        (y * w + x) * 4,
      );
    }
  }
  return { label, w, h, rgba };
}

const effectName = (e: Any) => EFFECT_COMMANDS[e.command];

Deno.test("a stage opens on its story: forty portraits over the screen, the ship hidden and the scroll held, then cleared", () => {
  const parts = ["Hello there,", "pilot."];
  const p = buildN64ProjectFromLevel(tinyLevel(), tinyArt(), {
    storyBackdrops: [
      {
        stage: 0,
        parts,
        variants: [
          storyVariant("too tall", 224, 256),
          storyVariant("picture + words", 224, 192),
          storyVariant("words", 224, 48),
        ],
      },
      // a story for a stage the level does not have is left alone
      { stage: 5, parts: ["far"], variants: [storyVariant("words", 224, 48)] },
    ],
  });
  const s0 = p.report.stages[0];
  const frames = storyFrames(parts);
  assertEquals(
    frames,
    N64_STORY_MIN_FRAMES,
    "a short story stays the six-second minimum",
  );
  const screen = storyScreen(storyVariant("picture + words", 224, 192));
  assertEquals(screen.cells.length, 40, "the 5 x 8 grid of 64x32 cells");
  assert(
    screen.textures.length < 40,
    "the black cells round the picture share one texture",
  );
  assertEquals(s0.story, {
    size: "picture + words",
    textures: screen.textures.length,
    reclaimed: 0,
    frames,
    seconds: frames / 30,
  }, "the 256-tall size is over the screen; the next fits");

  const bl = parseStageBl(p.files.find((f) => f.ext === "0BL")!.data) as Any;
  assertEquals(bl.tail.totalEffects, N64_STAGE_SCENE.length + 45);
  // the opening scene first, then the story's own
  const at0 = bl.effects.filter((e: Any) => e.frame === 0)
    .slice(N64_STAGE_SCENE.length);
  assertEquals(at0.length, 42);
  assertEquals(effectName(at0[0]), "playerVisibility");
  assertEquals(at0[0].values, [0, 0, 0, 0]);
  assertEquals(effectName(at0[1]), "mapScrollRate");
  assertEquals(at0[1].values, [0, 7, 0, 0], "the map's scroll is held");
  const portraits = at0.slice(2);
  assert(portraits.every((e: Any) => effectName(e) === "portrait"));
  assertEquals(
    portraits.map((e: Any) => e.values[2]),
    Array.from(
      { length: 40 },
      (_, k) => portraitPosition(Math.floor(k / 5), k % 5),
    ),
    "row-major, row * 10 + column, a 64-px texture every other column",
  );
  assertEquals(portraitPosition(7, 4), 78);
  assert(
    portraits.every((e: Any) => e.values[0] === 0 && e.values[3] === 1),
    "set, opaque, instant",
  );
  // every cell names a #GR texture a byte can hold, and that texture is the cell's art
  const gr = p.files.find((f) => f.ext === "0GR")!.data;
  portraits.forEach((e: Any, k: number) => {
    const texture = e.values[1];
    assert(
      texture >= N64_GR_TEXTURE_BASE && texture <= N64_PORTRAIT_MAX_TEXTURE,
      `cell ${k}: ${texture}`,
    );
    const tile = texture - N64_GR_TEXTURE_BASE;
    assert(
      same(
        gr.subarray(tile * N64_TEXTURE_BYTES, (tile + 1) * N64_TEXTURE_BYTES),
        screen.textures[screen.cells[k]],
      ),
      `cell ${k} shows its own texture`,
    );
  });
  // the enemies keep their textures: the story took the blank ones after them
  const enemyTiles = new Set(
    s0.textures.filter((t: Any) => !t.key.endsWith(":story")).map((t: Any) =>
      t.index
    ),
  );
  assert(
    portraits.every((e: Any) =>
      !enemyTiles.has(e.values[1] - N64_GR_TEXTURE_BASE)
    ),
  );

  const after = bl.effects.filter((e: Any) => e.frame !== 0);
  assertEquals(after.map((e: Any) => [e.frame, effectName(e), e.values]), [
    [frames, "portrait", [...N64_PORTRAIT_CLEAR]],
    [frames, "playerVisibility", [1, 0, 0, 0]],
    [frames, "mapScrollRate", [N64_SCROLL_RATE, 7, 0, 0]],
  ]);
  // nothing comes on behind it: the layout moves on past where the scroll stands
  assertEquals(
    bl.layout.map.map((e: Any) => e.frame),
    [
      -3200 - N64_SCROLL_START,
      -3200 - N64_SCROLL_START,
      -7040 - N64_SCROLL_START,
    ],
  );
  assertEquals(p.warnings.length, 1, "only enemyC's missing record");
});

Deno.test("a story falls back to a smaller size, takes back a template's unnamed art, and is dropped when nothing fits", () => {
  // A template stage whose sheet is painted through and whose map names
  // every tile but the last few a portrait can reach.
  const painted = new Uint8Array(N64_GR_TEXTURES * N64_TEXTURE_BYTES).fill(
    0x11,
  );
  const max = N64_PORTRAIT_MAX_TEXTURE - N64_GR_TEXTURE_BASE; // 215
  const withFree = (free: number) => [
    { ext: "0GR", data: painted },
    {
      ext: "0BL",
      data: buildStageBl({
        // a map texture byte is kept under both readings, t and t - 40
        map: Array.from(
          { length: max + 1 - free },
          (_, t) => ({ texture: t }),
        ) as Any,
      }),
    },
  ];
  const story = [{
    stage: 0,
    parts: ["A story."],
    variants: [
      storyVariant("picture + words", 224, 192),
      storyVariant("small words", 64, 32),
    ],
  }];
  const small = storyScreen(storyVariant("small words", 64, 32));
  assertEquals(small.textures.length, 3, "two cells of words and the black");

  const p = buildN64ProjectFromLevel(tinyLevel(), tinyArt(), {
    template: withFree(5),
    storyBackdrops: story,
  });
  const s0 = p.report.stages[0];
  assertEquals(
    s0.story.size,
    "small words",
    "the picture needs more than five",
  );
  assertEquals(
    s0.story.reclaimed,
    3,
    "no blank texture: the template's, taken back",
  );
  // the frames take back the template's art too, from the top of the sheet
  // down, so the tiles a portrait can name are left for the story
  assertEquals(s0.missed, []);
  assertEquals(
    s0.textures.filter((t: Any) => !t.key.endsWith(":story")).map((t: Any) =>
      t.index
    ),
    [259, 258, 257, 256, 255, 254],
  );
  assertEquals(s0.reclaimed, 6 + 3);
  const bl = parseStageBl(p.files.find((f) => f.ext === "0BL")!.data) as Any;
  const tiles = new Set<number>(
    bl.effects.filter((e: Any) =>
      effectName(e) === "portrait" && e.values[0] === 0
    )
      .map((e: Any) => e.values[1] - N64_GR_TEXTURE_BASE),
  );
  assertEquals(
    [...tiles].sort((a, b) => a - b),
    [211, 212, 213],
    "only tiles the map names under neither reading",
  );

  const none = buildN64ProjectFromLevel(tinyLevel(), tinyArt(), {
    template: withFree(2),
    storyBackdrops: story,
  });
  assertEquals(none.report.stages[0].story, null);
  assert(
    none.warnings.some((w) => w.includes("no size of its story fits")),
    none.warnings.join("; "),
  );
  const blNone = parseStageBl(
    none.files.find((f) => f.ext === "0BL")!.data,
  ) as Any;
  assertEquals(
    blNone.tail.totalEffects,
    N64_STAGE_SCENE.length,
    "the scene alone",
  );
  assertEquals(blNone.layout.map[0].frame, -3200, "no story, no shift");
});

Deno.test("a template project underlies the art and the art never covers a painted texture", () => {
  // a cartridge-layout GAM, marked; a CMD with a model of its own in slot 5
  // and another in the ship's slot
  const marked = encodeGam({ fontColor: 2 });
  const templateModel = spriteModel({ w: 8, h: 8 });
  const templateCmd = buildCmdFile(
    [
      null,
      null,
      null,
      null,
      null,
      templateModel,
      null,
      null,
      null,
      null,
      templateModel,
    ],
    [0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 7],
  );
  const template = projectExts().map((ext) => {
    const size =
      DOCUMENTED_SIZES[ext.replace(/^\d/, "") as keyof typeof DOCUMENTED_SIZES];
    let data = new Uint8Array(size);
    if (ext === "0GR") data.fill(0x55, 0, 3 * N64_TEXTURE_BYTES); // three painted textures
    if (ext === "GAM") data = Uint8Array.from(marked);
    if (ext === "CMD") data = Uint8Array.from(templateCmd);
    return { ext, data };
  });
  const p = buildN64ProjectFromLevel(tinyLevel(), tinyArt(), { template });
  assertEquals(p.report.template?.length, 30);
  assertEquals(p.report.stages[0].painted, 3);
  assertEquals(
    p.report.stages[0].textures[0].index,
    3,
    "the art starts past the template's textures",
  );
  const gr = p.files.find((f) => f.ext === "0GR")!.data;
  assert(
    gr.subarray(0, 3 * N64_TEXTURE_BYTES).every((b) => b === 0x55),
    "the template's textures survive",
  );
  // the template's GAM with the final stage set and the player on the
  // level's ship, model 10 at N64_SPRITE_SCALE — and nothing else touched
  const gam = p.files.find((f) => f.ext === "GAM")!.data;
  const g = decodeGam(gam);
  assertEquals(g.finalStage, 0);
  assertEquals(g.player.models, [10, 10, 10, 10]);
  assertEquals(g.player.scale, N64_SPRITE_SCALE);
  assertEquals(g.fontColor, 2);
  assertEquals(
    encodeGam({ ...g, finalStage: 2, player: decodeGam(marked).player }),
    marked,
    "nothing else touched",
  );
  const source = (ext: string) =>
    p.report.files.find((f: { ext: string }) => f.ext === ext)?.source;
  assertEquals(source("GAM"), "template, final stage and ship set");
  // the ship and the item in the template's CMD, its own model 5 kept
  assertEquals(source("CMD"), "template, ship and items set");
  const cmd = parseCmdFile(p.files.find((f) => f.ext === "CMD")!.data) as Any;
  assertEquals(
    cmd.models.map((m: Any, i: number) => (m ? i : -1)).filter((i: number) =>
      i >= 0
    ),
    [5, 10, 12],
  );
  assertEquals(cmd.textureIndices[5], 7);
  assertEquals(
    [cmd.textureIndices[10], cmd.textureIndices[12]],
    p.report.common.models.map((m: Any) => m.texture),
  );
  for (const ext of ["CBL", "MUS", "ULB"]) {
    assertEquals(
      source(ext),
      "template",
      `${ext} is carried from the template`,
    );
  }
  // the HUD's stock ship is the level's, where the GAM's sprite table puts it:
  // (0, 0x260) of the atlas, the top left of texture 38, the white ship
  assertEquals(p.report.common.hud?.stockShip.textures, [38]);
  const cgr = p.files.find((f) => f.ext === "CGR")!.data;
  const word = (texture: number, x: number, y: number) => {
    const at = texture * N64_TEXTURE_BYTES + (y * 64 + x) * 2;
    return (cgr[at] << 8) | cgr[at + 1];
  };
  assertEquals(word(38, 8, 8), 0xffff, "white, opaque");
  assertEquals(word(38, 20, 8), 0, "the icon is 16 wide");
  assertEquals(
    p.report.files.find((f: { ext: string }) => f.ext === "0BL")?.source,
    "records",
    "a stage's records are built even over a template; its map is the template's",
  );
  assertEquals(p.report.stages[0].records.map, "template");
  assertEquals(
    p.report.files.find((f: { ext: string }) => f.ext === "0GR")?.source,
    "art over template",
  );
  // the prototype's GAM, nine bytes short, is written in the cartridge's
  // layout: the nine bytes back at 0xA8
  const proto = new Uint8Array(PROTOTYPE_GAM_BYTES);
  proto.set(marked.subarray(0, PROTOTYPE_GAM_GAP));
  proto.set(marked.subarray(PROTOTYPE_GAM_GAP + 9), PROTOTYPE_GAM_GAP);
  const withProto = (gamData: Uint8Array) =>
    buildN64ProjectFromLevel(tinyLevel(), tinyArt(), {
      template: template.map((f) =>
        f.ext === "GAM" ? { ext: "GAM", data: gamData } : f
      ),
    });
  const fromProto = withProto(proto);
  const repaired = fromProto.files.find((f) => f.ext === "GAM")!.data;
  assertEquals(
    repaired,
    gam,
    "the same GAM as the cartridge-layout template's",
  );
  assertEquals(
    fromProto.report.files.find((f: { ext: string }) => f.ext === "GAM")
      ?.source,
    "template in the cartridge's layout, final stage and ship set",
  );
  assertEquals(fromProto.report.gam.repaired, true);
  // a GAM of a length neither layout explains is carried, its final stage set
  const odd = withProto(new Uint8Array(100).fill(1));
  const oddGam = odd.files.find((f) => f.ext === "GAM")!.data;
  assertEquals(oddGam.length, 100);
  assertEquals([oddGam[0], oddGam[1]], [0, 1]);
  assert(odd.warnings.some((w) => w.includes("template GAM is 100 bytes")));
  assertEquals(odd.report.common.hud, null, "its sprites unread");
});

Deno.test("GAM's sprite atlas is two textures to a 32-px band, and a sprite painted there is no longer blank", () => {
  assertEquals(spriteAtlasTexel(0, 0x260), { texture: 38, x: 0, y: 0 });
  assertEquals(spriteAtlasTexel(16, 0x260), { texture: 38, x: 16, y: 0 });
  assertEquals(spriteAtlasTexel(64 + 5, 0x1c0 + 3), {
    texture: 29,
    x: 5,
    y: 3,
  });
  assertEquals(spriteAtlasTexel(128, 0), null, "128 wide");
  assertEquals(spriteAtlasTexel(0, 40 * 16), null, "40 textures, 640 high");
  const sheet = new TextureSheet(N64_CGR_TEXTURES);
  assertEquals(
    sheet.paintAtlas(60, 0x260, solid(8, 4, [255, 255, 255])),
    [38, 39],
    "a sprite across a band's two textures",
  );
  assertEquals(sheet.blank[38], false);
  assertEquals(sheet.free, N64_CGR_TEXTURES - 2);
  assertEquals(sheet.paintAtlas(120, 0, solid(16, 16, [1, 1, 1])), null);
});

Deno.test("more stages than a project holds are dropped with a warning, and a full sheet is warned about", () => {
  const stages: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) stages[`stage${i}`] = { enemylist: [["A0"]] };
  const level = {
    name: "ten",
    stages,
    enemyData: { enemyA: { texture: ["a0.png"] } },
  };
  const p = buildN64ProjectFromLevel(level, tinyArt());
  assertEquals(p.report.stages.length, 8);
  assertEquals(p.report.stages.map((s: { stage: number }) => s.stage), [
    ...STAGES,
  ]);
  assert(p.warnings.some((w) => w.includes("10 stages")));
  // 300 frames of 32x32 into a 260-texture sheet
  const enemyData: Record<string, unknown> = {};
  const art: Record<string, { w: number; h: number; rgba: Uint8Array }> = {};
  const row: string[] = [];
  const letters = (i: number) =>
    String.fromCharCode(65 + Math.floor(i / 26)) +
    String.fromCharCode(65 + (i % 26));
  for (let i = 0; i < 75; i++) {
    const l = letters(i);
    enemyData[`enemy${l}`] = {
      texture: [0, 1, 2, 3].map((k) => `${l}${k}.png`),
    };
    for (let k = 0; k < 4; k++) art[`${l}${k}.png`] = solid(32, 32, [k, k, k]);
    row.push(`${l}0`);
  }
  const crowded = buildN64ProjectFromLevel({
    name: "x",
    enemylist: [row],
    enemyData,
  }, art);
  assertEquals(
    crowded.report.stages[0].used,
    N64_MD_MODELS,
    "a texture nobody models would show nothing, so the model table is the limit",
  );
  assertEquals(crowded.report.stages[0].missed.length, 300 - N64_MD_MODELS);
  assertEquals(crowded.report.stages[0].records.models, N64_MD_MODELS);
  assert(crowded.warnings.some((w) => w.includes("ran out of room")));
});

Deno.test("the layout's cap keeps the boss last, a partial hit counts as one, and a wrong-size template sheet is warned about", () => {
  // 1,200 cells and a boss: the layout holds 1,000, so 201 enemies go and
  // the boss — the most negative frame, so always last — stays.
  const rows: string[][] = [];
  for (let r = 0; r < 40; r++) {
    rows.push(Array.from({ length: 30 }, () => "A0"));
  }
  const big = buildN64ProjectFromLevel({
    name: "big",
    enemylist: rows,
    enemyData: { enemyA: { texture: ["a0.png"], hp: 2.5 } },
    bossData: { boss0: { texture: ["boss.png"], hp: 0.5 } },
  }, tinyArt());
  const bl = parseStageBl(big.files.find((f) => f.ext === "0BL")!.data) as Any;
  assertEquals(bl.layout.map.length, 1000);
  assertEquals(
    bl.layout.map[999].enemy,
    N64_ENEMY_NUMBER_BASE + big.report.stages[0].records.bossEntry,
    "the boss is the last placement",
  );
  assertEquals(
    bl.layout.map.filter((e: Any) => e.enemy === bl.layout.map[999].enemy)
      .length,
    1,
  );
  assert(
    big.warnings.some((w) => w.includes("201 dropped")),
    big.warnings.join("; "),
  );
  assertEquals(
    bl.enemies[0].hp,
    2,
    "hp 2.5 is three hits: a partial hit counts",
  );
  assertEquals(bl.enemies[1].hp, 0, "a boss of hp 0.5 takes one hit");
  // a template GR of the wrong size is left out, not fatal
  const odd = buildN64ProjectFromLevel(tinyLevel(), tinyArt(), {
    template: [{ ext: "0GR", data: new Uint8Array(100) }],
  });
  assert(odd.warnings.some((w) => w.includes("template 0GR is 100 bytes")));
  assertEquals(odd.report.stages[0].painted, 0);
  // a letter past the 180 entries places no frames, so the boss keeps a model
  const enemyData: Record<string, unknown> = {};
  const art: Record<string, { w: number; h: number; rgba: Uint8Array }> = {};
  const row: string[] = [];
  for (let i = 0; i < 181; i++) {
    const l = String.fromCharCode(65 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26));
    enemyData[`enemy${l}`] = { texture: [`${l}.png`] };
    art[`${l}.png`] = solid(8, 8, [i % 255, 0, 0]);
    row.push(`${l}0`);
  }
  art["boss.png"] = solid(32, 32, [0, 255, 255]);
  const full = buildN64ProjectFromLevel({
    name: "full",
    enemylist: [row],
    enemyData,
    bossData: { boss0: { texture: ["boss.png"] } },
  }, art);
  assertEquals(full.report.stages[0].records.entries, 180);
  assert(full.warnings.some((w) => w.includes("is left out")));
  assertEquals(
    full.report.stages[0].records.bossEntry,
    null,
    "180 letters took every entry",
  );
  assertEquals(
    full.report.stages[0].records.models,
    130,
    "the first 130 letters got models; the 181st placed none",
  );
});

Deno.test("exportLevelToDdd: a level to an .ndd in one call, and onto a donor with its first project as the template", () => {
  const out = exportLevelToDdd(tinyLevel(), tinyArt(), {});
  assertEquals(out.format, "ndd");
  assertEquals(out.image.length, NDD_IMAGE_BYTES);
  assertEquals(out.fileName, "Dezaemon 3D - Tiny game!.ndd");
  assertEquals(out.name, "TINYGAME");
  assertEquals(out.directory.length, 30);
  assertEquals(out.report.templateProject, null);
  assertEquals(readSystemArea(out.image).errors, []);
  const parsed = parseDddImage(userArea(out.image));
  assertEquals(parsed.recognised, true);
  assertEquals(parsed.directory?.every((e) => e.name === "TINYGAME"), true);

  // a donor: a sample-like SAMPLEZ1 whose GAM is marked, whose CGR is blank
  // and whose 0GR has one painted texture (fullProject paints every byte of
  // every file, which would leave the art nowhere to go)
  const sample = fullProject("SAMPLEZ1", 0);
  sample.files.find((f) => f.ext === "GAM")!.data.fill(0x5a);
  sample.files.find((f) => f.ext === "CGR")!.data.fill(0);
  sample.files.find((f) => f.ext === "0GR")!.data.fill(0).fill(
    1,
    0,
    N64_TEXTURE_BYTES,
  );
  const donor =
    buildDisk({ projects: [sample, fullProject("SAMP", 0)], format: "ddd" })
      .image;
  const onto = exportLevelToDdd(tinyLevel(), tinyArt(), {
    disk: donor,
    format: "ddd",
    name: "mine",
  });
  assertEquals(onto.format, "ddd");
  assertEquals(onto.name, "MINE");
  assertEquals(onto.report.templateProject, "SAMPLEZ1");
  const projects = readProjects(onto.image);
  assertEquals(projects.map((p) => p.name), ["SAMPLEZ1", "SAMP", "MINE"]);
  const mine = projects[2];
  const gam = Uint8Array.from(
    decompress(mine.files.find((f) => f.ext === "GAM")!.stream),
  );
  assertEquals(
    gam[0],
    0,
    "the template's GAM under the new name, its final stage set",
  );
  assert(gam.subarray(1).every((b) => b === 0x5a));
  const gr0 = Uint8Array.from(
    decompress(mine.files.find((f) => f.ext === "0GR")!.stream),
  );
  assert(
    gr0.subarray(0, N64_TEXTURE_BYTES).every((b) => b === 1),
    "the template's painted texture 0 survives",
  );
  assertEquals(onto.project.stages[0].textures[0].index, 1);
  assertEquals(templateFromDisk(donor, "samp")?.name, "SAMP");
  assertEquals(templateFromDisk(donor, "nope"), null);
  assertThrows(
    () =>
      exportLevelToDdd(tinyLevel(), tinyArt(), {
        disk: donor,
        template: "NOPE",
      }),
    Error,
    "no project named NOPE",
  );
  assertThrows(
    () => exportLevelToDdd(tinyLevel(), tinyArt(), { template: "disk" }),
    Error,
    "donor",
  );
  assertThrows(
    () => exportLevelToDdd(tinyLevel(), tinyArt(), { disk: new Uint8Array(4) }),
    Error,
    "neither",
  );
  assertEquals(dddFileName("a/b:c"), "Dezaemon 3D - a-b-c.ndd");
});

// ── The real disk, when this checkout has one ────────────────────────────────

const REPO_ROOT = new URL("../", import.meta.url);
const FIXTURE = "dezaemon298.ddd";

async function fixture(p: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(`dev-fixtures/${p}`, REPO_ROOT));
  } catch {
    return null;
  }
}

const haveDisk = await fixture(FIXTURE).then((b) => b !== null);

Deno.test({
  name:
    "the prototype disk rebuilt from its own projects is the same bytes, and a put-then-remove returns to them",
  ignore: !haveDisk,
  async fn() {
    const disk = (await fixture(FIXTURE))!;
    const again = buildDisk({ base: disk });
    assertEquals(
      again.report.projects.map((
        p: { name: string; kept: boolean },
      ) => [p.name, p.kept]),
      [["SAMPLEZ1", true], ["SAMP", true]],
    );
    assert(
      same(again.image, disk),
      "re-laying the two samples from LBA 9 reproduces the disk byte for byte",
    );
    const extra = putProject(disk, fullProject("SHMUPX"));
    assertEquals(readProjects(extra.image).map((p) => p.name), [
      "SAMPLEZ1",
      "SAMP",
      "SHMUPX",
    ]);
    assert(
      same(
        extra.image.subarray(ramStartOffset(0)!),
        disk.subarray(ramStartOffset(0)!),
      ),
      "the save area is untouched",
    );
    const gone = removeProject(extra.image, "SHMUPX");
    assert(same(gone.image, disk));
    // the template path decompresses SAMPLEZ1 to the documented sizes (bar its GAM)
    const t = templateFromDisk(disk)!;
    assertEquals(t.name, "SAMPLEZ1");
    assertEquals(t.files.length, 30);
    assertEquals(
      t.files.find((f) => f.ext === "0GR")!.data.length,
      DOCUMENTED_SIZES.GR,
    );
  },
});
