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
// names, and stage 0 opening on foo's story as portrait effects. Nothing here
// boots the disk: the cartridge, the IPL and the donor are not in the repo
// (FORMAT-N64.md "A level's story" is what a boot of a donor-built disk
// showed).

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import {
  DDD_IMAGE_BYTES,
  DEZAEMON_INITIAL_CODE,
  DIRECTORY_COPY_LBAS,
  EFFECT_COMMANDS,
  extractFile,
  FIRST_FILE_LBA,
  N64_GR_TEXTURE_BASE,
  N64_PORTRAIT_CLEAR,
  N64_PORTRAIT_MAX_TEXTURE,
  N64_SCROLL_RATE,
  N64_STAGE_SCENE,
  NDD_IMAGE_BYTES,
  parseDddImage,
  parseStageBl,
  PROJECT_FILE_COUNT,
  readDirectory,
  readSystemArea,
  romEndLba,
  SYSTEM_AREA_BYTES,
  userArea,
} from "@shmupx/shmup-engine/n64";
import {
  buildDdd,
  DDD_TITLES,
  dddTitleWords,
  titleLogLine,
} from "../scripts/build-ddd.ts";
import { type ArtFrame, inEditorAtlasOrder } from "../scripts/build-sav.ts";
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
  story: { size: string; frames: number; seconds: number } | null;
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
      assert(log.includes("untested on hardware"));
      // foo's logo goes where the cartridge's GAM points both title
      // pictures: stage 0's band 9, 2x2 textures
      assert(
        log.includes(
          "title: the level's logo, at y 928 (0GR textures 18, 19, 20, 21)\n",
        ),
        log,
      );

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
      // and the base game's item icons, which no record names: the editor's
      // art is the whole base atlas, so the CLI asks it for the same frames
      // and orders them as the editor does — the base's ahead of foo's own
      // .png copies — and the two disks wear the same icons in the same order.
      assertEquals(
        common.textures.filter((t) => t.key.startsWith("item:")).map((t) =>
          t.key
        ),
        [
          "item:barrierItem0.gif",
          "item:barrierItem1.gif",
          "item:powerup3way0.gif",
          "item:powerup3way1.gif",
          "item:powerupBig0.gif",
          "item:powerupBig1.gif",
          "item:speedupItem0.gif",
          "item:speedupItem1.gif",
        ],
      );

      // foo's stage 0 opens on its story: forty portraits over the screen at
      // frame 0, every one naming a #GR texture a byte holds, the ship hidden
      // and the map's scroll held until one effect clears them all.
      const story = stages[0].story;
      assert(story, "stage 0 carries foo's story");
      assert(
        log.includes(`story: opens stage0 ${story.size} (${story.seconds} s)`),
        log,
      );
      const bl = parseStageBl(
        extractFile(user, parsed.directory.find((e) => e.ext === "0BL")!).data,
      );
      const set = bl.effects.filter((e) =>
        EFFECT_COMMANDS[e.command] === "portrait" && e.values[0] === 0
      );
      assertStrictEquals(set.length, 40);
      assert(set.every((e) => e.frame === 0));
      assert(
        set.every((e) =>
          e.values[1] >= N64_GR_TEXTURE_BASE &&
          e.values[1] <= N64_PORTRAIT_MAX_TEXTURE
        ),
      );
      const clear = bl.effects.filter((e) =>
        EFFECT_COMMANDS[e.command] === "portrait" && e.values[0] === 0xff
      );
      assertEquals(clear.map((e) => [e.frame, ...e.values]), [[
        story.frames,
        ...N64_PORTRAIT_CLEAR,
      ]]);
      assertEquals(
        bl.effects.filter((e) => EFFECT_COMMANDS[e.command] !== "portrait")
          .map((e) => [e.frame, EFFECT_COMMANDS[e.command], e.values[0]]),
        [
          // the opening scene every stage gets, so its sprites draw
          ...N64_STAGE_SCENE.map((e) => [e.frame, e.command, e.values[0]]),
          [0, "playerVisibility", 0],
          [0, "mapScrollRate", 0],
          [story.frames, "playerVisibility", 1],
          [story.frames, "mapScrollRate", N64_SCROLL_RATE],
        ],
      );
      assertStrictEquals(bl.tail.totalEffects, bl.effects.length);
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

Deno.test("a level's 64DD title words come from static/n64dd/titles.json, the file the editor fetches", async () => {
  assertStrictEquals(
    DDD_TITLES,
    join(ROOT, "static", "n64dd", "titles.json"),
  );
  assertStrictEquals(await dddTitleWords("gs"), "SQUAD GAME");
  assertStrictEquals(await dddTitleWords("foo"), null, "foo is not listed");
  assertStrictEquals(
    await dddTitleWords("gs", join(ROOT, "no-such-titles.json")),
    null,
    "no file, no words",
  );
  const picture = (source: string, y: number, textures: number[]) => ({
    source,
    sheet: "0GR",
    y,
    textures,
  });
  assertStrictEquals(
    titleLogLine(
      {
        words: "SQUAD GAME",
        title1: picture("words", 928, [18, 19, 20, 21]),
        title2: picture("cleared", 992, [22, 23, 24, 25]),
      } as Parameters<typeof titleLogLine>[0],
    ),
    'title: "SQUAD GAME" in the story\'s face, at y 928 (0GR textures 18, 19, 20, 21); title 2 cleared',
  );
  assertStrictEquals(
    titleLogLine({ words: null, title1: null, title2: null }),
    "title: the template's own pictures (no logo, and no words to draw)",
  );
});

Deno.test("the CLI orders a level's art as the editor's atlas holds it", () => {
  const frame = (h: number): ArtFrame => ({
    w: 1,
    h,
    rgba: new Uint8Array(h * 4),
  });
  // loadLevelArt's order: the level's own frames, then the base's it named
  const art = {
    "myItem.png": frame(16),
    "speedupItem0.gif": frame(16), // the level's replacement of a base frame
    "boss.png": frame(64),
    "barrierItem0.gif": frame(16),
  };
  const base = ["barrierItem0.gif", "duke_0", "speedupItem0.gif"];
  // The editor's: the base's in its order, the replacement in its place,
  // then the level's new frames, tallest first and otherwise as they came.
  assertEquals(Object.keys(inEditorAtlasOrder(art, base)), [
    "boss.png",
    "barrierItem0.gif",
    "speedupItem0.gif",
    "myItem.png",
  ]);
});
