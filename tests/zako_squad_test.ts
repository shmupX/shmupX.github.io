// What a Dezaemon zako takes with it into another game: its SQUAD.
//
// The Ambition of Valkyrie's stage 3 motorcycle is four records. The upright
// bike (32) rides straight down; two more (33, 34) are the same bike leaning
// into a bend, on a diagonal entry path of their own; and a shot bike's death
// word spawns 35, the rider tumbling down the road. The mapper links that
// rider by roster KEY (`dezaemon.deathChild: 'enemyAZ'`), which means nothing
// outside Valkyrie: the motorcycle, published to the character library and
// imported into rando, pointed at an enemyAZ rando does not have, and nothing
// carried the lean poses at all. So a bike shot in rando's first stage left
// no rider behind, and none of them ever turned.
//
// Publishing now writes the squad down (extract-mode.js `zakoTravelRecord`):
// the poses, records identical to the zako in every byte but the appearance
// id and drawn in art of their own, and every record a death word of theirs
// spawns, under the keys they had. The editor's import re-keys the squad into
// the new roster and rewrites the links (`adoptSquad`). It walks the squad
// last, so a record that gains one keeps its own frames' numbers, and a game
// that imported it before (rando's motorcycle_deza2_32_<n>.png) still resolves.

import { assert, assertEquals } from "@std/assert";

type Rec = Record<string, unknown>;
type Roster = Record<string, Rec>;
interface Extract {
  zakoTravelRecord(recipe: Rec, record: Rec, key: string): Rec;
  collectFrameNames(record: Rec): string[];
}

/** Load the browser script under a window just real enough for its load-time arming. */
async function loadExtract(): Promise<Extract> {
  const src = await Deno.readTextFile(
    new URL("../static/phaser-plugins/extract-mode.js", import.meta.url),
  );
  const noop = () => {};
  const document = {
    getElementById: () => null,
    body: { appendChild: noop },
    readyState: "complete",
    addEventListener: noop,
    createElement: () => ({
      style: {},
      appendChild: noop,
      addEventListener: noop,
    }),
  };
  const win: Rec = {
    addEventListener: noop,
    removeEventListener: noop,
    postMessage: noop,
    document,
    location: {
      pathname: "/games/2028-ai/",
      search: "",
      origin: "http://localhost",
    },
    navigator: { onLine: true },
  };
  win.parent = win;
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  new Function(
    "window",
    "document",
    "MutationObserver",
    "navigator",
    "localStorage",
    src,
  )(win, document, MutationObserver, win.navigator, {});
  const ex = win.ShmupExtract as Extract | undefined;
  assert(
    ex && typeof ex.zakoTravelRecord === "function",
    "ShmupExtract loaded",
  );
  return ex;
}

const EDITOR = "static/editor/index.html";

/** One top-level function of the editor's main script, by name, as source. */
async function editorFunction<T>(name: string, call: string): Promise<T> {
  const html = (await Deno.readTextFile(
    new URL(`../${EDITOR}`, import.meta.url),
  )).replaceAll("\r\n", "\n");
  const start = html.indexOf(`\n        function ${name}(`);
  assert(start >= 0, `no ${name} in ${EDITOR}`);
  const end = html.indexOf("\n        }\n", start);
  assert(end > start, `${name} does not close`);
  return new Function(`${html.slice(start, end + 11)}\nreturn ${call};`)() as T;
}

const EX = await loadExtract();

const frames = (n: number) => [0, 1, 2, 3].map((i) => `deza2_${n}_${i}.gif`);
const shot = () => ({
  texture: ["normalProjectile0.gif", "normalProjectile1.gif"],
});

/** A stage-2 zako the way mapSaveToGame writes one. */
function zako(record: number, attributes: string, deathChild?: string): Rec {
  return {
    name: `deza2_${record}`,
    hp: 20,
    texture: frames(record),
    bulletData: shot(),
    dezaemon: {
      stage: 2,
      record,
      attributes,
      ...(deathChild ? { deathChild } : {}),
    },
  };
}

// Valkyrie's stage-3 motorcycle, as the mapper keys it. Byte 0 is the
// appearance id: 0x29 rides straight down, 0xD2 drifts on a diagonal.
const UPRIGHT = "29258c330511000000000000000000000000";
const LEANING = "d2258c330511000000000000000000000000";
const valkyrie = (): Roster => ({
  enemyAV: zako(31, "29258c330511000000000000000000000001"),
  enemyAW: zako(32, UPRIGHT, "enemyAZ"),
  enemyAX: zako(33, LEANING, "enemyAZ"),
  enemyAY: zako(34, LEANING, "enemyAZ"),
  enemyAZ: zako(35, "231028000000000000410020000000000000"),
  // Record 38: the upright bike again, byte 4 aside, in the upright's art.
  enemyBC: {
    ...zako(38, "29258c331511000000000000000000000000", "enemyAZ"),
    texture: frames(32),
  },
  // The same bytes on another stage are another game's business.
  enemyBD: {
    ...zako(33, LEANING),
    dezaemon: { stage: 1, record: 33, attributes: LEANING },
  },
});

Deno.test("the motorcycle leaves with its lean poses and the rider it drops", () => {
  const roster = valkyrie();
  const out = EX.zakoTravelRecord(
    { enemyData: roster },
    roster.enemyAW,
    "enemyAW",
  );
  const squad = out.squad as Roster;
  assertEquals(Object.keys(squad).sort(), ["enemyAX", "enemyAY", "enemyAZ"]);
  assertEquals(squad.enemyAX.texture, frames(33));
  assertEquals(squad.enemyAY.texture, frames(34));
  assertEquals(squad.enemyAZ.texture, frames(35));
  // The links still name the keys the squad is filed under.
  assertEquals((out.dezaemon as Rec).deathChild, "enemyAZ");
  assertEquals((squad.enemyAX.dezaemon as Rec).deathChild, "enemyAZ");
  // Copied, not assigned: publishing writes nothing into the game being played.
  assertEquals(roster.enemyAW.squad, undefined);
  squad.enemyAZ.hp = 99;
  assertEquals(roster.enemyAZ.hp, 20);
});

Deno.test("its whole squad is in the frames a publish packs", () => {
  const roster = valkyrie();
  const names = EX.collectFrameNames(
    EX.zakoTravelRecord({ enemyData: roster }, roster.enemyAW, "enemyAW"),
  );
  for (const n of [32, 33, 34, 35]) {
    for (const f of frames(n)) assert(names.includes(f), `${f} is packed`);
  }
});

Deno.test("a pose leaves with the upright bike as its own pose", () => {
  const roster = valkyrie();
  const out = EX.zakoTravelRecord(
    { enemyData: roster },
    roster.enemyAX,
    "enemyAX",
  );
  assertEquals(Object.keys(out.squad as Roster).sort(), [
    "enemyAW",
    "enemyAY",
    "enemyAZ",
  ]);
});

Deno.test("a death chain is followed to its end, and not back into the record", () => {
  const roster = valkyrie();
  (roster.enemyAZ.dezaemon as Rec).deathChild = "enemyAV";
  (roster.enemyAV.dezaemon as Rec).deathChild = "enemyAW";
  const out = EX.zakoTravelRecord(
    { enemyData: roster },
    roster.enemyAW,
    "enemyAW",
  );
  assertEquals(Object.keys(out.squad as Roster).sort(), [
    "enemyAV",
    "enemyAX",
    "enemyAY",
    "enemyAZ",
  ]);
});

Deno.test("a zako with no squad, and a record that is no Dezaemon zako, leave as they are", () => {
  const roster = valkyrie();
  // The rider: a death word of its own that spawns nothing, and no twins.
  const rider = EX.zakoTravelRecord(
    { enemyData: roster },
    roster.enemyAZ,
    "enemyAZ",
  );
  assertEquals(rider, roster.enemyAZ);
  const web: Rec = { name: "soliderA", texture: ["soliderA0.gif"] };
  assertEquals(
    EX.zakoTravelRecord({ enemyData: { enemyA: web } }, web, "enemyA"),
    web,
  );
  // A link to a key the roster lacks is not followed into nothing.
  const lone = zako(32, UPRIGHT, "enemyZZ");
  assertEquals(
    EX.zakoTravelRecord({ enemyData: { enemyA: lone } }, lone, "enemyA"),
    lone,
  );
});

type Adopt = (
  roster: Roster,
  entry: Rec,
  squad: Roster | null,
  nextKey: () => string | null,
) => string[];

/** rando's roster before the import: enemyA..enemyF. */
const rando = (): Roster =>
  Object.fromEntries("ABCDEF".split("").map((l) => [`enemy${l}`, { name: l }]));

async function adoptInto(roster: Roster, entry: Rec, squad: Roster | null) {
  const adopt = await editorFunction<Adopt>("adoptSquad", "adoptSquad");
  const next = () => {
    for (const l of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      if (!roster[`enemy${l}`]) return `enemy${l}`;
    }
    return null;
  };
  const key = next()!;
  roster[key] = entry;
  return { key, added: adopt(roster, entry, squad, next) };
}

Deno.test("an import re-keys the squad into this roster and rewires the rider", async () => {
  const valk = valkyrie();
  const published = EX.zakoTravelRecord(
    { enemyData: valk },
    valk.enemyAW,
    "enemyAW",
  );
  const entry = structuredClone(published);
  const squad = entry.squad as Roster;
  delete entry.squad;
  const roster = rando();
  const { key, added } = await adoptInto(roster, entry, squad);
  assertEquals(key, "enemyG");
  // In the order the old keys ran: AX, AY, AZ.
  assertEquals(added, ["enemyH", "enemyI", "enemyJ"]);
  assertEquals(roster.enemyH.texture, frames(33));
  assertEquals(roster.enemyJ.texture, frames(35));
  // Every link now names this roster's rider, and nothing names enemyAZ.
  for (const k of ["enemyG", "enemyH", "enemyI"]) {
    assertEquals((roster[k].dezaemon as Rec).deathChild, "enemyJ", k);
  }
  assert(!JSON.stringify(roster).includes("enemyAZ"));
});

Deno.test("a link the squad cannot answer is dropped, never left naming this game's enemy", async () => {
  // A record published before squads: the key of a game long gone.
  const entry = zako(32, UPRIGHT, "enemyAZ");
  const roster: Roster = { ...rando(), enemyAZ: { name: "someone else" } };
  const { added } = await adoptInto(roster, entry, null);
  assertEquals(added, []);
  assertEquals((entry.dezaemon as Rec).deathChild, undefined);
});

Deno.test("the import numbers a record's own frames before its squad's", async () => {
  const keys = await editorFunction<(o: Rec, d: number) => string[]>(
    "libraryWalkKeys",
    "libraryWalkKeys",
  );
  // The library stores keys sorted, which puts squad ahead of texture.
  const stored = {
    bulletData: {},
    dezaemon: {},
    hp: 1,
    squad: {},
    texture: [],
  };
  assertEquals(keys(stored, 0), [
    "bulletData",
    "dezaemon",
    "hp",
    "texture",
    "squad",
  ]);
  // Only the record's own top level: a member's keys are its own business.
  assertEquals(keys({ squad: {}, texture: [] }, 1), ["squad", "texture"]);
  assertEquals(keys({ texture: [] }, 0), ["texture"]);
});
