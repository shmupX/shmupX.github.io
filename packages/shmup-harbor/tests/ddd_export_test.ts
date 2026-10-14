// End to end: `deno task build:ddd` on the level named "foo" — the base game
// the repo ships as static/games/2028-ai/foo.json, the same record the
// editor would save to levels/foo — writes a 64DD disk image, and that image
// reads back through the n64 reader the way the prototype disk does.
//
// In-process rather than as a subprocess like sav_export_test.ts: buildDdd()
// is the function the task runs, and a subprocess here would only add a
// deno start-up to a build that already writes a 64 MB file per run. The
// task's own argv loop is a dozen lines over the same call.
//
// The build is --no-disk, because the prototype disk is community content
// that is never in the repo: a disk built from nothing has the boot
// program's notice, the project's thirty files from LBA 9, the directory
// three times over, a built system area, and an empty RAM area. What is
// checked is what an emulator and this repo's reader each look at: the
// system area the way mupen64plus-core validates it, the ATNFS directory and
// its three invariants, every file decompressing to its documented size, and
// the stage-0 texture sheet holding a frame for every enemy letter foo's grid
// names. Nothing here claims the disk boots — no cartridge, emulator or disk
// fixture exists to try it on.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import {
  DDD_IMAGE_BYTES,
  DEZAEMON_INITIAL_CODE,
  DIRECTORY_COPY_LBAS,
  extractFile,
  FIRST_FILE_LBA,
  NDD_IMAGE_BYTES,
  parseDddImage,
  PROJECT_FILE_COUNT,
  readDirectory,
  readSystemArea,
  romEndLba,
  SYSTEM_AREA_BYTES,
  userArea,
} from "@shmupx/shmup-engine/n64";
import { buildDdd } from "../scripts/build-ddd.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const FOO = join(ROOT, "static", "games", "2028-ai", "foo.json");

// The base game is what the export reads; a checkout without it has nothing
// to build, so the tests skip rather than fail.
const haveFoo = await Deno.stat(FOO).then((s) => s.isFile, () => false);
const gated = { ignore: !haveFoo };

interface Foo {
  name: string;
  enemylist: string[][];
  enemyData: Record<string, { texture: string[] }>;
}

/** The enemy letters foo's grid places, in the order they first appear. */
function enemyLetters(foo: Foo): string[] {
  const letters: string[] = [];
  for (const row of foo.enemylist) {
    for (const cell of row) {
      const m = /^([A-Za-z]+)(\d)$/.exec(cell);
      if (!m || cell === "00") continue;
      const letter = m[1].toUpperCase();
      if (!letters.includes(letter)) letters.push(letter);
    }
  }
  return letters;
}

interface StageReport {
  key: string;
  ext: string;
  textures: { key: string }[];
}

Deno.test({
  name:
    "buildDdd turns foo into an .ndd whose system area and directory both read back",
  ...gated,
  async fn() {
    const foo: Foo = JSON.parse(await Deno.readTextFile(FOO));
    const dir = await Deno.makeTempDir({ prefix: "shmupx-ddd-" });
    try {
      const out = join(dir, "foo.ndd");
      const lines: string[] = [];
      const result = await buildDdd({
        noDisk: true,
        out,
        log: (m) => lines.push(m),
      });
      const log = lines.join("\n");
      assert(
        log.includes("foo.json"),
        "the default level is the bundled foo.json",
      );
      assertStrictEquals(result.name, "FOO");
      assertStrictEquals(result.format, "ndd");
      assertStrictEquals(result.fileName, "Dezaemon 3D - foo.ndd");
      assertStrictEquals(result.donor, null);
      assertStrictEquals(result.template, null);
      assertStrictEquals(result.bytes, NDD_IMAGE_BYTES);
      assert(log.includes("untested on hardware or in an emulator"));

      const image = await Deno.readFile(out);
      assertStrictEquals(image.length, NDD_IMAGE_BYTES);
      assertStrictEquals(image.length, 64931840, "the whole-disk .ndd size");

      // The system area, the way an emulator reads it: the system data in
      // LBA 0 (retail format), the disk ID in LBA 14, and nothing to refuse.
      const sys = readSystemArea(image);
      assertEquals(sys.errors, []);
      assertStrictEquals(sys.systemLba, 0);
      assertStrictEquals(sys.development, false);
      assertStrictEquals(sys.diskIdLba, 14);
      assert(sys.systemData && sys.diskId);
      assertStrictEquals(sys.systemData.diskType, 0);
      assertStrictEquals(sys.systemData.retail, true);
      assertStrictEquals(sys.systemData.romEndLba, romEndLba());
      assertStrictEquals(sys.diskId.initialCode, DEZAEMON_INITIAL_CODE);
      assertStrictEquals(sys.diskId.initialCode, "DEZA");
      assertStrictEquals(sys.diskId.freeArea, "ATNFS0");

      // The user area, the way this repo's reader takes it.
      const user = userArea(image);
      assertStrictEquals(user.length, DDD_IMAGE_BYTES);
      assertStrictEquals(user.byteOffset, SYSTEM_AREA_BYTES);
      const parsed = parseDddImage(user);
      assertEquals(parsed.errors, []);
      assertStrictEquals(parsed.sizeOk, true);
      assertStrictEquals(parsed.recognised, true, "the DEZA64 notice is there");
      assert(parsed.directory && parsed.invariants);
      assertStrictEquals(parsed.directory.length, PROJECT_FILE_COUNT);
      assertStrictEquals(parsed.directory.length, 30);
      for (const e of parsed.directory) assertStrictEquals(e.name, "FOO");
      assertStrictEquals(parsed.directory[0].startLba, FIRST_FILE_LBA);
      assertStrictEquals(parsed.invariants.contiguous, true);
      assertStrictEquals(parsed.invariants.blocksFit, true);
      assertStrictEquals(parsed.invariants.withinCapacity, true);
      // the thirty, in directory order: six globals, then BL MD GR a stage
      assertEquals(
        parsed.directory.slice(0, 9).map((e) => e.ext),
        ["GAM", "CGR", "CMD", "CBL", "ULB", "MUS", "0BL", "0MD", "0GR"],
      );
      // every file — the sheets the art painted and the blanks alike —
      // decompresses to the size the format documentation predicts
      for (const e of parsed.directory) {
        const file = extractFile(user, e);
        assert(
          file.sizeOk,
          `${e.name}.${e.ext} came back ${file.data.length}, not ${file.expected}`,
        );
      }
      // the three directory copies, 834 bytes into LBA 1417, 1419 and 1422
      assertEquals([...DIRECTORY_COPY_LBAS], [1417, 1419, 1422]);
      const last = parsed.directory[parsed.directory.length - 1];
      assert(
        last.startLba + last.blockCount <= DIRECTORY_COPY_LBAS[0] - 1,
        "the files stop short of the directory's block",
      );

      // The stage-0 sheet holds a frame for every enemy letter foo's grid uses.
      const letters = enemyLetters(foo);
      assert(letters.length >= 2, "foo places more than one enemy");
      const stages =
        (result.report as { project: { stages: StageReport[] } }).project
          .stages;
      assertStrictEquals(stages.length, 1, "foo is a one-stage level");
      assertStrictEquals(stages[0].ext, "0GR");
      const keys = stages[0].textures.map((t) => t.key);
      for (const letter of letters) {
        assert(foo.enemyData[`enemy${letter}`], `foo names enemy${letter}`);
        assert(
          keys.some((k) => k.startsWith(`enemy${letter}:`)),
          `enemy${letter} has a texture in 0GR: ${keys.join(", ")}`,
        );
      }
      // and the CGR sheet has a ship (foo names no playerData, so the stock one)
      const common = (result.report as {
        project: { common: { textures: { key: string }[] } };
      }).project.common;
      assert(
        common.textures.some((t) => t.key.startsWith("ship:")),
        "the ship is in CGR",
      );
      assertEquals(result.warnings, [], "foo builds without a warning");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "--ddd writes the user area alone, with the same directory as the .ndd",
  ...gated,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "shmupx-ddd-" });
    try {
      const ndd = await buildDdd({ noDisk: true, out: join(dir, "foo.ndd") });
      const ddd = await buildDdd({
        noDisk: true,
        format: "ddd",
        out: join(dir, "foo.ddd"),
      });
      assertStrictEquals(ddd.format, "ddd");
      assertStrictEquals(ddd.fileName, "Dezaemon 3D - foo.ddd");
      assertStrictEquals(ddd.bytes, DDD_IMAGE_BYTES);
      assertStrictEquals(ddd.bytes, 64458560, "the system-area-less .ddd size");
      const a = await Deno.readFile(ddd.outPath);
      const b = userArea(await Deno.readFile(ndd.outPath));
      assertStrictEquals(a.length, DDD_IMAGE_BYTES);
      assertEquals(readDirectory(a), readDirectory(b));
      // the same bytes, not only the same directory: the user area does not
      // depend on the format, only the system area in front of it does
      assertStrictEquals(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          throw new Error(
            `the .ddd and the .ndd's user area differ at 0x${i.toString(16)}`,
          );
        }
      }
      assertStrictEquals(
        readSystemArea(a).systemData,
        null,
        "a .ddd has no system area",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
