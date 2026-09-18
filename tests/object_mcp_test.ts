// The object tools translate a spoken phrase into a catalog record and a few
// dials into field edits and pixel edits. Every rule in that translation is a
// literal here: which shape is which role, which boss "the second boss" is,
// what +1 aggression does to which number, what 120 degrees does to red.
//
// Nothing touches the network. The catalog fixtures below are trimmed copies
// of real records — dezaBoss0's slots, a Dezaemon zako's behaviour block,
// dukeNukem's shoot tables, the bullet and the backdrop that sit in
// /characters next to the bosses.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { decodePng, newRaster, type Raster } from "@shmupx/shmup-harbor/png";
import {
  applyAggression,
  cadenceIsRead,
  classify,
  DIAL_RANGE,
  framesFor,
  framesInScope,
  hasDezaBehavior,
  levelSegment,
  mainProjectileSlot,
  naturalCompare,
  numberObjects,
  type ObjectSummary,
  ordinalWord,
  parseQuery,
  partFrames,
  resolveQuery,
  shotsAreRead,
  stageOf,
  statesOf,
} from "../mcp/lib/objects.ts";
import {
  dominantColors,
  hslToRgb,
  lerpHue,
  parseColor,
  pngBase64,
  recolor,
  rgbToHsl,
  scaleNearest,
} from "../mcp/lib/pixels.ts";
import { storedFrameKey } from "../mcp/lib/art.ts";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const BUNDLE = join(ROOT, "static/games/2028-ai/game.bundle.js");

/** ─── fixtures ─────────────────────────────────────────────────────────── */

const dezaBoss0 = {
  name: "dezaBoss0",
  textureKey: "dezaBoss0",
  anim: {
    idle: ["dezaBoss0_0.gif", "dezaBoss0_1.gif"],
    attack: ["dezaBoss0_2.gif", "dezaBoss0_3.gif"],
    _note: ["not art"],
  },
  bulletDataA: {
    damage: 1,
    hp: 1,
    score: 0,
    speed: 2,
    spgage: 0,
    texture: ["dezaBullet0_0.gif", "dezaBullet0_1.gif"],
  },
  bulletDataC: { damage: 1, speed: 2, texture: ["dezaBullet2_0.gif"] },
  dezaemon: { boss: { patterns: [] }, partArt: { "37": ["dezaPart0.gif"] } },
  hp: 113,
  interval: 100,
  score: 10000,
  spgage: 30,
  stageBgEnd: { frame: "bg-great-hall_atlas_s0", alpha: 0.45 },
};

/** A Dezaemon-imported zako: the cart's fire table drives it. */
const dezaZako = {
  name: "deza1_39",
  textureKey: "deza1_39",
  bulletData: { damage: 1, hp: 100, speed: 0.75, texture: ["np0.gif"] },
  dezaemon: {
    record: 39,
    stage: 1,
    behavior: { fire: { mode: 0, window: 29 } },
  },
  hp: 1,
  interval: 119,
  score: 10000,
  speed: 1,
  texture: ["deza1_39_0.gif", "deza1_39_1.gif"],
};

/** A stock zako: the record's own numbers drive it. */
const stockZako = {
  name: "enemyR",
  textureKey: "enemyr_atlas",
  bulletData: { damage: 1, speed: 2, texture: ["np0.gif"] },
  hp: 20,
  interval: 100,
  score: 400,
  speed: 1,
  texture: ["v2-spikeC_0", "v2-spikeC_1"],
};

const akuma = {
  name: "akuma",
  textureKey: "akuma",
  bulletData: { damage: 1, speed: 1, texture: ["np0.gif"] },
  hp: 1000,
  interval: 300,
  speed: 1,
  texture: ["sprite_0", "sprite_1"],
};

const duke = {
  name: "dukeNukem",
  textureKey: "duke_atlas",
  maxHp: 3,
  shootNormal: { interval: 23 },
  texture: ["duke_0"],
};

const bullet = {
  name: "dezaKissBullet0_0_gif",
  textureKey: "dezaKissBullet0_0_gif",
  score: 100,
  speed: 2,
  texture: ["dezaBullet0_0.gif"],
};

const backdrop = {
  name: "stage_over_c_png",
  textureKey: "stage_over_c_png",
  texture: ["stage_over_c.png"],
};

/** A summary the resolver can chew on, with only the fields it reads. */
function obj(
  id: string,
  role: ObjectSummary["role"],
  stage: number | null,
  extra: Partial<ObjectSummary> = {},
): ObjectSummary {
  return {
    id,
    label: id,
    role,
    ordinal: null,
    ordinalWord: null,
    stage,
    character: id,
    inCatalog: true,
    textureKey: id,
    states: [],
    projectiles: [],
    size: null,
    frames: 0,
    hp: null,
    score: null,
    interval: null,
    ...extra,
  };
}

// The real catalog's shape: numbered bosses with a gap at stage 2, four
// unnumbered ones, sixteen zako, a player, a bullet, a backdrop. Handed to
// numberObjects the way listObjects hands its own summaries.
const CATALOG: ObjectSummary[] = numberObjects([
  obj("uglySister", "boss", null),
  obj("dezaBoss3", "boss", 3),
  obj("pyramid", "boss", null),
  obj("dezaBoss0", "boss", 0),
  obj("hadoukenBoss", "boss", null),
  obj("dezaBoss4_ramsie", "boss", 4),
  obj("akuma", "boss", null),
  obj("dezaBoss1", "boss", 1),
  obj("red_dress_killer", "enemy", null),
  obj("deza1_39", "enemy", null),
  obj("deza1_09", "enemy", null),
  obj("dukeNukem", "player", null),
  obj("dezaKissBullet0_0_gif", "projectile", null),
  obj("stage_over_c_png", "art", null),
]);

// A level's slots: every one carries a stage but bossExtra.
const LEVEL: ObjectSummary[] = numberObjects([
  obj("bossExtra", "boss", null, { character: "goki", inCatalog: false }),
  obj("boss0", "boss", 0, { character: "dezaBoss0" }),
  obj("boss1", "boss", 1, { character: "dezaBoss1" }),
  obj("boss2", "boss", 2, { character: "dezaBoss2", inCatalog: false }),
  obj("boss3", "boss", 3, { character: "bison", inCatalog: false }),
]);

const resolved = (query: string, objects = CATALOG) =>
  resolveQuery(query, objects).resolved?.id ?? null;

/** ─── roles ────────────────────────────────────────────────────────────── */

Deno.test("classify reads each role off the record's shape", () => {
  assertEquals(classify(dezaBoss0), "boss");
  // Tough, fires from the unsuffixed slot, no Dezaemon zako record: a boss.
  assertEquals(classify(akuma), "boss");
  // Animation states alone make a boss — pyramid has anim and no dezaemon.
  assertEquals(classify({ anim: { idle: ["a"] }, hp: 300 }), "boss");
  // A suffixed slot alone does too.
  assertEquals(classify({ bulletDataB: { texture: ["a"] } }), "boss");
  // hp 1 with a Dezaemon zako record is a zako, however it is armed.
  assertEquals(classify(dezaZako), "enemy");
  // A tough Dezaemon zako is still a zako: the record number settles it.
  assertEquals(
    classify({ ...dezaZako, hp: 500, dezaemon: { record: 56, stage: 3 } }),
    "enemy",
  );
  assertEquals(classify(stockZako), "enemy");
  assertEquals(classify(duke), "player");
  assertEquals(classify(bullet), "projectile");
  assertEquals(classify(backdrop), "art");
  // hp stored as the string "infinity" is not a number and not a boss.
  assertEquals(
    classify({ hp: "infinity", interval: 119, dezaemon: { record: 56 } }),
    "enemy",
  );
});

Deno.test("what the runtime reads depends on who drives the object", () => {
  assert(hasDezaBehavior(dezaZako));
  assert(!hasDezaBehavior(stockZako));
  assert(!hasDezaBehavior(dezaBoss0));
  // Only a stock zako's interval is a cadence the runtime reads.
  assert(cadenceIsRead(stockZako, "enemy"));
  assert(!cadenceIsRead(dezaZako, "enemy"));
  assert(!cadenceIsRead(dezaBoss0, "boss"));
  assert(!cadenceIsRead(duke, "player"));
  // Shot speed and art come from the record for everyone but a Dezaemon zako.
  assert(shotsAreRead(stockZako, "enemy"));
  assert(shotsAreRead(dezaBoss0, "boss"));
  assert(!shotsAreRead(dezaZako, "enemy"));
});

Deno.test("stageOf reads the boss slot out of a name, and only there", () => {
  assertEquals(stageOf("dezaBoss0"), 0);
  assertEquals(stageOf("dezaBoss4_ramsie"), 4);
  assertEquals(stageOf("dezaBoss1_bulky"), 1);
  assertEquals(stageOf("boss12"), 12);
  assertEquals(stageOf("Boss_3"), 3);
  assertEquals(stageOf("hadoukenBoss"), null);
  assertEquals(stageOf("uglySister"), null);
  assertEquals(stageOf("deza1_39"), null);
  // A digit elsewhere in a name is not a stage.
  assertEquals(stageOf("dezaKissBullet0_0_gif"), null);
  assertEquals(stageOf("stage_over_c_png"), null);
});

Deno.test("naturalCompare counts, rather than spelling, the digits", () => {
  const names = ["dezaBoss10", "dezaBoss3", "dezaBoss1", "dezaBoss0"];
  assertEquals(names.sort(naturalCompare), [
    "dezaBoss0",
    "dezaBoss1",
    "dezaBoss3",
    "dezaBoss10",
  ]);
  assertEquals(ordinalWord(1), "first");
  assertEquals(ordinalWord(2), "second");
  assertEquals(ordinalWord(10), "tenth");
  assertEquals(ordinalWord(11), "11th");
});

Deno.test("numberObjects counts numbered members by stage and the rest after them", () => {
  const bosses = CATALOG.filter((o) => o.role === "boss");
  assertEquals(
    bosses.map((o) => [o.id, o.ordinal, o.ordinalWord]),
    [
      ["dezaBoss0", 1, "first"],
      ["dezaBoss1", 2, "second"],
      // No dezaBoss2: no third boss.
      ["dezaBoss3", 4, "fourth"],
      ["dezaBoss4_ramsie", 5, "fifth"],
      ["akuma", 6, "sixth"],
      ["hadoukenBoss", 7, "seventh"],
      ["pyramid", 8, "eighth"],
      ["uglySister", 9, "ninth"],
    ],
  );
  // A role with no numbers counts by position, naturally ordered.
  assertEquals(
    CATALOG.filter((o) => o.role === "enemy").map((o) => [o.id, o.ordinal]),
    [["deza1_09", 1], ["deza1_39", 2], ["red_dress_killer", 3]],
  );
  // Roles are laid out in ROLES order.
  assertEquals(
    CATALOG.map((o) => o.role).join(","),
    [
      ...Array(8).fill("boss"),
      ...Array(3).fill("enemy"),
      "player",
      "projectile",
      "art",
    ].join(","),
  );
  // The level's hidden boss follows the numbered slots.
  assertEquals(
    LEVEL.map((o) => [o.id, o.ordinal]),
    [["boss0", 1], ["boss1", 2], ["boss2", 3], ["boss3", 4], ["bossExtra", 5]],
  );
});

Deno.test("what the list says is what the phrase gets", () => {
  // Every listed ordinal, spoken back with its role, names that object.
  for (const objects of [CATALOG, LEVEL]) {
    for (const o of objects) {
      assertEquals(
        resolveQuery(`the ${o.ordinalWord} ${o.role}`, objects).resolved?.id,
        o.id,
        `the ${o.ordinalWord} ${o.role}`,
      );
    }
  }
});

/** ─── frames ───────────────────────────────────────────────────────────── */

Deno.test("statesOf lists animation states and implies idle from a bare texture", () => {
  assertEquals(statesOf(dezaBoss0), ["idle", "attack"]);
  assertEquals(statesOf(dezaZako), ["idle"]);
  assertEquals(statesOf({}), []);
  // An empty state is not a state.
  assertEquals(statesOf({ anim: { idle: [], attack: ["a"] } }), ["attack"]);
});

Deno.test("framesFor falls back exactly the way bossAdd does", () => {
  assertEquals(framesFor(dezaBoss0, "idle"), [
    "dezaBoss0_0.gif",
    "dezaBoss0_1.gif",
  ]);
  assertEquals(framesFor(dezaZako, "idle"), [
    "deza1_39_0.gif",
    "deza1_39_1.gif",
  ]);
  assertEquals(framesFor(dezaBoss0, "attack"), [
    "dezaBoss0_2.gif",
    "dezaBoss0_3.gif",
  ]);
  // The main projectile is the A slot, not the unsuffixed one, and the
  // unsuffixed one stands in when there is no A.
  assertEquals(mainProjectileSlot(dezaBoss0), "bulletDataA");
  assertEquals(mainProjectileSlot(dezaZako), "bulletData");
  assertEquals(mainProjectileSlot(backdrop), null);
  assertEquals(framesFor(dezaBoss0, "projectile"), [
    "dezaBullet0_0.gif",
    "dezaBullet0_1.gif",
  ]);
  assertEquals(framesFor(dezaBoss0, "backdrop"), ["bg-great-hall_atlas_s0"]);
  assertEquals(framesFor({ stageBgEnd: "end.png" }, "backdrop"), ["end.png"]);
  // Authoring keys are not states, and a missing state names the real ones.
  assertThrows(() => framesFor(dezaBoss0, "_note"));
  assertThrows(() => framesFor(dezaBoss0, "warp"), Error, "idle, attack");
  assertThrows(() => framesFor(backdrop, "projectile"));
});

Deno.test("framesInScope keeps the body apart from its shots and backdrop", () => {
  const body = framesInScope(dezaBoss0, "body");
  assertEquals(
    [...body].sort(),
    [
      "dezaBoss0_0.gif",
      "dezaBoss0_1.gif",
      "dezaBoss0_2.gif",
      "dezaBoss0_3.gif",
      "dezaPart0.gif",
    ],
  );
  assertEquals(
    [...framesInScope(dezaBoss0, "projectiles")].sort(),
    ["dezaBullet0_0.gif", "dezaBullet0_1.gif", "dezaBullet2_0.gif"],
  );
  const all = framesInScope(dezaBoss0, "all");
  assertEquals(all.size, 9);
  assert(all.has("bg-great-hall_atlas_s0"));
  assert(!body.has("bg-great-hall_atlas_s0"));
  // The parts are the frames the silhouette dial leaves at their size.
  assertEquals(partFrames(dezaBoss0), ["dezaPart0.gif"]);
  assertEquals(partFrames(dezaZako), []);
});

/** ─── the phrase ───────────────────────────────────────────────────────── */

Deno.test("parseQuery reads ordinals, roles, hints and fragments", () => {
  assertEquals(parseQuery("the second boss"), {
    ordinal: 2,
    last: false,
    stage: null,
    role: "boss",
    hints: [],
    fragments: [],
  });
  // People count from one: boss 2, stage 2 and level 2 are all the second.
  assertEquals(parseQuery("boss 2").ordinal, 2);
  assertEquals(parseQuery("stage 2 boss").ordinal, 2);
  assertEquals(parseQuery("stage 2 boss").stage, null);
  assertEquals(parseQuery("level 2 boss").ordinal, 2);
  // "slot 2" names the zero-based key itself.
  assertEquals(parseQuery("slot 2 boss").stage, 2);
  assertEquals(parseQuery("slot 2 boss").ordinal, null);
  assertEquals(parseQuery("2nd boss").ordinal, 2);
  assertEquals(parseQuery("boss #3").ordinal, 3);
  assertEquals(parseQuery("boss number 3").ordinal, 3);
  assertEquals(parseQuery("the last boss").last, true);
  assertEquals(parseQuery("the final enemy").role, "enemy");
  // An identifier with digits in it is a fragment, not a count.
  assertEquals(parseQuery("boss1").fragments, ["boss1"]);
  assertEquals(parseQuery("make the pyramid bulkier").fragments, [
    "pyramid",
    "bulkier",
  ]);
  assertEquals(parseQuery("the player ship").role, "player");
  assertEquals(parseQuery("its bullets").role, "projectile");
  // A possessive is dropped, not turned into an "s" fragment; a second role
  // word is a hint about what to edit, not a change of subject.
  assertEquals(parseQuery("the boss's bullets"), {
    ordinal: null,
    last: false,
    stage: null,
    role: "boss",
    hints: ["projectile"],
    fragments: [],
  });
  assertEquals(parseQuery("akuma's bullets").fragments, ["akuma"]);
  assertEquals(parseQuery("akuma’s bullets").fragments, ["akuma"]);
  // One-letter leftovers are noise.
  assertEquals(parseQuery("the x boss").fragments, []);
});

Deno.test("the second boss is stage 1, and a missing stage is nobody", () => {
  assertEquals(resolved("the second boss"), "dezaBoss1");
  assertEquals(resolved("the first boss"), "dezaBoss0");
  assertEquals(resolved("boss 2"), "dezaBoss1");
  assertEquals(resolved("2nd boss"), "dezaBoss1");
  assertEquals(resolved("stage 2 boss"), "dezaBoss1");
  assertEquals(resolved("level 4 boss"), "dezaBoss3");
  assertEquals(resolved("slot 3 boss"), "dezaBoss3");
  assertEquals(resolved("the fourth boss"), "dezaBoss3");
  assertEquals(resolved("the fifth boss"), "dezaBoss4_ramsie");
  // The unnumbered bosses follow the numbered ones.
  assertEquals(resolved("the sixth boss"), "akuma");
  assertEquals(resolved("the ninth boss"), "uglySister");
  // "Last" is the highest numbered one, not the end of the list.
  assertEquals(resolved("the last boss"), "dezaBoss4_ramsie");
  // There is no stage 2 in this catalog. Nothing, not dezaBoss3.
  const third = resolveQuery("the third boss", CATALOG);
  assertEquals(third.resolved, null);
  assertEquals(third.candidates, []);
  assert(third.explanation.includes("present: first, second, fourth"));
});

Deno.test("names win: exact ids, spoken ids, fragments and stray words", () => {
  assertEquals(resolved("dezaBoss1"), "dezaBoss1");
  assertEquals(resolved("DEZABOSS1"), "dezaBoss1");
  // Speech puts spaces in an id.
  assertEquals(resolved("deza boss 1"), "dezaBoss1");
  assertEquals(resolved("deza boss 4 ramsie"), null);
  // A fragment narrows; "bulkier" names nothing and is dropped, not fatal.
  const r = resolveQuery("make the pyramid bulkier", CATALOG);
  assertEquals(r.resolved?.id, "pyramid");
  assertEquals(r.ignored, ["bulkier"]);
  assertEquals(resolved("hadouken"), "hadoukenBoss");
  assertEquals(resolved("the hadouken boss"), "hadoukenBoss");
  assertEquals(resolved("the ugly sister"), "uglySister");
  assertEquals(resolved("the player"), "dukeNukem");
  assertEquals(resolved("the bullet"), "dezaKissBullet0_0_gif");
  // A role alone is a shortlist, not an answer.
  const bosses = resolveQuery("the boss", CATALOG);
  assertEquals(bosses.resolved, null);
  assert(bosses.ambiguous);
  assertEquals(bosses.candidates.length, 8);
  // A phrase that names nothing resolves to nothing — not to everything.
  const nothing = resolveQuery("make it bulkier", CATALOG);
  assertEquals(nothing.resolved, null);
  assertEquals(nothing.candidates, []);
  assertEquals(nothing.ignored, ["bulkier"]);
});

Deno.test("a name beats a role word, which becomes a hint", () => {
  // "akuma's bullets" is akuma, about its shots — not the bullet record.
  const shots = resolveQuery("akuma's bullets", CATALOG);
  assertEquals(shots.resolved?.id, "akuma");
  assertEquals(shots.hints, ["projectile"]);
  assert(shots.explanation.includes("kept as a hint"));
  // With no name, the role stands and the extra role word is the hint.
  const whose = resolveQuery("the boss's bullets", CATALOG);
  assertEquals(whose.resolved, null);
  assertEquals(whose.candidates.length, 8);
  assertEquals(whose.hints, ["projectile"]);
  // The possessive did not shrink the shortlist by an accident of spelling.
  assertEquals(resolveQuery("the boss's hp", CATALOG).candidates.length, 8);
});

Deno.test("an unnumbered set counts by position", () => {
  assertEquals(resolved("the second enemy"), "deza1_39");
  assertEquals(resolved("the first enemy"), "deza1_09");
  assertEquals(resolved("the last enemy"), "red_dress_killer");
  assertEquals(resolved("the ninth enemy"), null);
});

Deno.test("a level's slots resolve by stage, by spoken id, and by character", () => {
  assertEquals(resolved("the second boss", LEVEL), "boss1");
  assertEquals(resolved("the third boss", LEVEL), "boss2");
  // The hidden boss is listed after the numbered ones, and "last" is the
  // highest numbered slot, not it.
  assertEquals(resolved("the fifth boss", LEVEL), "bossExtra");
  assertEquals(resolved("the last boss", LEVEL), "boss3");
  // Reading a slot id aloud names that slot, not the one below it.
  assertEquals(resolved("boss 1", LEVEL), "boss1");
  assertEquals(resolved("boss 0", LEVEL), "boss0");
  // The slot's character name is a name too.
  assertEquals(resolved("dezaBoss1", LEVEL), "boss1");
  assertEquals(resolved("bison", LEVEL), "boss3");
  assertEquals(resolved("goki", LEVEL), "bossExtra");
});

Deno.test("levelSegment admits what authors typed and refuses what walks the path", () => {
  assertEquals(levelSegment("Daioh P!"), "Daioh%20P!");
  assertEquals(
    levelSegment("SummerCarnival'99 LECCA"),
    "SummerCarnival'99%20LECCA",
  );
  assertEquals(levelSegment("akuma"), "akuma");
  assertThrows(() => levelSegment("../characters"));
  assertThrows(() => levelSegment("a/b"));
  assertThrows(() => levelSegment("has.dot"));
  assertThrows(() => levelSegment(""));
});

/** ─── the dials ────────────────────────────────────────────────────────── */

Deno.test("aggression on a boss moves its shots and leaves its dead interval alone", () => {
  const record = structuredClone(dezaBoss0) as Record<string, unknown>;
  const { changes, warnings } = applyAggression(record, 1, "boss");
  assertEquals((record.bulletDataA as { speed: number }).speed, 3);
  assertEquals((record.bulletDataA as { damage: number }).damage, 2);
  assertEquals((record.bulletDataC as { speed: number }).speed, 3);
  assertEquals(changes.map((c) => c.field).sort(), [
    "bulletDataA.damage",
    "bulletDataA.speed",
    "bulletDataC.damage",
    "bulletDataC.speed",
  ]);
  // A boss's interval is copied into the scene and never read back.
  assertEquals(record.interval, 100);
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("pattern script"));
  // hp is not aggression.
  assertEquals(record.hp, 113);
  assertEquals(DIAL_RANGE, 0.5);
});

Deno.test("aggression on a stock zako moves its interval, speed and damage", () => {
  const record = structuredClone(stockZako) as Record<string, unknown>;
  const { changes, warnings } = applyAggression(record, 1, "enemy");
  assertEquals(record.interval, 50);
  assertEquals((record.bulletData as { speed: number }).speed, 3);
  assertEquals((record.bulletData as { damage: number }).damage, 2);
  assertEquals(warnings, []);
  assertEquals(changes.map((c) => c.field).sort(), [
    "bulletData.damage",
    "bulletData.speed",
    "interval",
  ]);
  // Movement speed is not aggression.
  assertEquals(record.speed, 1);
});

Deno.test("aggression on a Dezaemon zako moves only what the cart does not own", () => {
  const record = structuredClone(dezaZako) as Record<string, unknown>;
  const { changes, warnings } = applyAggression(record, 1, "enemy");
  // Cadence: the cart's fire table. Speed and art: the level's bullet bank.
  assertEquals(record.interval, 119);
  assertEquals((record.bulletData as { speed: number }).speed, 0.75);
  // Damage is the one number the runtime keeps from the slot.
  assertEquals((record.bulletData as { damage: number }).damage, 2);
  assertEquals(changes, [{
    field: "bulletData.damage",
    before: 1,
    after: 2,
  }]);
  assert(warnings.some((w) => w.includes("fire table")));
  assert(warnings.some((w) => w.includes("bullet bank")));
});

Deno.test("aggression compounds, reverses, clamps and floors", () => {
  const record = { interval: 100, bulletData: { speed: 2, damage: 1 } };
  applyAggression(record, 0.5, "enemy");
  assertEquals(record.interval, 75);
  assertEquals(record.bulletData.speed, 2.5);
  // Arithmetic on the current value: a second turn moves it again.
  applyAggression(record, 0.5, "enemy");
  assertEquals(record.interval, 56);
  assertEquals(record.bulletData.speed, 3.13);
  // -1 lengthens the interval by half and slows the shots.
  const calm = { interval: 100, bulletData: { speed: 2, damage: 2 } };
  applyAggression(calm, -1, "enemy");
  assertEquals(calm.interval, 150);
  assertEquals(calm.bulletData.speed, 1);
  assertEquals(calm.bulletData.damage, 1);
  // Beyond the dial is the dial.
  const wild = { interval: 100 };
  applyAggression(wild, 7, "enemy");
  assertEquals(wild.interval, 50);
  // The interval never reaches zero and damage never drops below one.
  const tiny = { interval: 1, bulletData: { speed: 0.1, damage: 1 } };
  applyAggression(tiny, 1, "enemy");
  assertEquals(tiny.interval, 1);
  assertEquals(tiny.bulletData.damage, 2);
  applyAggression(tiny, -1, "enemy");
  assertEquals(tiny.bulletData.speed, 0.1);
  assertEquals(tiny.bulletData.damage, 1);
  // Zero is a no-op that reports nothing.
  assertEquals(applyAggression({ interval: 100 }, 0, "enemy"), {
    changes: [],
    warnings: [],
  });
});

Deno.test("aggression starts a stock zako from the runtime's default, and reports dead ends", () => {
  // The zako path reads `data.interval || 300`.
  const fresh: Record<string, unknown> = { bulletData: { speed: 1 } };
  const f = applyAggression(fresh, -1, "enemy");
  assertEquals(fresh.interval, 450);
  assertEquals(f.changes[0], { field: "interval", before: null, after: 450 });
  assert(f.warnings[0].includes("default for a zako is 300"));
  // interval -1 means "never fires" and is reported, not turned into a cadence.
  const never: Record<string, unknown> = { interval: -1 };
  const n = applyAggression(never, 1, "enemy");
  assertEquals(never.interval, -1);
  assertEquals(n.changes, []);
  assert(n.warnings.some((w) => w.includes("never fires")));
  // A boss with no projectile slot has nothing the dial can move, and the
  // result must say so instead of writing an interval nobody reads.
  const bare: Record<string, unknown> = { interval: 100, hp: 113 };
  const b = applyAggression(bare, 1, "boss");
  assertEquals(bare.interval, 100);
  assertEquals(b.changes, []);
  assert(b.warnings.some((w) => w.includes("Nothing for aggression to move")));
  // A boss with no interval at all gets none invented.
  const silent: Record<string, unknown> = { bulletDataA: { speed: 2 } };
  const s = applyAggression(silent, 1, "boss");
  assertEquals(silent.interval, undefined);
  assertEquals(s.changes, [{
    field: "bulletDataA.speed",
    before: 2,
    after: 3,
  }]);
  assertEquals(s.warnings, []);
});

/** ─── pixels ───────────────────────────────────────────────────────────── */

function pixel(r: number, g: number, b: number, a = 255): Raster {
  const out = newRaster(1, 1);
  out.data.set([r, g, b, a]);
  return out;
}

const rgb = (raster: Raster, i = 0) => [
  raster.data[i * 4],
  raster.data[i * 4 + 1],
  raster.data[i * 4 + 2],
  raster.data[i * 4 + 3],
];

Deno.test("HSL round-trips the corners and the middle", () => {
  assertEquals(rgbToHsl(255, 0, 0), [0, 1, 0.5]);
  assertEquals(rgbToHsl(0, 255, 0), [120, 1, 0.5]);
  assertEquals(rgbToHsl(0, 0, 255), [240, 1, 0.5]);
  assertEquals(rgbToHsl(0, 0, 0), [0, 0, 0]);
  assertEquals(rgbToHsl(255, 255, 255), [0, 0, 1]);
  for (
    const [r, g, b] of [[255, 0, 0], [12, 200, 90], [128, 128, 128], [1, 2, 3]]
  ) {
    assertEquals(hslToRgb(...rgbToHsl(r, g, b)), [r, g, b]);
  }
  assertEquals(lerpHue(350, 10, 0.5), 0);
  assertEquals(lerpHue(10, 350, 0.5), 0);
  assertEquals(lerpHue(0, 120, 0.5), 60);
});

Deno.test("parseColor takes hex and the spoken names, and refuses the rest", () => {
  assertEquals(parseColor("#f00"), [255, 0, 0]);
  assertEquals(parseColor("#00FF00"), [0, 255, 0]);
  assertEquals(parseColor("0000ff"), [0, 0, 255]);
  assertEquals(parseColor(" Blue "), [0, 0, 255]);
  assertEquals(parseColor("gray"), parseColor("grey"));
  assertThrows(() => parseColor("#12"), Error, "Unknown colour");
  assertThrows(() => parseColor("chartreuse-ish"));
});

Deno.test("recolor moves hue and keeps shading, and never touches a clear pixel", () => {
  // 120 degrees turns red into green.
  assertEquals(rgb(recolor(pixel(255, 0, 0), { hue: 120 })), [0, 255, 0, 255]);
  // A dark red stays exactly as dark when it turns blue: only hue moved.
  const dark = recolor(pixel(80, 0, 0), { toward: "blue" });
  assertEquals(rgb(dark), [0, 0, 80, 255]);
  // Black and white have no hue to move and come through untouched.
  assertEquals(rgb(recolor(pixel(0, 0, 0), { toward: "red" })), [0, 0, 0, 255]);
  assertEquals(
    rgb(recolor(pixel(255, 255, 255), { toward: "red" })),
    [255, 255, 255, 255],
  );
  // A grey mid-tone takes the colour outright: "make it red" reddens a grey
  // sprite. 128 is not exactly mid-lightness, so judge it in HSL: full
  // saturation at the target hue, lightness kept.
  const grey = recolor(pixel(128, 128, 128), { toward: "red" });
  const [gh, gs, gl] = rgbToHsl(grey.data[0], grey.data[1], grey.data[2]);
  assertEquals(Math.round(gh), 0);
  assertEquals(Math.round(gs * 100), 100);
  assertEquals(Math.round(gl * 255), 128);
  assertEquals(grey.data[0], 255);
  assert(grey.data[1] <= 2 && grey.data[2] <= 2);
  // Halfway toward blue from red is purple, along the short arc.
  const half = recolor(pixel(255, 0, 0), { toward: "blue", amount: 0.5 });
  const [h] = rgbToHsl(half.data[0], half.data[1], half.data[2]);
  assertEquals(Math.round(h), 300);
  // Saturation -1 is greyscale; lightness ±1 is white / black.
  assertEquals(rgb(recolor(pixel(255, 0, 0), { saturation: -1 })), [
    128,
    128,
    128,
    255,
  ]);
  assertEquals(rgb(recolor(pixel(255, 0, 0), { lightness: 1 })), [
    255,
    255,
    255,
    255,
  ]);
  assertEquals(rgb(recolor(pixel(255, 0, 0), { lightness: -1 })), [
    0,
    0,
    0,
    255,
  ]);
  // Transparent black stays transparent black whatever the edit.
  assertEquals(rgb(recolor(pixel(0, 0, 0, 0), { toward: "red", hue: 90 })), [
    0,
    0,
    0,
    0,
  ]);
  // Semi-transparent pixels keep their alpha.
  assertEquals(rgb(recolor(pixel(255, 0, 0, 90), { hue: 120 })), [
    0,
    255,
    0,
    90,
  ]);
  // An empty edit is a copy, not the same buffer.
  const src = pixel(1, 2, 3);
  const copy = recolor(src, {});
  assertEquals(rgb(copy), [1, 2, 3, 255]);
  assert(copy.data !== src.data);
});

Deno.test("toward white, black or grey drains colour instead of turning red", () => {
  // A grey target has no hue; rgbToHsl calls it 0, which is red. It must
  // be read as a saturation move, or "make it white" publishes a red boss.
  for (const target of ["white", "black", "grey", "silver", "#808080"]) {
    const out = recolor(pixel(0, 0, 255), { toward: target });
    const [r, g, b] = rgb(out);
    assertEquals(r, g, `toward ${target} left a tint: ${[r, g, b]}`);
    assertEquals(g, b, `toward ${target} left a tint: ${[r, g, b]}`);
  }
  // White lightens, black darkens, part of the way: shading survives.
  const white = rgb(recolor(pixel(0, 0, 255), { toward: "white" }))[0];
  const black = rgb(recolor(pixel(0, 0, 255), { toward: "black" }))[0];
  const grey = rgb(recolor(pixel(0, 0, 255), { toward: "grey" }))[0];
  assert(white > 128 && white < 255, `toward white gave ${white}`);
  assert(black > 0 && black < 128, `toward black gave ${black}`);
  assertEquals(grey, 128);
  // Half way drains half the colour.
  const half = recolor(pixel(0, 0, 255), { toward: "grey", amount: 0.5 });
  const [, s] = rgbToHsl(half.data[0], half.data[1], half.data[2]);
  assertEquals(Math.round(s * 100), 50);
  // Green toward grey keeps its lightness exactly, since grey's is the same.
  const [, gs, gl] = rgbToHsl(
    ...(rgb(recolor(pixel(0, 192, 0), { toward: "grey" })).slice(0, 3) as [
      number,
      number,
      number,
    ]),
  );
  assertEquals(gs, 0);
  assertEquals(Math.round(gl * 255), Math.round((0.376 + 0.502) / 2 * 255));
});

Deno.test("scaleNearest rounds to whole pixels and never vanishes", () => {
  const src = newRaster(64, 64);
  assertEquals(
    [scaleNearest(src, 1.5).width, scaleNearest(src, 1.5).height],
    [96, 96],
  );
  assertEquals(scaleNearest(src, 1.25).width, 80);
  assertEquals(scaleNearest(src, 0.5).width, 32);
  // 1 × 0.3 rounds to 0; the floor keeps a pixel.
  const tiny = scaleNearest(newRaster(1, 1), 0.3);
  assertEquals([tiny.width, tiny.height], [1, 1]);
  assertThrows(() => scaleNearest(src, 0));
  assertThrows(() => scaleNearest(src, -2));
  // Nearest-neighbour: a 2x2 checker doubled is a 4x4 checker with hard edges.
  const checker = newRaster(2, 2);
  checker.data.set([
    255,
    0,
    0,
    255,
    0,
    0,
    255,
    255,
    0,
    0,
    255,
    255,
    255,
    0,
    0,
    255,
  ]);
  const big = scaleNearest(checker, 2);
  assertEquals(rgb(big, 0), [255, 0, 0, 255]);
  assertEquals(rgb(big, 1), [255, 0, 0, 255]);
  assertEquals(rgb(big, 2), [0, 0, 255, 255]);
  assertEquals(rgb(big, 5), [255, 0, 0, 255]);
  // Factor 1 is a copy.
  const same = scaleNearest(checker, 1);
  assertEquals(same.data, checker.data);
  assert(same.data !== checker.data);
});

Deno.test("dominantColors counts what is visible, most common first", () => {
  const r = newRaster(3, 1);
  r.data.set([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
  assertEquals(dominantColors(r), ["#ff0000", "#0000ff"]);
  // A pixel under half alpha — an anti-aliased fringe — is not a colour the
  // sprite is made of.
  const fringe = newRaster(3, 1);
  fringe.data.set([9, 9, 9, 0, 255, 0, 0, 1, 0, 128, 0, 255]);
  assertEquals(dominantColors(fringe), ["#008000"]);
  const half = newRaster(1, 1);
  half.data.set([1, 2, 3, 128]);
  assertEquals(dominantColors(half), ["#010203"]);
  assertEquals(dominantColors(newRaster(2, 2)), []);
});

Deno.test("pngBase64 is a bare PNG the watch can decode", async () => {
  const raster = newRaster(3, 2);
  raster.data.set([255, 0, 0, 255, 0, 255, 0, 255], 0);
  const b64 = await pngBase64(raster);
  assert(!b64.startsWith("data:"), "no data: prefix — the watch strips none");
  assert(/^[A-Za-z0-9+/]+=*$/.test(b64));
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assertEquals([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const back = await decodePng(bytes);
  assertEquals([back.width, back.height], [3, 2]);
  assertEquals(rgb(back, 0), [255, 0, 0, 255]);
  assertEquals(rgb(back, 1), [0, 255, 0, 255]);
});

Deno.test("an in-place rewrite keeps a frame's stored key spelling, bar the leader", () => {
  // spriteX's k_-hex spelling is read back by spriteX: kept verbatim.
  assertEquals(
    storedFrameKey("k_00610074006c00610073005f00730030"),
    "k_00610074006c00610073005f00730030",
  );
  assertEquals(storedFrameKey("dezaBoss1_0.gif"), "dezaBoss1_0.gif");
  // The one-dot-leader was only ever this server's own habit, and the level
  // editor cannot find a frame spelled that way: normalised on rewrite.
  assertEquals(storedFrameKey("dezaBoss0_0․gif"), "dezaBoss0_0.gif");
});

/** ─── the runtime contract ─────────────────────────────────────────────── */

Deno.test("the dials' meaning is still in the bundle", async () => {
  const src = await Deno.readTextFile(BUNDLE);
  // aggression, the shots: bullets carry the slot's damage, and every spawner
  // but a Dezaemon zako's sets the slot's speed.
  assert(
    src.includes(
      "(projData.speed || DEZA_BOSS_BULLET.speed) / SATURN_TICKS_PER_FRAME",
    ),
    "spawnDezaBossBullet no longer reads the slot's speed",
  );
  assert(
    src.includes('bullet.setData("damage", projData.damage || 1)'),
    "bullets no longer carry the slot's damage",
  );
  // ...while dezaVolley sets a Dezaemon zako's speed after the spawn, from
  // the level's bullet bank — which is why the dial skips that speed.
  assert(
    src.includes("function dezaVolley(scene, enemy, st, geom, shootFn)"),
    "dezaVolley is gone — recheck shotsAreRead",
  );
  assert(
    src.includes('bullet.setData("speed", speed / SATURN_TICKS_PER_FRAME);'),
    "dezaVolley no longer overrides the shot speed — let the dial move it",
  );
  // aggression, the cadence: a stock zako's interval is read back with this
  // default, and a Dezaemon zako's comes from its behaviour table instead.
  assert(
    src.includes('enemy.setData("interval", data.interval || 300)'),
    "the zako path no longer defaults interval to 300",
  );
  assert(
    src.includes('var shootInterval = enemy.getData("interval") || 300'),
    "the zako shooter no longer reads interval",
  );
  assert(
    src.includes("if (updateEnemyBehavior(scene, enemy)) {"),
    "the behaviour branch that bypasses the stock shooter is gone",
  );
  assert(
    src.includes(
      "var interval = fire.mode === 3 ? fire.interval : TYPE012_INTERVAL[rate];",
    ),
    "zakoReload no longer takes the cadence from the fire table",
  );
  assert(
    src.includes(
      "initEnemyBehavior(enemy, data.dezaemon.behavior, data.dezaemon, scene)",
    ),
    "a record's dezaemon.behavior no longer arms the behaviour engine",
  );
  // A boss's interval is copied into the scene and never read: every mention
  // of bossInterval in the bundle is an assignment. If this fails, the
  // runtime has started reading it — let applyAggression move it for bosses.
  const mentions = [...src.matchAll(/\bbossInterval\b[^\n]*/g)].map((m) =>
    m[0]
  );
  assert(mentions.length >= 2, "bossInterval is gone from the bundle");
  for (const mention of mentions) {
    assert(
      /^bossInterval\s*=[^=]/.test(mention),
      `the runtime now reads a boss's interval: ${mention}`,
    );
  }
  // preview: the frame a boss spawns with is anim.idle, else texture — the
  // same fallback framesFor makes.
  assert(
    src.includes("bossData.anim && bossData.anim.idle || bossData.texture"),
    "bossAdd no longer spawns from anim.idle || texture",
  );
  // The projectile slots the aggression dial walks are the ones bossAdd arms.
  assert(src.includes("bossData.bulletDataA || bossData.projectileDataA"));
  assert(src.includes("bossData.bulletData || bossData.projectileData"));
  // silhouette: parts are spawned at the cart's offsets from the core, which
  // is why the dial leaves their frames at their size.
  assert(
    src.includes(
      'var part = scene.add.sprite(boss.x + fp.dx, boss.y + fp.dy, "game_asset", frames[0]);',
    ),
    "parts are no longer anchored at fixed offsets — the silhouette dial could scale them",
  );
});
