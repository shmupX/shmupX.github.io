// The cloud game evil-invaders: Evil Invaders (easierbycode/evil-invaders,
// the Phaser CE shooter at easierbycode.com/evil-invaders) converted by
// scripts/evil-invaders/build-level.ts.
//
// The conversion reuses 95-demo's script compiler and fire gates, whose
// claims about the runtime tests/95_demo_test.ts checks against the bundle's
// own code. What is checked here is this game's own port: that an enemy is
// replayed as the source flies it (the straight line, the bounce, the kill,
// the two-second gun), that every flight compiles into a script the runtime
// model flies within a pixel, and then the record itself — two stages that
// spawn every enemy they name, the RedDevil boss on the first and none on the
// second, every frame packed, the ship turned nose-up, the eShop archive and
// its row.

import { assert, assertEquals } from "@std/assert";
import {
  ANIMS,
  ENEMY_CLASSES,
  GAME_WIDTH,
  LEVELS,
  RED_DEVIL,
  SHEETS,
  SPAWN_Y,
} from "../scripts/evil-invaders/source.ts";
import {
  FIELD_H,
  FIRE_FRAMES,
  hiddenAt,
  KX,
  KY,
  replayEnemy,
  SPRITE_DIMS,
  spriteScale,
} from "../scripts/evil-invaders/flight.ts";
import {
  buildArt,
  buildLevel,
  buildStage,
  ENTRY_Y,
  RAINBOW_SHOT_CYCLE,
  SCORE_PER_HP,
  stagePlan,
  tickSpeed,
} from "../scripts/evil-invaders/build-level.ts";
import {
  gridFrame,
  loadArt,
  toFieldArt,
} from "../scripts/evil-invaders/art.ts";
import {
  gameEntries,
  ICON,
  TITLE,
} from "../scripts/evil-invaders/build-zip.ts";
import {
  ENTRY_NO_FIRE,
  rowFlagsByFrame,
  runEntryScript,
} from "../scripts/95-demo/entry-script.ts";
import {
  CUTIN,
  CUTIN_COUNT,
  TEXTURE_LIMIT,
} from "../scripts/95-demo/build-level.ts";
import { gridFrame as stockGridFrame } from "../scripts/95-demo/art.ts";
import { LEVEL_PATCH } from "../scripts/2019/build-zip.ts";
import { LAUNCHER_MARKER } from "../lib/launcher-inject.ts";
import { decodeDataUrl, decodePng } from "@shmupx/shmup-harbor/png";
import { cut, rotateCcw } from "@shmupx/shmup-harbor/raster";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

// --- the source, replayed ---------------------------------------------------

const HALF = { w: 16, h: 12 };
const LEVEL_FRAMES = LEVELS[0].duration * 60;

Deno.test("a GenericEnemy flies straight, bounces two pixels inside the walls and leaves below the world", () => {
  // Level 1's third spawn: the small Bowser from x 0.1 at (50, 50) px/s.
  const def = LEVELS[0].enemies[2];
  assertEquals(def.key, "bowser");
  const scale = spriteScale(def);
  assertEquals(scale, 0.5 / 3);
  const hw = SPRITE_DIMS.bowser.w * scale / 2;
  const f = replayEnemy("t", def, { half: HALF, levelFrames: LEVEL_FRAMES });
  assertEquals(f.launchFrame, 5 * 60);
  assertEquals(f.track[0].src, { x: 36, y: SPAWN_Y });
  // one physics step a frame, straight down at 50 px/s
  assertEquals(
    Math.round((f.track[1].src.y - f.track[0].src.y) * 1e6) / 1e6,
    Math.round(50 / 60 * 1e6) / 1e6,
  );
  // across to the right wall in six seconds, back to the left in six more,
  // and off the bottom before a third
  assertEquals(f.bounces, 2);
  assert(f.leftTheWorld);
  const rightmost = Math.max(...f.track.map((t) => t.src.x));
  const leftmost = Math.min(...f.track.slice(1).map((t) => t.src.x));
  assert(rightmost <= GAME_WIDTH - hw + 1e-9, `${rightmost}`);
  assert(rightmost >= GAME_WIDTH - hw - 2 - 1, `${rightmost}`);
  assert(leftmost >= hw - 1e-9 && leftmost <= hw + 2 + 1, `${leftmost}`);
  const flips = f.track.slice(2).filter((t, i) =>
    Math.sign(t.src.x - f.track[i + 1].src.x) !==
      Math.sign(f.track[i + 1].src.x - f.track[i].src.x)
  );
  assertEquals(flips.length, 2);
  // the field sees the sprite's centre, scaled per axis
  const h = SPRITE_DIMS.bowser.h * scale;
  assertEquals(f.track[0].pos, {
    x: 36 * KX,
    y: (SPAWN_Y - h / 2) * KY,
  });
  // The gun: fired on construction above the world, where Phaser kills the
  // bullet unseen, then every two seconds while it lives — seven shots in
  // its fifteen seconds, all aimed, since Bowser fires at the player.
  assertEquals(f.shots.map((s) => s.frame - f.launchFrame), [
    FIRE_FRAMES,
    FIRE_FRAMES * 2,
    FIRE_FRAMES * 3,
    FIRE_FRAMES * 4,
    FIRE_FRAMES * 5,
    FIRE_FRAMES * 6,
    FIRE_FRAMES * 7,
  ]);
  assert(f.shots.every((s) => s.aimed));
  // A flirty girl's lips drop straight down.
  const girl = replayEnemy("g", LEVELS[0].enemies[1], {
    half: HALF,
    levelFrames: LEVEL_FRAMES,
  });
  assertEquals(girl.bounces, 1);
  assert(girl.shots.length === 7 && girl.shots.every((s) => !s.aimed));
  assertEquals(ENEMY_CLASSES.flirtyGirl.aimed, false);
});

Deno.test("the RedDevil descends to y 150 in two seconds, holds, and fires at every moment either gun would", () => {
  const def = LEVELS[0].enemies[8];
  assertEquals(def.key, "redDevil");
  const f = replayEnemy("d", def, { half: HALF, levelFrames: LEVEL_FRAMES });
  assertEquals(f.launchFrame, 15 * 60);
  assertEquals(f.track[0].src, { x: 72, y: SPAWN_Y });
  const at = (s: number) => f.track[s * 60].src;
  assert(Math.abs(at(2).y - RED_DEVIL.restY) < 1e-9);
  assert(
    at(1).y > SPAWN_Y + 100 && at(1).y < RED_DEVIL.restY - 100,
    "midway at 1 s",
  );
  assertEquals(at(10), at(2));
  assertEquals(f.bounces, 0);
  assert(!f.leftTheWorld);
  // it is parked until the level's timer, twenty seconds later
  assertEquals(f.track.length, LEVEL_FRAMES - f.launchFrame + 1);
  // DevilFire at 0, 4, 8 … s and DevilBlast at 2, 6, 10 … s: the first is
  // fired 87 px above the world and dies; the rest, every two seconds.
  const rel = f.shots.map((s) => s.frame - f.launchFrame);
  assertEquals(rel.slice(0, 4), [120, 240, 360, 480]);
  assertEquals(rel.length, 10);
  assert(f.shots.every((s) => s.aimed));
  assertEquals(f.shots[0].speed, 600); // the blast
  assertEquals(f.shots[1].speed, 200); // the fire
});

Deno.test("the second RedDevil of level 1 is the stage's boss; level 2 has none", () => {
  const first = stagePlan(0);
  assertEquals(first.zako.length, 9);
  assertEquals(first.boss?.time, 16);
  assertEquals(first.boss?.x, 0.75);
  assert(first.zako.some((z) => z.def.key === "redDevil" && z.def.time === 15));
  const second = stagePlan(1);
  assertEquals(second.zako.length, 8);
  assertEquals(second.boss, null);
});

Deno.test("every flight compiles into a script the runtime model flies within a pixel, one gate a shot", async () => {
  const { half } = await buildArt();
  for (const stage of [0, 1]) {
    const st = buildStage(stage, half);
    const plan = stagePlan(stage);
    assertEquals(st.enemies.length, plan.zako.length);
    assertEquals(st.boss, !!plan.boss);
    // the stage ends when the source sends the boss, else on its timer
    assertEquals(
      st.endFrame,
      plan.boss ? plan.boss.time * 60 : LEVELS[stage].duration * 60,
    );
    for (const e of st.enemies) {
      assert(
        e.maxVisibleError <= 0.75 + 1e-9,
        `${e.letters} ${e.maxVisibleError}`,
      );
      assert(e.spawnFrame >= 30, `${e.letters} spawns at ${e.spawnFrame}`);
      assert(e.spawnFrame < st.endFrame, `${e.letters} after the end`);
      // The spawn frame is the source's clock: a flight is picked up where
      // it crosses ENTRY_Y, a frame or two after a pre-roll from the grid.
      const sourceFrame = e.def.time * 60;
      assert(e.spawnFrame >= sourceFrame, `${e.letters} spawns early`);
      // one open gate per shot the source fires
      const frames = e.rows.reduce((n, r) => n + r[0] + 1, 0);
      const flags = rowFlagsByFrame(e.rows, Math.min(frames, 4000));
      let gates = 0;
      for (let k = 0; k < flags.length; k++) {
        const open = !(flags[k] & ENTRY_NO_FIRE);
        const wasOpen = k > 0 && !(flags[k - 1] & ENTRY_NO_FIRE);
        if (open && !wasOpen) gates++;
      }
      assertEquals(gates, e.shots, `${e.letters} gates`);
      // the script's enemy never shows above the field's top edge
      const spawn = { x: 16 + 16 * e.column, y: -16 };
      const run = runEntryScript(e.rows, spawn, spawn.x > 128, 200);
      const h = half[`${e.kind}@${e.scale}`];
      for (let k = 1; k < run.length; k++) {
        if (run[k].y >= ENTRY_Y) break;
        assert(run[k].y >= -60, `${e.letters} above the cull box at ${k}`);
        assert(
          hiddenAt(run[k], h) || run[k].y + h.h <= 24,
          `${e.letters} shows at ${k}: ${JSON.stringify(run[k])}`,
        );
      }
    }
    // spawn order is bottom-up: due frames never run backwards
    const due = st.waveRows.slice().reverse();
    for (let i = 1; i < due.length; i++) assert(due[i] >= due[i - 1]);
    assertEquals(due[0], 30);
    assertEquals(due[due.length - 1], 30 + st.endFrame);
  }
});

// --- the record -------------------------------------------------------------

type Stage = {
  enemylist: string[][];
  waveRows: number[];
  waveInterval: number;
};

Deno.test("the evil-invaders record: two stages, its art, the RedDevil boss", async () => {
  const { record, stages } = await buildLevel();
  assertEquals(record.name, "evil-invaders");
  assertEquals(record.title, TITLE);
  assertEquals(record.gameId, "evil-invaders-57de0224");
  assertEquals(record.noStory, true);
  assertEquals(record.ownCutin, true);
  assertEquals(
    "endsOnClear" in record,
    false,
    "the levels end on their timers",
  );
  assertEquals(Object.keys(record.stages).sort(), ["stage0", "stage1"]);
  assertEquals(record.enemylist, record.stages.stage0.enemylist);
  assertEquals(record.width, 16);

  let enemies = 0;
  for (
    const [key, st] of Object.entries(record.stages) as [string, Stage][]
  ) {
    assertEquals(st.waveRows.length, st.enemylist.length, key);
    assertEquals(st.waveInterval, 2);
    for (const row of st.enemylist) {
      assertEquals(row.length, record.width);
      for (const cell of row) {
        if (cell === "00") continue;
        enemies++;
        assert(record.enemyData[`enemy${cell.slice(0, -1)}`], cell);
        assertEquals(cell.slice(-1), "0", "no item drops: the source has none");
      }
    }
  }
  assertEquals(enemies, Object.keys(record.enemyData).length);
  assertEquals(
    enemies,
    LEVELS.reduce((n, l) => n + l.enemies.length, 0) - 1,
    "every spawn but the boss",
  );
  // the table's hp, a hundred points an hp, the source's own gun
  const big = record.enemyData.enemyAAA;
  assertEquals(big.name, "bowser");
  assertEquals(big.hp, 25);
  assertEquals(big.score, 25 * SCORE_PER_HP);
  assertEquals(big.texture, ["eiBowser50_0", "eiBowser50_1"]);
  assertEquals(big.dezaemon.behavior.fire.aimed, true);
  assertEquals(big.bulletData.texture.length, 4);
  assertEquals(big.bulletData.speed, tickSpeed(200));
  assertEquals("speed" in big, false, "a hold row leaves the enemy still");
  const girl = record.enemyData.enemyAAB;
  assertEquals(girl.name, "flirtyGirl");
  assertEquals(girl.dezaemon.behavior.fire.aimed, false);
  assertEquals(girl.bulletData.texture.length, ANIMS.lipsLick.frames.length);
  const devil = record.enemyData.enemyAAI;
  assertEquals(devil.name, "redDevil");
  assertEquals(devil.hp, 50);
  assertEquals(devil.bulletData.facing, 45);
  const rainbow = record.enemyData.enemyBAB;
  assertEquals(rainbow.name, "rainbowInvader");
  assertEquals(rainbow.bulletData.texture.length, RAINBOW_SHOT_CYCLE.length);
  assertEquals(rainbow.bulletData.frameRate, 60);
  assertEquals(new Set(rainbow.bulletData.texture).size, 16);
  for (const s of stages) {
    for (const e of s.enemies) assert(e.maxVisibleError <= 0.75 + 1e-9);
  }

  // The boss: level 1's second RedDevil, on Fang's routine, bursting into
  // the LittleDevil trio below the devils' share of its bar. Level 2 has
  // none, so its stage ends on its timer.
  assertEquals(Object.keys(record.bossData), ["boss0"]);
  const boss = record.bossData.boss0;
  assertEquals(boss.name, "redDevil");
  assertEquals(boss.attackPattern, "boss4");
  assertEquals(boss.hp, 50 + 3 * 12);
  assertEquals(boss.score, 86 * SCORE_PER_HP);
  assertEquals(boss.stage2.attackPattern, "boss1");
  assertEquals(boss.stage2.hpBelow, 0.4186);
  assertEquals(boss.bulletDataA.speed, tickSpeed(600));
  assertEquals(boss.bulletDataB.facing, 45);
  assertEquals(boss.stage2.bulletData.texture[0], "eiDevilFireHalf0");
  assertEquals(boss.anim.charge, [
    "eiRedDevil11",
    "eiRedDevil12",
    "eiRedDevil13",
  ]);

  // Peach: four booster frames at 6 fps, bubbles every 7 ticks (60 ms).
  assertEquals(record.playerData.texture.length, 4);
  assertEquals(record.playerData.shootNormal.interval, 7);
  assertEquals(record.playerData.maxHp, 3);
  assertEquals("playerData2" in record, false, "a one-player game");

  // Its own sky on every stage, and the title plates.
  assertEquals(Object.keys(record.stageBackgrounds).sort(), [
    "stage0",
    "stage1",
  ]);
  for (const k of ["stage0", "stage1"]) {
    for (const part of ["loop", "end"]) {
      assert(
        String(record.stageBackgrounds[k][part]).startsWith(
          "data:image/png;base64,",
        ),
      );
    }
  }
  const sky = await decodeDataUrl(record.stageBackgrounds.stage0.loop);
  assertEquals([sky.width, sky.height], [256, 256]);
  for (
    const k of [
      "atlasImageDataURL",
      "titleBgDataURL",
      "logoDataURL",
      "subTitleDataURL",
      "titleStartTextDataURL",
    ]
  ) {
    assert(String(record[k]).startsWith("data:image/png;base64,"), k);
  }

  // The SP bomb's cut-in: rando's nine, carried as 95-demo carries them.
  const stock =
    JSON.parse(await read("static/games/2028-ai/assets/game_asset.json")).meta
      .size;
  const sheet = await decodeDataUrl(record.atlasImageDataURL);
  const rando = await decodePng(
    await Deno.readFile(
      new URL(
        "../static/games/2028-ai/assets/img/cutinCustom.png",
        import.meta.url,
      ),
    ),
  );
  for (let i = 0; i < CUTIN_COUNT; i++) {
    const rect = record.atlasFrames[`cutin${i}․gif`].frame;
    assertEquals([rect.w, rect.h], [CUTIN.frameW, CUTIN.frameH], `cutin${i}`);
    assertEquals(
      cut(sheet, rect).data,
      stockGridFrame(rando, CUTIN, i).data,
      `cutin${i}`,
    );
  }
  assert(sheet.width <= stock.w, `${sheet.width} px wide: it widens the stack`);
  assert(
    stock.h + sheet.height <= TEXTURE_LIMIT,
    `${stock.h + sheet.height} rows`,
  );
  assert(!JSON.stringify(Object.keys(record.atlasFrames)).includes("."));
});

Deno.test("Peach's ship is packed nose-up and her bubble as drawn, since the runtime turns a shot a quarter turn", async () => {
  // The source rotates the peachShip sprite to angle 270; the runtime draws
  // the player's frames as they are. The bubble the source fires leaves at
  // Phaser's angle 0 — drawn pointing right — which is the way the runtime
  // wants a shot drawn before it turns it to fly up.
  const { record } = await buildLevel();
  const sheet = await decodeDataUrl(record.atlasImageDataURL);
  const ship = await loadArt(SHEETS.peachShip.file);
  for (const [i, fi] of ANIMS.peachBoosters.frames.entries()) {
    const want = rotateCcw(
      toFieldArt(gridFrame(ship, SHEETS.peachShip, fi), 1, true),
    );
    const rect = record.atlasFrames[record.playerData.texture[i]].frame;
    assertEquals([rect.w, rect.h], [want.width, want.height]);
    assertEquals(cut(sheet, rect).data, want.data, `eiPeach${i}`);
    assert(rect.h > rect.w, "nose-up: taller than wide");
  }
  const bubbles = await loadArt(SHEETS.purpleBubble.file);
  for (const [i, fi] of ANIMS.purpleBubble.frames.entries()) {
    const want = toFieldArt(
      gridFrame(bubbles, SHEETS.purpleBubble, fi),
      1,
      true,
    );
    const rect =
      record.atlasFrames[record.playerData.shootNormal.texture[i]].frame;
    assertEquals(cut(sheet, rect).data, want.data, `eiBubble${i}`);
  }
});

Deno.test("Bowser's frames are cut a pixel in, as the loader's margin places them", async () => {
  const sheet = await loadArt(SHEETS.bowser.file);
  const f0 = gridFrame(sheet, SHEETS.bowser, 0);
  const f2 = gridFrame(sheet, SHEETS.bowser, 2);
  assertEquals([f0.width, f0.height], [272, 196]);
  // frame 0 starts at (1, 1): its first column is the sheet's second
  assertEquals(
    [...f0.data.slice(0, 4)],
    [...sheet.data.slice(
      (1 * sheet.width + 1) * 4,
      (1 * sheet.width + 1) * 4 + 4,
    )],
  );
  // frame 2 at x 545, and its overhanging bottom row reads as transparent
  const x2 = 1 + 2 * 272;
  assertEquals(
    [...f2.data.slice(0, 4)],
    [...sheet.data.slice(
      (1 * sheet.width + x2) * 4,
      (1 * sheet.width + x2) * 4 + 4,
    )],
  );
  assert(f0.data.slice(195 * 272 * 4).every((v) => v === 0));
});

// --- the eShop's web build ----------------------------------------------------

Deno.test("the eShop archive is the game page, the bundle pointed at its own level, and the record", async () => {
  const entries = await gameEntries();
  assertEquals(entries.map((e) => e.path), [
    "foo.json",
    "game.bundle.js",
    "index.html",
  ]);
  const text = new TextDecoder();
  const byPath = Object.fromEntries(
    entries.map((e) => [e.path, text.decode(e.data)]),
  );
  const { record } = await buildLevel();
  assertEquals(JSON.parse(byPath["foo.json"]), record);
  assertEquals(record.gameId, "evil-invaders-57de0224");
  const bundle = byPath["game.bundle.js"];
  assert(bundle.includes(LEVEL_PATCH.to));
  assertEquals(bundle.includes(LEVEL_PATCH.from), false);
  const html = byPath["index.html"];
  assert(html.includes(LAUNCHER_MARKER.trim()), "no launcher marker");
  assert(html.includes('<script src="game.bundle.js" defer></script>'));
  assert(html.includes(`<title>${TITLE}</title>`));
});

Deno.test("evil-invaders is listed as a web build, installed from this origin", async () => {
  const eshop = JSON.parse(await read("data/eshop.json"));
  const row = eshop.find((e: { id: string }) => e.id === "evil-invaders");
  assert(row, "data/eshop.json has no evil-invaders entry");
  assertEquals(row.kind, "web");
  assertEquals(row.name, TITLE);
  assertEquals("shelf" in row, false, "it is no console's game");
  assertEquals(row.source, "url");
  assertEquals(row.downloadUrl, "/games/evil-invaders-web.zip");
  assertEquals(row.entry, "index.html");
  assertEquals(row.players, 1);
  assertEquals(row.icon, "/icons/evil-invaders-icon.png");
  assert((await Deno.stat(ICON)).isFile, "the icon the row points at ships");
  assert(
    (await read(".gitignore")).includes("static/games/evil-invaders-web.zip"),
  );
  const tasks = JSON.parse(await read("deno.json")).tasks;
  assert(tasks["evil-invaders:zip"], "no evil-invaders:zip task");
  assert(
    tasks.build.includes("deno task evil-invaders:zip"),
    "deno task build does not pack the archive",
  );
  // the field is the 256x480 the flight is scaled onto
  assertEquals(FIELD_H, 480);
});
