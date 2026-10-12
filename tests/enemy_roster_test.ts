// The SELECT ENEMY picker edits the roster it lists.
//
// A new game is buildBlankGame()'s record — one enemy, enemyA — and the picker
// only ever listed enemyData, so after CHOOSE YOUR CHARACTER it showed soliderA
// and no road to a second. Now each entry carries an × that takes the enemy
// out of the game, and an add row brings one in from the stock roster (the
// enemyData the editor booted on, whose frames are in game_asset), the shared
// character library, or a blank record. The two rules below are the ones the
// runtime and game-schema.js hold the editor to: a removed enemy's cells go
// with it on every stage (a cell naming an enemy the record lacks is a schema
// error, and the runtime draws it as the player ship), and nothing is offered
// whose frames the atlas cannot draw.

import { assert, assertEquals } from "@std/assert";

const EDITOR = "static/editor/index.html";
const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the editor's main script, by name, as source. */
function functionSource(html: string, name: string): string {
  let start = html.indexOf(`\n        function ${name}(`);
  if (start < 0) start = html.indexOf(`\n        async function ${name}(`);
  assert(start >= 0, `no ${name} in ${EDITOR}`);
  const end = html.indexOf("\n        }\n", start);
  assert(end > start, `${name} does not close`);
  return html.slice(start, end + 11);
}

type Game = Record<string, unknown>;
type Counts = { cells: number; stages: number };

async function enemyCellsOf() {
  const html = await read(EDITOR);
  const src = functionSource(html, "cellEnemyLetter") +
    functionSource(html, "enemyCellsOf");
  return new Function(
    "game",
    "letter",
    "clear",
    src + "\nreturn enemyCellsOf(game, letter, clear);",
  ) as (game: Game, letter: string, clear: boolean) => Counts;
}

async function stockEnemyChoices() {
  const html = await read(EDITOR);
  const src = functionSource(html, "entryFrameNames") +
    functionSource(html, "stockEnemyChoices");
  return new Function(
    "roster",
    "enemies",
    "frames",
    src + "\nreturn stockEnemyChoices(roster, enemies, frames);",
  ) as (roster: Game, enemies: Game, frames: Game) => string[];
}

const game = () => ({
  stage0: { enemylist: [["A0", "00", "AB1"], ["B2", "A3", "00"]] },
  stage1: { enemylist: [["00", "A0", "00"]] },
  stage2: { enemylist: [["B0", "00", "AB0"]] },
  // Not a stage: never read, never touched.
  stageBackgrounds: { stage0: "x" },
  enemyData: { enemyA: {}, enemyB: {}, enemyAB: {} },
});

Deno.test("removing an enemy clears exactly its cells, on every stage, and counts them first", async () => {
  const run = await enemyCellsOf();
  const g = game();
  // A dry run reports and changes nothing.
  assertEquals(run(g, "A", false), { cells: 3, stages: 2 });
  assertEquals(g.stage0.enemylist, [["A0", "00", "AB1"], ["B2", "A3", "00"]]);
  // Clearing takes "A" and leaves "AB" — the whole letter run, as the runtime
  // reads a cell — and other enemies, with their item drops, where they were.
  assertEquals(run(g, "A", true), { cells: 3, stages: 2 });
  assertEquals(g.stage0.enemylist, [["00", "00", "AB1"], ["B2", "00", "00"]]);
  assertEquals(g.stage1.enemylist, [["00", "00", "00"]]);
  assertEquals(g.stage2.enemylist, [["B0", "00", "AB0"]]);
  assertEquals(run(g, "A", false), { cells: 0, stages: 0 });
  assertEquals(run(g, "AB", false), { cells: 2, stages: 2 });
  // A stage with no grid, and no game at all, are nothing to clear.
  assertEquals(run({ stage0: {}, stage1: null }, "A", true), {
    cells: 0,
    stages: 0,
  });
  assertEquals(run(null as unknown as Game, "A", true), {
    cells: 0,
    stages: 0,
  });
});

Deno.test("the stock list offers what this game lacks and the atlas can draw", async () => {
  const run = await stockEnemyChoices();
  const roster = {
    enemyA: {
      name: "soliderA",
      texture: ["soliderA0.gif"],
      bulletData: { texture: ["normalProjectile0.gif"] },
    },
    enemyB: { name: "soliderB", texture: ["soliderB0.gif"] },
    enemyD: {
      name: "tora",
      texture: ["tora0.gif"],
      bulletData: { texture: ["toraShot0.gif"] },
    },
    enemyP: { name: "drum", texture: ["drum.gif"] },
  };
  const frames = {
    "soliderA0.gif": {},
    "soliderB0.gif": {},
    "tora0.gif": {},
    "drum.gif": {},
    "normalProjectile0.gif": {},
  };
  // soliderA is in the game under another key: still soliderA, not offered
  // twice. tora's bullet art is not in this atlas: not offered at all.
  const inGame = { enemyC: { name: "soliderA", texture: ["soliderA0.gif"] } };
  assertEquals(run(roster, inGame, frames), ["enemyB", "enemyP"]);
  // An empty game takes everything the atlas can draw; no atlas draws nothing.
  assertEquals(run(roster, {}, frames), ["enemyA", "enemyB", "enemyP"]);
  assertEquals(run(roster, {}, {}), []);
  assertEquals(run({}, {}, frames), []);
});

Deno.test("the picker, the boot load and the CHARACTER EDITOR agree on the roster", async () => {
  const html = await read(EDITOR);
  // The add row and the stock list sit in the SELECT ENEMY sheet.
  const picker = html.slice(
    html.indexOf('id="enemy-picker-overlay"'),
    html.indexOf('id="powerup-picker-overlay"'),
  );
  for (
    const needle of [
      'onclick="toggleStockEnemyList()"',
      'onclick="openCharacterLibrary()"',
      'onclick="newEnemyFromPicker()"',
      'id="enemy-picker-stock"',
      "× REMOVES FROM THIS GAME",
    ]
  ) assert(picker.includes(needle), `the picker lacks ${needle}`);
  // Every entry carries the ×, and a tap on it arms nothing.
  const populate = functionSource(html, "populateEnemyPicker");
  assert(populate.includes("rm.className = 'opt-remove'"));
  assert(
    populate.includes(
      "e.stopPropagation(); e.preventDefault(); removeEnemyFromGame(ek);",
    ),
  );
  // The stock roster is what the editor booted on, and + STOCK reads it
  // through the same relative fetch the boot does (rewritten onto GAME_BASE).
  assert(
    html.includes(
      "stockEnemyRoster = dezaClone(gameData.enemyData || {});   // what + STOCK offers",
    ),
  );
  assert(
    functionSource(html, "loadStockEnemyRoster").includes(
      "fetch('assets/game.json')",
    ),
  );
  // Removal disarms a removed enemy, re-reads the cleared grid, and drops the
  // editor form that could hand the record back on Save.
  const remove = functionSource(html, "removeEnemyFromGame");
  assert(
    remove.includes("commitCurrentGrid();"),
    "the working grid is not committed before the count",
  );
  assert(remove.includes("enemyCellsOf(gameData, letter, true);"));
  assert(remove.includes("if (selectedEnemyFullKey === key) {"));
  assert(remove.includes("if (currentEnemyKey === key) {"));
  assert(remove.includes("loadCurrentStage();"));
  // The CHARACTER EDITOR's list keeps the picker in step, and has the same
  // DELETE — on the Enemies tab only.
  assert(
    functionSource(html, "renderEnemyList").includes(
      "refreshEnemyPickerIfOpen();",
    ),
  );
  assert(
    html.includes('id="char-del-btn" onclick="deleteCurrentEnemyEntry()"'),
  );
  assert(
    functionSource(html, "switchEditorTab").includes(
      "delBtn.style.display = tab === 'enemies' ? '' : 'none'",
    ),
  );
});
