// End to end: `deno task build:sav` on the level named "foo" — the base game
// the repo ships as static/games/2028-ai/foo.json, the same record the
// editor would save to levels/foo — writes foo.sav, and that file reads back
// through the import pipeline every community cart goes through.
//
// The task is run as a real subprocess (the command a user types), then the
// output is checked the way MiSTer's Saturn core would see it: a 1,114,112-
// byte 0xFF-interleaved BackUpRam image holding one DEZA2____01 game whose
// eight sections decompress to their fixed sizes and decode to the stages,
// enemies and art foo.json describes. A second build in-process exercises the
// Super Famicom palette target and the CGRAM sidecar.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { decodeDataUrl } from "../lib/ps2/png.ts";
import { cut } from "../lib/ps2/raster.ts";
import * as deza from "../packages/shmup-engine/mod.js";
import { SEC5_REGIONS } from "../packages/shmup-engine/src/decode/decode-stage.js";
import { buildSav } from "../scripts/build-sav.ts";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const FOO = join(ROOT, "static", "games", "2028-ai", "foo.json");

// deno-lint-ignore no-explicit-any
const engine = deza as any;

interface Foo {
  name: string;
  width: number;
  enemylist: string[][];
  enemyData: Record<string, { texture: string[] }>;
  atlasImageDataURL: string;
  atlasFrames: Record<
    string,
    { frame: { x: number; y: number; w: number; h: number } }
  >;
}

const foo: Foo = JSON.parse(await Deno.readTextFile(FOO));
const lettersUsed = new Set<string>();
let placedCells = 0;
for (const row of foo.enemylist) {
  for (const cell of row) {
    if (cell === "00") continue;
    placedCells++;
    lettersUsed.add(cell.slice(0, -1));
  }
}

async function importSav(bytes: Uint8Array) {
  const norm = await engine.normalize(bytes);
  const saves = engine.parse(norm.data);
  const games = saves.filter((s: { filename: string }) => engine.isGameSave(s));
  return {
    norm,
    saves,
    games,
    decoded: engine.decodeSave(games[0].payload.buffer),
  };
}

Deno.test("deno task build:sav turns foo into foo.sav, a cart MiSTer can read", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-sav-" });
  try {
    const out = join(dir, "foo.sav");
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "scripts/build-sav.ts", "--out", out],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    });
    const run = await cmd.output();
    const stdout = new TextDecoder().decode(run.stdout);
    const stderr = new TextDecoder().decode(run.stderr);
    assertStrictEquals(run.code, 0, `build:sav failed:\n${stdout}\n${stderr}`);
    assert(
      stdout.includes("foo.json"),
      "the default level is the bundled foo.json",
    );

    const bytes = await Deno.readFile(out);
    assertStrictEquals(bytes.length, engine.MISTER_SAV_SIZE);
    assertStrictEquals(bytes.length, 1114112, "the community .sav size");
    // hardware/MiSTer interleave: every even byte is the unused 0xFF half
    for (let i = 0; i < bytes.length; i += 2) {
      if (bytes[i] !== 0xff) {
        throw new Error(`even byte ${i} is 0x${bytes[i].toString(16)}`);
      }
    }

    const { norm, saves, games, decoded } = await importSav(bytes);
    assertStrictEquals(norm.kind, "interleaved");
    assertEquals(engine.detectPartitions(norm.data), [
      { base: 0, size: 0x8000, blockSize: 64 },
      { base: 0x8000, size: 0x80000, blockSize: 512 },
    ]);
    assertStrictEquals(saves.length, 1);
    assertStrictEquals(games.length, 1);
    assertStrictEquals(games[0].filename, "DEZA2____01");
    assertStrictEquals(games[0].comment, "foo");
    assertStrictEquals(games[0].payloadError, null);
    // the header block is block 2 of the cart partition, as in every dump
    assertStrictEquals(games[0].offset, 0x8000 + 2 * 512);

    // eight sections, each to its fixed region size
    assertStrictEquals(decoded.tableError, null);
    assert(
      decoded.sections.every((s: { sizeMatchesKnown: boolean }) =>
        s.sizeMatchesKnown
      ),
    );
    assertStrictEquals(decoded.confidence.decompression, "confirmed");
    assertStrictEquals(decoded.cgError, null);
    assertStrictEquals(decoded.backgroundError, null);

    // the palette bank: the 12 system rows every save carries, word 0 = 0x8000
    const sec4 = decoded.sections[4].decompressed as Uint8Array;
    assertEquals([...sec4.subarray(0, 2)], [0x80, 0x00]);
    for (let i = 1; i < 192; i++) {
      assertStrictEquals(
        (sec4[i * 2] << 8) | sec4[i * 2 + 1],
        engine.DEZA2_PALETTE_WORDS[i],
        `system colour ${i}`,
      );
    }

    // one stage, the letters foo's grid names, one placement per cell
    assertStrictEquals(decoded.stageCount, 1);
    assertStrictEquals(decoded.enemies.length, lettersUsed.size);
    const placements = decoded.enemies.reduce(
      (n: number, e: { placements: number }) => n + e.placements,
      0,
    );
    assertStrictEquals(placements, placedCells);
    for (const e of decoded.enemies) {
      assertStrictEquals(
        e.spriteKeys.length,
        4,
        `${e.name} has its four frames`,
      );
      assert(e.behavior, `${e.name} decodes a record`);
    }
    // the boss, with its core painted, after the last wave
    assertStrictEquals(decoded.bosses.length, 1);
    assert(decoded.bosses[0].coreArt);
    const lastWave = Math.max(...decoded.stages[0].waveRows);
    assert(
      decoded.bosses[0].row > lastWave,
      "the boss waits past the last wave",
    );
    // ship, item icons, both blast anims and the bullet types are in the global bank
    assert(
      decoded.globalArt.player && decoded.globalArt.player.idle.length === 2,
    );
    assertStrictEquals(
      decoded.globalArt.items.filter((i: number | null) => i !== null).length,
      8,
    );
    assertStrictEquals(decoded.globalArt.blastA.length, 6);
    assertStrictEquals(decoded.globalArt.blastB.length, 6);
    assert(decoded.globalArt.bullets.some(Boolean));
    // the player's weapon art (bank refs 48-93) is painted — left empty, the
    // Saturn fires invisible shots — and both drawn title logos are there:
    // foo's logo is a GIF, its subtitle a PNG
    const sec5 = decoded.sections[5].decompressed as Uint8Array;
    const bank = SEC5_REGIONS.spriteBank.offset;
    for (let ref = 48; ref <= 93; ref++) {
      const word = (sec5[bank + ref * 2] << 8) | sec5[bank + ref * 2 + 1];
      assert(word !== 0xffff, `weapon ref ${ref} is painted`);
    }
    assert(decoded.titleArt, "the title screen is drawn");
    assert(decoded.titleArt.title1 !== undefined, "TITLE 1 holds the logo");
    assert(decoded.titleArt.title2 !== undefined, "TITLE 2 holds the subtitle");
    assert(
      decoded.titleLayout.title1.y + decoded.titleLayout.title1.h <=
        decoded.titleLayout.title2.y,
      "the logo sits above the subtitle",
    );
    // settings: vertical 1P, the stage is the final one, extents cover the boss
    assertStrictEquals(decoded.settings.gameMode, 0);
    assert(decoded.settings.stageFlags[0].finalStage);
    assert(
      decoded.settings.stageExtents[0].endPart * 16 > decoded.bosses[0].row,
    );

    // and the save maps back to a valid game.json with foo's wave structure
    const { gameJson, warnings } = engine.mapSaveToGame(decoded);
    assertEquals(warnings, []);
    const v = engine.validateGameJson(gameJson);
    assert(v.ok, v.errors.join("; "));
    const fooWaves = foo.enemylist.filter((row) => row.some((c) => c !== "00"));
    const backWaves = gameJson.stage0.enemylist as string[][];
    assertStrictEquals(
      backWaves.length,
      fooWaves.length,
      "every non-empty wave survives",
    );
    assertEquals(
      backWaves.map((row) => row.filter((c) => c !== "00").length),
      fooWaves.map((row) => row.filter((c) => c !== "00").length),
      "each wave keeps its enemy count, in order",
    );
    assertStrictEquals(
      Object.keys(gameJson.enemyData).length,
      lettersUsed.size,
    );

    // colour fidelity: enemy A's first frame comes back within 15-bit rounding
    // of the atlas pixels it was cut from, placed where the writer centred it
    const sheet = await decodeDataUrl(foo.atlasImageDataURL);
    const texA = foo.enemyData.enemyA.texture[0];
    const rect = foo.atlasFrames[texA.replace(/\./g, "․")].frame;
    const src = cut(sheet, rect);
    const enemyA = decoded.enemies.find((e: { name: string; record: number }) =>
      e.record === 32
    );
    assert(enemyA, "redEyeOcto lands in the 32x32 band as record 32");
    const sprite = decoded.sprites[enemyA.spriteKeys[0]];
    assertStrictEquals(sprite.w, 32);
    assertStrictEquals(sprite.h, 32);
    const fitted = engine.fitRgba(
      { w: src.width, h: src.height, rgba: src.data },
      32,
      32,
    );
    let error = 0, opaque = 0, mismatchedAlpha = 0;
    for (let i = 0; i < 32 * 32; i++) {
      const a = fitted.rgba[i * 4 + 3] >= 128;
      const b = sprite.rgba[i * 4 + 3] === 255;
      if (a !== b) mismatchedAlpha++;
      if (!a || !b) continue;
      opaque++;
      for (let c = 0; c < 3; c++) {
        error += Math.abs(fitted.rgba[i * 4 + c] - sprite.rgba[i * 4 + c]);
      }
    }
    assert(opaque > 100, "the frame has pixels");
    assertStrictEquals(mismatchedAlpha, 0, "transparency is preserved exactly");
    const mean = error / (opaque * 3);
    assert(
      mean < 16,
      `mean channel error ${mean.toFixed(1)} exceeds the palette's reach`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the Super Famicom palette target: one 15-colour row per sprite, plus a CGRAM file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "shmupx-sav-snes-" });
  try {
    const out = join(dir, "foo.sav");
    const pal = join(dir, "foo.pal");
    const result = await buildSav({ palette: "snes", out, snesPal: pal });
    assertStrictEquals(result.fileName, "Dez 2 - foo.sav");
    assertStrictEquals(result.bytes, 1114112);
    const report = result.report as {
      palette: { target: string; rows: { row: number; colors: number }[] };
    };
    assertStrictEquals(report.palette.target, "snes");
    assert(report.palette.rows.length >= 1 && report.palette.rows.length <= 4);
    for (const row of report.palette.rows) assert(row.colors <= 15);

    const { decoded } = await importSav(await Deno.readFile(out));
    const pages = decoded.sections.slice(0, 4).map((
      s: { decompressed: Uint8Array },
    ) => s.decompressed);
    const sec5 = decoded.sections[5].decompressed as Uint8Array;
    const bank = SEC5_REGIONS.spriteStages.offset;
    // every painted zako ref in stage 0's bank draws from exactly one user row
    for (let i = 0; i < 0x500 / 2; i++) {
      const ref = (sec5[bank + i * 2] << 8) | sec5[bank + i * 2 + 1];
      if (ref === 0xffff) continue;
      const cell = pages[(ref >> 8) & 3].subarray(
        (ref & 0xff) * 256,
        (ref & 0xff) * 256 + 256,
      );
      const rows = new Set(
        [...cell].filter(Boolean).map((v: number) => v >> 4),
      );
      assert(rows.size <= 1, `ref ${i} mixes rows ${[...rows]}`);
      for (const r of rows) {
        assert(r >= 12 && r <= 15, `ref ${i} uses system row ${r}`);
      }
    }
    // the bank: entry 0 of each used row is the transparent slot
    const sec4 = decoded.sections[4].decompressed as Uint8Array;
    for (const row of report.palette.rows) {
      assertStrictEquals((sec4[row.row * 32] << 8) | sec4[row.row * 32 + 1], 0);
    }
    // the sidecar: 512 bytes of little-endian words, white at entry 64
    const cgram = await Deno.readFile(pal);
    assertStrictEquals(cgram.length, 512);
    assertEquals([...cgram.subarray(128, 130)], [0xff, 0x7f]);
    // still a valid game
    const { gameJson } = engine.mapSaveToGame(decoded);
    assert(engine.validateGameJson(gameJson).ok);
    assertStrictEquals(decoded.enemies.length, lettersUsed.size);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
