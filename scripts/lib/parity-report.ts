// The parity testdrive's SURVEY REPORT: one run's Saturn survey set against its
// web survey, record by record, as `report-survey.md` beside `report.json`
// (README-Parity.md §5, Phase 0). Everything here is pure — it reads the two
// survey files the samplers in parity-survey.ts wrote and the run's rush.json
// (the imported level record, for the roster) and returns markdown plus a
// verdict; scripts/testdrive-parity.ts writes the file and sets the exit code.
//
// What is compared, and how (the README's §2 numbers were built this way):
//
// - The Saturn's run is read on its KEPT clock: the rewind pilot replays a
//   span after every death, so only births and samples whose wall time falls
//   inside a kept span count, and time is the sum of the spans before plus
//   the offset into the current one. The web's run is one take under god
//   mode and needs no such mapping. Both sides are then lined up by the
//   stage's own clock, the map's scroll position, never by seconds.
// - A grid enemy is known on both sides by its PLACEMENT ID: the Saturn's
//   formation key (a pool slot's byte at 0x06090530), the web's `dezaKey`,
//   rush.json's `enemyData[*].dezaemon.placementId` — 128 + 16 × band + the
//   record's index in its band (bands start at records 0/16/24/32/48/52/56).
//   A type-3 "big shot" is a class-99 object built from the record its
//   shooter's byte 5 names, and carries THAT record's placement id, so a key
//   nobody placed names a big shot; a key that is both (Ramsie's B and R's
//   big shots) is told apart by proximity — a birth within AMBIGUOUS_SHOT_PX
//   of a live shooter of that record is the shot (a big shot is built where
//   its shooter stands; a placement enters from the edge).
// - A bullet KIND is what fired it and what it is drawn with. On the Saturn
//   a type-0/1/2 bullet is sprite 55/59/63 drawn with the cart's bullet art
//   table (`dezaBullet<type>` on the web), a big shot is drawn with its
//   record's own cells; on the web a bullet's kind follows its art — the
//   cart's bullet table is a type, the stock bolt or a record's cells a big
//   shot of the nearest type-3 shooter (the sampler's nearest-enemy guess
//   lands on bystanders). A kind on one side only — today the web's stock
//   `normalProjectile` bolts standing in for every big shot — fails the
//   run, as does a record whose first-seen scroll differs by more than
//   SCROLL_TOLERANCE once the web's known gate lead (its wave gate is
//   row·16−512 against the Saturn's row·16−272, so every row comes on
//   WEB_GATE_LEAD px early) is taken out.
// - One thing the kept clock alone gets wrong: the Saturn sampler logs a
//   birth when a slot's sprite differs from its previous tick, and after a
//   rewind that tick belongs to the DISCARDED play. So at a span's first
//   kept sample an object that survived the restore can be logged again (a
//   carry here, not a birth), one the discarded play had left the same
//   sprite in is not logged at all (added here from the sample), and a DEAD
//   slot can be logged too (dead slots keep key and sprite; a birth with no
//   hp is never a spawn).
// - A Saturn life ends when the object has left the 320×224 frame and
//   stopped moving: the engine parks what has exited just past the edge,
//   alive, until its slot is reused. The web's ends when the runtime
//   removes the object. Rows are ordered by first appearance on the web's
//   scroll axis (a record the web never saw by its Saturn scroll less the
//   lead); bullet kinds by births, then name.

import type {
  SaturnBirth,
  SaturnSample,
  SurveyDump,
  WebBirth,
  WebSample,
} from "./parity-survey.ts";

/** How early the web's wave gate lets a row on, in scroll px (P1). */
export const WEB_GATE_LEAD = 512 - 272;
/** A record's first-seen scroll may differ by this much after the lead. */
export const SCROLL_TOLERANCE = 16;
/** A bullet kind with fewer births than this is listed but not judged. */
export const KIND_MIN_BIRTHS = 2;
/** A birth under a key that is also a big shot's, this close to a live shooter, is the shot. */
export const AMBIGUOUS_SHOT_PX = 12;
/** The Saturn's frame; what has left it and stopped has exited. */
export const SATURN_FRAME = { width: 320, height: 224 } as const;
/** A web bolt with no type-3 shooter alive looks one sample back, this far. */
export const SHOOTER_REACH_PX = 64;

/** Object slots: the enemy pool, player 1's shots, the pods and SUB objects. */
export const SLOTS = {
  ship: 2,
  shots: [4, 33] as const,
  pods: [[64, 71], [80, 87]] as const,
  bossCore: 98,
  pool: [99, 248] as const,
};
/** Enemy bullet sprite index -> bullet type (FORMAT.md "Shot sprites"). */
export const BULLET_SPRITES: Record<number, number> = { 55: 0, 59: 1, 63: 2 };
/** The first record of each art band; a band's placement ids start 16 apart. */
export const BAND_FIRST = [0, 16, 24, 32, 48, 52, 56];

/** The placement id a record carries as its formation key. */
export function placementId(record: number): number {
  let band = 0;
  for (let i = 0; i < BAND_FIRST.length; i++) {
    if (record >= BAND_FIRST[i]) band = i;
  }
  return 128 + 16 * band + (record - BAND_FIRST[band]);
}

/** The record a big shot's band/index names, or null off the table. */
export function bigShotRecord(
  shot: { band: number; index: number } | null | undefined,
): number | null {
  if (!shot || shot.band < 0 || shot.band >= BAND_FIRST.length) return null;
  return BAND_FIRST[shot.band] + shot.index;
}

// --- the inputs -------------------------------------------------------------

export interface SaturnSurveyFile
  extends SurveyDump<SaturnBirth, SaturnSample> {
  pane?: string;
  level?: string;
  source?: string;
  /** Wall-ms spans the rewind pilot kept; a null end is an open last span. */
  kept?: [number, number | null][];
  deaths?: number;
}

export interface WebSurveyFile extends SurveyDump<WebBirth, WebSample> {
  pane?: string;
  level?: string;
  source?: string;
  stage?: number;
  modes?: string[];
}

/** The parts of a level record the report reads. */
export interface RushRecord {
  name?: string;
  enemyData?: Record<string, RushEnemy>;
  playerData?: Record<string, unknown>;
  dezaemonBullets?: { art?: string[][] };
}

export interface RushEnemy {
  name?: string;
  hp?: number;
  texture?: string[];
  dezaemon?: {
    stage?: number;
    record?: number;
    placementId?: number;
    behavior?: {
      hp?: number;
      ground?: boolean;
      fire?: {
        enabled?: boolean;
        mode?: number;
        interval?: number;
        geometry?: number | null;
        bigShot?: { band: number; index: number; character: number } | null;
      };
    };
  };
}

// --- the roster -------------------------------------------------------------

export interface RosterEntry {
  pid: number;
  letter: string;
  name: string;
  record: number;
  /** hp in the cart's units (256 per hit of 1). */
  hp: number | null;
  webHp: number | null;
  ground: boolean;
  fire: {
    enabled: boolean;
    mode: number;
    interval: number | null;
    geometry: number | null;
  };
  /** For a type-3 shooter: the record its big shots are built from. */
  bigShot: { record: number; pid: number; character: number } | null;
}

/** The stage's placed records by placement id, letters in grid order. */
export function roster(
  rush: RushRecord,
  stage = 0,
): Map<number, RosterEntry> {
  const out = new Map<number, RosterEntry>();
  for (const [key, e] of Object.entries(rush.enemyData ?? {})) {
    const dz = e.dezaemon;
    if (!dz || (dz.stage ?? 0) !== stage) continue;
    const record = dz.record ?? -1;
    const pid = dz.placementId ?? (record >= 0 ? placementId(record) : -1);
    if (pid < 0) continue;
    const fire = dz.behavior?.fire ?? {};
    const shotRecord = (fire.mode ?? 0) === 3
      ? bigShotRecord(fire.bigShot)
      : null;
    out.set(pid, {
      pid,
      letter: key.replace(/^enemy/, ""),
      name: e.name ?? key,
      record,
      hp: dz.behavior?.hp ?? null,
      webHp: e.hp ?? null,
      ground: !!dz.behavior?.ground,
      fire: {
        enabled: !!fire.enabled,
        mode: fire.mode ?? 0,
        interval: fire.interval ?? null,
        geometry: fire.geometry ?? null,
      },
      bigShot: shotRecord === null ? null : {
        record: shotRecord,
        pid: placementId(shotRecord),
        character: fire.bigShot?.character ?? 0,
      },
    });
  }
  return new Map(
    [...out.entries()].sort((a, b) =>
      a[1].letter.length - b[1].letter.length ||
      a[1].letter.localeCompare(b[1].letter)
    ),
  );
}

export interface BigShotTarget {
  pid: number;
  record: number;
  character: number;
  /** The letters whose big shots are built from this record. */
  shooters: string[];
  /** True when a placed record carries the same key (B and R's shots). */
  ambiguous: boolean;
}

/** The records the stage's type-3 shooters fire, by the key their shots carry. */
export function bigShotTargets(
  placed: Map<number, RosterEntry>,
): Map<number, BigShotTarget> {
  const out = new Map<number, BigShotTarget>();
  for (const e of placed.values()) {
    if (!e.bigShot) continue;
    const t = out.get(e.bigShot.pid) ?? {
      pid: e.bigShot.pid,
      record: e.bigShot.record,
      character: e.bigShot.character,
      shooters: [],
      ambiguous: placed.has(e.bigShot.pid),
    };
    t.shooters.push(e.letter);
    out.set(e.bigShot.pid, t);
  }
  return out;
}

// --- the kept clock ---------------------------------------------------------

export interface KeptClock {
  /** Closed spans with some length, in wall ms. */
  spans: [number, number][];
  /** How many spans the pilot reported, zero-length ones included. */
  reported: number;
  /** True when no span had any length and the whole run became one. */
  whole: boolean;
  seconds: number;
  /** The span index a wall time falls in, or -1. */
  spanOf(wall: number): number;
  /** Seconds on the kept clock, or null outside every span. */
  at(wall: number): number | null;
}

/**
 * The Saturn's kept spans as a clock. An open last span (a null end) and
 * the no-span case (no rewind pilot: the whole run from t0 is one span)
 * close at `end` — the run's last sample — when it is given.
 */
export function keptClock(
  kept: [number, number | null][] | undefined,
  t0: number | null,
  end: number | null = null,
): KeptClock {
  const open = end ?? Number.MAX_SAFE_INTEGER;
  const spans = (kept ?? [])
    .map(([a, b]) => [a, b ?? Math.max(open, a)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const whole = !spans.length;
  if (whole) spans.push([t0 ?? 0, Math.max(open, t0 ?? 0)]);
  const starts: number[] = [];
  let acc = 0;
  for (const [a, b] of spans) {
    starts.push(acc);
    acc += b === Number.MAX_SAFE_INTEGER ? 0 : b - a;
  }
  const spanOf = (wall: number) =>
    spans.findIndex(([a, b]) => wall >= a && wall <= b);
  return {
    spans,
    reported: kept?.length ?? 0,
    whole,
    seconds: acc / 1000,
    spanOf,
    at(wall) {
      const i = spanOf(wall);
      return i < 0 ? null : (starts[i] + (wall - spans[i][0])) / 1000;
    },
  };
}

// --- one side's reading -----------------------------------------------------

export interface FirstSeen {
  /** Seconds on the side's clock (kept for the Saturn, run for the web). */
  t: number;
  scroll: number | null;
  x: number;
  y: number;
  /** The Saturn sprite index or the web frame. */
  art: string;
}

export interface BulletSeen {
  /** `type 0`, `big shot (record 13)` or `bullet from X`. */
  what: string;
  /** `dezaBullet0`, `record 13 cells`, `normalProjectile`, a frame name. */
  art: string;
  /** The placement id of what fired it, or null when unknown. */
  shooter: number | null;
  t: number;
  scroll: number | null;
}

export interface ShipObject {
  /** Sprite index (Saturn) or shoot mode (web). */
  art: string;
  slots: string;
  /** The attack words seen, most common first (the web has none). */
  attacks: number[];
  births: number;
  firstT: number;
  lastT: number;
}

export interface SideReading {
  side: "saturn" | "web";
  source: string;
  samples: number;
  seconds: number;
  wallSeconds: number;
  scrollFrom: number | null;
  scrollTo: number | null;
  /** Median px/s over the spans that have two samples, and their range. */
  rate: { median: number; min: number; max: number } | null;
  maxObjs: number;
  /** Objects with hp > 0 at once (the Saturn's pool counts dead slots). */
  maxLive: number | null;
  firsts: Map<number, FirstSeen>;
  /** Births per placement id on the side's clock. */
  spawns: Map<number, number>;
  art: Map<number, Set<string>>;
  /** Seconds each spawn of a record stayed alive. */
  lives: Map<number, number[]>;
  bullets: BulletSeen[];
  ship: ShipObject[];
  /** Placed records the Saturn spawned only in rewound-away play: pid -> scroll. */
  outside: Map<number, number>;
  /** Rewind boundaries: births that were carries, and spawns added from the sample. */
  carried: number;
  added: number;
  notes: string[];
}

const inPool = (slot: number) =>
  slot >= SLOTS.pool[0] && slot <= SLOTS.pool[1];
const inRange = (slot: number, r: readonly [number, number]) =>
  slot >= r[0] && slot <= r[1];
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** The Saturn survey on its kept clock. */
export function readSaturn(
  sat: SaturnSurveyFile,
  placed: Map<number, RosterEntry>,
  targets: Map<number, BigShotTarget>,
): SideReading {
  const samples = [...sat.samples].sort((a, b) => a.wall - b.wall);
  const lastWall = samples.length ? samples[samples.length - 1].wall : null;
  const clock = keptClock(sat.kept, sat.t0, lastWall);
  const kept = samples.filter((s) => clock.spanOf(s.wall) >= 0);
  const byWall = new Map<number, number>();
  kept.forEach((s, i) => byWall.set(s.wall, i));
  const anyByWall = new Map<number, SaturnSample>();
  samples.forEach((s) => anyByWall.set(s.wall, s));
  const firsts = new Map<number, FirstSeen>();
  const spawns = new Map<number, number>();
  const art = new Map<number, Set<string>>();
  const lives = new Map<number, number[]>();
  const bullets: BulletSeen[] = [];
  const shipBirths = new Map<string, ShipObject>();
  const attackSeen = new Map<string, Map<number, number>>();
  const outside = new Map<number, number>();
  const shooterPids = new Set(placed.keys());
  const pidOfLetter = new Map(
    [...placed.values()].map((e) => [e.letter, e.pid] as const),
  );

  // Rewind boundaries (see the header): at a span's first kept sample, a pool
  // object the previous kept sample held in the same slot with the same key
  // and sprite, alive, is a carry; one it did not hold, with no birth logged
  // at that sample, is a spawn the sampler missed.
  const carriedAt = new Map<number, Set<number>>();
  const loggedAt = new Map<number, Set<number>>();
  for (const b of sat.births) {
    (loggedAt.get(b.wall) ?? loggedAt.set(b.wall, new Set()).get(b.wall)!)
      .add(b.slot);
  }
  const added: SaturnBirth[] = [];
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1], s = kept[i];
    if (clock.spanOf(prev.wall) === clock.spanOf(s.wall)) continue;
    const slots = new Set<number>();
    for (const o of s.objs) {
      if (!inPool(o[0]) || o[4] <= 0) continue;
      const p = prev.objs.find((q) => q[0] === o[0]);
      if (p && p[5] === o[5] && p[1] === o[1] && p[4] > 0) {
        slots.add(o[0]);
      } else if (!loggedAt.get(s.wall)?.has(o[0])) {
        added.push({
          t: s.t,
          wall: s.wall,
          slot: o[0],
          spr: o[1],
          x: o[2],
          y: o[3],
          hp: o[4],
          key: o[5],
          attr: o[6],
          atk: o[7],
          scroll: s.scroll,
        });
      }
    }
    if (slots.size) carriedAt.set(s.wall, slots);
  }
  let carried = 0;

  const shotOf = (b: SaturnBirth, sample: SaturnSample | undefined) => {
    const target = targets.get(b.key);
    return target &&
        (!placed.has(b.key) ||
          nearShooter(sample, b, target.shooters.map((l) => pidOfLetter.get(l))))
      ? target
      : undefined;
  };
  const births = [...sat.births, ...added].sort((a, b) => a.wall - b.wall);
  for (const b of births) {
    const t = clock.at(b.wall);
    if (t === null) {
      // Rewound-away play: remembered for a record the kept run never
      // shows, under the same tests as a kept birth.
      if (
        inPool(b.slot) && b.hp > 0 && placed.has(b.key) &&
        BULLET_SPRITES[b.spr] === undefined && !outside.has(b.key) &&
        !shotOf(b, anyByWall.get(b.wall))
      ) {
        outside.set(b.key, b.scroll);
      }
      continue;
    }
    if (inPool(b.slot)) {
      if (carriedAt.get(b.wall)?.has(b.slot)) {
        carried++;
        continue;
      }
      // A dead slot keeps its key and sprite; a birth with no hp is a slot
      // the discarded play had changed, not a spawn.
      if (b.hp <= 0) continue;
      const sample = kept[byWall.get(b.wall) ?? -1];
      const type = BULLET_SPRITES[b.spr];
      if (type !== undefined && b.key === 0) {
        bullets.push({
          what: `type ${type}`,
          art: `dezaBullet${type}`,
          shooter: nearestShooter(sample, b, shooterPids),
          t,
          scroll: b.scroll,
        });
        continue;
      }
      const target = shotOf(b, sample);
      if (target) {
        bullets.push({
          what: `big shot (record ${target.record})`,
          art: b.spr === target.character
            ? `record ${target.record} cells`
            : `sprite ${b.spr}`,
          shooter: null,
          t,
          scroll: b.scroll,
        });
        continue;
      }
      if (!placed.has(b.key)) continue;
      if (!firsts.has(b.key)) {
        firsts.set(b.key, {
          t,
          scroll: b.scroll,
          x: b.x,
          y: b.y,
          art: `sprite ${b.spr}`,
        });
      }
      spawns.set(b.key, (spawns.get(b.key) ?? 0) + 1);
      (art.get(b.key) ?? art.set(b.key, new Set()).get(b.key)!).add(
        `sprite ${b.spr}`,
      );
      const life = saturnLife(kept, byWall.get(b.wall), b, clock);
      if (life !== null) {
        (lives.get(b.key) ?? lives.set(b.key, []).get(b.key)!).push(life);
      }
      continue;
    }
    const shot = inRange(b.slot, SLOTS.shots);
    const pod = SLOTS.pods.some((r) => inRange(b.slot, r));
    if (!shot && !pod) continue;
    const key = `${shot ? "shot" : "pod"}:${b.spr}`;
    const o = shipBirths.get(key) ?? {
      art: `sprite ${b.spr}`,
      slots: shot ? `${SLOTS.shots[0]}-${SLOTS.shots[1]}` : `${b.slot}`,
      attacks: [],
      births: 0,
      firstT: t,
      lastT: t,
    };
    o.births++;
    o.lastT = t;
    attackSeen.set(key, attackSeen.get(key) ?? new Map());
    const seen = attackSeen.get(key)!;
    seen.set(b.atk, (seen.get(b.atk) ?? 0) + 1);
    o.attacks = [...seen.entries()].sort((p, q) => q[1] - p[1]).map((e) => e[0]);
    if (pod && !o.slots.split(", ").includes(String(b.slot))) {
      o.slots += `, ${b.slot}`;
    }
    shipBirths.set(key, o);
  }

  // Scroll pacing per kept span, from the samples inside it.
  const rates: number[] = [];
  for (let i = 0; i < clock.spans.length; i++) {
    const inside = kept.filter((s) => clock.spanOf(s.wall) === i);
    if (inside.length < 2) continue;
    const a = inside[0], z = inside[inside.length - 1];
    const dt = (z.wall - a.wall) / 1000;
    if (dt > 0) rates.push((z.scroll - a.scroll) / dt);
  }
  let maxLive = 0;
  for (const s of kept) {
    const live = s.objs.filter((o) => o[4] > 0 && o[0] < 249).length;
    if (live > maxLive) maxLive = live;
  }
  const notes: string[] = [];
  if (clock.whole) {
    notes.push("no kept spans in the file: the whole run counts");
  }
  if (carried || added.length) {
    notes.push(
      `at the rewinds ${carried} logged birth(s) were objects carried over and ${added.length} spawn(s) the sampler missed were added from the samples`,
    );
  }
  if (sat.err) notes.push(`sampler error: ${sat.err}`);
  return {
    side: "saturn",
    source: sat.source ?? "export",
    samples: kept.length,
    seconds: clock.seconds === 0 && kept.length
      ? (kept[kept.length - 1].wall - kept[0].wall) / 1000
      : clock.seconds,
    wallSeconds: samples.length
      ? (samples[samples.length - 1].wall - samples[0].wall) / 1000
      : 0,
    scrollFrom: kept.length ? kept[0].scroll : null,
    scrollTo: kept.length ? kept[kept.length - 1].scroll : null,
    rate: rates.length
      ? {
        median: median(rates),
        min: Math.min(...rates),
        max: Math.max(...rates),
      }
      : null,
    maxObjs: sat.maxObjs,
    maxLive,
    firsts,
    spawns,
    art,
    lives,
    bullets,
    ship: [...shipBirths.values()].sort((a, b) => a.firstT - b.firstT),
    outside,
    carried,
    added: added.length,
    notes,
  };
}

/** Whether a live shooter of a big shot's record stands within reach of a birth. */
function nearShooter(
  sample: SaturnSample | undefined,
  b: SaturnBirth,
  shooterPids: (number | undefined)[],
): boolean {
  if (!sample) return false;
  const pids = new Set(shooterPids.filter((p): p is number => p !== undefined));
  return sample.objs.some((o) =>
    inPool(o[0]) && pids.has(o[5]) && o[4] > 0 &&
    Math.hypot(o[2] - b.x, o[3] - b.y) <= AMBIGUOUS_SHOT_PX
  );
}

/** The placed record nearest a bullet in the sample it was born in. */
function nearestShooter(
  sample: SaturnSample | undefined,
  b: SaturnBirth,
  shooters: Set<number>,
): number | null {
  if (!sample) return null;
  let best: number | null = null, bd = Infinity;
  for (const o of sample.objs) {
    if (!inPool(o[0]) || !shooters.has(o[5]) || o[4] <= 0) continue;
    const d = (o[2] - b.x) ** 2 + (o[3] - b.y) ** 2;
    if (d < bd) {
      bd = d;
      best = o[5];
    }
  }
  return best;
}

/**
 * How long a Saturn spawn stayed on the field, on the kept clock: from its
 * birth sample through the following kept samples while its slot keeps the
 * key with hp above zero (dead slots keep their sprite) and the object has
 * not left the frame and stopped (the engine parks what has exited just
 * past the edge, alive). The kept spans are contiguous game time — a rewind
 * restores the state the last span ended in — so a life runs on across
 * them.
 */
function saturnLife(
  kept: SaturnSample[],
  at: number | undefined,
  b: SaturnBirth,
  clock: KeptClock,
): number | null {
  if (at === undefined) return null;
  const born = clock.at(b.wall);
  if (born === null) return null;
  let last = born;
  let prev: [number, number] = [b.x, b.y];
  for (let i = at + 1; i < kept.length; i++) {
    const s = kept[i];
    const o = s.objs.find((o) => o[0] === b.slot);
    if (!o || o[5] !== b.key || o[4] <= 0) break;
    const off = o[2] < 0 || o[2] > SATURN_FRAME.width || o[3] < 0 ||
      o[3] > SATURN_FRAME.height;
    if (off && Math.abs(o[2] - prev[0]) < 0.05 && Math.abs(o[3] - prev[1]) < 0.05) {
      break;
    }
    prev = [o[2], o[3]];
    last = clock.at(s.wall) ?? last;
  }
  return last - born;
}

/** A web bullet's art family and what it says about the kind. */
export function webArt(frame: string | null, tex?: string | null): string {
  const f = frame ?? "";
  let m = /^dezaBullet(\d+)_\d+\.gif$/.exec(f);
  if (m) return `dezaBullet${m[1]}`;
  if (/^normalProjectile\d+\.gif$/.test(f)) return "normalProjectile";
  m = /^deza\d+_(\d+)_\d+\.gif$/.exec(f);
  if (m) return `record ${Number(m[1])} cells`;
  return (tex && tex !== "game_asset" ? `${tex}:` : "") + (f || "?");
}

/** The web survey, one take. */
export function readWeb(
  web: WebSurveyFile,
  placed: Map<number, RosterEntry>,
): SideReading {
  const samples = [...web.samples].sort((a, b) => a.t - b.t);
  const firsts = new Map<number, FirstSeen>();
  const spawns = new Map<number, number>();
  const art = new Map<number, Set<string>>();
  const lives = new Map<number, number[]>();
  const bullets: BulletSeen[] = [];
  const lastSeen = new Map<number, number>();
  const byT = new Map<number, number>();
  let maxLive = 0;
  for (const [i, s] of samples.entries()) {
    byT.set(s.t, i);
    for (const o of s.objs) {
      lastSeen.set(o.id, s.t);
      if (o.kind === "enemy" && o.deza != null && o.frame) {
        (art.get(o.deza) ?? art.set(o.deza, new Set()).get(o.deza)!).add(
          o.frame,
        );
      }
    }
    if (s.objs.length > maxLive) maxLive = s.objs.length;
  }
  // The type-3 shooter nearest a bullet in the sample it was born in — one
  // whose big shot is the record the art names, when the art names one —
  // or, when none is alive there (it left in the same tick), the nearest
  // within reach in the sample before.
  const nearestShooterOf = (
    b: WebBirth,
    record: number | null,
  ): RosterEntry | null => {
    const pick = (s: WebSample | undefined, reach: number) => {
      let best: RosterEntry | null = null, bd = Infinity, matched = false;
      for (const o of s?.objs ?? []) {
        if (o.kind !== "enemy" || o.deza == null) continue;
        const e = placed.get(o.deza);
        if (!e?.bigShot) continue;
        const d = Math.hypot(o.x - b.x, o.y - b.y);
        if (d > reach) continue;
        const match = record !== null && e.bigShot.record === record;
        if ((match && !matched) || (match === matched && d < bd)) {
          bd = d;
          best = e;
          matched = match;
        }
      }
      return best;
    };
    const i = byT.get(b.t);
    return pick(i === undefined ? undefined : samples[i], Infinity) ??
      pick(i ? samples[i - 1] : undefined, SHOOTER_REACH_PX);
  };
  const births = [...web.births].sort((a, b) => a.t - b.t);
  for (const b of births) {
    if (b.kind === "enemy" && b.deza != null) {
      if (!firsts.has(b.deza)) {
        firsts.set(b.deza, {
          t: b.t / 1000,
          scroll: b.scroll,
          x: b.x,
          y: b.y,
          art: b.frame ?? "?",
        });
      }
      spawns.set(b.deza, (spawns.get(b.deza) ?? 0) + 1);
      const last = lastSeen.get(b.id);
      if (last !== undefined) {
        (lives.get(b.deza) ?? lives.set(b.deza, []).get(b.deza)!).push(
          (last - b.t) / 1000,
        );
      }
    } else if (b.kind === "bullet") {
      // The kind follows the art: the cart's bullet table is a type whoever
      // stood nearest; the stock bolt or a record's cells is a big shot of
      // the nearest type-3 shooter — the one the sampler named if it is
      // one, else the nearest alive in the sample.
      const named = b.from?.deza == null ? undefined : placed.get(b.from.deza);
      const artName = webArt(b.frame, b.tex);
      const typeArt = /^dezaBullet(\d+)$/.exec(artName);
      let shooter: number | null = named?.pid ?? b.from?.deza ?? null;
      let what: string;
      if (typeArt) what = `type ${typeArt[1]}`;
      else {
        const cells = /^record (\d+) cells$/.exec(artName);
        const record = cells ? Number(cells[1]) : null;
        const firing =
          named?.bigShot && (record === null || named.bigShot.record === record)
            ? named
            : (nearestShooterOf(b, record) ?? (named?.bigShot ? named : null));
        if (firing?.bigShot) {
          shooter = firing.pid;
          what = `big shot (record ${firing.bigShot.record})`;
        } else what = `bullet from ${named?.letter ?? "?"}`;
      }
      bullets.push({ what, art: artName, shooter, t: b.t / 1000, scroll: b.scroll });
    }
  }
  // The ship: the survey keeps its shoot mode, not its projectiles. A sample
  // without a player (a respawn) does not end a mode.
  const ship: ShipObject[] = [];
  let mode: string | null = null;
  for (const s of samples) {
    const shot = s.player?.shot ?? null;
    if (shot === null || shot === mode) continue;
    mode = shot;
    ship.push({
      art: shot,
      slots: "shoot mode",
      attacks: [],
      births: 1,
      firstT: s.t / 1000,
      lastT: s.t / 1000,
    });
  }
  for (let i = 0; i < ship.length; i++) {
    ship[i].lastT = i + 1 < ship.length
      ? ship[i + 1].firstT
      : (samples.length ? samples[samples.length - 1].t / 1000 : ship[i].firstT);
  }
  const withScroll = samples.filter((s) => typeof s.scroll === "number");
  const a = withScroll[0], z = withScroll[withScroll.length - 1];
  const dt = a && z ? (z.t - a.t) / 1000 : 0;
  const notes: string[] = [
    "the web survey keeps the ship's shoot mode, not its projectiles",
  ];
  if (web.ended) notes.push(`the stage ${web.ended} during the survey`);
  if (web.err) notes.push(`sampler error: ${web.err}`);
  return {
    side: "web",
    source: web.source ?? "import",
    samples: samples.length,
    seconds: samples.length ? samples[samples.length - 1].t / 1000 : 0,
    wallSeconds: samples.length
      ? (samples[samples.length - 1].wall - samples[0].wall) / 1000
      : 0,
    scrollFrom: a?.scroll ?? null,
    scrollTo: z?.scroll ?? null,
    rate: dt > 0 && a.scroll !== null && z.scroll !== null
      ? (() => {
        const r = (z.scroll - a.scroll) / dt;
        return { median: r, min: r, max: r };
      })()
      : null,
    maxObjs: web.maxObjs,
    maxLive,
    firsts,
    spawns,
    art,
    lives,
    bullets,
    ship,
    outside: new Map(),
    carried: 0,
    added: 0,
    notes,
  };
}

// --- the comparison ---------------------------------------------------------

export interface RecordRow {
  entry: RosterEntry;
  saturn: FirstSeen | null;
  web: FirstSeen | null;
  /** web first scroll − Saturn first scroll, raw. */
  delta: number | null;
  /** The same with the expected lead taken out. */
  residual: number | null;
  bulletsPerKpx: { saturn: number | null; web: number | null };
  life: { saturn: number | null; web: number | null };
  art: { saturn: string[]; web: string[] };
  status:
    | "ok"
    | "fail"
    | "one side"
    | "before"
    | "beyond"
    | "unknown"
    | "unseen";
  note: string;
}

export interface KindRow {
  what: string;
  art: string;
  saturn: number;
  web: number;
  shooters: string;
  judged: boolean;
  note: string;
}

export interface SurveyReportOptions {
  /** The web's expected lead in scroll px; 0 once the gates agree. */
  expectedLead?: number;
  tolerance?: number;
  stage?: number;
}

export interface SurveyReport {
  markdown: string;
  ok: boolean;
  failures: string[];
  notJudged: string[];
  rows: RecordRow[];
  kinds: KindRow[];
  saturn: SideReading;
  web: SideReading;
}

/** The report for one run: both surveys read, compared and rendered. */
export function surveyReport(
  input: {
    saturn: SaturnSurveyFile;
    web: WebSurveyFile;
    rush: RushRecord;
    level?: string;
  },
  options: SurveyReportOptions = {},
): SurveyReport {
  const lead = options.expectedLead ?? WEB_GATE_LEAD;
  const tolerance = options.tolerance ?? SCROLL_TOLERANCE;
  const stage = options.stage ?? input.web.stage ?? 0;
  const placed = roster(input.rush, stage);
  const targets = bigShotTargets(placed);
  const saturn = readSaturn(input.saturn, placed, targets);
  const web = readWeb(input.web, placed);
  const failures: string[] = [];
  const notJudged: string[] = [];

  // Bullets per record per 1,000 scroll px. A big shot goes to the shooter
  // the side names (the web's sampler does); without one (the Saturn's carry
  // no shooter) it is shared among the letters that fire that record.
  const pidOfLetter = new Map(
    [...placed.values()].map((e) => [e.letter, e.pid] as const),
  );
  const perKpx = (side: SideReading) => {
    const span = side.scrollFrom !== null && side.scrollTo !== null
      ? Math.max(1, side.scrollTo - side.scrollFrom) / 1000
      : null;
    const count = new Map<number, number>();
    const credit = (pid: number, n: number) =>
      count.set(pid, (count.get(pid) ?? 0) + n);
    for (const b of side.bullets) {
      const m = /^big shot \(record (\d+)\)$/.exec(b.what);
      if (!m) {
        if (b.shooter !== null) credit(b.shooter, 1);
        continue;
      }
      const t = targets.get(placementId(Number(m[1])));
      const named = b.shooter !== null ? placed.get(b.shooter) : undefined;
      if (named && (!t || t.shooters.includes(named.letter))) {
        credit(named.pid, 1);
        continue;
      }
      const shooters = (t?.shooters ?? [])
        .map((l) => pidOfLetter.get(l))
        .filter((p): p is number => p !== undefined);
      for (const pid of shooters) credit(pid, 1 / shooters.length);
    }
    return (pid: number) =>
      span === null ? null : (count.get(pid) ?? 0) / span;
  };
  const satRate = perKpx(saturn), webRate = perKpx(web);

  // A record seen on one side only is a failure when the other side's run
  // covered that scroll (the lead moved onto its axis), else not judged.
  const covered = (
    scroll: number,
    other: SideReading,
  ): "inside" | "before" | "beyond" | "unknown" =>
    other.scrollFrom === null || other.scrollTo === null
      ? "unknown"
      : scroll < other.scrollFrom
      ? "before"
      : scroll > other.scrollTo
      ? "beyond"
      : "inside";

  const rows: RecordRow[] = [];
  for (const entry of placed.values()) {
    const s = saturn.firsts.get(entry.pid) ?? null;
    const w = web.firsts.get(entry.pid) ?? null;
    const row: RecordRow = {
      entry,
      saturn: s,
      web: w,
      delta: null,
      residual: null,
      bulletsPerKpx: { saturn: satRate(entry.pid), web: webRate(entry.pid) },
      life: {
        saturn: mean(saturn.lives.get(entry.pid) ?? []),
        web: mean(web.lives.get(entry.pid) ?? []),
      },
      art: {
        saturn: [...(saturn.art.get(entry.pid) ?? [])],
        web: [...(web.art.get(entry.pid) ?? [])],
      },
      status: "unseen",
      note: "",
    };
    const target = targets.get(entry.pid);
    const shared = target
      ? `key ${entry.pid} is also ${
        target.shooters.join("/")
      }'s big shots (record ${target.record}): births within ${AMBIGUOUS_SHOT_PX} px of a live ${
        target.shooters.join("/")
      } counted as shots`
      : "";
    const rewound = s ? undefined : saturn.outside.get(entry.pid);
    const rewoundNote = rewound === undefined
      ? ""
      : `the Saturn spawned it only in rewound-away play (scroll ${rewound})`;
    if (s && w) {
      if (s.scroll === null || w.scroll === null) {
        row.status = "unknown";
        row.note = `no scroll on the ${s.scroll === null ? "Saturn" : "web"}; not judged`;
        notJudged.push(`${entry.letter}: ${row.note}`);
      } else {
        row.delta = w.scroll - s.scroll;
        row.residual = row.delta + lead;
        if (Math.abs(row.residual) > tolerance) {
          row.status = "fail";
          row.note = `first seen ${signed(row.residual)} px after the ${lead} px lead`;
          failures.push(`${entry.letter}: ${row.note}`);
        } else row.status = "ok";
      }
    } else if ((s && !w) || (w && !s)) {
      const seenOn = s ? "Saturn" : "web";
      const other = s ? web : saturn;
      const otherName = s ? "web" : "Saturn";
      const f = (s ?? w)!;
      const where = f.scroll === null
        ? "no scroll"
        : covered(s ? f.scroll - lead : f.scroll + lead, other);
      if (where === "inside") {
        row.status = "one side";
        row.note = `seen on the ${seenOn} only (scroll ${f.scroll})`;
        failures.push(`${entry.letter}: ${row.note}`);
      } else {
        row.status = where === "before"
          ? "before"
          : where === "beyond"
          ? "beyond"
          : "unknown";
        row.note = where === "before" || where === "beyond"
          ? `${where} the ${otherName}'s run`
          : where === "no scroll"
          ? `no scroll on the ${seenOn}; not judged`
          : `the ${otherName}'s run has no scroll range; not judged`;
        notJudged.push(`${entry.letter}: ${row.note}`);
      }
    } else {
      row.status = "unseen";
      row.note = "not seen on either side";
    }
    row.note = [row.note, rewoundNote, shared].filter(Boolean).join("; ");
    rows.push(row);
  }
  rows.sort((a, b) => firstScroll(a, lead) - firstScroll(b, lead));

  // Bullet kinds on each side, judged when either side has enough of them.
  const kindMap = new Map<string, KindRow & { by: Record<"saturn" | "web", Map<string, number>> }>();
  const addKind = (side: "saturn" | "web", b: BulletSeen) => {
    const id = `${b.what} drawn as ${b.art}`;
    const k = kindMap.get(id) ?? {
      what: b.what,
      art: b.art,
      saturn: 0,
      web: 0,
      shooters: "",
      judged: true,
      note: "",
      by: { saturn: new Map<string, number>(), web: new Map<string, number>() },
    };
    k[side]++;
    const letter = b.shooter === null ? "?" : (placed.get(b.shooter)?.letter ?? "?");
    k.by[side].set(letter, (k.by[side].get(letter) ?? 0) + 1);
    kindMap.set(id, k);
  };
  saturn.bullets.forEach((b) => addKind("saturn", b));
  web.bullets.forEach((b) => addKind("web", b));
  const list = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`)
      .join(", ");
  // Most births first, then by name, so two kinds of one record keep a
  // stated order whatever the samplers' timing.
  const sorted = [...kindMap.values()].sort((a, b) =>
    (b.saturn + b.web) - (a.saturn + a.web) ||
    a.what.localeCompare(b.what) || a.art.localeCompare(b.art)
  );
  for (const k of sorted) {
    const m = /^big shot \(record (\d+)\)$/.exec(k.what);
    const t = m ? targets.get(placementId(Number(m[1]))) : undefined;
    k.shooters = t
      ? t.shooters.join("/") +
        (k.web && list(k.by.web) !== `${t.shooters.join("/")} ${k.web}`
          ? ` (web: ${list(k.by.web)})`
          : "")
      : [
        k.saturn ? `Saturn ${list(k.by.saturn)}` : "",
        k.web ? `web ${list(k.by.web)}` : "",
      ].filter(Boolean).join("; ");
    const notes: string[] = [];
    if (t?.ambiguous) {
      notes.push(
        `key ${t.pid} is also a placed record's; shots told from spawns by proximity`,
      );
    }
    if (Math.max(k.saturn, k.web) < KIND_MIN_BIRTHS) {
      k.judged = false;
      notes.unshift(`fewer than ${KIND_MIN_BIRTHS} births; not judged`);
      notJudged.push(`bullet kind "${k.what} drawn as ${k.art}": ${notes[0]}`);
    }
    if (k.judged && (k.saturn === 0) !== (k.web === 0)) {
      const only = k.saturn === 0 ? "web" : "Saturn";
      notes.unshift(`${only} only`);
      failures.push(
        `bullet kind "${k.what} drawn as ${k.art}" on the ${only} only (${
          k.saturn || k.web
        } births)`,
      );
    }
    k.note = notes.join("; ");
  }
  const kinds: KindRow[] = sorted.map(({ by: _by, ...k }) => k);

  const markdown = render({
    level: input.level ?? input.rush.name ?? input.web.level ?? "level",
    stage,
    lead,
    tolerance,
    saturn,
    web,
    rows,
    kinds,
    failures,
    notJudged,
    rush: input.rush,
    targets,
    items: webItems(input.web),
  });
  return {
    markdown,
    ok: failures.length === 0,
    failures,
    notJudged,
    rows,
    kinds,
    saturn,
    web,
  };
}

/** A row's place on the web's scroll axis; unseen rows keep roster order. */
const firstScroll = (r: RecordRow, lead: number) =>
  r.web?.scroll ?? (r.saturn?.scroll !== null && r.saturn?.scroll !== undefined
    ? r.saturn.scroll - lead
    : Number.MAX_VALUE);
const signed = (n: number) => (n > 0 ? "+" : "") + fmt(n);
const fmt = (n: number | null | undefined, dp = 0): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(dp);

/** The web's item births, paired when two land on one spot (the double drop). */
export function webItems(
  web: WebSurveyFile,
): { byName: Map<string, number>; pairs: number; total: number } {
  const items = web.births.filter((b) => b.kind === "item").sort((a, b) =>
    a.t - b.t
  );
  const byName = new Map<string, number>();
  let pairs = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    byName.set(it.name ?? "?", (byName.get(it.name ?? "?") ?? 0) + 1);
    const prev = items[i - 1];
    if (
      prev && prev.name === it.name && Math.abs(prev.x - it.x) <= 1 &&
      Math.abs(prev.y - it.y) <= 1 && Math.abs(prev.t - it.t) <= 250
    ) pairs++;
  }
  return { byName, pairs, total: items.length };
}

// --- rendering --------------------------------------------------------------

function render(r: {
  level: string;
  stage: number;
  lead: number;
  tolerance: number;
  saturn: SideReading;
  web: SideReading;
  rows: RecordRow[];
  kinds: KindRow[];
  failures: string[];
  notJudged: string[];
  rush: RushRecord;
  targets: Map<number, BigShotTarget>;
  items: { byName: Map<string, number>; pairs: number; total: number };
}): string {
  const { saturn: s, web: w } = r;
  const L: string[] = [];
  L.push(`# ${r.level}: the Saturn against the web, stage ${r.stage}`);
  L.push("");
  L.push(
    `Built from \`panes/saturn.survey.json\` and \`panes/web.survey.json\` ` +
      `with the roster of \`rush.json\`. The Saturn is read on its kept clock ` +
      `(${s.samples} samples inside ${s.seconds.toFixed(1)} kept seconds of a ` +
      `${s.wallSeconds.toFixed(0)} s wall run); the web is one take ` +
      `(${w.samples} samples, ${w.seconds.toFixed(1)} s). A record's first ` +
      `appearance is compared by scroll position after the web's ${r.lead} px ` +
      `gate lead, with ${r.tolerance} px of tolerance; a bullet kind is what ` +
      `fired it and what it is drawn with.`,
  );
  L.push("");
  L.push(`**Verdict: ${r.failures.length ? "FAIL" : "PASS"}**` +
    (r.failures.length ? ` — ${r.failures.length} finding(s), listed last.` : "."));
  L.push("");
  L.push("## The runs");
  L.push("");
  L.push("| | Saturn | Web |");
  L.push("| --- | --- | --- |");
  L.push(`| Source | ${s.source} | ${w.source} |`);
  L.push(`| Seconds | ${s.seconds.toFixed(1)} kept of ${s.wallSeconds.toFixed(0)} wall | ${w.seconds.toFixed(1)} |`);
  L.push(`| Samples | ${s.samples} | ${w.samples} |`);
  L.push(`| Scroll | ${fmt(s.scrollFrom)} → ${fmt(s.scrollTo)} | ${fmt(w.scrollFrom)} → ${fmt(w.scrollTo)} |`);
  L.push(`| Scroll px/s | ${rateCell(s.rate)} | ${rateCell(w.rate)} |`);
  L.push(`| Live objects (max) | ${s.maxLive ?? "—"} with hp (${s.maxObjs} slots) | ${w.maxLive ?? "—"} |`);
  L.push(`| Enemy bullets seen | ${s.bullets.length} | ${w.bullets.length} |`);
  const notes = [...s.notes.map((n) => `Saturn: ${n}`), ...w.notes.map((n) => `web: ${n}`)];
  if (notes.length) {
    L.push("");
    for (const n of notes) L.push(`- ${n}`);
  }
  L.push("");
  L.push("## Records");
  L.push("");
  L.push(
    "First seen = the first birth under the record's placement id (seconds on " +
      "the side's clock / scroll px). Δ = web − Saturn scroll; after lead = Δ + " +
      `${r.lead}. Bullets = enemy bullets attributed to the record per 1,000 ` +
      "scroll px of the side's run (a big shot shared among the letters that " +
      "fire the same record). Life = mean seconds a spawn stayed on the field: " +
      `the Saturn's on its kept clock until the object has left the ${SATURN_FRAME.width}×${SATURN_FRAME.height} ` +
      "frame and stopped (the engine parks what has exited just past the edge), " +
      "the web's until the runtime removed it; a life still running at the last " +
      "sample is counted to there. Rows in order of first appearance on the " +
      "web's scroll axis.",
  );
  L.push("");
  L.push(
    "| Id | Letter | Name | Rec | Fire | Saturn first | Web first | Δ | After lead | Bullets S / W | Life S / W | Art S / W | Status |",
  );
  L.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of r.rows) {
    const e = row.entry;
    const fire = !e.fire.enabled && e.fire.mode !== 3
      ? "—"
      : `type ${e.fire.mode}${e.fire.interval !== null ? ` / ${e.fire.interval}` : ""}${
        e.bigShot ? ` → rec ${e.bigShot.record}` : ""
      }${!e.fire.enabled ? " (no-fire bit)" : ""}`;
    L.push(
      `| ${e.pid} | ${e.letter}${e.ground ? " (ground)" : ""} | ${e.name} | ${e.record} | ${fire} | ` +
        `${seen(row.saturn)} | ${seen(row.web)} | ${fmt(row.delta)} | ${
          row.residual === null ? "—" : signed(row.residual)
        } | ${fmt(row.bulletsPerKpx.saturn, 1)} / ${fmt(row.bulletsPerKpx.web, 1)} | ` +
        `${fmt(row.life.saturn, 1)} / ${fmt(row.life.web, 1)} | ${
          artCell(row.art.saturn)
        } / ${artCell(row.art.web)} | ${status(row)} |`,
    );
  }
  if (r.targets.size) {
    L.push("");
    L.push("Big-shot records (what the type-3 shooters build their shots from):");
    L.push("");
    for (const t of r.targets.values()) {
      L.push(
        `- record ${t.record} (key ${t.pid}, character ${t.character}) fired by ${
          t.shooters.join("/")
        }${t.ambiguous ? " — the key of a placed record too" : ""}`,
      );
    }
  }
  L.push("");
  L.push("## Bullet kinds");
  L.push("");
  L.push(
    "| Kind | Drawn as | Saturn | Web | Fired by | Note |",
  );
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const k of r.kinds) {
    L.push(
      `| ${k.what} | ${k.art} | ${k.saturn} | ${k.web} | ${k.shooters || "—"} | ${
        k.note || (k.judged ? "both sides" : "")
      } |`,
    );
  }
  L.push("");
  L.push("## The ship");
  L.push("");
  L.push("Saturn: objects born in player 1's shot slots and the pod slots.");
  L.push("");
  L.push("| Art | Slots | Attack | Births | First s | Last s |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const o of s.ship) {
    L.push(
      `| ${o.art} | ${o.slots} | ${o.attacks.join(", ") || "—"} | ${o.births} | ${o.firstT.toFixed(1)} | ${o.lastT.toFixed(1)} |`,
    );
  }
  if (!s.ship.length) L.push("| — | | | | | |");
  L.push("");
  L.push("Web: the ship's shoot mode over the run" + playerShots(r.rush) + ".");
  L.push("");
  L.push("| Mode | From s | To s |");
  L.push("| --- | --- | --- |");
  for (const o of w.ship) {
    L.push(`| ${o.art} | ${o.firstT.toFixed(1)} | ${o.lastT.toFixed(1)} |`);
  }
  if (!w.ship.length) L.push("| — | | |");
  L.push("");
  L.push("## Items (web)");
  L.push("");
  if (r.items.total) {
    L.push(
      `${r.items.total} item births — ${
        [...r.items.byName.entries()].map(([n, c]) => `${n} ${c}`).join(", ")
      } — ${r.items.pairs} of them landing on the spot of the one before ` +
        "(a death-word drop arriving twice). The Saturn survey does not name items.",
    );
  } else L.push("No item was born in the web run.");
  L.push("");
  L.push("## Verdict");
  L.push("");
  if (r.failures.length) {
    L.push(`**FAIL** — ${r.failures.length} finding(s):`);
    L.push("");
    for (const f of r.failures) L.push(`- ${f}`);
  } else {
    L.push(
      `**PASS** — every record first seen within ${r.tolerance} px after the ${r.lead} px lead, and every bullet kind on both sides.`,
    );
  }
  if (r.notJudged.length) {
    L.push("");
    L.push("Not judged:");
    L.push("");
    for (const n of r.notJudged) L.push(`- ${n}`);
  }
  L.push("");
  return L.join("\n");
}

const rateCell = (r: SideReading["rate"]) =>
  r === null
    ? "—"
    : r.min === r.max
    ? r.median.toFixed(1)
    : `${r.median.toFixed(1)} (${r.min.toFixed(1)}–${r.max.toFixed(1)})`;
const seen = (f: FirstSeen | null) =>
  f === null ? "—" : `${f.t.toFixed(1)} s / ${fmt(f.scroll)}`;
const artCell = (a: string[]) =>
  a.length === 0
    ? "—"
    : a.length <= 2
    ? a.join(", ")
    : `${a.length} (${a[0]} …)`;
const status = (row: RecordRow) =>
  row.status === "ok"
    ? ["ok", ...row.note.split("; ").filter(Boolean)].join("; ")
    : row.status === "fail" || row.status === "one side"
    ? `**FAIL** ${row.note}`
    : row.note || row.status;

/** The shot textures playerData names, since the web survey has none. */
function playerShots(rush: RushRecord): string {
  const pd = rush.playerData ?? {};
  const names: string[] = [];
  for (const key of ["shootNormal", "shootBig", "shoot3way"]) {
    const s = pd[key] as { name?: string; texture?: string[] } | undefined;
    if (s?.texture?.length) {
      names.push(`${s.name ?? key} ${s.texture[0].replace(/\d+\.(png|gif)$/, "*")}`);
    }
  }
  return names.length
    ? ` (its projectiles are not surveyed; \`playerData\` draws them as ${names.join(", ")})`
    : " (its projectiles are not surveyed)";
}
