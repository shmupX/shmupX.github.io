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
// frame it names packed, keys RTDB takes, the schema's shape, and the boss.

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
import { STAGES } from "../scripts/95-demo/source.ts";
import {
  buildArt,
  buildLevel,
  buildStage,
  enemyLetters,
  fireGateFrames,
  HORIZON_MS,
  SEED,
} from "../scripts/95-demo/build-level.ts";

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
  assert(create.includes('String(liveRow[lc]) !== "00"'));
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

  let enemies = 0;
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
        enemies++;
        assert(record.enemyData[`enemy${cell.slice(0, -1)}`], cell);
        assertEquals(cell.slice(-1), "0", "no item drops: the source has none");
      }
    }
  }
  assertEquals(enemies, Object.keys(record.enemyData).length);
  assertEquals(
    enemies,
    STAGES.reduce((n, d) => n + planSlots(d).length, 0),
  );
  for (const s of stages) {
    for (const e of s.enemies) assert(e.maxVisibleError <= 0.75 + 1e-9);
  }

  const boss = record.bossData.boss9;
  assertEquals(Object.keys(record.bossData), ["boss9"]);
  assertEquals(boss.attackPattern, "boss4");
  assertEquals(boss.hp, 86);
  assertEquals(boss.stage2.attackPattern, "boss1");
  assert(boss.stage2.hpBelow > 0.41 && boss.stage2.hpBelow < 0.42);

  // keys RTDB takes, art the runtime finds
  assert(!JSON.stringify(Object.keys(record.atlasFrames)).includes("."));
  for (const k of ["atlasImageDataURL", "titleBgDataURL", "logoDataURL"]) {
    assert(String(record[k]).startsWith("data:image/png;base64,"), k);
  }
});
