// The cloud game 95-demo: EVIL INVADERS '95 converted by
// scripts/95-demo/build-level.ts, and the runtime flag it plays under.
//
// The conversion stands on two claims about the runtime, and both are checked
// here against the runtime's own code, lifted out of game.bundle.js:
//
// - a zako's appearance script moves it exactly as entry-script.ts's
//   runEntryScript says (the compiler fits every row against that model), and
// - a fire gate as long as fireGateFrames(stage) lets exactly one bullet
//   through, at every rank the stage can reach (dezaFirePulse, zakoReload).
//
// Then the record itself: ten stages that spawn every enemy they name, every
// frame it names packed, keys RTDB takes, the schema's shape, and the boss;
// and the foo raiders, which drop through without holding a stage open.

import { assert, assertEquals } from "@std/assert";
import { createLevelLoaderPlugin } from "../static/phaser-plugins/level-loader.js";
import {
  compileEntryScript,
  ENTRY_ADVANCE,
  ENTRY_NO_FIRE,
  type EntryRow,
  type Point,
  rowFlagsByFrame,
  runEntryScript,
} from "../scripts/95-demo/entry-script.ts";
import {
  planSlots,
  replayLevel,
  seededRandom,
} from "../scripts/95-demo/replay.ts";
import {
  ANIMS,
  DRAW_SCALE,
  FOO_HOMING_Y,
  FOO_RAID_ROWS,
  fooRaiderX,
  GAME_HEIGHT,
  RAINBOW_BULLET_TINTS,
  STAGES,
} from "../scripts/95-demo/source.ts";
import {
  blobHeadRows,
  buildArt,
  buildLevel,
  buildStage,
  CUTIN,
  CUTIN_COUNT,
  enemyLetters,
  fireGateFrames,
  HORIZON_MS,
  planRaids,
  RAID_FIRST_STAGE,
  raiderKey,
  raiderLag,
  raiderSpawn,
  SEED,
  TEXTURE_LIMIT,
} from "../scripts/95-demo/build-level.ts";
import {
  atlasFrame,
  gridFrame,
  loadArt,
  toFieldArt,
} from "../scripts/95-demo/art.ts";
import { gameEntries, ICON, TITLE } from "../scripts/95-demo/build-zip.ts";
import { LEVEL_PATCH } from "../scripts/2019/build-zip.ts";
import { LAUNCHER_MARKER } from "../lib/launcher-inject.ts";
import { decodeDataUrl, decodePng } from "@shmupx/shmup-harbor/png";
import { cut, rotateCcw, rotateCw } from "@shmupx/shmup-harbor/raster";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

/** A top-level `function name(...) {...}` of the bundle, as source. */
function lift(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start > 0, `no function ${name} in the bundle`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// --- the runtime flag ------------------------------------------------------

const Plugin = createLevelLoaderPlugin({
  Plugins: {
    ScenePlugin: class {
      scene: unknown;
      constructor(scene: unknown) {
        this.scene = scene;
      }
    },
  },
});

const BASE = {
  stage0: { enemylist: [["00"]] },
  playerData: { texture: ["player00.gif"] },
  enemyData: {},
  bossData: {},
};

const scene = {
  textures: { exists: () => false, get: () => null },
  cache: { json: { get: () => null, exists: () => false } },
};

Deno.test("mergeRecipe carries a level's endsOnClear onto the recipe", () => {
  const plugin = new Plugin(scene, null, "levelLoader");
  const own = plugin.mergeRecipe(
    BASE,
    { name: "95-demo", enemylist: [["00"]], endsOnClear: true },
    "game_asset",
  );
  assertEquals(own.endsOnClear, true);
  const stock = plugin.mergeRecipe(
    BASE,
    { name: "gs", enemylist: [["00"]] },
    "game_asset",
  );
  assertEquals("endsOnClear" in stock, false);
});

function slice(js: string, from: string, to: string) {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert(start > 0 && end > start, `no ${from}`);
  return js.slice(start, end).replace(/\s+/g, " ").trim();
}

Deno.test("the bundle's inlined mergeRecipe carries endsOnClear as the plugin does", async () => {
  const plugin = (await read("static/phaser-plugins/level-loader.js"))
    .replace(/\r\n/g, "\n");
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const pass = (js: string) =>
    slice(
      js,
      "// A stage that ends when its field is clear",
      "const atlasFrames",
    );
  assertEquals(pass(bundle), pass(plugin));
});

Deno.test("an endsOnClear stage skips its empty tail once the field is clear", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  // create() finds the last row that holds an enemy, in spawn order...
  const create = slice(
    bundle,
    "// endsOnClear: the spawn-order index",
    "this.stageBgOverlay = null;",
  );
  assert(
    create.includes(
      "this.endsOnClear = !!(this.recipe && this.recipe.endsOnClear)",
    ),
  );
  assert(create.includes('liveCode !== "00"'));
  // ...and the wave block jumps to the wave's end when nothing is left.
  const tick = slice(
    bundle,
    "// A record with endsOnClear ends the stage",
    "if (this.bossTimerStartFlg",
  );
  assert(tick.includes("this.waveCount > this.lastLiveRow"));
  assert(tick.includes('getData("type") !== "boss"'));
  assert(
    tick.includes(
      "this.waveCount = this.stageEnemyPositionList.length; enemyWave(this);",
    ),
  );
});

Deno.test("the editor keeps endsOnClear through LOAD, PLAY and SAVE", async () => {
  const editor = await read("static/editor/index.html");
  // SAVE writes it beside ownItems, so a copy under another name keeps it...
  assert(
    editor.includes(
      "payload.endsOnClear = !!(gameData && gameData.endsOnClear);",
    ),
  );
  // ...and LOAD puts it on gameData, which PLAY's recipe is a copy of.
  const load = slice(
    editor,
    "if (d.ownItems) gameData.ownItems = true;",
    "syncNoStoryKnob();",
  );
  assert(load.includes("if (d.endsOnClear) gameData.endsOnClear = true;"));
  assert(load.includes("else delete gameData.endsOnClear;"));
});

// --- appearance scripts, against the runtime's own stepper ----------------

Deno.test("runEntryScript moves an enemy exactly as the bundle's stepEntryScript", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const consts = [
    "ENTRY_ADVANCE",
    "ENTRY_NO_FIRE",
    "ENTRY_NO_COS",
    "ENTRY_NO_SIN",
    "ENTRY_LONG_ROW",
    "ENTRY_MOVER_B",
    "ENTRY_RIDE_GATE",
    "ENTRY_RIDES",
  ];
  const values = consts.map((c) => {
    const m = bundle.match(new RegExp(`var ${c} = (0x[0-9a-fA-F]+|\\d+);`));
    assert(m, `no ${c}`);
    return Number(m[1]);
  });
  const step = new Function(
    ...consts,
    `${lift(bundle, "stepEntryScript")}\nreturn stepEntryScript;`,
  )(...values);

  const rand = seededRandom(7);
  for (let trial = 0; trial < 40; trial++) {
    const rows: EntryRow[] = [];
    for (let r = 0; r < 6; r++) {
      rows.push([
        Math.floor(rand() * 30),
        Math.floor(rand() * 65536),
        rand() < 0.5 ? 0 : Math.floor(rand() * 2000) - 1000,
        rand() < 0.15 ? 0 : Math.floor(rand() * 2048),
        ENTRY_ADVANCE | (rand() < 0.5 ? ENTRY_NO_FIRE : 0),
      ]);
    }
    const start = { x: rand() * 256, y: -16 };
    const mirror = start.x > 128;
    const frames = 220;
    const enemy = {
      x: start.x,
      y: start.y,
      getData: () => null,
    };
    const st = {
      entry: {
        rows,
        idx: 0,
        rowT: 0,
        angle: 0,
        turn: 0,
        amp: 0,
        flags: rows[0][4],
        mirror,
        ground: false,
        moveFlag: false,
      },
    };
    const ours = runEntryScript(rows, start, mirror, frames);
    const flags = rowFlagsByFrame(rows, frames);
    for (let f = 1; f <= frames; f++) {
      step(enemy, st);
      assertEquals(enemy.x, ours[f].x, `trial ${trial} frame ${f} x`);
      assertEquals(enemy.y, ours[f].y, `trial ${trial} frame ${f} y`);
      assertEquals(
        st.entry.flags,
        flags[f - 1],
        `trial ${trial} frame ${f} flags`,
      );
    }
  }
});

Deno.test("compileEntryScript flies a curve, a hold and a gate, mirrored or not", () => {
  for (const mirror of [false, true]) {
    const pos: Point[] = [{ x: mirror ? 160 : 96, y: -16 }];
    const hidden = [true];
    // down, a half loop, a hold, then off the bottom
    for (let f = 1; f <= 60; f++) pos.push({ x: pos[0].x, y: -16 + f * 2 });
    const c = { x: pos[60].x + 30, y: pos[60].y };
    for (let f = 1; f <= 90; f++) {
      const a = Math.PI - (Math.PI * f) / 90;
      pos.push({ x: c.x + Math.cos(a) * 30, y: c.y + Math.sin(a) * 30 });
    }
    for (let f = 1; f <= 40; f++) pos.push({ ...pos[pos.length - 1] });
    for (let f = 1; f <= 100; f++) {
      const p = pos[pos.length - 1];
      pos.push({ x: p.x, y: p.y + 3 });
    }
    for (let i = 1; i < pos.length; i++) {
      hidden.push(pos[i].y - 8 > 481 || pos[i].y + 8 < -1);
    }
    const fire = new Array(pos.length - 1).fill(false);
    for (let k = 170; k < 174; k++) fire[k] = true;
    const out = compileEntryScript({ pos, hidden, fire }, {
      mirror,
      isHidden: (p) => p.y - 8 > 481 || p.y + 8 < -1,
      inBounds: (p) => p.y <= 499 && p.x >= -39 && p.x <= 295,
    });
    assert(out.maxVisibleError <= 0.75, `${out.maxVisibleError}`);
    const run = runEntryScript(out.rows, pos[0], mirror, pos.length - 1);
    for (let k = 1; k < pos.length; k++) {
      if (hidden[k]) continue;
      const d = Math.hypot(run[k].x - pos[k].x, run[k].y - pos[k].y);
      assert(d <= 0.75 + 1e-9, `frame ${k} off by ${d}`);
    }
    const flags = rowFlagsByFrame(out.rows, pos.length - 1);
    for (let k = 0; k < pos.length - 1; k++) {
      assertEquals(!(flags[k] & ENTRY_NO_FIRE), fire[k], `move ${k} gate`);
    }
  }
});

// --- the fire gate, against the runtime's own pulse ------------------------

Deno.test("a fire gate lets exactly one zako bullet through at every rank", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const pulseFns = new Function(
    "gameState",
    [
      "var TYPE012_INTERVAL = [14, 12, 10, 8, 6, 4, 2, 1];",
      "var FIRE_WINDOW = [29, 22, 16, 11, 7, 4, 2, 1];",
      lift(bundle, "zakoReload"),
      lift(bundle, "dezaRank"),
      lift(bundle, "dezaFirePulse"),
      "return { zakoReload, dezaFirePulse };",
    ].join("\n"),
  );
  assert(
    bundle.includes("var TYPE012_INTERVAL = [14, 12, 10, 8, 6, 4, 2, 1];"),
  );
  assert(bundle.includes("var FIRE_WINDOW = [29, 22, 16, 11, 7, 4, 2, 1];"));
  for (let stage = 0; stage < 10; stage++) {
    const gameState = { stageId: stage };
    const { zakoReload, dezaFirePulse } = pulseFns(gameState);
    const gate = fireGateFrames(stage);
    // the rank runs 8 + 8s at the start of the stage to 36 + 8s
    for (let rank = 8 + 8 * stage; rank <= 36 + 8 * stage; rank++) {
      for (let phase = 0; phase < 12; phase++) {
        const sc: Record<string, unknown> = { _dezaDyn: rank, _dezaFireAcc: 0 };
        for (let i = 0; i < phase; i++) dezaFirePulse(sc);
        // updateEnemyFire's single-shot arm, gate open for `gate` frames,
        // after a long silent stretch has spent the reload
        let reload = 0, shots = 0;
        for (let f = 0; f < gate + 40; f++) {
          dezaFirePulse(sc);
          const open = f < gate;
          if (sc._dezaFirePulse && reload <= 0 && open) {
            reload = zakoReload({ window: 2, mode: 0 });
            shots++;
          }
          if (sc._dezaFirePulse && reload > 0) reload--;
        }
        assertEquals(shots, 1, `stage ${stage} rank ${rank} phase ${phase}`);
      }
    }
  }
});

// --- the source, replayed ---------------------------------------------------

const HALF = {
  eyeDude: { w: 9, h: 7 },
  pinkBunny: { w: 9, h: 9 },
  goldGirl: { w: 10.5, h: 13.5 },
};

Deno.test("every level locks its formation, dives, fires and empties", () => {
  for (let s = 0; s < 10; s++) {
    const r = replayLevel({
      level: s + 1,
      def: STAGES[s],
      half: HALF,
      horizonMs: 45_000,
      seed: 1234 + s,
    });
    assertEquals(r.flights.length, planSlots(STAGES[s]).length);
    assert(r.lockFrame > 0, `level ${s + 1} never locked`);
    assert(r.endFrame > r.lockFrame);
    for (const f of r.flights) {
      assert(f.dives >= 1, `level ${s + 1} enemy ${f.id} never dived`);
      for (let i = 1; i < f.track.length; i++) {
        assertEquals(f.track[i].frame, f.track[i - 1].frame + 1);
      }
    }
    assert(r.flights.some((f) => f.shots.length > 0));
    // the same seed replays the same level
    const again = replayLevel({
      level: s + 1,
      def: STAGES[s],
      half: HALF,
      horizonMs: 45_000,
      seed: 1234 + s,
    });
    assertEquals(again.endFrame, r.endFrame);
  }
});

Deno.test("enemy letters are unique per stage and never the stock A or B", () => {
  const seen = new Set<string>();
  for (let s = 0; s < 10; s++) {
    for (let n = 0; n < 46; n++) {
      const l = enemyLetters(s, n);
      assert(/^[A-Z]{3}$/.test(l));
      assert(!seen.has(l));
      seen.add(l);
    }
  }
  // the raiders' keys are clear of every stage's
  for (let s = 0; s < 10; s++) {
    for (const kind of ["blobHead", "flyBrain"] as const) {
      const l = raiderKey(kind, s);
      assert(/^Z[A-Z]{2}$/.test(l));
      assert(!seen.has(l), l);
      seen.add(l);
    }
  }
});

Deno.test("an enemy aims as most of its own shots do", async () => {
  // The source's divers always aim and its formation aims from level 5 on; a
  // zako has one aim, so the majority of the enemy's shots decides it.
  const art = await buildArt();
  for (let s = 0; s < 10; s++) {
    const built = buildStage(s, art.half);
    const replay = replayLevel({
      level: s + 1,
      def: STAGES[s],
      half: art.half,
      horizonMs: HORIZON_MS,
      seed: SEED + s + 1,
      hiddenSpeed: 40,
    });
    replay.flights.forEach((f, n) => {
      const aimed = f.shots.filter((x) => x.aimed).length;
      assertEquals(
        built.enemies[n].aimed,
        aimed * 2 > f.shots.length,
        `stage ${s} enemy ${n}`,
      );
      if (STAGES[s].aimedShots) assertEquals(aimed, f.shots.length);
      for (const shot of f.shots) {
        if (shot.from === "dive") assert(shot.aimed, "a dive shot aims");
      }
    });
    if (!STAGES[s].aimedShots) {
      // some early enemies dive more than they shoot from formation
      assert(built.enemies.some((e) => e.aimed), `stage ${s}: none aims`);
    }
  }
});

// --- the record -------------------------------------------------------------

interface Stage {
  enemylist: string[][];
  waveRows: number[];
  waveInterval: number;
}

Deno.test("keepOnScreen widens Barlog's slide margin to half the boss's width", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const margin = new Function(
    `${lift(bundle, "bossSlideMargin")}\nreturn bossSlideMargin;`,
  )();
  const body = (w: number) => ({ displayWidth: w, width: w });
  const fight = (
    rec: Record<string, unknown>,
    stage2: Record<string, unknown> | null = null,
  ) => ({ bossRecord: rec, bossStage2: stage2, bossStage2Done: !!stage2 });
  // stock: only the centre keeps off the walls
  assertEquals(margin(fight({}), body(102)), 30);
  // the flag keeps the whole body on, an Invader's 102 px
  assertEquals(margin(fight({ keepOnScreen: true }), body(102)), 51);
  // and never pulls a narrow boss further in than stock
  assertEquals(margin(fight({ keepOnScreen: true }), body(40)), 30);
  // past its second stage the record fought is the stage-2 one
  assertEquals(margin(fight({}, { keepOnScreen: true }), body(64)), 32);
  // every slide the routine makes is clamped by it
  const barlog = lift(bundle, "bossPatternBarlog");
  assert(barlog.includes("var margin = bossSlideMargin(scene, boss);"));
  assertEquals(
    barlog.match(/clamp2\([^;]*, margin, GW6 - margin\)/g)?.length,
    3,
  );
  assert(!/clamp2\([^;]*, 30, GW6 - 30\)/.test(barlog));
});

// --- the foo raiders ---------------------------------------------------------

Deno.test("a blocksClear: false record never holds an endsOnClear stage open", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const blocks = new Function(
    `${lift(bundle, "zakoBlocksClear")}\nreturn zakoBlocksClear;`,
  )();
  const field = {
    recipe: {
      enemyData: { enemyZBA: { blocksClear: false }, enemyAAA: { hp: 1 } },
    },
  };
  assertEquals(blocks(field, "ZBA"), false);
  assertEquals(blocks(field, "AAA"), true);
  // a record without the flag, or no record at all, holds it as stock does
  assertEquals(blocks(field, "QQQ"), true);
  assertEquals(blocks({ recipe: null }, "ZBA"), true);
  // both halves of the clear ask it: the last live row and the live count
  const create = slice(
    bundle,
    "// endsOnClear: the spawn-order index",
    "this.stageBgOverlay = null;",
  );
  assert(create.includes("zakoBlocksClear(this, liveCode.slice(0, -1))"));
  const tick = slice(
    bundle,
    "// A record with endsOnClear ends the stage",
    "if (this.bossTimerStartFlg",
  );
  assert(tick.includes('zakoBlocksClear(this, lzEnemy.getData("enemyKey"))'));
});

Deno.test("raids drop every 7 s while the formation is up, through foo's rows in turn", () => {
  assertEquals(planRaids(0, 0, 100_000), [], "none before the first boss");
  const lock = 1000, end = 4000;
  for (let s = RAID_FIRST_STAGE; s < STAGES.length; s++) {
    // the source's raid timer, from the level's mount; only the ones that
    // find the formation locked and still up drop a row
    const due = [...Array(12).keys()].map((k) => 420 * (k + 1))
      .filter((f) => f >= lock && f < end);
    // the second cycle's level for this stage starts foo's rows at 7 x it,
    // and each raid spends one, empty or not
    const level = 11 + s + 1;
    const expected = due.flatMap((frame, i) => {
      const row = (level * 7 + i) % FOO_RAID_ROWS.length;
      return FOO_RAID_ROWS[row].flatMap((cell, col) =>
        cell[0] === "A"
          ? [{ frame, row, kind: "blobHead", col }]
          : cell[0] === "B"
          ? [{ frame, row, kind: "flyBrain", col }]
          : []
      );
    });
    assertEquals(planRaids(s, lock, end), expected, `stage ${s}`);
  }
});

Deno.test("a blobHead marches down foo's column, funnels across and fires every 5 s", () => {
  const lag = raiderLag("blobHead");
  assertEquals(lag, 20, "16 px at 0.8 px a frame");
  assertEquals(raiderLag("flyBrain"), 13);
  for (const stage of [1, 9]) {
    const rows = blobHeadRows(stage);
    // one gate, fireGateFrames long, open from the move the source fires
    // on: 5 s after it mounts the raider
    const open = rowFlagsByFrame(rows, 900).flatMap((f, k) =>
      f & ENTRY_NO_FIRE ? [] : [k]
    );
    assertEquals(
      open,
      [...Array(fireGateFrames(stage)).keys()].map((i) => 300 - lag - 1 + i),
    );
    for (let col = 0; col < 8; col++) {
      const { spawn, mirror, column } = raiderSpawn("blobHead", col);
      assertEquals(spawn.x, 16 + 16 * column, "on the wave grid");
      const run = runEntryScript(rows, spawn, mirror, 900);
      // past its 8 px sidestep, on foo's column, and where the source's is:
      // y -32 + 0.8 t from its mount
      for (const k of [10, 100, 200]) {
        assert(Math.abs(run[k].x - fooRaiderX("blobHead", col)) < 0.1);
        assert(Math.abs(run[k].y - (-32 + 0.8 * (k + lag))) < 0.3);
      }
      // from the funnel line, 1 px across to 0.8 down, toward the far side
      const k0 = Math.round((160 + 32) / 0.8) - lag;
      assert(Math.abs(run[k0].y - 160) < 0.5, `col ${col} funnels at y 160`);
      const dx = run[k0 + 100].x - run[k0].x;
      const dy = run[k0 + 100].y - run[k0].y;
      assert(Math.abs(Math.abs(dx) - 100) < 2 && Math.abs(dy - 80) < 2);
      assertEquals(Math.sign(dx), col < 4 ? 1 : -1);
      // and off that side, on the screen's height, its one gate behind it
      const gone = run.findIndex((p) => p.x < -40 || p.x > 296);
      assert(gone > open[open.length - 1] && run[gone].y < 480, `col ${col}`);
    }
  }
});

Deno.test("the 95-demo record: ten stages, its art, its boss", async () => {
  const { record, stages } = await buildLevel();
  assertEquals(record.name, "95-demo");
  assertEquals(record.gameId, "95-demo-8d9cd1fd");
  assertEquals(record.endsOnClear, true);
  assertEquals(record.noStory, true);
  assertEquals(Object.keys(record.stages).sort(), [
    "stage0",
    "stage1",
    "stage2",
    "stage3",
    "stage4",
    "stage5",
    "stage6",
    "stage7",
    "stage8",
    "stage9",
  ]);
  assertEquals(record.enemylist, record.stages.stage0.enemylist);

  let enemies = 0, raiders = 0;
  for (
    const [key, st] of Object.entries(record.stages) as [string, Stage][]
  ) {
    assertEquals(st.waveRows.length, st.enemylist.length, key);
    assertEquals(st.waveInterval, 2);
    // spawn order is bottom-up: due frames never run backwards
    const due = st.waveRows.slice().reverse();
    for (let i = 1; i < due.length; i++) assert(due[i] >= due[i - 1], key);
    assert(due.every((r: number) => r >= 30), `${key} row inside the screen`);
    for (const row of st.enemylist) {
      assertEquals(row.length, record.width);
      for (const cell of row) {
        if (cell === "00") continue;
        const rec = record.enemyData[`enemy${cell.slice(0, -1)}`];
        assert(rec, cell);
        if (cell[0] === "Z") {
          raiders++;
          assert(key !== "stage0", "no raids before the first boss");
          assertEquals(rec.blocksClear, false, cell);
        } else {
          enemies++;
          assertEquals(rec.blocksClear, undefined, cell);
        }
        assertEquals(cell.slice(-1), "0", "no item drops: the source has none");
      }
    }
  }
  assertEquals(
    enemies,
    Object.keys(record.enemyData).filter((k) => !k.startsWith("enemyZ"))
      .length,
  );
  assertEquals(
    enemies,
    STAGES.reduce((n, d) => n + planSlots(d).length, 0),
  );
  assertEquals(raiders, stages.reduce((n, s) => n + s.raiders.length, 0));
  for (const s of stages.slice(RAID_FIRST_STAGE)) {
    assert(s.raiders.length > 0, `stage ${s.stage} has raids`);
  }

  // The raiders: a blobHead a stage, scripted, its gun the stage's gate...
  for (const s of stages) {
    const blob = record.enemyData[`enemy${raiderKey("blobHead", s.stage)}`];
    if (!s.raiders.some((r) => r.kind === "blobHead")) continue;
    assertEquals([blob.name, blob.hp, blob.score], ["blobHead", 1, 100]);
    assertEquals(blob.dezaemon.entry.rows, blobHeadRows(s.stage));
    assertEquals(blob.dezaemon.behavior.fire.aimed, false);
    assertEquals(blob.bulletData.texture, ["ei95FooShot0", "ei95FooShot1"]);
  }
  // ...and the flyBrain on the plain path as the runtime's soliderA, whose
  // homing (x += 0.005 (ship x - x) from y 320) is foo's own; it never fires.
  const fly = record.enemyData[`enemy${raiderKey("flyBrain", 1)}`];
  assertEquals([fly.name, fly.hp, fly.score], ["soliderA", 2, 200]);
  assertEquals(fly.speed, 0.6, "1.2 px a frame, two ticks");
  assertEquals(fly.interval, -1);
  assertEquals(fly.dezaemon, undefined);
  assertEquals(FOO_HOMING_Y * 480 / GAME_HEIGHT, 480 / 1.5);
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  assert(
    bundle.includes(
      "var driftTo = enemy.y >= GH2 / 1.5 ? aimPlayer(scene) : null;",
    ),
  );
  for (const s of stages) {
    for (const e of s.enemies) assert(e.maxVisibleError <= 0.75 + 1e-9);
  }

  // A boss ends every stage: the source's roster, RedDevil, CoolInvader,
  // RainbowInvader, turning each stage, with hp climbing to the source's
  // figure on the tenth.
  assertEquals(
    Object.keys(record.bossData),
    STAGES.map((_, s) => `boss${s}`),
  );
  assertEquals(
    STAGES.map((_, s) => record.bossData[`boss${s}`].name),
    [
      "redDevil",
      "coolInvader",
      "rainbowInvader",
      "redDevil",
      "coolInvader",
      "rainbowInvader",
      "redDevil",
      "coolInvader",
      "rainbowInvader",
      "redDevil",
    ],
  );
  const boss = record.bossData.boss9;
  assertEquals(boss.attackPattern, "boss4");
  assertEquals(boss.hp, 86);
  assertEquals(boss.stage2.attackPattern, "boss1");
  assert(boss.stage2.hpBelow > 0.41 && boss.stage2.hpBelow < 0.42);
  const first = record.bossData.boss0;
  assertEquals(first.hp, 35); // 20 + 3 x 5: the devil and its trio, both at two fifths
  assertEquals(first.stage2.hpBelow, 0.4286);
  for (let s = 3; s < STAGES.length; s++) {
    assert(
      record.bossData[`boss${s}`].hp > record.bossData[`boss${s - 3}`].hp,
      `boss${s} outgrows the last of its kind`,
    );
  }
  const cool = record.bossData.boss1;
  assertEquals(cool.attackPattern, "boss1");
  assertEquals(cool.hp, 23);
  assertEquals(cool.anim.idle.length, 6);
  assertEquals(cool.bulletData.texture, [
    "ei95CoolInvaderShot0",
    "ei95CoolInvaderShot1",
  ]);
  const rainbow = record.bossData.boss2;
  assertEquals(rainbow.attackPattern, "boss1");
  assertEquals(rainbow.hp, 27);
  assertEquals(rainbow.bulletData.texture.length, RAINBOW_BULLET_TINTS.length);
  assertEquals(rainbow.bulletData.frameRate, 60);
  assertEquals(record.bossData.boss8.hp, 47);
  // Barlog's slides keep the Invaders and the butt-devil trio whole on the
  // screen; the RedDevil flies Fang's routine, which never slides it.
  for (let s = 0; s < STAGES.length; s++) {
    const b = record.bossData[`boss${s}`];
    if (b.name === "redDevil") {
      assertEquals(b.keepOnScreen, undefined, `boss${s}`);
      assertEquals(b.stage2.keepOnScreen, true, `boss${s} stage2`);
    } else {
      assertEquals(b.keepOnScreen, true, `boss${s} ${b.name}`);
    }
  }

  // The SP bomb's cut-in is rando's nine — what every custom game plays —
  // carried as the level's own under the stock names, so the eShop's web
  // build, a plain page the loader does not paint (neither ?level= nor an
  // exported app), shows them too: byte for byte the sheet's cells. The
  // sheet is as wide as the stock atlas it stacks under, so they take two
  // rows of the texture, not nine, and the stack fits a phone.
  assertEquals(record.ownCutin, true);
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
  const rows = new Set<number>();
  for (let i = 0; i < CUTIN_COUNT; i++) {
    const rect = record.atlasFrames[`cutin${i}․gif`].frame;
    assertEquals([rect.w, rect.h], [CUTIN.frameW, CUTIN.frameH], `cutin${i}`);
    rows.add(rect.y);
    assertEquals(
      cut(sheet, rect).data,
      gridFrame(rando, CUTIN, i).data,
      `cutin${i}`,
    );
  }
  assertEquals(rows.size, 2);
  assert(sheet.width <= stock.w, `${sheet.width} px wide: it widens the stack`);
  assert(
    stock.h + sheet.height <= TEXTURE_LIMIT,
    `${stock.h + sheet.height} rows`,
  );

  // keys RTDB takes, art the runtime finds
  assert(!JSON.stringify(Object.keys(record.atlasFrames)).includes("."));
  for (const k of ["atlasImageDataURL", "titleBgDataURL", "logoDataURL"]) {
    assert(String(record[k]).startsWith("data:image/png;base64,"), k);
  }
});

// --- the player's shots ------------------------------------------------------

Deno.test("rotateCw undoes rotateCcw: a dart pointing up comes out pointing right", () => {
  // A 1x3 dart, tip at the top.
  const dart = { width: 1, height: 3, data: new Uint8Array(12) };
  dart.data.set([30, 0, 0, 255], 0); // the tip
  dart.data.set([20, 0, 0, 255], 4);
  dart.data.set([10, 0, 0, 255], 8);
  const turned = rotateCw(dart);
  assertEquals([turned.width, turned.height], [3, 1]);
  assertEquals([...turned.data.slice(8, 12)], [30, 0, 0, 255]); // tip at right
  assertEquals([...rotateCcw(turned).data], [...dart.data]);
});

Deno.test("the player's shots fly pointing up: packed side-on, as the runtime turns them", async () => {
  // The runtime fires every player shot a quarter turn anticlockwise (the
  // stock shot00.gif is a 21x9 dart drawn pointing right). If this changes,
  // so must shotArt in build-level.ts.
  const shoot = lift(
    await read("static/games/2028-ai/game.bundle.js"),
    "shootBullets",
  );
  assert(shoot.includes("bullet.setRotation(-Math.PI / 2);"));
  assert(shoot.includes("b.setRotation(-Math.PI / 2 + a * 0.2);"));

  // So each frame a shoot record names, cut from the record's own sheet and
  // given that turn, is the source's art upright as the source draws it.
  const { record } = await buildLevel();
  const png = record.atlasImageDataURL.slice("data:image/png;base64,".length);
  const sheet = await decodePng(
    Uint8Array.from(atob(png), (c: string) => c.charCodeAt(0)),
  );
  const upright = new Map([[
    "ei95FighterShot",
    toFieldArt(
      await loadArt("player-bullet.png"),
      DRAW_SCALE.playerBullet,
      true,
    ),
  ]]);
  for (const [i, name] of ANIMS.purpleBubble.frames.entries()) {
    upright.set(
      `ei95Orb${i}`,
      toFieldArt(
        await atlasFrame("purpleOrb.png", "purpleOrb.json", name),
        DRAW_SCALE.purpleOrb,
        true,
      ),
    );
  }

  const named = new Set<string>();
  for (const key of ["shootNormal", "shootBig", "shoot3way"]) {
    for (const f of record.playerData[key].texture) named.add(f);
  }
  assertEquals([...named].sort(), [...upright.keys()].sort());
  for (const [name, art] of upright) {
    const rect = record.atlasFrames[name].frame;
    const shown = rotateCcw(cut(sheet, rect));
    assertEquals([shown.width, shown.height], [art.width, art.height], name);
    assertEquals(shown.data, art.data, name);
  }
  // The dart in particular is drawn tall and thin, so it is packed wide.
  const dart = record.atlasFrames.ei95FighterShot.frame;
  assert(dart.w > dart.h, `ei95FighterShot is ${dart.w}x${dart.h}`);
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

  // The record --apply writes, so an install plays the live game, scores and all.
  const { record } = await buildLevel();
  assertEquals(JSON.parse(byPath["foo.json"]), record);
  assertEquals(record.gameId, "95-demo-8d9cd1fd");

  const bundle = byPath["game.bundle.js"];
  assert(
    bundle.includes(LEVEL_PATCH.to),
    "the bundle reads 2028.Ai's foo.json",
  );
  assertEquals(bundle.includes(LEVEL_PATCH.from), false);
  assert(bundle.includes('var ASSET_BASE = "/games/2028-ai/";'));

  const html = byPath["index.html"];
  assert(html.includes(LAUNCHER_MARKER.trim()), "no launcher marker");
  assert(html.includes('<script src="game.bundle.js" defer></script>'));
  assert(html.includes(`<title>${TITLE}</title>`));
});

Deno.test("95-demo is listed as a web build, installed from this origin", async () => {
  const eshop = JSON.parse(await read("data/eshop.json"));
  const row = eshop.find((e: { id: string }) => e.id === "95-demo");
  assert(row, "data/eshop.json has no 95-demo entry");
  assertEquals(row.kind, "web");
  assertEquals(row.name, TITLE);
  assertEquals("shelf" in row, false, "it is no console's game");
  assertEquals(row.source, "url");
  assertEquals(row.downloadUrl, "/games/95-demo-web.zip");
  assertEquals(row.entry, "index.html");
  assertEquals(row.players, 2);
  assertEquals(row.icon, "/icons/95-demo-icon.png");
  assert((await Deno.stat(ICON)).isFile, "the icon the row points at ships");
  // The archive is a build artifact, not a committed file.
  assert((await read(".gitignore")).includes("static/games/95-demo-web.zip"));
  const tasks = JSON.parse(await read("deno.json")).tasks;
  assert(tasks["95-demo:zip"], "no 95-demo:zip task");
  assert(
    tasks.build.includes("deno task 95-demo:zip"),
    "deno task build does not pack the archive",
  );
});
