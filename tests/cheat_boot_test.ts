// The launcher's Cheats are boot-time URL params the Guide writes into the
// game frame's URL — Start Stage (?stage=N), Boss Rush (?bossRush=1), Akuma
// Boss (?boss=goki), Final Boss (?finalBoss=1) — and the runtime reads them
// into gameState as the level resolves. The eShop's 2019 web build then showed
// its title like any plain visit (no ?level=), and the title's START
// (goToAdvScene) began a fresh run over them: stage 0, the whole wave, no
// Akuma. The editor's hand-off never saw it, because ?editorPlay=1 skips the
// title. game.bundle.js is a vendored artifact patched by hand (README), so
// this pins the three halves of the fix in it: one reader for the four, the
// title skipped when a boot asks for one, and the cheats laid back over a run
// started from the title.

import { assert, assertEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

// The checkout may carry CRLF; every anchor below is written with LF.
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

/**
 * cmgCheatStart as a callable, over a stub window. lastStageId is the only
 * other name it reaches for; parseStageId / DEFAULTS / gameState belong to
 * cmgApplyCheatStart, which is pinned by text below.
 */
async function cheatStart(): Promise<
  (search: string, last?: number) => unknown
> {
  const src = functionSource(await read(BUNDLE), "cmgCheatStart");
  return (search, last = 4) =>
    new Function(
      "window",
      "lastStageId",
      src + "\nreturn cmgCheatStart({});",
    )({ location: { search } }, () => last);
}

Deno.test("a plain boot, or Mod Mode alone, asks for no start of its own", async () => {
  const start = await cheatStart();
  assertEquals(start(""), null);
  assertEquals(start("?version=mod"), null);
  assertEquals(start("?level=foo&god=1"), null);
  // Unset is unset: an empty stage or a bossRush that is not "1".
  assertEquals(start("?stage="), null);
  assertEquals(start("?bossRush=0"), null);
});

Deno.test("Start Stage, Boss Rush, Akuma and Final Boss each read as the boot read them", async () => {
  const start = await cheatStart();
  assertEquals(start("?stage=2"), {
    stageId: "2",
    bossRush: false,
    forceBoss: null,
  });
  assertEquals(start("?bossRush=1"), {
    stageId: null,
    bossRush: true,
    forceBoss: null,
  });
  // Akuma is 2028.Ai's fixed stage-3 fight; an explicit stage still wins.
  assertEquals(start("?boss=goki"), {
    stageId: 3,
    bossRush: true,
    forceBoss: "goki",
  });
  assertEquals(start("?boss=goki&stage=1"), {
    stageId: "1",
    bossRush: true,
    forceBoss: "goki",
  });
  // Final Boss is whatever the level's last stage is, at its boss.
  assertEquals(start("?finalBoss=1", 4), {
    stageId: 4,
    bossRush: true,
    forceBoss: null,
  });
  assertEquals(start("?finalBoss=1&stage=0", 7), {
    stageId: 7,
    bossRush: true,
    forceBoss: null,
  });
  // Mod Mode beside a cheat changes nothing about the start.
  assertEquals(start("?version=mod&bossRush=1"), {
    stageId: null,
    bossRush: true,
    forceBoss: null,
  });
});

Deno.test("the boot primes the level, lays the cheats over it, and skips the title when one is asked", async () => {
  const js = await read(BUNDLE);
  // One reader. The inline copy onPrimeState used to carry is gone.
  assertEquals(
    js.split("function cmgCheatStart(recipe) {").length - 1,
    1,
    "cmgCheatStart defined once",
  );
  assert(
    js.includes(
      "          primeGameStateForStage2(recipe, info.stageId);\n" +
        "          if (info.bossRush) gameState.shortFlg = true;\n" +
        "          // The Guide's cheats, over that: see cmgCheatStart above.\n" +
        "          cmgApplyCheatStart(recipe);\n",
    ),
    "onPrimeState does not lay the cheats over the primed state",
  );
  assert(
    !js.includes('              gameState.forceBossName = "goki";'),
    "onPrimeState still reads ?boss=goki on its own",
  );
  // A cheat boot goes where it asks, before the scene-script and Dezaemon
  // title overrides get a say.
  assert(
    js.includes(
      '          let nextScene = result.showTitle ? "PhaserTitleScene" : "PhaserGameScene";\n' +
        "          if (cmgCheatStart(gameState._phaserRecipe)) {\n",
    ),
    "the boot does not ask cmgCheatStart before choosing the first scene",
  );
  const skip = js.indexOf("if (cmgCheatStart(gameState._phaserRecipe)) {");
  const branch = js.slice(skip, js.indexOf("} else if", skip));
  assert(
    branch.includes('nextScene = "PhaserGameScene";'),
    "a cheat boot does not go straight to the stage",
  );
});

Deno.test("START on the title keeps a cheat the Guide still shows switched on", async () => {
  const js = await read(BUNDLE);
  // goToAdvScene is the one place the fresh-run reset lives.
  const resets = js.split("      gameState.forceBossName = null;\n");
  assertEquals(resets.length - 1, 1, "one fresh-run reset");
  const after = resets[1].slice(0, 500);
  assert(
    after.includes("      cmgApplyCheatStart(recipe);\n      var game = this.game;\n"),
    "goToAdvScene resets the run without laying the cheats back",
  );
  // And what it lays back: the stage (clamped as the boot clamps it), the
  // boss-rush flag and Akuma — never the other way around.
  const apply = functionSource(js, "cmgApplyCheatStart");
  assert(apply.includes("gameState.stageId = parseStageId(cheat.stageId, DEFAULTS.maxStage);"));
  assert(apply.includes("if (cheat.bossRush) gameState.shortFlg = true;"));
  assert(apply.includes("if (cheat.forceBoss) gameState.forceBossName = cheat.forceBoss;"));
  assert(!apply.includes("shortFlg = false"), "cmgApplyCheatStart clears a flag");
});
