/**
 * One EVIL INVADERS '95 level, played out frame by frame as the source plays
 * it, with nobody shooting back — the flight every enemy would take.
 *
 * This is src/Enemies.svelte, src/Enemy.svelte, src/game/Flight.ts and
 * src/game/Formation.ts run at a fixed 60 Hz with a seeded generator in place
 * of Math.random: the squadron launch schedule, the CORE_GALAGA fly-in paths
 * (Phaser's arc-length parameterisation, ported below), the seek into a
 * marching slot, the lock, the formation guns and the dive launcher with its
 * gold-girl-and-escorts rule. The converter (build-level.ts) compiles each
 * enemy's flight into an appearance script, so in the shmupX runtime the
 * level moves the way the source moves it.
 *
 * Where the shmupX runtime cannot do what the source does, the replay does
 * the nearest thing, and says so here:
 *
 * - The march glides. The source steps the formation 9 px at a time; a script
 *   row per step would cost two rows a step for every enemy for the whole
 *   level, so the slots move at the march's average speed between the same
 *   step instants and turn round on the same frames.
 * - A diver leaves the screen before it comes back. The source teleports a
 *   diver from the end of its loop (sometimes mid-screen) to just above its
 *   slot; a shmupX enemy cannot vanish, so it flies on along its loop's last
 *   heading until it is off the screen, then takes a hidden route round the
 *   outside of the screen (`hiddenRoute`) and comes back in above its slot.
 * - The level ends. The source keeps its formation diving until the player
 *   has shot every last enemy; a shmupX stage needs its enemies to leave. So
 *   `horizonMs` after the wave locks, divers stop coming back and the rest
 *   peel off at four times the dive rate — the cloud game's
 *   `endsOnClear` ends the stage the moment the field is empty, whichever way
 *   it emptied.
 */

import {
  createPaths,
  DIVE_BOSS,
  DIVE_BUTTERFLY,
  DIVE_FIRE_AT,
  DIVE_SPEED_BONUS,
  DIVE_WASP,
  type EnemyKind,
  FORMATION_CELL_H,
  FORMATION_CELL_W,
  FORMATION_STEP_PX,
  FORMATION_STEPS_PER_SIDE,
  FORMATION_TOP,
  GAME_HEIGHT,
  GAME_WIDTH,
  INTRO_DELAY,
  LOCK_POLL_MS,
  MEMBER_STAGGER,
  type PathDef,
  type Point,
  SQUADRON_INTERVAL,
  SQUADRON_SIZE,
  type StageDef,
} from "./source.ts";

export const FRAME_MS = 1000 / 60;

// --- the playfield shmupX draws on ----------------------------------------

/** shmupX's playfield (game.bundle.js GAME_DIMENSIONS). */
export const FIELD_W = 256;
export const FIELD_H = 480;
const KX = FIELD_W / GAME_WIDTH;
const KY = FIELD_H / GAME_HEIGHT;

/** A source position on the shmupX field. */
export function toField(p: Point): Point {
  return { x: p.x * KX, y: p.y * KY };
}

/**
 * The runtime culls an enemy past y 500 or outside x -40..296
 * (game.bundle.js, the enemy pass's bounds check). Hidden routes run inside
 * these lines: down the sides, along the bottom, across the top.
 */
export const HIDE = { left: -34, right: 290, top: -30, bottom: 496 };

/** Keep a position inside the cull box, on the hidden lanes where it left. */
export function clampToLanes(p: Point): Point {
  return {
    x: Math.min(HIDE.right, Math.max(HIDE.left, p.x)),
    y: Math.min(HIDE.bottom, Math.max(HIDE.top, p.y)),
  };
}

/** Half the drawn size of each enemy kind on the shmupX field. */
export type HalfSizes = Record<EnemyKind, { w: number; h: number }>;

/** Whether a sprite of this half-size at `p` draws nothing on the screen. */
export function hiddenAt(p: Point, half: { w: number; h: number }): boolean {
  return p.x + half.w < -1 || p.x - half.w > FIELD_W + 1 ||
    p.y + half.h < -1 || p.y - half.h > FIELD_H + 1;
}

// --- Phaser.Curves, as far as the paths use them ---------------------------

const ARC_DIVISIONS = 100;

interface Curve {
  getPoint(t: number): Point;
  getPointAt(u: number): Point;
  length: number;
}

function lineCurve(a: Point, b: Point): Curve {
  const getPoint = (t: number) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  return {
    getPoint,
    getPointAt: getPoint,
    length: Math.hypot(b.x - a.x, b.y - a.y),
  };
}

function cubicCurve(p0: Point, p1: Point, p2: Point, p3: Point): Curve {
  const getPoint = (t: number) => {
    const k = 1 - t;
    const a = k * k * k, b = 3 * k * k * t, c = 3 * k * t * t, d = t * t * t;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
  };
  // Curve.getLengths(arcLengthDivisions = 100)
  const lengths = [0];
  let last = getPoint(0);
  let sum = 0;
  for (let p = 1; p <= ARC_DIVISIONS; p++) {
    const cur = getPoint(p / ARC_DIVISIONS);
    sum += Math.hypot(cur.x - last.x, cur.y - last.y);
    lengths.push(sum);
    last = cur;
  }
  // Curve.getUtoTmapping
  const uToT = (u: number) => {
    const il = lengths.length;
    const target = u * lengths[il - 1];
    let low = 0, high = il - 1, i = 0;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      const cmp = lengths[i] - target;
      if (cmp < 0) low = i + 1;
      else if (cmp > 0) high = i - 1;
      else {
        high = i;
        break;
      }
    }
    i = high;
    if (lengths[i] === target) return i / (il - 1);
    const before = lengths[i];
    const after = lengths[i + 1];
    return (i + (target - before) / (after - before)) / (il - 1);
  };
  return { getPoint, getPointAt: (u) => getPoint(uToT(u)), length: sum };
}

/** Phaser.Curves.Path: getPoint(t) walks the curves by arc length. */
export class Path {
  readonly curves: Curve[] = [];
  readonly cumulative: number[] = [];
  readonly length: number;

  constructor(def: PathDef) {
    let at = def.start;
    for (const seg of def.segs) {
      this.curves.push(
        seg.kind === "line"
          ? lineCurve(at, seg.to)
          : cubicCurve(at, seg.c1, seg.c2, seg.to),
      );
      at = seg.to;
    }
    let sum = 0;
    for (const c of this.curves) {
      sum += c.length;
      this.cumulative.push(sum);
    }
    this.length = sum;
  }

  getPoint(t: number): Point {
    const d = t * this.length;
    for (let i = 0; i < this.cumulative.length; i++) {
      if (this.cumulative[i] >= d) {
        const diff = this.cumulative[i] - d;
        const seg = this.curves[i].length;
        const u = seg === 0 ? 0 : 1 - diff / seg;
        return this.curves[i].getPointAt(u);
      }
    }
    return this.curves[this.curves.length - 1].getPointAt(1);
  }
}

// --- the level ------------------------------------------------------------

/** mulberry32: the replay's Math.random, so a conversion is repeatable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Slot {
  row: number;
  col: number;
  colsInRow: number;
}

/** A shot the source fires, and who fires it. */
export interface Shot {
  frame: number;
  aimed: boolean;
  /** "formation" from the guns, "dive" from a diver. */
  from: "formation" | "dive";
}

/** One frame of an enemy's flight on the shmupX field. */
export interface TrackPoint {
  frame: number;
  pos: Point;
  /** Off the screen (or on a hidden route): may be tracked loosely. */
  hidden: boolean;
}

export interface FlightRecord {
  id: number;
  kind: EnemyKind;
  slot: Slot;
  squadron: number;
  flyInPath: number;
  /** Frame the source launches it, counted from the wave's mount. */
  launchFrame: number;
  /** Its whole flight, launchFrame onwards, ending once it has left. */
  track: TrackPoint[];
  shots: Shot[];
  /** How many times it dived. */
  dives: number;
}

export interface ReplayResult {
  stage: number;
  flights: FlightRecord[];
  /** Frame the wave locked: every enemy in formation. */
  lockFrame: number;
  /** Frame the last enemy left. */
  endFrame: number;
}

export interface ReplayOptions {
  /** 1-based level number (1..10). */
  level: number;
  def: StageDef;
  half: HalfSizes;
  /** How long after the lock divers keep coming back. */
  horizonMs: number;
  seed: number;
  /** Fastest a hidden route may travel, px per frame (field units). */
  hiddenSpeed?: number;
}

type FlightState =
  | "waiting"
  | "path"
  | "seek"
  | "formation"
  | "extend"
  | "hidden"
  | "gone";

interface Flier {
  rec: FlightRecord;
  state: FlightState;
  diving: boolean;
  path: Path | null;
  t: number;
  offset: Point;
  speed: number;
  fireAt: number[];
  fired: number;
  pos: Point;
  /** Extension heading (unit vector, source space). */
  dir: Point;
  /** Hidden route: positions on the field, one per frame. */
  route: Point[];
  routeIdx: number;
  /** After the hidden route: seek back or leave. */
  leaving: boolean;
}

/** The ten paths, built once. */
const PATHS = createPaths().map((def) => new Path(def));

/** Formation slots for a stage, as planWave deals them (row-major). */
export function planSlots(def: StageDef): { kind: EnemyKind; slot: Slot }[] {
  const out: { kind: EnemyKind; slot: Slot }[] = [];
  def.rows.forEach((row, r) => {
    for (let c = 0; c < row.count; c++) {
      out.push({
        kind: row.type,
        slot: { row: r, col: c, colsInRow: row.count },
      });
    }
  });
  return out;
}

/**
 * The route a hidden enemy takes from `from` (already off the screen) to
 * `to` (just above the screen): out to the nearer side lane, up it to the
 * top lane, across to `to`'s column and down onto it — or, from above the
 * screen, straight up to the top lane and across. One position a frame,
 * never faster than `speed`, never on the screen.
 */
export function hiddenRoute(from: Point, to: Point, speed: number): Point[] {
  const a = clampToLanes(from);
  const pts: Point[] = [a];
  if (a.y < 0) {
    pts.push({ x: a.x, y: HIDE.top });
  } else {
    const onSide = a.x <= HIDE.left + 0.5 || a.x >= HIDE.right - 0.5;
    const side = onSide ? a.x : a.x < FIELD_W / 2 ? HIDE.left : HIDE.right;
    if (!onSide) pts.push({ x: side, y: a.y });
    pts.push({ x: side, y: HIDE.top });
  }
  pts.push({ x: to.x, y: HIDE.top });
  pts.push(to);
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const frames = Math.max(2, Math.ceil(len / speed));
  const out: Point[] = [];
  for (let f = 1; f <= frames; f++) {
    let d = (len * f) / frames;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(
        pts[i].x - pts[i - 1].x,
        pts[i].y - pts[i - 1].y,
      );
      if (d <= seg || i === pts.length - 1) {
        const u = seg === 0 ? 1 : Math.min(1, d / seg);
        out.push({
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u,
          y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u,
        });
        break;
      }
      d -= seg;
    }
  }
  return out;
}

/** Frames until a timer with this period first fires, then every period. */
function timerFires(frame: number, periodMs: number): boolean {
  const before = Math.floor(((frame - 1) * FRAME_MS + 1e-6) / periodMs);
  const now = Math.floor((frame * FRAME_MS + 1e-6) / periodMs);
  return now > before;
}

/** Play one level out. */
export function replayLevel(opts: ReplayOptions): ReplayResult {
  const { def, level, half } = opts;
  const rand = seededRandom(opts.seed);
  const hiddenSpeed = opts.hiddenSpeed ?? 40;
  const plan = planSlots(def);

  // --- the march, precomputed: no enemy is ever shot, so its interval never
  // shortens (currentMarchInterval with every enemy alive). marchAcc resets
  // to 0 on each step, so a step lands every ceil(interval / frame) frames.
  const marchEvery = Math.ceil(def.marchInterval / FRAME_MS - 1e-9);
  const stepOffset: number[] = [0];
  const stepDrop: number[] = [0];
  {
    let off = 0, dir = 1, drop = 0;
    for (let k = 1; k < 4000; k++) {
      off += dir;
      if (Math.abs(off) >= FORMATION_STEPS_PER_SIDE) {
        dir *= -1;
        drop += def.descendOnFlip;
      }
      stepOffset.push(off);
      stepDrop.push(drop);
    }
  }
  /** The gliding slot offset at a (fractional) frame. */
  const march = (frame: number) => {
    const k = Math.min(
      stepOffset.length - 2,
      Math.max(0, frame / marchEvery),
    );
    const i = Math.floor(k);
    const u = k - i;
    return {
      off: stepOffset[i] + (stepOffset[i + 1] - stepOffset[i]) * u,
      drop: stepDrop[i] + (stepDrop[i + 1] - stepDrop[i]) * u,
    };
  };
  const slotPos = (slot: Slot, frame: number): Point => {
    const m = march(frame);
    return {
      x: GAME_WIDTH / 2 +
        (slot.col - (slot.colsInRow - 1) / 2) * FORMATION_CELL_W +
        m.off * FORMATION_STEP_PX,
      y: FORMATION_TOP + slot.row * FORMATION_CELL_H + m.drop,
    };
  };

  const fliers: Flier[] = plan.map((p, i) => {
    const squadron = Math.floor(i / SQUADRON_SIZE);
    const order = i % SQUADRON_SIZE;
    const launchMs = INTRO_DELAY + squadron * SQUADRON_INTERVAL +
      order * MEMBER_STAGGER;
    return {
      rec: {
        id: i,
        kind: p.kind,
        slot: p.slot,
        squadron,
        flyInPath: squadron % 4,
        launchFrame: Math.ceil(launchMs / FRAME_MS - 1e-9),
        track: [],
        shots: [],
        dives: 0,
      },
      state: "waiting",
      diving: false,
      path: null,
      t: 0,
      offset: { x: 0, y: 0 },
      speed: def.entrySpeed,
      fireAt: [],
      fired: 0,
      pos: { x: -100, y: -100 },
      dir: { x: 0, y: 1 },
      route: [],
      routeIdx: 0,
      leaving: false,
    };
  });

  let locked = false;
  let lockFrame = -1;
  let lockAcc = 0;
  let diveToggle = 0;
  let exodusFrame = Infinity;
  let endFrame = 0;
  const pathPoint = (f: Flier, t: number): Point => {
    const p = f.path!.getPoint(t);
    return { x: p.x + f.offset.x, y: p.y + f.offset.y };
  };

  const startDive = (f: Flier, pool: readonly number[], speed: number) => {
    f.state = "path";
    f.diving = true;
    f.speed = speed;
    // src/Enemies.svelte picks the mirror by `e.slot % 2`: the row-major
    // slot index, which is the flight's id.
    f.path = PATHS[pool[f.rec.id % 2]];
    f.t = 0;
    f.offset = { ...f.pos };
    f.fireAt = [...DIVE_FIRE_AT];
    f.fired = 0;
    f.rec.dives++;
  };

  const record = (f: Flier, frame: number) => {
    if (f.state === "waiting" || f.state === "gone") return;
    let pos: Point;
    let hidden: boolean;
    if (f.state === "hidden") {
      pos = f.route[Math.min(f.routeIdx, f.route.length - 1)];
      hidden = true;
    } else {
      const raw = toField(f.pos);
      hidden = hiddenAt(raw, half[f.rec.kind]);
      pos = hidden ? clampToLanes(raw) : raw;
    }
    f.rec.track.push({ frame, pos, hidden });
  };

  /** A diver at the end of its loop: off the screen, then home or away. */
  const finishDive = (f: Flier, frame: number) => {
    f.diving = false;
    const field = toField(f.pos);
    if (!hiddenAt(field, half[f.rec.kind])) {
      // still on the screen: fly on along the loop's last heading
      const a = pathPoint(f, 1);
      const b = pathPoint(f, 0.995);
      const len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      f.dir = { x: (a.x - b.x) / len, y: (a.y - b.y) / len };
      f.state = "extend";
      return;
    }
    beginHidden(f, frame);
  };

  const beginHidden = (f: Flier, frame: number) => {
    f.leaving = frame >= exodusFrame;
    if (f.leaving) {
      f.state = "gone";
      return;
    }
    // Where it comes back in: just above its slot, as Flight.ts places it.
    let to = toField({ x: slotPos(f.rec.slot, frame).x, y: -30 });
    let route = hiddenRoute(toField(f.pos), to, hiddenSpeed);
    // the slot will have marched on by the time it gets there
    to = toField({ x: slotPos(f.rec.slot, frame + route.length).x, y: -30 });
    route = hiddenRoute(toField(f.pos), to, hiddenSpeed);
    f.route = route;
    f.routeIdx = 0;
    f.state = "hidden";
  };

  const fireFrom = (
    f: Flier,
    frame: number,
    aimed: boolean,
    from: Shot["from"],
  ) => f.rec.shots.push({ frame, aimed, from });

  for (let frame = 1; frame < 60 * 60 * 10; frame++) {
    const dt = FRAME_MS;

    // 'step': the march runs off the precomputed schedule; the lock poll.
    if (!locked) {
      lockAcc += dt;
      if (lockAcc > LOCK_POLL_MS + 1e-9) {
        lockAcc = 0;
        const alive = fliers.filter((f) => f.state !== "gone");
        if (alive.length > 0 && alive.every((f) => f.state === "formation")) {
          locked = true;
          lockFrame = frame;
          exodusFrame = frame + Math.round(opts.horizonMs / FRAME_MS);
        }
      }
    }

    // 'step': every launched enemy's flight
    for (const f of fliers) {
      const speedPx = (f.speed * dt) / 1000;
      switch (f.state) {
        case "path": {
          f.t = Math.min(f.t + speedPx / f.path!.length, 1);
          f.pos = pathPoint(f, f.t);
          if (f.diving) {
            while (f.fired < f.fireAt.length && f.t >= f.fireAt[f.fired]) {
              f.fired++;
              fireFrom(f, frame, true, "dive");
            }
          }
          if (f.t >= 1) {
            if (f.diving) finishDive(f, frame);
            else f.state = "seek";
          }
          break;
        }
        case "seek": {
          const target = slotPos(f.rec.slot, frame);
          const dx = target.x - f.pos.x, dy = target.y - f.pos.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= Math.max(8, speedPx)) {
            f.pos = target;
            f.state = "formation";
          } else {
            const a = Math.atan2(dy, dx);
            f.pos = {
              x: f.pos.x + Math.cos(a) * speedPx,
              y: f.pos.y + Math.sin(a) * speedPx,
            };
          }
          break;
        }
        case "formation":
          f.pos = slotPos(f.rec.slot, frame);
          break;
        case "extend": {
          f.pos = {
            x: f.pos.x + f.dir.x * speedPx,
            y: f.pos.y + f.dir.y * speedPx,
          };
          if (hiddenAt(toField(f.pos), half[f.rec.kind])) {
            beginHidden(f, frame);
          }
          break;
        }
        case "hidden": {
          f.routeIdx++;
          if (f.routeIdx >= f.route.length) {
            // back in at (slotX, -30), gliding home at the dive's speed
            f.pos = { x: slotPos(f.rec.slot, frame).x, y: -30 };
            f.state = "seek";
          }
          break;
        }
      }
    }

    // the scene clock: launches, the guns, the dive launcher
    for (const f of fliers) {
      if (f.state === "waiting" && frame >= f.rec.launchFrame) {
        f.state = "path";
        f.diving = false;
        f.path = PATHS[f.rec.flyInPath];
        f.t = 0;
        f.offset = { x: 0, y: 0 };
        f.speed = def.entrySpeed;
        f.pos = pathPoint(f, 0);
      }
    }

    if (locked && timerFires(frame, def.fireDelay)) {
      const inFormation = fliers.filter((f) => f.state === "formation");
      if (inFormation.length) {
        const sorted = [...inFormation].sort((a, b) =>
          b.rec.slot.row - a.rec.slot.row
        );
        const pool = sorted.slice(
          0,
          Math.max(3, Math.ceil(sorted.length / 3)),
        );
        const shooter = pool[Math.floor(rand() * pool.length)];
        fireFrom(shooter, frame, def.aimedShots, "formation");
      }
    }

    const diving = locked && (frame >= exodusFrame
      ? timerFires(
        frame - exodusFrame,
        Math.max(300, Math.min(500, def.diveDelay / 4)),
      )
      : timerFires(frame, def.diveDelay));
    if (diving) {
      const candidates = fliers.filter((f) => f.state === "formation");
      if (candidates.length) {
        diveToggle++;
        const wantGirl = diveToggle % 3 === 0;
        const girls = candidates.filter((f) => f.rec.kind === "goldGirl");
        const others = candidates.filter((f) => f.rec.kind !== "goldGirl");
        if (wantGirl && girls.length > 0) {
          const girl = girls[Math.floor(rand() * girls.length)];
          const speed = def.entrySpeed + DIVE_SPEED_BONUS.boss;
          startDive(girl, DIVE_BOSS, speed);
          others.filter((f) => f.rec.kind === "eyeDude").slice(0, 2)
            .forEach((f) => startDive(f, DIVE_BOSS, speed));
        } else if (others.length > 0) {
          const diver = others[Math.floor(rand() * others.length)];
          const speed = def.entrySpeed + DIVE_SPEED_BONUS.single;
          const pool = diver.rec.kind === "pinkBunny"
            ? DIVE_WASP
            : DIVE_BUTTERFLY;
          startDive(diver, pool, speed);
          if (diver.rec.kind === "pinkBunny" && level >= 5) {
            const second = others.find((f) =>
              f !== diver && f.rec.kind === "pinkBunny"
            );
            if (second) startDive(second, DIVE_WASP, speed);
          }
        } else if (frame >= exodusFrame && girls.length > 0) {
          // In the exodus the gold girls go too, even off their turn.
          const girl = girls[Math.floor(rand() * girls.length)];
          startDive(girl, DIVE_BOSS, def.entrySpeed + DIVE_SPEED_BONUS.boss);
        }
      }
    }

    for (const f of fliers) record(f, frame);

    if (fliers.every((f) => f.state === "gone")) {
      endFrame = frame;
      break;
    }
  }
  if (!endFrame) throw new Error(`level ${level}: the replay never ended`);

  return {
    stage: level - 1,
    flights: fliers.map((f) => f.rec),
    lockFrame,
    endFrame,
  };
}
