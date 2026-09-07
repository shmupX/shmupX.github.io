// A level record -> the eight sections -> back through decodeSave(): the
// assembler is checked by the decoders that read real saves.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeEnemyRecord,
  HP_TABLE,
  SCORE_TABLE,
} from "../src/decode/decode-enemy.js";
import { decodeBossTrailer } from "../src/decode/decode-boss.js";
import { decodeSettings } from "../src/decode/decode-settings.js";
import { SEC5_REGIONS } from "../src/decode/decode-stage.js";
import { SECTION_SIZES } from "../src/decompress.js";
import { mapSaveToGame } from "../src/map-to-game.js";
import { validateGameJson } from "../src/game-schema.js";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { isGameSave } from "../src/payload-table.js";
import {
  bandFor,
  bossClassFor,
  buildSaveFromGame,
  emptySong,
  encodeBossTrailer,
  encodeEnemyRecord,
  encodeSettings,
  fitRgba,
  levelStages,
  mapColumn,
  placeRgba,
  rotateCcwRgba,
  spreadFrames,
} from "../src/write/game-to-save.js";
import {
  GLOBAL_WEAPON_SLOTS,
  renderFrame,
  TITLE_SLOTS,
} from "../src/decode/decode-sprites.js";
import { exportLevelToSav, savFileName } from "../src/write/export-sav.js";
// decodeSave wants a payload; the writer's own table builder makes one.
import { buildPayload } from "../src/bup-write.js";

function frame(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  // a transparent corner so frames are not solid blocks
  rgba[3] = 0;
  return { w, h, rgba };
}

function level() {
  return {
    name: "tiny",
    width: 8,
    enemylist: [
      ["00", "00", "B0", "00", "00", "B0", "00", "00"], // spawns last
      ["A1", "00", "00", "A0", "00", "00", "00", "A1"],
      ["00", "A0", "00", "00", "00", "00", "A0", "00"], // spawns first
    ],
    enemyData: {
      enemyA: {
        name: "dot",
        hp: 3,
        score: 200,
        speed: 1,
        interval: 60,
        texture: ["dot0.png", "dot1.png"],
        projectileData: { texture: ["shot0.png"], speed: 2 },
      },
      enemyB: {
        name: "slab",
        hp: 20,
        score: 1000,
        speed: 2,
        interval: -1,
        texture: ["slab0.png"],
      },
    },
    bossData: {
      boss0: {
        name: "big",
        hp: 300,
        score: 6000,
        texture: ["boss0.png", "boss1.png"],
      },
    },
  };
}

function art() {
  return {
    "dot0.png": frame(12, 14, [255, 0, 0]),
    "dot1.png": frame(12, 14, [200, 0, 0]),
    "slab0.png": frame(40, 30, [0, 0, 255]),
    "shot0.png": frame(6, 6, [255, 255, 0]),
    "boss0.png": frame(70, 70, [0, 255, 0]),
    "boss1.png": frame(70, 70, [0, 200, 0]),
  };
}

Deno.test("geometry helpers", () => {
  assertStrictEquals(bandFor(12, 14), 0);
  assertStrictEquals(bandFor(32, 16), 1);
  assertStrictEquals(bandFor(16, 32), 2);
  assertStrictEquals(bandFor(40, 30), 4);
  assertStrictEquals(bandFor(200, 200), 6);
  assertStrictEquals(bossClassFor(64, 64), 0);
  assertStrictEquals(bossClassFor(100, 40), 1);
  assertStrictEquals(bossClassFor(40, 100), 2);
  assertStrictEquals(bossClassFor(70, 70), 3);
  // 8 columns spread over the 14-column playfield, injectively
  const cols8 = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => mapColumn(c, 8));
  assertEquals(cols8, [3, 5, 7, 9, 10, 12, 14, 16]);
  assertEquals([0, 13].map((c) => mapColumn(c, 14)), [3, 16]);
  assertEquals([0, 19].map((c) => mapColumn(c, 20)), [0, 19]);
  assertEquals(spreadFrames(["a", "b", "c", "d", "e", "f"], 4), [
    "a",
    "b",
    "d",
    "e",
  ]);
  assertEquals(spreadFrames(["a"], 4), ["a", "a", "a", "a"]);
  const fit = fitRgba(frame(70, 70, [1, 2, 3]), 64, 64);
  assertStrictEquals(fit.w, 64);
  assert(fit.scaled);
  const same = fitRgba(frame(10, 10, [1, 2, 3]), 16, 16);
  assert(!same.scaled);
  // pixel (0,0) of the source is its transparent corner; (1,0) lands at (4,3)
  assertStrictEquals(
    same.rgba[((3 * 16) + 3) * 4 + 3],
    0,
    "the transparent corner stays transparent",
  );
  assertStrictEquals(
    same.rgba[((3 * 16) + 4) * 4 + 3],
    255,
    "centred with a 3px margin",
  );
  assertStrictEquals(
    same.rgba[((2 * 16) + 4) * 4 + 3],
    0,
    "nothing above the margin",
  );
});

Deno.test("levelStages reads the flat record, the stages map, and stageN keys", () => {
  assertEquals(levelStages(level()).map((s) => s.key), ["stage0"]);
  const multi = {
    stages: {
      stage2: { enemylist: [["00"]] },
      stage0: { enemylist: [["A0"]] },
    },
  };
  assertEquals(levelStages(multi).map((s) => s.key), ["stage0", "stage2"]);
  const gameJson = {
    stage0: { enemylist: [["A0"]] },
    stage1: { enemylist: [["B0"]] },
  };
  assertEquals(levelStages(gameJson).map((s) => s.key), ["stage0", "stage1"]);
});

Deno.test("encodeEnemyRecord round-trips through decodeEnemyRecord", () => {
  const bytes = encodeEnemyRecord({
    appearance: 0x23,
    animIndex: 2,
    scoreIndex: 4,
    hpIndex: 5,
    deathMode: 1,
    deathParam: 3,
    bulletType: 2,
    fireRateIndex: 6,
    fireGeometry: 1,
    aimed: true,
  });
  const d = decodeEnemyRecord(bytes);
  assertStrictEquals(d.appearance, 0x23);
  assertStrictEquals(d.animPeriod, 15);
  assertStrictEquals(d.score, SCORE_TABLE[4]);
  assertStrictEquals(d.hp, HP_TABLE[5]);
  assertStrictEquals(d.death.mode, 1);
  assertStrictEquals(d.death.item, 4);
  assertStrictEquals(d.fire.mode, 2);
  assertStrictEquals(d.fire.interval, 3);
  assertStrictEquals(d.fire.geometry, 1);
  assert(d.fire.aimed);
  assert(!d.death.silent);
  assert(!(d.move.mode & 1));
  const armoured = decodeEnemyRecord(encodeEnemyRecord({ armour: true }));
  assertStrictEquals(armoured.move.mode & 1, 1);
});

Deno.test("encodeBossTrailer round-trips through decodeBossTrailer", () => {
  const t = encodeBossTrailer({
    sizeClass: 2,
    hpStages: 3,
    hp: 4608000,
    score: 20000,
    optionFlag: true,
    playlist: [[0, 0, 1, 1], [2, 2, 3, 3], [1, 2, 3, 0], [3, 3, 3, 3]],
    arrive: 0x5a,
    death: 0x14,
  });
  const d = decodeBossTrailer(t);
  assertStrictEquals(d.sizeClass, 2);
  assertStrictEquals(d.hpStages, 3);
  assertStrictEquals(d.hp, 4608000);
  assertStrictEquals(d.score, 20000);
  assert(d.optionFlag);
  assertEquals(d.playlist, [[0, 0, 1, 1], [2, 2, 3, 3], [1, 2, 3, 0], [
    3,
    3,
    3,
    3,
  ]]);
  assertStrictEquals(d.arrive, 0x5a);
  assertStrictEquals(d.death, 0x14);
  assertStrictEquals(d.patterns.length, 4);
  assertStrictEquals(d.patterns[0].moveScript, 1);
  assertStrictEquals(d.patterns[0].firePoints[0].dy, 24);
  assertStrictEquals(d.patterns[0].firePoints[0].shot.aimed, true);
  // and an encode of the decode is byte-identical
  assertEquals(
    encodeBossTrailer({
      ...d,
      hpIndex: undefined,
      patterns: d.patterns.map((p) => ({ ...p, firePoints: p.firePoints })),
    }),
    t,
  );
});

Deno.test("encodeSettings decodes with the fields it was given", () => {
  const sec5 = new Uint8Array(SECTION_SIZES[5]);
  sec5.set(
    encodeSettings({
      gameMode: 1,
      stageCount: 3,
      extents: [[2, 10], [0, 20], [4, 30]],
      bgmTable: [1, 2, 3, 4, 5, 6],
      sfxSet: 2,
    }),
    SEC5_REGIONS.settings.offset,
  );
  const s = decodeSettings(sec5);
  assertStrictEquals(s.gameMode, 1);
  assertEquals(s.stageFlags.slice(0, 4).map((f) => f.finalStage), [
    false,
    false,
    true,
    false,
  ]);
  assertEquals(s.stageExtents.slice(0, 3), [{ loopPart: 2, endPart: 10 }, {
    loopPart: 0,
    endPart: 20,
  }, { loopPart: 4, endPart: 30 }]);
  assertEquals(s.bgmTable.slice(0, 6), [1, 2, 3, 4, 5, 6]);
  assertStrictEquals(s.sfxSet, 2);
  assertEquals(s.itemSlots.map((i) => i.type), [7, 0, 8, 6, 5, 4, 1, 2]);
  assertStrictEquals(s.loadouts[0].main, 1);
  assertStrictEquals(s.loadouts[0].sub, 1);
  assertStrictEquals(s.shotDamage, 20);
});

Deno.test("emptySong is the engine's unused-slot template", () => {
  const song = emptySong();
  assertStrictEquals(song.length, 4228);
  assertEquals([...song.subarray(0, 4)], [0x00, 0x1f, 0x03, 0x0f]);
  assertEquals([...song.subarray(4, 8)], [0x00, 0x00, 0x80, 0x03]);
  assertEquals([...song.subarray(4 + 132 * 31, 8 + 132 * 31)], [
    0x00,
    0x00,
    0x80,
    0x03,
  ]);
  assertStrictEquals(song.filter((b) => b).length, 67);
});

Deno.test("a tiny level assembles, and decodeSave reads it back", () => {
  const { sections, warnings, report } = buildSaveFromGame(level(), art());
  assertEquals(sections.map((s) => s.length), SECTION_SIZES);
  assertEquals(warnings.filter((w) => !/drop digits/.test(w)), []);
  assertStrictEquals(report.stages.length, 1);
  assertStrictEquals(report.ship, "duke");
  assertStrictEquals(report.bulletTypes, 1);

  const decoded = decodeSave(buildPayload(sections));
  assert(decoded.sections.every((s) => s.sizeMatchesKnown));
  assertStrictEquals(decoded.stageCount, 1);
  assertStrictEquals(decoded.enemies.length, 2);
  const dot = decoded.enemies.find((e) => e.record < 16);
  const slab = decoded.enemies.find((e) => e.record >= 48 && e.record < 52);
  assert(dot && slab, "dot is a 16x16 record, slab a 64x32 one");
  assertStrictEquals(dot.placements, 5);
  assertStrictEquals(slab.placements, 2);
  assertStrictEquals(dot.spriteKeys.length, 4);
  assertStrictEquals(slab.spriteKeys.length, 2);
  assertStrictEquals(decoded.sprites[dot.spriteKeys[0]].w, 16);
  assertStrictEquals(decoded.sprites[slab.spriteKeys[0]].w, 64);
  // attributes: 3 hits -> the 12800 step, 200 points, fires
  assertStrictEquals(dot.behavior.hp, 12800);
  assertStrictEquals(dot.behavior.score, 200);
  assert(dot.behavior.fire.enabled && dot.behavior.fire.geometry === 1);
  assertStrictEquals(
    slab.behavior.fire.geometry,
    0,
    "interval -1 = never fires",
  );
  // the drop digit 1 (power-up) became a mode-1 death word on slot 0
  assertStrictEquals(dot.behavior.death.mode, 1);
  assertStrictEquals(dot.behavior.death.item, 1);
  // placement: row order is spawn order (json reversed), columns on the playfield
  const rows = decoded.stages[0].waveRows;
  assertEquals(rows, [8, 20, 32]);
  const first = decoded.stages[0].rows[0];
  assertEquals(first.map((c, i) => (c ? i : -1)).filter((i) => i >= 0), [
    5,
    14,
  ]);
  // boss: F3, one 128x128 core frame, past the last wave
  assertStrictEquals(decoded.bosses.length, 1);
  assertStrictEquals(decoded.bosses[0].sizeClass, 3);
  assertStrictEquals(decoded.bosses[0].row, 32 + 24);
  assert(decoded.bosses[0].coreArt);
  assertStrictEquals(decoded.bosses[0].behavior.score, 5000);
  // global art: ship, 8 icons, both blasts, one bullet type
  assert(
    decoded.globalArt.player && decoded.globalArt.items &&
      decoded.globalArt.blastA && decoded.globalArt.blastB,
  );
  assertStrictEquals(decoded.globalArt.bullets.filter(Boolean).length, 1);
  // settings: extents fit the stage, three stages worth of flags are not set
  assertEquals(decoded.settings.stageExtents[0], { loopPart: 2, endPart: 6 });
  assert(decoded.settings.stageFlags[0].finalStage);
  // and the whole thing maps back to a valid game.json
  const { gameJson } = mapSaveToGame(decoded);
  const v = validateGameJson(gameJson);
  assert(v.ok, v.errors.join("; "));
  assertStrictEquals(gameJson.stage0.enemylist.length, 3);
  assertStrictEquals(gameJson.stage0.enemylist[0].length, 20);
});

function bankWord(sections, ref) {
  const at = SEC5_REGIONS.spriteBank.offset + ref * 2;
  return (sections[5][at] << 8) | sections[5][at + 1];
}

Deno.test("the player's weapon art fills refs 48-93, the level's shots stood on end", () => {
  const lv = level();
  // a sideways bolt, 12x4, the way the runtime draws a shot travelling right
  lv.playerData = { texture: [], shootNormal: { texture: ["bolt.png"] } };
  const a = art();
  a["bolt.png"] = frame(12, 4, [255, 255, 255]);
  const { sections, report } = buildSaveFromGame(lv, a);
  assertStrictEquals(report.weaponArt.levelShotFrames, 1);
  assertStrictEquals(report.weaponArt.slots, GLOBAL_WEAPON_SLOTS.length);
  assertStrictEquals(report.player2, false);
  // every char slot the engine draws player shots, beams, pods and bombs
  // from is painted — an empty one is an invisible weapon
  for (const slot of GLOBAL_WEAPON_SLOTS) {
    for (let k = 0; k < slot.w * slot.h; k++) {
      assert(
        bankWord(sections, slot.first + k) !== 0xffff,
        `ref ${slot.first + k} (${slot.role}) is painted`,
      );
    }
  }
  // a 1P save leaves the second ship (refs 24-47) empty
  for (let ref = 24; ref < 48; ref++) {
    assertStrictEquals(bankWord(sections, ref), 0xffff);
  }
  // weapon 1's cell (ref 63) holds the bolt, rotated to fly upward: its
  // opaque box is taller than it is wide
  const decoded = decodeSave(buildPayload(sections));
  const sec = decoded.sections.map((s) => s.decompressed);
  const w = bankWord(sections, 63);
  const img = renderFrame(sec, decoded.cg.palettes, {
    w: 1,
    h: 1,
    cells: [{
      empty: false,
      cell: w & 0x3ff,
      hflip: (w & 0x4000) !== 0,
      vflip: (w & 0x8000) !== 0,
    }],
  });
  let minX = 16, maxX = -1, minY = 16, maxY = -1;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (!img.rgba[(y * 16 + x) * 4 + 3]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  assert(maxX >= 0, "ref 63 draws something");
  assert(maxY - minY > maxX - minX, "the bolt stands on end");
});

Deno.test("a 2P game paints the second ship from the first when it has none of its own", () => {
  const { sections, report } = buildSaveFromGame(level(), art(), {
    gameMode: 2,
  });
  assertStrictEquals(report.player2, true);
  for (let ref = 24; ref < 48; ref++) {
    assertStrictEquals(bankWord(sections, ref), bankWord(sections, ref - 24));
  }
  const decoded = decodeSave(buildPayload(sections));
  assert(
    decoded.globalArt.player2 && decoded.globalArt.player2.idle.length === 2,
  );
});

Deno.test("both title logos stack: the logo on top, the subtitle in the bottom row", () => {
  const title1 = frame(256, 91, [200, 200, 200]);
  const title2 = frame(256, 20, [100, 200, 255]);
  const { sections, report } = buildSaveFromGame(level(), art(), {
    title1,
    title2,
  });
  assert(report.title.title1 && report.title.title2);
  const painted = (slot) =>
    Array.from(
      { length: slot.w * slot.h },
      (_, i) => bankWord(sections, slot.first + i) !== 0xffff,
    );
  const t1 = painted(TITLE_SLOTS.title1);
  const t2 = painted(TITLE_SLOTS.title2);
  assert(t1.slice(0, 24).every(Boolean), "the logo fills rows 0-2 of TITLE 1");
  assert(t1.slice(24).every((p) => !p), "and leaves row 3 for the subtitle");
  assert(
    t2.slice(0, 24).every((p) => !p),
    "the subtitle stays out of rows 0-2 of TITLE 2",
  );
  assert(t2.slice(24).every(Boolean), "and fills row 3");
  // alone, a logo is centred in its slot: 256x91 halves to 128x46, which
  // touches all four cell rows
  const only = buildSaveFromGame(level(), art(), { title1 });
  const c = Array.from(
    { length: 32 },
    (_, i) => bankWord(only.sections, TITLE_SLOTS.title1.first + i) !== 0xffff,
  );
  assert(c.every(Boolean));
  assert(
    Array.from(
      { length: 32 },
      (_, i) => bankWord(only.sections, TITLE_SLOTS.title2.first + i),
    )
      .every((w) => w === 0xffff),
    "no subtitle, no TITLE 2",
  );
});

Deno.test("rotateCcwRgba and placeRgba move pixels where they say", () => {
  const src = {
    w: 3,
    h: 1,
    rgba: new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255]),
  };
  const rot = rotateCcwRgba(src);
  assertEquals([rot.w, rot.h], [1, 3]);
  // the right end (3) is now on top
  assertEquals([rot.rgba[0], rot.rgba[4], rot.rgba[8]], [3, 2, 1]);
  const placed = placeRgba(src, 3, 1, 8, 4, 2, 3);
  assertEquals([placed.w, placed.h], [8, 4]);
  assertStrictEquals(placed.rgba[((3 * 8) + 2) * 4], 1);
  assertStrictEquals(placed.rgba[((3 * 8) + 4) * 4], 3);
  assertStrictEquals(placed.rgba[((2 * 8) + 2) * 4 + 3], 0);
});

Deno.test("an import's own record bytes go back verbatim, in their own slot", () => {
  const lv = level();
  const bytes = "23 15 42 00 24 11 00 00 00 00 00 00 00 00 00 00 00 00".replace(
    / /g,
    "",
  );
  lv.enemyData.enemyA.dezaemon = { stage: 0, record: 7, attributes: bytes };
  const { sections } = buildSaveFromGame(lv, art());
  const rec = sections[5].subarray(
    SEC5_REGIONS.enemies.offset + 7 * 18,
    SEC5_REGIONS.enemies.offset + 8 * 18,
  );
  assertEquals(
    [...rec].map((b) => b.toString(16).padStart(2, "0")).join(""),
    bytes,
  );
});

Deno.test("snes palette keeps every zako frame inside one user row", () => {
  const decoded = decodeSave(
    buildPayload(
      buildSaveFromGame(level(), art(), { palette: "snes" }).sections,
    ),
  );
  const pages = decoded.sections.slice(0, 4).map((s) => s.decompressed);
  const bank = SEC5_REGIONS.spriteStages.offset;
  const sec5 = decoded.sections[5].decompressed;
  // record 0's four frames: refs at bank +0x000
  for (let f = 0; f < 4; f++) {
    const ref = (sec5[bank + f * 2] << 8) | sec5[bank + f * 2 + 1];
    assert(ref !== 0xffff);
    const cell = pages[ref >> 8 & 3].subarray(
      (ref & 0xff) * 256,
      (ref & 0xff) * 256 + 256,
    );
    const rows = new Set([...cell].filter(Boolean).map((v) => v >> 4));
    assertStrictEquals(rows.size, 1);
    assert([...rows][0] >= 12);
  }
});

Deno.test("exportLevelToSav wraps it all into a MiSTer cart named the collection's way", async () => {
  const out = exportLevelToSav(level(), art(), { comment: "tiny" });
  assertStrictEquals(out.sav.length, 1114112);
  assertStrictEquals(out.fileName, "Dez 2 - tiny.sav");
  assertStrictEquals(out.filename, "DEZA2____01");
  assertStrictEquals(savFileName("a/b:c"), "Dez 2 - a-b-c.sav");
  const [save] = bup.parse((await normalize(out.sav)).data).filter(isGameSave);
  assertStrictEquals(save.comment, "tiny");
  const decoded = decodeSave(save.payload.buffer);
  assertStrictEquals(decoded.enemies.length, 2);
  assertEquals(out.report.stages[0].boss.sizeClass, 3);
});
