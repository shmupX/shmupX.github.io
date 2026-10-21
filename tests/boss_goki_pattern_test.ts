// Akuma's routine for an Akuma who is not the hidden boss.
//
// An Akuma imported from the 2019 game and made a stage's boss (the cloud
// game "rando" fights him second) flew that slot's stock routine — boss1's is
// Barlog's — with his own bullets and in his idle pose throughout: his
// stances (SHOOT-A, SHOOT-B, the Ashura warp) were only built by the hidden
// boss's entrance, and his routine only ran for the hidden boss. The runtime
// (game.bundle.js, a vendored artifact patched by hand — README) now runs his
// routine for any record carrying his stances, and for `attackPattern:
// "bossExtra"`, the GOKI pattern the editor's Boss Lab writes; the lab and
// the editor say the same.

import { assert, assertEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

// deno-lint-ignore no-explicit-any
type Json = any;

async function stock(): Promise<Json> {
  return JSON.parse(await read("static/games/2028-ai/assets/game.json"))
    .bossData;
}

async function patternSlot() {
  const js = await read(BUNDLE);
  assert(js.includes('\n  var GOKI_PATTERN = "goki";\n'), "no GOKI_PATTERN");
  return new Function(
    'var GOKI_PATTERN = "goki";' + functionSource(js, "isGokiRecord") +
      functionSource(js, "bossPatternSlot") + "\nreturn bossPatternSlot;",
  )() as (bossData: unknown, stageId: number) => number | string;
}

Deno.test("Akuma's record runs his own routine in whatever slot it sits", async () => {
  const slot = await patternSlot();
  const bosses = await stock();
  // rando's shape: the stock Akuma, unpinned, as stage 1's boss.
  assertEquals(slot(bosses.bossExtra, 1), "goki");
  // Every other stock boss still runs the slot it sits in.
  for (const key of ["boss0", "boss1", "boss2", "boss3", "boss4"]) {
    assertEquals(slot(bosses[key], 1), 1, key);
  }
  assertEquals(slot(null, 2), 2);
  // He is known by his name, not his stances: the shipped game's boss2,
  // trump, is drawn on Akuma's stance set and flies his routine only
  // because he is pinned to it.
  const shipped = JSON.parse(await read("static/games/2028-ai/foo.json"));
  const trump = shipped.bossData.boss2;
  assert(trump.anim.syngoku, "boss2 no longer wears Akuma's set");
  assertEquals(trump.attackPattern, "bossExtra");
  assertEquals(slot(trump, 2), "goki");
  assertEquals(slot({ ...trump, attackPattern: undefined }, 2), 2);
});

Deno.test("attackPattern pins a routine, and bossExtra pins Akuma's", async () => {
  const slot = await patternSlot();
  const bosses = await stock();
  // The Boss Lab's GOKI pick fell through to the slot's routine before.
  assertEquals(
    slot({ ...bosses.boss3, attackPattern: "bossExtra" }, 1),
    "goki",
  );
  // An Akuma pinned elsewhere flies where he is pinned.
  assertEquals(slot({ ...bosses.bossExtra, attackPattern: "boss3" }, 1), 3);
  // An unknown pin is the slot's, as it always was.
  assertEquals(slot({ ...bosses.boss1, attackPattern: "nobody" }, 1), 1);
});

async function shootStart() {
  const js = await read(BUNDLE);
  const calls: string[] = [];
  const run = new Function(
    "calls",
    "scene",
    'var GOKI_PATTERN = "goki";' +
      functionSource(js, "isGokiRecord") +
      functionSource(js, "bossPatternSlot") +
      functionSource(js, "bossStage2Due") +
      functionSource(js, "bossShootStart") +
      `
      function _bossAlive() { return true; }
      function startDezaBoss() { calls.push("deza"); }
      function bossPatternGoki() { calls.push("goki"); }
      function bossPatternPyramid() { calls.push("pyramid"); }
      function bossPatternBarlog() { calls.push("barlog"); }
      function bossPatternSagat() { calls.push("sagat"); }
      function bossPatternVega() { calls.push("vega"); }
      function bossPatternFang() { calls.push("fang"); }
      bossShootStart(scene);`,
  );
  return (scene: Json) => {
    calls.length = 0;
    run(calls, scene);
    return calls[0];
  };
}

Deno.test("bossShootStart flies Akuma's routine for his record and for a GOKI pin", async () => {
  const shoot = await shootStart();
  const bosses = await stock();
  const scene = (boss1: Json, bossIsGoki: boolean) => ({
    recipe: { bossData: { boss1 } },
    bossStageId: 1,
    bossIsGoki,
  });
  // bossAdd marks his own record bossIsGoki.
  assertEquals(shoot(scene(bosses.bossExtra, true)), "goki");
  // Someone else pinned to his routine reaches it through the switch.
  assertEquals(
    shoot(scene({ ...bosses.boss3, attackPattern: "bossExtra" }, false)),
    "goki",
  );
  assertEquals(shoot(scene(bosses.boss1, false)), "barlog");
});

async function grabs() {
  const js = await read(BUNDLE);
  return new Function(
    'var GOKI_PATTERN = "goki"; var BOSS_STAGE2_HP_BELOW = 0.5;' +
      ' var BOSS_WEAPON_SUFFIXES = ["", "A", "B", "C"];' +
      functionSource(js, "isGokiRecord") +
      functionSource(js, "bossPatternSlot") +
      functionSource(js, "bossStage2Record") +
      functionSource(js, "bossGrabs") +
      "\nreturn { bossGrabs, bossStage2Record };",
  )() as {
    bossGrabs: (scene: unknown) => boolean;
    bossStage2Record: (bossData: unknown) => Json;
  };
}

// rando's trump and gs's Daltonius fly Akuma's routine by their
// "bossExtra" pin, but a ship that met one on his Ashura dive lost 1 hp, as
// against any boss: only a record named goki grabbed.
Deno.test("a boss flying Akuma's routine grabs a ship that touches it", async () => {
  const { bossGrabs, bossStage2Record } = await grabs();
  const bosses = await stock();
  const shipped = JSON.parse(await read("static/games/2028-ai/foo.json"));
  const scene = (key: string, boss: Json, extra: Json = {}) => ({
    recipe: { bossData: { [key]: boss } },
    bossStageId: Number(key.slice(4)),
    bossIsGoki: false,
    ...extra,
  });
  // Akuma himself, and the hidden boss's takeover, as before.
  assert(bossGrabs(scene("boss1", bosses.bossExtra, { bossIsGoki: true })));
  // trump, pinned to his routine as boss2 (rando's and the shipped game's).
  assert(bossGrabs(scene("boss2", shipped.bossData.boss2)));
  // Daltonius's shape: pinned, and stage 2 keeps the pin unless it names its
  // own routine.
  const pinned = { ...bosses.boss1, attackPattern: "bossExtra" };
  const dragon = bossStage2Record({ ...pinned, stage2: { anim: {} } });
  assert(bossGrabs(scene("boss1", pinned)));
  assert(
    bossGrabs(scene("boss1", pinned, {
      bossStage2: dragon,
      bossStage2Done: true,
    })),
  );
  assert(
    !bossGrabs(scene("boss1", pinned, {
      bossStage2: { ...dragon, attackPattern: "boss1" },
      bossStage2Done: true,
    })),
  );
  // Every other routine scrapes, and so does a Dezaemon boss whatever its pin
  // (bossShootStart flies its own fire points).
  for (const key of ["boss0", "boss1", "boss2", "boss3", "boss4"]) {
    assert(!bossGrabs(scene(key, bosses[key])), key);
  }
  assert(!bossGrabs(scene("boss1", pinned, { dezaBossState: {} })));
  assert(!bossGrabs(scene("boss1", null)));
  // The ship-contact branch asks it.
  const js = await read(BUNDLE);
  assert(
    js.includes(
      "          if (bossGrabs(this) && !p.hurtFlg && !p.dezaBombInvuln && !p.barrierActive) {\n",
    ),
    "contact ignores it",
  );
  assert(!js.includes("          if (this.bossIsGoki) {\n"), "still by name");
});

Deno.test("bossAdd builds Akuma's stances for his routine and makes his record Akuma", async () => {
  const js = await read(BUNDLE);
  const src = functionSource(js, "bossAdd");
  // The stances are built by armBossStances, which a boss's second stage
  // calls again with its own record.
  assert(src.includes("armBossStances(scene, bossData, patternSlot);"));
  const stances = functionSource(js, "armBossStances");
  assert(
    stances.includes("if (patternSlot === GOKI_PATTERN) {"),
    "no Goki stances",
  );
  for (
    const stance of [
      "gokiAnimIdle",
      "gokiAnimShootA",
      "gokiAnimShootB",
      "gokiAnimSyngoku",
      "gokiAnimSyngokuFinish",
      "gokiAnimSyngokuFinishTen",
    ]
  ) {
    assert(stances.includes(`scene.${stance} = `), `${stance} is not built`);
  }
  assert(src.includes("if (patternSlot === GOKI_PATTERN) {"));
  assert(src.includes("scene.bossIsGoki = isGokiRecord(bossData);"));
  // His own entrance voice, not the slot's.
  assert(src.includes('(scene.bossIsGoki ? "goki" :'));
});

Deno.test("the Boss Lab and the editor name Akuma's own routine as the runtime runs it", async () => {
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  g.window = globalThis;
  try {
    new Function(await read("static/editor/boss-lab.js"))();
    const lab = g.BossLab as {
      ownPattern: (key: string, rec: unknown) => string;
      PAT: Record<string, { label: string }>;
    };
    const bosses = await stock();
    assertEquals(lab.ownPattern("boss1", bosses.bossExtra), "bossExtra");
    assertEquals(
      lab.PAT[lab.ownPattern("boss1", bosses.bossExtra)].label,
      "GOKI",
    );
    assertEquals(lab.ownPattern("boss1", bosses.boss1), "boss1");
  } finally {
    delete g.BossLab;
    if (!had) delete g.window;
  }
  const labSrc = await read("static/editor/boss-lab.js");
  assert(labSrc.includes("return v || this.ownKey(k);"), "effKey ignores it");
  const editor = await read("static/editor/index.html");
  // The boss strip's DEFAULT label, and the mod overlay a cart export keeps.
  assert(editor.includes("BossLab.ownPattern(key, entry)"));
  assert(editor.includes("BossLab.ownPattern(k, b)"));
});

// The grab gives the world back when the run survives it.
//
// gokiPlayerAttack stops time, lands its hit and shows the KO, and only god
// mode ever lifted the stop: a web game's ship died of the hit and the run
// went to CONTINUE?, so nothing else had to. A ship out of a stock — a cart
// played OG, or the 3-HIT SHIP off — is replaced inside the hit
// (dezaNextShip), a shielded one survives it, a second player may still be
// flying: the fight then sat frozen on the KO for good, the button dark and
// Akuma idle (rando's Akuma, reproduced in a headless Chromium: theWorldFlg
// up 900 frames after the grab with the next ship in the air). The grab now
// keeps what it draws and, with a player still flying and the run not ended,
// fades the KO and hands back to bossShootStart, as god mode did.
Deno.test("the grab gives the world back when a ship survives it", async () => {
  const js = await read(BUNDLE);
  const grab = functionSource(js, "gokiPlayerAttack");
  assert(
    grab.includes(
      "if (!gameState.godFlg && !scene._runEnded && !allPlayersDead(scene)) {",
    ),
    "a run that survives the grab is not given the world back",
  );
  // Both roads back are the one function, god mode's included.
  assertEquals(grab.split("_gokiGrabResume(scene);").length - 1, 2);
  assertEquals(
    grab.split("scene.time.delayedCall(GOKI_GRAB_RESUME_MS, function() {")
      .length - 1,
    2,
  );
  assert(js.includes("\n  var GOKI_GRAB_RESUME_MS = 800;\n"));
  // The resume waits on the KO, which the hit is 300 ms ahead of.
  assert(
    grab.indexOf("scene.time.delayedCall(3e3, function() {") <
      grab.lastIndexOf("_gokiGrabResume(scene);"),
  );
  assert(grab.includes("scene.showAkebonoFinish();"));
  // What the grab and the KO draw is kept, so the resume can take it down.
  assert(
    grab.includes(
      "_keepAkebonoOverlay(scene, [akebonoBg, akebonoTen, akebonoTenShock]);",
    ),
  );
  const ko = functionSource(js, "showAkebonoFinish");
  assert(ko.includes("_keepAkebonoOverlay(scene, [akebonoBg, koK, koO]);"));
  // And a ship the grab's own hit would bounce off — blinking after a hit
  // or a respawn, under a bomb, behind a barrier — is not caught: the next
  // ship out of the stock arrives blinking under the Akuma who took the last.
  assert(
    js.includes(
      "if (bossGrabs(this) && !p.hurtFlg && !p.dezaBombInvuln && !p.barrierActive) {",
    ),
    "a ship that cannot be hit is still caught",
  );
  const resume = functionSource(js, "_gokiGrabResume");
  for (
    const line of [
      "clearAkebonoOverlays(scene);",
      "scene.theWorldFlg = false;",
      "if (scene.spBtn) scene.spBtn.setAlpha(1);",
      "bossShootStart(scene);",
    ]
  ) assert(resume.includes(line), `the resume lacks ${line}`);
});

Deno.test("clearAkebonoOverlays fades what is still up and destroys it, once", async () => {
  const js = await read(BUNDLE);
  const sandbox = new Function(
    functionSource(js, "_keepAkebonoOverlay") +
      functionSource(js, "clearAkebonoOverlays") +
      "\nreturn { keep: _keepAkebonoOverlay, clear: clearAkebonoOverlays };",
  )() as {
    keep: (scene: unknown, sprites: unknown[]) => void;
    clear: (scene: unknown) => void;
  };
  type Sprite = { active: boolean; destroyed: number; destroy: () => void };
  const sprite = (active: boolean): Sprite => {
    const s: Sprite = {
      active,
      destroyed: 0,
      destroy: () => {
        s.destroyed++;
        s.active = false;
      },
    };
    return s;
  };
  const killed: unknown[] = [];
  const tweens: {
    targets: Sprite[];
    alpha: number;
    duration: number;
    onComplete: () => void;
  }[] = [];
  const scene = {
    akebonoOverlays: undefined as unknown,
    akebonoBgSprite: {} as unknown,
    tweens: {
      killTweensOf: (t: unknown) => killed.push(t),
      add: (cfg: (typeof tweens)[number]) => tweens.push(cfg),
    },
  };
  const bg = sprite(true),
    ten = sprite(true),
    gone = sprite(false),
    k = sprite(true);
  sandbox.keep(scene, [bg, ten, gone]);
  sandbox.keep(scene, [k]);
  assertEquals((scene.akebonoOverlays as unknown[]).length, 4);
  sandbox.clear(scene);
  // Only what is still on the screen is faded; its own tweens (the 天's
  // scale and the shock ring's) are stopped first so they cannot fight the
  // fade.
  assertEquals(killed, [bg, ten, k]);
  assertEquals(tweens.length, 1);
  assertEquals(tweens[0].targets, [bg, ten, k]);
  assertEquals(tweens[0].alpha, 0);
  assertEquals(tweens[0].duration, 300);
  assertEquals((scene.akebonoOverlays as unknown[]).length, 0);
  assertEquals(scene.akebonoBgSprite, null);
  tweens[0].onComplete();
  assertEquals([bg.destroyed, ten.destroyed, gone.destroyed, k.destroyed], [
    1,
    1,
    0,
    1,
  ]);
  // A second clear, with nothing kept, adds no tween.
  sandbox.clear(scene);
  assertEquals(tweens.length, 1);
});
