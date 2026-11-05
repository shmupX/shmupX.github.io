// ?bfg=1 — max weapon power, on any game the 2028-ai runtime plays.
//
// The web shot goes to its strongest (BIG: 2 damage, piercing) at the R
// drop's rapid cadence, and wherever the Dezaemon weapons run — a cart, or a
// web game in MOD on the crossover kit — the shot level (the OPTION count
// every MAIN / SUB / CHARGE table is indexed by) goes to the ship's own cap.
// It is armed wherever a ship is seeded and after every pickup, the editor's
// PLAY passes it on (a library game opens in the editor first), the Guide's
// Cheats list it, and like ?god=1 it keeps the run off WORLD BEST.
// game.bundle.js is a vendored artifact patched by hand (README), so this
// pins each half in it.

import { assert, assertEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const EDITOR = "static/editor/index.html";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** The source of `function <name>(…) { … }`, braces matched. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`function ${name}(`);
  assert(start >= 0, `no function ${name}`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

type Ship = Record<string, unknown>;

/** bfgArm over stubs: the flag, the player record and the ship it reads. */
async function arm(): Promise<
  (
    on: boolean,
    p: Ship,
    pd: Record<string, unknown>,
    ship: Ship | null,
  ) => Ship
> {
  const js = await read(BUNDLE);
  const src = functionSource(js, "bfgOn") + "\n" +
    functionSource(js, "bfgArm");
  return (on, p, pd, ship) => {
    new Function(
      "gameState",
      "playerRecord",
      "dezaShip",
      "PLAYER_STATES",
      "p",
      src + "\nbfgArm({}, p);",
    )(
      { bfgFlg: on },
      () => pd,
      () => ship,
      {
        SHOOT_NAME_BIG: "big",
        SHOOT_NAME_3WAY: "3way",
        SHOOT_SPEED_HIGH: "speed_high",
      },
      p,
    );
    return p;
  };
}

const WEB = {
  shootNormal: { damage: 1 },
  shootBig: { damage: 2 },
  shoot3way: { damage: 1 },
};
const fresh = () => ({
  index: 0,
  shootMode: "normal",
  shootSpeed: "speed_normal",
  dezaOptions: 0,
  dezaPower: 2,
});

Deno.test("without ?bfg=1 a ship is left exactly as it was seeded", async () => {
  const bfgArm = await arm();
  assertEquals(bfgArm(false, fresh(), WEB, { maxOptions: 4 }), fresh());
});

Deno.test("?bfg=1 maxes the web shot and a cart ship's shot level, never its speed", async () => {
  const bfgArm = await arm();
  // A cart: the ship's own cap.
  assertEquals(bfgArm(true, fresh(), WEB, { maxOptions: 3 }), {
    ...fresh(),
    shootMode: "big",
    shootSpeed: "speed_high",
    dezaOptions: 3,
  });
  // No cap named is the engine's 4; a cap past the 4-wide pod block is 4.
  assertEquals(bfgArm(true, fresh(), WEB, {}).dezaOptions, 4);
  assertEquals(bfgArm(true, fresh(), WEB, { maxOptions: 7 }).dezaOptions, 4);
  // A web game played OG has no Dezaemon weapons: the shot level stays put.
  assertEquals(bfgArm(true, fresh(), WEB, null), {
    ...fresh(),
    shootMode: "big",
    shootSpeed: "speed_high",
  });
  // A record with no BIG shot takes its 3-way, and one with neither keeps
  // the shot it has (shootBullets reads the mode's record unguarded).
  assertEquals(
    bfgArm(true, fresh(), { shootNormal: {}, shoot3way: {} }, null).shootMode,
    "3way",
  );
  assertEquals(
    bfgArm(true, fresh(), { shootNormal: {} }, null).shootMode,
    "normal",
  );
});

Deno.test("it is read once like ?god=1, armed wherever a ship is seeded, and again after every pickup", async () => {
  const js = await read(BUNDLE);
  assert(
    functionSource(js, "syncRuntimeFlagsFromLocation").includes(
      'state.bfgFlg = readBooleanSearchParam("bfg", typeof state.bfgFlg === "boolean" ? state.bfgFlg : false);',
    ),
    "the boot never reads ?bfg=",
  );
  // createPlayer and revivePlayer (which the ship stock's next ship goes
  // through too) both seed the ship's power and arm it straight after.
  assertEquals(
    js.split("    dezaSeedPower(scene, p);\n    bfgArm(scene, p);\n").length -
      1,
    2,
    "a ship is seeded somewhere without being armed",
  );
  assertEquals(
    js.split("dezaSeedPower(scene, p);").length - 1,
    2,
    "a new seeding site",
  );
  const collect = functionSource(js, "collectItem");
  assert(
    collect.endsWith(
      "    }\n    // ?bfg=1: no drop takes a maxed ship back down (a 3-way pickup would\n    // trade BIG for the spread and drop the rapid cadence).\n    bfgArm(scene, p);\n  }",
    ),
    "a pickup can take a maxed ship back down",
  );
});

Deno.test("a BFG run is no record, and the HUD's best does not climb with it", async () => {
  const js = await read(BUNDLE);
  const counts = new Function(
    "isExportedLevelApp",
    functionSource(js, "scoreCountsAsRecord") + "\nreturn scoreCountsAsRecord;",
  )(() => false) as (s: Record<string, unknown>) => boolean;
  assertEquals(counts({}), true);
  assertEquals(counts({ bfgFlg: true }), false);
  assertEquals(counts({ godFlg: true }), false);
  assert(
    js.includes(
      "var best = scoreCountsAsRecord() ? Math.max(getDisplayedHighScore(), this.scoreCount) : getDisplayedHighScore();",
    ),
    "the HUD shows a cheat run's score as WORLD BEST",
  );
});

Deno.test("the Guide's Cheats list it and the editor's PLAY passes it on", async () => {
  const js = await read(BUNDLE);
  assert(
    functionSource(js, "cmgBroadcastCheats").includes(
      '{ param: "bfg", kind: "toggle", label: "BFG (Max Weapons)", on: "1" }',
    ),
    "no BFG row in the Cheats",
  );
  const editor = await read(EDITOR);
  assert(
    functionSource(editor, "debugPlayParams").includes(
      "if (q.get('bfg') === '1') out += '&bfg=1';",
    ),
    "a library game opened with ?bfg=1 loses it at the hand-off",
  );
});
