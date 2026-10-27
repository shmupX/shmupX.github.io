// The parity testdrive's survey report (scripts/lib/parity-report.ts): a
// Saturn survey and a web survey of one stage set against each other by
// record, and the verdict the rig exits on. The surveys here are hand-built
// in the samplers' own shapes (the Saturn's as the 10-tuples the first runs
// wrote, with one 12-tuple), on a 50 px/s stage where the web lets every row
// on 240 px early — its gate lead.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  bigShotRecord,
  bigShotTargets,
  keptClock,
  placementId,
  readSaturn,
  roster,
  type RushRecord,
  type SaturnSurveyFile,
  surveyReport,
  webArt,
  webItems,
  type WebSurveyFile,
} from "../scripts/lib/parity-report.ts";
import type {
  SaturnBirth,
  SaturnSample,
  WebBirth,
  WebSample,
} from "../scripts/lib/parity-survey.ts";

const enemy = (
  record: number,
  pid: number,
  fire: Record<string, unknown>,
  more: Record<string, unknown> = {},
) => ({
  name: `deza0_${String(record).padStart(2, "0")}`,
  hp: 3,
  texture: [`deza0_${String(record).padStart(2, "0")}_0.gif`],
  dezaemon: {
    stage: 0,
    record,
    placementId: pid,
    behavior: { hp: 12800, ground: false, fire, ...more },
  },
});

const RUSH: RushRecord = {
  name: "Test",
  enemyData: {
    enemyA: enemy(0, 128, { enabled: false, mode: 0, interval: 119 }),
    enemyB: enemy(1, 129, { enabled: true, mode: 0, interval: 59, geometry: 1 }),
    enemyD: enemy(4, 132, {
      enabled: true,
      mode: 3,
      interval: 11,
      bigShot: { band: 0, index: 13, character: 119, frames: 4 },
    }),
    enemyR: enemy(38, 182, {
      enabled: true,
      mode: 3,
      interval: 59,
      bigShot: { band: 0, index: 1, character: 71, frames: 4 },
    }),
    enemyT: enemy(40, 184, { enabled: true, mode: 0, interval: 119 }),
    enemyW: enemy(52, 208, { enabled: true, mode: 0, interval: 119 }, {
      ground: true,
    }),
    // Another stage's record under a two-letter key: not this stage's roster.
    enemyAA: {
      name: "deza1_00",
      dezaemon: { stage: 1, record: 0, placementId: 128 },
    },
  },
  playerData: {
    shootNormal: {
      name: "normal",
      texture: ["bigProjectile_0.png", "bigProjectile_1.png"],
    },
  },
};

// The Saturn: two kept spans (a zero-length one between them), 100 ms
// samples, 5 px of scroll per sample. Span 0 is wall 1000-4000 (scroll
// 300-450), span 1 wall 9000-11000 (scroll 450-550); wall 5000-7000 is
// rewound-away play.
const SAT_T0 = 1000;
type Tuple = number[];
const satSample = (wall: number, scroll: number, objs: Tuple[]): SaturnSample => ({
  t: wall - SAT_T0,
  wall,
  play: 3,
  lives: 2,
  scroll,
  step: 1,
  rank: 8,
  boss: 0,
  objs: objs as SaturnSample["objs"],
});
const JUNK: Tuple[] = [
  [0, 289, 160, 80, 0, 0, 0, 0, 0, 0],
  [1, 288, 160, 80, 0, 0, 0, 0, 0, 0],
  [249, 0, 32768, 0, 16777216, 0, 0, 268435456, 0, 0],
];
const satSamples: SaturnSample[] = [];
for (let i = 0; i <= 30; i++) {
  const wall = 1000 + i * 100;
  const objs: Tuple[] = [...JUNK];
  // The objects stand inside the 320×224 frame (a parked object outside it
  // has exited); their births below enter from above it.
  if (i >= 5 && i <= 10) objs.push([100, 67, 40, 10, 12800, 128, 0, 256, 0, 0]);
  if (i >= 10 && i <= 12) {
    objs.push([101, 83, 280, 10, 25600, 132, 0, 256, 0, 0, 0, 4096]);
  }
  if (i >= 18 && i <= 22) objs.push([104, 71, 40, 10, 12800, 129, 0, 256, 0, 0]);
  // R stands at (200, 100) while its record-1 shots are born beside it.
  if (i >= 20 && i <= 22) objs.push([106, 219, 200, 100, 102400, 182, 4, 768, 0, 0]);
  if (i === 20 || i === 21) objs.push([115, 55, 50, 50, 256, 0, 0, 256, 0, 0]);
  satSamples.push(satSample(wall, 300 + 5 * i, objs));
}
for (let i = 0; i <= 20; i++) {
  satSamples.push(satSample(5000 + i * 100, 350 + 5 * i, [...JUNK]));
}
for (let i = 0; i <= 20; i++) {
  const objs: Tuple[] = [...JUNK];
  if (i >= 15) objs.push([105, 267, 240, 283, 51200, 208, 4, 1024, 0, 0]);
  satSamples.push(satSample(9000 + i * 100, 450 + 5 * i, objs));
}
const satBirth = (
  wall: number,
  slot: number,
  spr: number,
  key: number,
  scroll: number,
  more: Partial<SaturnBirth> = {},
): SaturnBirth => ({
  t: wall - SAT_T0,
  wall,
  slot,
  spr,
  x: 40,
  y: -18,
  hp: 12800,
  key,
  attr: 0,
  atk: 256,
  scroll,
  ...more,
});
const SATURN: SaturnSurveyFile = {
  pane: "saturn",
  level: "Test",
  source: "cart",
  kept: [[1000, 4000], [8000, 8000], [9000, 11000]],
  deaths: 2,
  n: satSamples.length,
  t0: SAT_T0,
  err: null,
  kinds: {},
  maxObjs: 5,
  ended: null,
  births: [
    satBirth(1200, 4, 15, 0, 310, { hp: 256, atk: 6656 }),
    satBirth(1400, 4, 15, 0, 320, { hp: 256, atk: 6656 }),
    satBirth(1500, 100, 67, 128, 325),
    satBirth(2000, 101, 83, 132, 350, { hp: 25600, x: 280 }),
    satBirth(2500, 102, 119, 141, 375, { attr: 1 }),
    satBirth(2600, 103, 119, 141, 380, { attr: 1 }),
    satBirth(2800, 104, 71, 129, 390),
    satBirth(3000, 106, 219, 182, 400, { hp: 102400, x: 200, y: 100, atk: 768 }),
    satBirth(3000, 115, 55, 0, 400, { hp: 256, x: 50, y: 50 }),
    satBirth(3100, 115, 55, 0, 405, { hp: 256, x: 52, y: 60 }),
    // Two births under B's key beside the live R: R's big shots, not B.
    satBirth(3100, 107, 71, 129, 405, { x: 201, y: 102 }),
    satBirth(3200, 108, 71, 129, 410, { x: 199, y: 108 }),
    // A rewound-away replay of A: outside every kept span, so not counted.
    satBirth(6000, 100, 67, 128, 350),
    satBirth(9100, 64, 26, 0, 455, { hp: 2147483647, atk: 256 }),
    satBirth(10500, 105, 267, 208, 525, { hp: 51200, x: 240, y: 283, atk: 1024 }),
  ],
  samples: satSamples,
};

// The web: one take, 100 ms samples, 5 px per sample from scroll 60.
const WEB_T0 = 2000;
const webSamples: WebSample[] = [];
const webObj = (
  id: number,
  deza: number,
  key: string,
  name: string,
  frame: string,
) => ({ id, kind: "enemy" as const, name, key, deza, x: 16, y: -38, hp: 3, frame, sx: 1, sy: 1 });
for (let i = 0; i <= 60; i++) {
  const t = i * 100;
  const objs: WebSample["objs"] = [];
  if (t >= 500 && t <= 1000) objs.push(webObj(1, 128, "A", "deza0_00", "deza0_00_0.gif"));
  if (t === 1400) objs.push(webObj(2, 132, "D", "deza0_04", "deza0_02_0.gif"));
  if (t === 1500) objs.push(webObj(2, 132, "D", "deza0_04", "deza0_02_1.gif"));
  if (t >= 1800 && t <= 2000) objs.push(webObj(3, 129, "B", "deza0_01", "deza0_00_0.gif"));
  if (t === 2000) objs.push(webObj(13, 182, "R", "deza0_38", "deza0_38_0.gif"));
  if (t === 5800) objs.push(webObj(4, 184, "T", "deza0_40", "deza0_40_0.gif"));
  webSamples.push({
    t,
    wall: WEB_T0 + t,
    step: 0,
    scroll: 60 + 5 * i,
    score: 0,
    player: {
      x: 128,
      y: 400,
      hp: 3,
      shot: t < 2500 ? "normal/speed_normal" : "3way/speed_normal",
      dead: false,
    },
    boss: null,
    objs,
  });
}
const from = (id: number, deza: number, key: string) => ({
  id,
  name: `deza0_${key}`,
  key,
  deza,
  kind: "enemy",
  dist: 10,
});
const webBirth = (
  t: number,
  kind: WebBirth["kind"],
  id: number,
  more: Partial<WebBirth>,
): WebBirth => ({
  t,
  wall: WEB_T0 + t,
  kind,
  id,
  x: 16,
  y: -38,
  frame: null,
  scroll: 60 + t / 20,
  step: 0,
  ...more,
});
const WEB: WebSurveyFile = {
  pane: "web",
  level: "Test",
  source: "import",
  stage: 0,
  modes: ["GOD"],
  n: webSamples.length,
  t0: WEB_T0,
  err: null,
  kinds: {},
  maxObjs: 3,
  ended: null,
  births: [
    webBirth(500, "enemy", 1, { name: "deza0_00", key: "A", deza: 128, frame: "deza0_00_0.gif" }),
    webBirth(1400, "enemy", 2, { name: "deza0_04", key: "D", deza: 132, frame: "deza0_02_0.gif" }),
    webBirth(1500, "bullet", 5, { frame: "normalProjectile0.gif", tex: "game_asset", from: from(2, 132, "D") }),
    webBirth(1600, "bullet", 6, { frame: "normalProjectile0.gif", tex: "game_asset", from: from(2, 132, "D") }),
    webBirth(1800, "enemy", 3, { name: "deza0_01", key: "B", deza: 129, frame: "deza0_00_0.gif" }),
    webBirth(1900, "bullet", 7, { frame: "dezaBullet0_0.gif", tex: "game_asset", from: from(3, 129, "B") }),
    webBirth(2000, "enemy", 13, { name: "deza0_38", key: "R", deza: 182, frame: "deza0_38_0.gif" }),
    webBirth(2000, "bullet", 8, { frame: "dezaBullet0_0.gif", tex: "game_asset", from: from(3, 129, "B") }),
    webBirth(2000, "item", 10, { name: "3way", x: 96, y: 67, frame: "dezaItem0.gif" }),
    webBirth(2000, "item", 11, { name: "3way", x: 96, y: 67, frame: "dezaItem1.gif" }),
    webBirth(2100, "bullet", 9, { frame: "dezaBullet1_0.gif", tex: "game_asset", from: from(3, 129, "B") }),
    webBirth(3000, "item", 12, { name: "big", x: 10, y: 10, frame: "dezaItem4.gif" }),
    webBirth(5800, "enemy", 4, { name: "deza0_40", key: "T", deza: 184, frame: "deza0_40_0.gif" }),
  ],
  samples: webSamples,
};

const letter = (r: ReturnType<typeof surveyReport>, l: string) =>
  r.rows.find((row) => row.entry.letter === l)!;

Deno.test("a record's placement id is 128 + 16 x band + its index in the band", () => {
  assertEquals(placementId(0), 128);
  assertEquals(placementId(13), 141);
  assertEquals(placementId(26), 162);
  assertEquals(placementId(38), 182);
  assertEquals(placementId(48), 192);
  assertEquals(placementId(52), 208);
  assertEquals(placementId(56), 224);
  assertEquals(bigShotRecord({ band: 0, index: 13 }), 13);
  assertEquals(bigShotRecord({ band: 2, index: 0 }), 24);
  assertEquals(bigShotRecord({ band: 9, index: 0 }), null);
  assertEquals(bigShotRecord(null), null);
});

Deno.test("the kept clock drops zero-length spans, counts only inside them, and closes an open span at the run's end", () => {
  const clock = keptClock(SATURN.kept, SAT_T0);
  assertEquals(clock.spans, [[1000, 4000], [9000, 11000]]);
  assertEquals(clock.reported, 3);
  assertEquals(clock.seconds, 5);
  assertEquals(clock.at(1500), 0.5);
  assertEquals(clock.at(9500), 3.5);
  assertEquals(clock.at(6000), null);
  assertEquals(clock.spanOf(11000), 1);
  assertEquals(clock.spanOf(12000), -1);
  // An open last span runs to the end it is given; with none it runs on and
  // has no seconds of its own.
  const open = keptClock([[1000, 4000], [9000, null]], SAT_T0, 11000);
  assertEquals(open.spans, [[1000, 4000], [9000, 11000]]);
  assertEquals(open.seconds, 5);
  const endless = keptClock([[1000, 4000], [9000, null]], SAT_T0);
  assertEquals(endless.spanOf(10_000_000), 1);
  assertEquals(endless.at(9500), 3.5);
  assertEquals(endless.seconds, 3);
  // Without spans the whole run from t0 is one span.
  const whole = keptClock(undefined, 500, 4500);
  assertEquals(whole.spans, [[500, 4500]]);
  assertEquals(whole.at(1500), 1);
  assertEquals(whole.seconds, 4);
  assertEquals(whole.spanOf(99), -1);
});

Deno.test("the roster keeps the stage's records in letter order and names each big shot's record", () => {
  const placed = roster(RUSH, 0);
  assertEquals([...placed.values()].map((e) => e.letter), ["A", "B", "D", "R", "T", "W"]);
  assertEquals(placed.get(132)?.bigShot, { record: 13, pid: 141, character: 119 });
  assertEquals(placed.get(182)?.bigShot, { record: 1, pid: 129, character: 71 });
  assertEquals(placed.get(208)?.ground, true);
  assertEquals(placed.get(128)?.fire.enabled, false);
  const targets = bigShotTargets(placed);
  assertEquals(targets.get(141), { pid: 141, record: 13, character: 119, shooters: ["D"], ambiguous: false });
  assertEquals(targets.get(129)?.shooters, ["R"]);
  assertEquals(targets.get(129)?.ambiguous, true);
  assertEquals(roster(RUSH, 1).size, 1);
});

Deno.test("a web bullet's art family tells the kind: the cart's bullet table, a record's cells or the stock bolt", () => {
  assertEquals(webArt("dezaBullet0_3.gif"), "dezaBullet0");
  assertEquals(webArt("normalProjectile2.gif"), "normalProjectile");
  assertEquals(webArt("deza0_13_1.gif"), "record 13 cells");
  assertEquals(webArt("beam_0.png", "boss"), "boss:beam_0.png");
  assertEquals(webArt(null), "?");
});

Deno.test("the report lines records up by scroll after the lead and judges each side's bullet kinds", () => {
  const r = surveyReport({ saturn: SATURN, web: WEB, rush: RUSH });
  assertEquals(r.ok, false);
  // Rows on the web's scroll axis: W, seen on the Saturn only at 525, sits
  // at 285 there, before T's 350.
  assertEquals(r.rows.map((row) => row.entry.letter), ["A", "D", "B", "R", "W", "T"]);
  const [a, d, b, rr, w, t] = r.rows;
  // A: the Saturn's first birth inside a kept span at scroll 325, the web's
  // at 85 — the 240 px lead and nothing else; the replay at 6000 is not a
  // second spawn and leaves no note. Life: six samples on each side.
  assertEquals(a.status, "ok");
  assertEquals(a.note, "");
  assertEquals(a.saturn, { t: 0.5, scroll: 325, x: 40, y: -18, art: "sprite 67" });
  assertEquals(a.web?.scroll, 85);
  assertEquals(a.delta, -240);
  assertEquals(a.residual, 0);
  assertEquals(r.saturn.spawns.get(128), 1);
  assertEquals(a.life, { saturn: 0.5, web: 0.5 });
  assertEquals(a.art, { saturn: ["sprite 67"], web: ["deza0_00_0.gif"] });
  // D came on 20 px late after the lead: the one record that fails.
  assertEquals(d.status, "fail");
  assertEquals(d.residual, 20);
  assertEquals(d.art.web, ["deza0_02_0.gif", "deza0_02_1.gif"]);
  assertAlmostEquals(d.life.saturn!, 0.2);
  // Its big shots: two on the Saturn as record 13's cells over 250 px of
  // kept run, two on the web as the stock bolt over 300 px.
  assertEquals(d.bulletsPerKpx.saturn?.toFixed(1), "8.0");
  assertEquals(d.bulletsPerKpx.web?.toFixed(1), "6.7");
  // B's key is also R's big shots': the two births beside the live R are
  // R's shots, B's own spawn at 390 is judged, and the row says how.
  assertEquals(b.status, "ok");
  assertEquals(b.saturn?.scroll, 390);
  assertEquals(b.residual, 0);
  assertEquals(r.saturn.spawns.get(129), 1);
  assert(b.note.includes("key 129 is also R's big shots (record 1): births within 12 px of a live R counted as shots"), b.note);
  assertEquals(rr.status, "ok");
  assertEquals(rr.bulletsPerKpx.saturn, 8);
  // W parked on the Saturn where the web never spawned it, inside the web's
  // run: one side only. T the web met past the Saturn's last scroll.
  assertEquals(w.status, "one side");
  assertEquals(t.status, "beyond");
  // Kinds by births, then name: the three two-birth kinds keep one order
  // whatever the samplers' timing, and the verdict lists them that way.
  assertEquals(r.failures, [
    "D: first seen +20 px after the 240 px lead",
    "W: seen on the Saturn only (scroll 525)",
    'bullet kind "big shot (record 1) drawn as record 1 cells" on the Saturn only (2 births)',
    'bullet kind "big shot (record 13) drawn as normalProjectile" on the web only (2 births)',
    'bullet kind "big shot (record 13) drawn as record 13 cells" on the Saturn only (2 births)',
  ]);
  assertEquals(r.notJudged, [
    "T: beyond the Saturn's run",
    'bullet kind "type 1 drawn as dezaBullet1": fewer than 2 births; not judged',
  ]);
  assertEquals(
    r.kinds.map((k) => [k.what, k.art, k.saturn, k.web, k.judged]),
    [
      ["type 0", "dezaBullet0", 2, 2, true],
      ["big shot (record 1)", "record 1 cells", 2, 0, true],
      ["big shot (record 13)", "normalProjectile", 0, 2, true],
      ["big shot (record 13)", "record 13 cells", 2, 0, true],
      ["type 1", "dezaBullet1", 0, 1, false],
    ],
  );
  // Who fired what, per side; a big shot by its record's shooters.
  assertEquals(r.kinds[0].shooters, "Saturn B 2; web B 2");
  assertEquals(r.kinds[1].note, "Saturn only; key 129 is also a placed record's; shots told from spawns by proximity");
  assertEquals(r.kinds[2].shooters, "D");
  assertEquals(r.kinds[2].note, "web only");
  // Pacing: 5 px per 100 ms sample on both sides; the junk slots never count
  // as live, B, R and a bullet in one sample do.
  assertEquals(r.saturn.rate, { median: 50, min: 50, max: 50 });
  assertEquals(r.web.rate?.median, 50);
  assertEquals(r.saturn.maxLive, 3);
  assertEquals(r.saturn.seconds, 5);
  assertEquals(r.saturn.carried, 0);
  assertEquals(r.saturn.added, 0);
  // The ship: two VULCAN births in the shot slots, a pod in 64; the web's
  // shoot mode changed once.
  assertEquals(r.saturn.ship.map((o) => [o.art, o.slots, o.attacks, o.births]), [
    ["sprite 15", "4-33", [6656], 2],
    ["sprite 26", "64", [256], 1],
  ]);
  assertEquals(r.web.ship.map((o) => [o.art, o.firstT, o.lastT]), [
    ["normal/speed_normal", 0, 2.5],
    ["3way/speed_normal", 2.5, 6],
  ]);
});

Deno.test("the lead and the tolerance are the report's to set, and move lone records across the other side's run", () => {
  const flat = surveyReport({ saturn: SATURN, web: WEB, rush: RUSH }, { expectedLead: 0 });
  assertEquals(flat.rows[0].residual, -240);
  assertEquals(flat.rows[0].status, "fail");
  // Without the lead W's Saturn scroll 525 is past the web's last scroll,
  // 360, and T's web scroll 350 lands inside the Saturn's run.
  assertEquals([letter(flat, "W").status, letter(flat, "W").note], ["beyond", "beyond the web's run"]);
  assertEquals([letter(flat, "T").status, letter(flat, "T").note], ["one side", "seen on the web only (scroll 350)"]);
  assert(flat.notJudged.includes("W: beyond the web's run"));
  assert(flat.failures.includes("T: seen on the web only (scroll 350)"));
  const loose = surveyReport({ saturn: SATURN, web: WEB, rush: RUSH }, { tolerance: 30 });
  assertEquals(letter(loose, "D").status, "ok");
  assert(!loose.failures.some((f) => f.startsWith("D:")));
  // A lone record below the other side's first scroll is not judged either.
  const early: WebSurveyFile = {
    ...WEB,
    births: WEB.births.map((b) => b.deza === 184 ? { ...b, scroll: 20 } : b),
  };
  const before = surveyReport({ saturn: SATURN, web: early, rush: RUSH });
  assertEquals([letter(before, "T").status, letter(before, "T").note], ["before", "before the Saturn's run"]);
});

Deno.test("the stage option picks the roster, else the web survey's stage, else 0", () => {
  const other = surveyReport({ saturn: SATURN, web: WEB, rush: RUSH }, { stage: 1 });
  assertEquals(other.rows.map((row) => row.entry.letter), ["AA"]);
  assert(other.markdown.startsWith("# Test: the Saturn against the web, stage 1\n"));
  assertEquals(surveyReport({ saturn: SATURN, web: { ...WEB, stage: 1 }, rush: RUSH }).rows.length, 1);
  assertEquals(surveyReport({ saturn: SATURN, web: { ...WEB, stage: undefined }, rush: RUSH }).rows.length, 6);
});

Deno.test("a web birth without a scroll is reported but not judged", () => {
  const web: WebSurveyFile = {
    ...WEB,
    births: WEB.births.map((b) => b.deza === 128 ? { ...b, scroll: null } : b),
  };
  const r = surveyReport({ saturn: SATURN, web, rush: RUSH });
  const a = letter(r, "A");
  assertEquals([a.status, a.note], ["unknown", "no scroll on the web; not judged"]);
  assert(a.saturn && a.web);
  assert(!r.failures.some((f) => f.startsWith("A:")));
  assert(r.notJudged.includes("A: no scroll on the web; not judged"));
});

Deno.test("at a rewind an object that survived the restore is a carry, and one the sampler never logged is added", () => {
  // Two kept spans; slot 100 (A) lives from the first span's start to the
  // second's end and is logged again at the restore; slot 101 (D) appears at
  // the restore with no birth logged; slot 102 (A again) died with the
  // discarded play.
  const alive = (slot: number, key: number, spr: number): Tuple => [slot, spr, 40, 10, 12800, key, 0, 256, 0, 0];
  const samples = [
    satSample(1000, 300, [alive(100, 128, 67)]),
    satSample(1100, 305, [alive(100, 128, 67)]),
    satSample(1200, 310, [alive(100, 128, 67), alive(102, 128, 67)]),
    satSample(5000, 310, [alive(100, 128, 67), alive(101, 132, 83)]),
    satSample(5100, 315, [alive(100, 128, 67), alive(101, 132, 83)]),
    satSample(5200, 320, [alive(100, 128, 67)]),
  ];
  const sat: SaturnSurveyFile = {
    ...SATURN,
    kept: [[1000, 1200], [5000, 5200]],
    births: [
      satBirth(1000, 100, 67, 128, 300),
      satBirth(1200, 102, 67, 128, 310),
      satBirth(5000, 100, 67, 128, 310),
    ],
    samples,
  };
  const placed = roster(RUSH, 0);
  const side = readSaturn(sat, placed, bigShotTargets(placed));
  assertEquals([side.carried, side.added], [1, 1]);
  assertEquals(side.spawns.get(128), 2);
  assertEquals(side.spawns.get(132), 1);
  // D's first is the restore sample, on the kept clock: 0.2 s, scroll 310.
  assertEquals(side.firsts.get(132), { t: 0.2, scroll: 310, x: 40, y: 10, art: "sprite 83" });
  // Slot 100's life runs across the rewind: 0.2 s kept, then 0.2 more.
  assertAlmostEquals(side.lives.get(128)![0], 0.4);
  assertAlmostEquals(side.lives.get(132)![0], 0.1);
  assertEquals(side.notes, [
    "at the rewinds 1 logged birth(s) were objects carried over and 1 spawn(s) the sampler missed were added from the samples",
  ]);
  // Slot 102 died with the discarded play: its life is the one sample.
  assertEquals(side.lives.get(128)!.length, 2);
  assertAlmostEquals(side.lives.get(128)![1], 0);
});

Deno.test("a dead slot re-logged at a rewind is no spawn, and a rewound-away sighting takes the same tests", () => {
  // At the span boundary (walls 4000 -> 9000) slot 120 holds A's key and
  // sprite with no hp on both sides, and the sampler logs a birth for it.
  const dead: Tuple = [120, 67, 40, 10, 0, 128, 0, 256, 0, 0];
  const saturn: SaturnSurveyFile = {
    ...SATURN,
    samples: SATURN.samples.map((s) =>
      s.wall === 4000 || s.wall === 9000 ? { ...s, objs: [...s.objs, dead] as SaturnSample["objs"] } : s
    ),
    births: [
      ...SATURN.births,
      satBirth(9000, 120, 67, 128, 450, { hp: 0 }),
      // In rewound-away play: a dead slot under E's key, and R's shot under
      // B's key beside a live R — neither is a spawn the Saturn made.
      satBirth(5500, 121, 71, 129, 375, { x: 201, y: 101 }),
    ],
  };
  const placed = roster(RUSH, 0);
  const side = readSaturn(saturn, placed, bigShotTargets(placed));
  assertEquals(side.spawns.get(128), 1);
  assertEquals(side.lives.get(128)!.length, 1);
  assertEquals(side.firsts.get(128)?.scroll, 325);
  // No R stands in that rewound sample, so the key-129 birth is B's
  // rewound-away spawn; put R beside it and it is R's shot.
  assertEquals(side.outside.get(129), 375);
  const rSample = saturn.samples.find((s) => s.wall === 5500)!;
  rSample.objs = [...rSample.objs, [106, 219, 200, 100, 102400, 182, 4, 768, 0, 0]] as SaturnSample["objs"];
  assertEquals(readSaturn(saturn, placed, bigShotTargets(placed)).outside.has(129), false);
});

Deno.test("a life ends when the object has left the frame and stopped; parked on the frame it runs on", () => {
  // Slot 100 crosses the frame in 30 px steps, leaves it moving at the
  // eighth sample and freezes just past the edge; slot 101 stands still on
  // the frame throughout.
  const samples: SaturnSample[] = [];
  for (let i = 0; i <= 10; i++) {
    const y = i <= 7 ? 10 + 30 * i : 250;
    samples.push(satSample(1000 + i * 100, 300 + 5 * i, [
      [100, 67, 40, y, 12800, 128, 0, 256, 0, 0],
      [101, 83, 100, 100, 25600, 132, 0, 256, 0, 0],
    ]));
  }
  const sat: SaturnSurveyFile = {
    ...SATURN,
    kept: [[1000, 2000]],
    births: [satBirth(1000, 100, 67, 128, 300), satBirth(1000, 101, 83, 132, 300, { hp: 25600 })],
    samples,
  };
  const placed = roster(RUSH, 0);
  const side = readSaturn(sat, placed, bigShotTargets(placed));
  assertAlmostEquals(side.lives.get(128)![0], 0.8);
  assertAlmostEquals(side.lives.get(132)![0], 1.0);
});

Deno.test("B's key: a birth 12 px from the live R is R's shot, one at 13 px is B's", () => {
  const saturn: SaturnSurveyFile = {
    ...SATURN,
    births: [
      ...SATURN.births,
      satBirth(3000, 109, 71, 129, 400, { x: 212, y: 100 }),
      satBirth(3100, 110, 71, 129, 405, { x: 213, y: 100 }),
    ],
  };
  const r = surveyReport({ saturn, web: WEB, rush: RUSH });
  assertEquals(r.saturn.spawns.get(129), 2);
  const shots = r.kinds.find((k) => k.what === "big shot (record 1)" && k.art === "record 1 cells")!;
  assertEquals(shots.saturn, 3);
});

Deno.test("a stock bolt with no type-3 shooter alive looks one sample back, within reach", () => {
  // D's last sample is t 1500 at (16, -38): a bolt at t 1600 18 px from
  // there is D's; one 340 px away keeps the bystander the sampler named.
  const web: WebSurveyFile = {
    ...WEB,
    births: [
      ...WEB.births,
      webBirth(1600, "bullet", 30, { frame: "normalProjectile0.gif", tex: "game_asset", x: 20, y: -20, from: from(3, 129, "B") }),
      webBirth(1600, "bullet", 31, { frame: "normalProjectile0.gif", tex: "game_asset", x: 200, y: 300, from: from(3, 129, "B") }),
    ],
  };
  const r = surveyReport({ saturn: SATURN, web, rush: RUSH });
  // The fixture's own bolt at t 1.6 (named D) comes first.
  assertEquals(
    r.web.bullets.filter((b) => b.t === 1.6).map((b) => [b.what, b.shooter]),
    [["big shot (record 13)", 132], ["big shot (record 13)", 132], ["bullet from B", 129]],
  );
});

Deno.test("a bullet drawn as a record's cells goes to the shooter of that record, nearer or not", () => {
  // At t 2000 R stands at (16, -38) and D, put there for this test, at
  // (100, 100): a deza0_13 bullet beside R is D's big shot all the same.
  const web: WebSurveyFile = {
    ...WEB,
    samples: WEB.samples.map((s) =>
      s.t === 2000
        ? { ...s, objs: [...s.objs, { ...webObj(2, 132, "D", "deza0_04", "deza0_02_0.gif"), x: 100, y: 100 }] }
        : s
    ),
    births: [
      ...WEB.births,
      webBirth(2000, "bullet", 32, { frame: "deza0_13_0.gif", tex: "game_asset", x: 16, y: -30, from: from(13, 182, "R") }),
    ],
  };
  const r = surveyReport({ saturn: SATURN, web, rush: RUSH });
  const cells = r.web.bullets.find((b) => b.art === "record 13 cells")!;
  assertEquals([cells.what, cells.shooter], ["big shot (record 13)", 132]);
  // Drawn with its record's own cells, the web's kind now matches the
  // Saturn's and is on both sides.
  const kind = r.kinds.find((k) => k.what === "big shot (record 13)" && k.art === "record 13 cells")!;
  assertEquals([kind.saturn, kind.web, kind.note], [2, 1, ""]);
});

Deno.test("readSaturn closes an open last kept span at the run's last sample", () => {
  const placed = roster(RUSH, 0);
  const side = readSaturn({ ...SATURN, kept: [[1000, 4000], [9000, null]] }, placed, bigShotTargets(placed));
  assertEquals(side.seconds, 5);
  assertEquals(side.samples, 52);
  assertEquals(side.firsts.get(208)?.t, 4.5);
  assertEquals(side.scrollTo, 550);
});

Deno.test("a web bullet's kind follows its art: the bullet table is a type whoever is nearest, the stock bolt a big shot of the nearest type-3 shooter", () => {
  const web: WebSurveyFile = {
    ...WEB,
    births: [
      ...WEB.births,
      // The cart's type-0 art born beside D stays type 0.
      webBirth(1400, "bullet", 20, { frame: "dezaBullet0_1.gif", tex: "game_asset", from: from(2, 132, "D") }),
      // The stock bolt the sampler pinned on B, with D alive 9 px away, is D's big shot.
      webBirth(1400, "bullet", 21, { frame: "normalProjectile1.gif", tex: "game_asset", x: 20, y: -30, from: from(3, 129, "B") }),
      // The stock bolt with no type-3 shooter alive keeps its bystander.
      webBirth(5800, "bullet", 22, { frame: "normalProjectile0.gif", tex: "game_asset", from: from(4, 184, "T") }),
    ],
  };
  const r = surveyReport({ saturn: SATURN, web, rush: RUSH });
  const at = (t: number) => r.web.bullets.filter((b) => b.t === t);
  assertEquals(at(1.4).map((b) => [b.what, b.art, b.shooter]), [
    ["type 0", "dezaBullet0", 132],
    ["big shot (record 13)", "normalProjectile", 132],
  ]);
  assertEquals(at(5.8).map((b) => [b.what, b.art, b.shooter]), [["bullet from T", "normalProjectile", 184]]);
  const bolt = r.kinds.find((k) => k.what === "big shot (record 13)" && k.art === "normalProjectile")!;
  assertEquals([bolt.web, bolt.shooters], [3, "D"]);
  // D's column counts its three big shots and the type-0 bolt beside it.
  assertEquals(letter(r, "D").bulletsPerKpx.web?.toFixed(1), "13.3");
});

Deno.test("a big shot two letters fire is shared between them unless the side names the shooter", () => {
  const shot = { enabled: true, mode: 3, interval: 3, bigShot: { band: 0, index: 5, character: 87, frames: 4 } };
  const rush: RushRecord = {
    ...RUSH,
    enemyData: { ...RUSH.enemyData, enemyU: enemy(48, 192, shot), enemyV: enemy(49, 193, shot) },
  };
  const placed = roster(rush, 0);
  assertEquals(bigShotTargets(placed).get(133), { pid: 133, record: 5, character: 87, shooters: ["U", "V"], ambiguous: false });
  // Three record-5 big shots on the Saturn over 250 kept px carry no
  // shooter: half to each letter. One stock bolt from U on the web over
  // 300 px is U's alone.
  const saturn: SaturnSurveyFile = {
    ...SATURN,
    births: [
      ...SATURN.births,
      satBirth(3200, 110, 87, 133, 410, { attr: 1 }),
      satBirth(3300, 111, 87, 133, 415, { attr: 1 }),
      satBirth(3400, 112, 87, 133, 420, { attr: 1 }),
    ],
  };
  const web: WebSurveyFile = {
    ...WEB,
    births: [
      ...WEB.births,
      webBirth(4000, "bullet", 20, { frame: "normalProjectile1.gif", tex: "game_asset", from: from(9, 192, "U") }),
    ],
  };
  const r = surveyReport({ saturn, web, rush });
  assertEquals(letter(r, "U").bulletsPerKpx, { saturn: 6, web: 1 / 0.3 });
  assertEquals(letter(r, "V").bulletsPerKpx, { saturn: 6, web: 0 });
  const kind = r.kinds.find((k) => k.what === "big shot (record 5)" && k.art === "record 5 cells")!;
  assertEquals([kind.saturn, kind.web, kind.shooters, kind.judged, kind.note], [3, 0, "U/V", true, "Saturn only"]);
  const bolt = r.kinds.find((k) => k.what === "big shot (record 5)" && k.art === "normalProjectile")!;
  assertEquals(bolt.shooters, "U/V (web: U 1)");
  assert(r.markdown.includes("- record 5 (key 133, character 87) fired by U/V"), r.markdown);
});

Deno.test("the 12-tuple samples feed a life and a nearest shooter; an effect in the pool is neither", () => {
  const saturn: SaturnSurveyFile = {
    ...SATURN,
    births: [
      ...SATURN.births,
      satBirth(2100, 116, 55, 0, 355, { hp: 256, x: 270, y: -10 }),
      satBirth(2100, 117, 49, 0, 355, { hp: 0, x: 100, y: 100 }),
    ],
  };
  const r = surveyReport({ saturn, web: WEB, rush: RUSH });
  // Two type-0 bullets, two record-13 and two record-1 big shots, plus the
  // bullet born beside D's 12-tuple slot — and not the effect sprite.
  assertEquals(r.saturn.bullets.length, 7);
  assertEquals(r.saturn.bullets.find((b) => b.t === 1.1), {
    what: "type 0",
    art: "dezaBullet0",
    shooter: 132,
    t: 1.1,
    scroll: 355,
  });
  assertEquals(r.kinds[0].shooters, "Saturn B 2, D 1; web B 2");
  assertEquals([...r.saturn.spawns.values()].reduce((a, b) => a + b, 0), 5);
});

Deno.test("without kept spans the whole run counts, replay and all, and the report says so", () => {
  const placed = roster(RUSH, 0);
  for (const kept of [undefined, []]) {
    const side = readSaturn({ ...SATURN, kept }, placed, bigShotTargets(placed));
    assertEquals(side.notes, ["no kept spans in the file: the whole run counts"]);
    assertEquals(side.samples, 73);
    assertEquals(side.seconds, 10);
    // The rewound-away replay of A at wall 6000 is a second spawn now...
    assertEquals(side.spawns.get(128), 2);
    assertEquals(side.firsts.get(128)?.t, 0.5);
    // ...and the rewound stretch drags the one-span rate down from 50 px/s.
    assertEquals(side.rate, { median: 25, min: 25, max: 25 });
  }
  const md = surveyReport({ saturn: { ...SATURN, kept: undefined }, web: WEB, rush: RUSH }).markdown;
  assert(md.includes("- Saturn: no kept spans in the file: the whole run counts"), md);
});

Deno.test("a run with every record on time and no bullets passes, and the markdown says so", () => {
  const saturn: SaturnSurveyFile = {
    ...SATURN,
    births: SATURN.births.filter((b) => b.key === 128 || b.slot < 99),
  };
  const web: WebSurveyFile = {
    ...WEB,
    births: WEB.births.filter((b) => b.kind !== "bullet" && b.deza === 128),
  };
  const r = surveyReport({ saturn, web, rush: RUSH });
  assertEquals(r.ok, true);
  assertEquals(r.failures, []);
  assertEquals(r.kinds, []);
  assertEquals(
    r.rows.map((row) => [row.entry.letter, row.status]),
    [["A", "ok"], ["B", "unseen"], ["D", "unseen"], ["R", "unseen"], ["T", "unseen"], ["W", "unseen"]],
  );
  // The Saturn saw B only in rewound-away play? No — not at all here; D's
  // replay-only sighting would be named: give it one.
  assertEquals(r.rows[0].bulletsPerKpx, { saturn: 0, web: 0 });
  assert(r.markdown.includes("**Verdict: PASS**.\n"), r.markdown);
  assert(
    r.markdown.includes("**PASS** — every record first seen within 16 px after the 240 px lead, and every bullet kind on both sides."),
    r.markdown,
  );
  assert(r.markdown.includes("| Enemy bullets seen | 0 | 0 |"), r.markdown);
  assert(r.markdown.includes("| --- | --- | --- | --- | --- | --- |\n\n## The ship"), r.markdown);
  // A record the Saturn spawned only in rewound-away play says so on its row.
  const replayed = surveyReport({
    saturn: { ...saturn, births: [...saturn.births, satBirth(6000, 101, 83, 132, 350, { hp: 25600 })] },
    web: { ...web, births: [...web.births, webBirth(1400, "enemy", 2, { name: "deza0_04", key: "D", deza: 132, frame: "deza0_02_0.gif" })] },
    rush: RUSH,
  });
  const d = letter(replayed, "D");
  assertEquals(d.status, "one side");
  assertEquals(d.note, "seen on the web only (scroll 130); the Saturn spawned it only in rewound-away play (scroll 350)");
  // The verdict line carries the finding alone; the row carries the rest.
  assertEquals(replayed.failures, ["D: seen on the web only (scroll 130)"]);
});

Deno.test("the markdown carries the verdict, the record table, the kinds, the ship and the items", () => {
  const md = surveyReport({ saturn: SATURN, web: WEB, rush: RUSH }).markdown;
  assert(md.startsWith("# Test: the Saturn against the web, stage 0\n"), md.slice(0, 80));
  assert(md.includes("**Verdict: FAIL** — 5 finding(s)"), md);
  assert(md.includes("| 128 | A | deza0_00 | 0 | — | 0.5 s / 325 | 0.5 s / 85 | -240 | 0 |"), md);
  assert(md.includes("| 132 | D | deza0_04 | 4 | type 3 / 11 → rec 13 |"), md);
  assert(md.includes("**FAIL** first seen +20 px after the 240 px lead"), md);
  assert(md.includes("| 129 | B | deza0_01 | 1 | type 0 / 59 | 1.8 s / 390 | 1.8 s / 150 | -240 | 0 |"), md);
  assert(md.includes("| ok; key 129 is also R's big shots (record 1): births within 12 px of a live R counted as shots |"), md);
  assert(md.includes("| 208 | W (ground) |"), md);
  assert(md.includes("Big-shot records (what the type-3 shooters build their shots from):"), md);
  assert(md.includes("- record 13 (key 141, character 119) fired by D"), md);
  assert(md.includes("- record 1 (key 129, character 71) fired by R — the key of a placed record too"), md);
  assert(md.includes("| type 0 | dezaBullet0 | 2 | 2 | Saturn B 2; web B 2 | both sides |"), md);
  assert(md.includes("| big shot (record 13) | normalProjectile | 0 | 2 | D | web only |"), md);
  assert(md.includes("| big shot (record 1) | record 1 cells | 2 | 0 | R | Saturn only; key 129 is also a placed record's; shots told from spawns by proximity |"), md);
  assert(md.includes("| type 1 | dezaBullet1 | 0 | 1 | web B 1 | fewer than 2 births; not judged |"), md);
  assert(md.includes("| sprite 15 | 4-33 | 6656 | 2 | 0.2 | 0.4 |"), md);
  assert(md.includes("`playerData` draws them as normal bigProjectile_*"), md);
  assert(md.includes("| 3way/speed_normal | 2.5 | 6.0 |"), md);
  assert(md.includes("3 item births — 3way 2, big 1 — 1 of them landing"), md);
  assert(md.includes("- T: beyond the Saturn's run"), md);
  assert(md.includes('- bullet kind "type 1 drawn as dezaBullet1": fewer than 2 births; not judged'), md);
  assertEquals(webItems(WEB), { byName: new Map([["3way", 2], ["big", 1]]), pairs: 1, total: 3 });
  // Two different drops on one spot are not one drop arriving twice.
  const mixed: WebSurveyFile = {
    ...WEB,
    births: WEB.births.map((b) => b.id === 11 ? { ...b, name: "big" } : b),
  };
  assertEquals(webItems(mixed).pairs, 0);
});
