/**
 * A zako's appearance script, run exactly as the shmupX runtime runs it, and
 * a compiler that writes one from a flight path.
 *
 * The runtime (static/games/2028-ai/game.bundle.js, `stepEntryScript`) moves
 * a scripted enemy once per Saturn frame — two of its 120 Hz ticks — from a
 * list of rows `[duration, angle, turnRate, amp, flags]`:
 *
 * - a row lasts `duration + 1` frames;
 * - `angle` is a 16-bit circle (0 right, 0x4000 up, 0x8000 left, 0xC000
 *   down), but only its high byte steers: the heading is quantised to 1/256
 *   of a turn;
 * - `turnRate` is added to the angle every frame after the first, and the
 *   velocity is recomputed only on a row load or a turning frame;
 * - the speed is `amp / 256` px per frame, and amp 0 hands the enemy back to
 *   its record, which for a record with no speed field means it holds;
 * - an enemy that spawned right of the screen centre has its x velocity
 *   negated for its whole life, so one script flies mirrored pairs.
 *
 * `runEntryScript` is that loop, line for line. `compileEntryScript` turns a
 * per-frame target path into rows by pursuit: each row is fitted from where
 * the SIMULATED enemy actually is, so quantisation error never accumulates,
 * and each row is made as long as a constant-speed, constant-turn arc can
 * stay within tolerance of the target.
 */

export type Point = { x: number; y: number };

/** `[duration, angle, turnRate, amp, flags]`, as the runtime reads a row. */
export type EntryRow = [number, number, number, number, number];

/** Load the next row when this one ends (without it a row holds forever). */
export const ENTRY_ADVANCE = 0x1;
/** The enemy may not fire while this row runs. */
export const ENTRY_NO_FIRE = 0x10;
/** The longest a row can last; the runtime counts it down from here. */
export const ROW_FOREVER = 32767;

const TAU = Math.PI * 2;

/** The heading the runtime steers by for a 16-bit angle. */
function heading(angle: number): number {
  return (angle >>> 8) * (TAU / 256);
}

/**
 * Run `rows` from `start` for `frames` Saturn frames, as stepEntryScript does,
 * and answer every position: index k is the position after k moves.
 */
export function runEntryScript(
  rows: EntryRow[],
  start: Point,
  mirror: boolean,
  frames: number,
): Point[] {
  const out: Point[] = [{ ...start }];
  let x = start.x, y = start.y;
  let idx = 0, rowT = 0, angle = 0, turn = 0, amp = 0, flags = 0;
  let vx = 0, vy = 0, active = false;
  for (let f = 0; f < frames; f++) {
    let recompute = false;
    if (--rowT < 0) {
      const row = rows[idx < rows.length ? idx : rows.length - 1];
      flags = row[4];
      rowT = row[0];
      angle = row[1];
      turn = row[2];
      amp = row[3] & 0x7fff;
      if (flags & ENTRY_ADVANCE) {
        idx = idx + 1 < rows.length ? idx + 1 : rows.length - 1;
      }
      recompute = true;
    } else if (turn) {
      angle = (angle + turn) & 0xffff;
      recompute = true;
    }
    if (recompute) {
      const th = heading(angle);
      const v = amp / 256;
      vx = Math.cos(th) * v;
      if (mirror) vx = -vx;
      vy = -Math.sin(th) * v;
      active = amp > 0;
    }
    if (active) {
      x += vx;
      y += vy;
    }
    out.push({ x, y });
  }
  return out;
}

/** The flags of the row each frame runs under, as the fire gate reads them. */
export function rowFlagsByFrame(rows: EntryRow[], frames: number): number[] {
  const out: number[] = [];
  let idx = 0, rowT = 0, flags = rows.length ? rows[0][4] : 0;
  for (let f = 0; f < frames; f++) {
    if (--rowT < 0) {
      const row = rows[idx < rows.length ? idx : rows.length - 1];
      flags = row[4];
      rowT = row[0];
      if (flags & ENTRY_ADVANCE) {
        idx = idx + 1 < rows.length ? idx + 1 : rows.length - 1;
      }
    }
    out.push(flags);
  }
  return out;
}

/** One row's positions from `q`, frame 1..L (frame 0 is `q` itself). */
function simulateRow(
  q: Point,
  angle0: number,
  turn: number,
  amp: number,
  L: number,
  mirror: boolean,
): Point[] {
  const out: Point[] = [];
  let x = q.x, y = q.y, angle = angle0 & 0xffff;
  let vx = 0, vy = 0;
  for (let i = 0; i < L; i++) {
    if (i === 0 || turn) {
      if (i > 0) angle = (angle + turn) & 0xffff;
      const th = heading(angle);
      const v = amp / 256;
      vx = Math.cos(th) * v;
      if (mirror) vx = -vx;
      vy = -Math.sin(th) * v;
    }
    if (amp > 0) {
      x += vx;
      y += vy;
    }
    out.push({ x, y });
  }
  return out;
}

export interface CompileTarget {
  /** Where the enemy should be after k moves; pos[0] is its spawn point. */
  pos: Point[];
  /** Frame k (1..) may be tracked loosely: the enemy is off the screen. */
  hidden: boolean[];
  /** Move k (0..) runs under a row that lets the enemy fire. */
  fire: boolean[];
}

export interface CompileOptions {
  /** Spawned right of centre: the runtime negates every x velocity. */
  mirror: boolean;
  /** Max error on frames the player can see, px. */
  tolerance?: number;
  /** Max error on hidden frames, px — they only have to stay hidden. */
  hiddenTolerance?: number;
  /** Whether a position keeps the sprite off the screen. */
  isHidden: (p: Point) => boolean;
  /** Whether a position is inside the runtime's cull box. */
  inBounds: (p: Point) => boolean;
  /** Longest row the compiler will try, frames. */
  maxRow?: number;
}

export interface Compiled {
  rows: EntryRow[];
  /** The positions the rows actually produce, frame 0..K. */
  sim: Point[];
  /** Worst miss on a visible frame, px. */
  maxVisibleError: number;
}

interface Fit {
  angle: number;
  turn: number;
  amp: number;
  pts: Point[];
  err: number;
  ok: boolean;
}

/**
 * Rows that fly `target`. Row boundaries fall wherever the fire permission
 * changes, so a gate opens and closes on the frame it was asked for.
 */
export function compileEntryScript(
  target: CompileTarget,
  opts: CompileOptions,
): Compiled {
  const tol = opts.tolerance ?? 0.75;
  const hidTol = opts.hiddenTolerance ?? 10;
  const maxRow = opts.maxRow ?? 1200;
  const K = target.pos.length - 1;
  const rows: EntryRow[] = [];
  const sim: Point[] = [{ ...target.pos[0] }];
  let q = { ...target.pos[0] };
  let k = 0;
  let worst = 0;

  // How far a run of equal fire permission reaches from move k.
  const runEnd = (from: number) => {
    let e = from + 1;
    while (e < K && target.fire[e] === target.fire[from]) e++;
    return e;
  };

  const evaluate = (
    from: number,
    L: number,
    angle: number,
    turn: number,
    amp: number,
    stopOnMiss: boolean,
  ): Fit => {
    const pts = simulateRow(q, angle, turn, amp, L, opts.mirror);
    let err = 0;
    let ok = true;
    for (let j = 1; j <= L; j++) {
      const p = pts[j - 1];
      const t = target.pos[from + j];
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      const hidden = target.hidden[from + j];
      if (!opts.inBounds(p)) ok = false;
      if (hidden) {
        if (!opts.isHidden(p) || d > hidTol) ok = false;
        // the last frame of a row hands its position on; keep it close
        if (j === L) err = Math.max(err, d / 4);
      } else {
        err = Math.max(err, d);
        if (d > tol) ok = false;
      }
      if (!ok && stopOnMiss) break;
    }
    return { angle, turn, amp, pts, err, ok };
  };

  /**
   * The arc that best follows the target for L moves from the simulated
   * position: a least-squares line through the headings, the mean speed,
   * then — for short rows, where the runtime's 1/256-turn steering is
   * coarsest — a coordinate descent on all three knobs.
   */
  const fitRow = (from: number, L: number, refine: boolean): Fit => {
    const us: Point[] = [];
    let prev = q;
    for (let j = 1; j <= L; j++) {
      const t = target.pos[from + j];
      us.push({ x: t.x - prev.x, y: t.y - prev.y });
      prev = t;
    }
    const speeds = us.map((u) => Math.hypot(u.x, u.y));
    const mean = speeds.reduce((a, b) => a + b, 0) / L;
    if (mean < 1e-4) return evaluate(from, L, 0, 0, 0, !refine);
    // Headings the script must steer (y up; mirrored when x is negated).
    const hs: number[] = [];
    const is: number[] = [];
    let last: number | null = null;
    for (let j = 0; j < L; j++) {
      if (speeds[j] < 1e-6) continue;
      let h = Math.atan2(-us[j].y, opts.mirror ? -us[j].x : us[j].x);
      if (last !== null) {
        while (h - last > Math.PI) h -= TAU;
        while (h - last < -Math.PI) h += TAU;
      }
      hs.push(h);
      is.push(j);
      last = h;
    }
    let a = hs[0], b = 0;
    if (hs.length > 1) {
      const n = hs.length;
      const mi = is.reduce((s, v) => s + v, 0) / n;
      const mh = hs.reduce((s, v) => s + v, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        num += (is[i] - mi) * (hs[i] - mh);
        den += (is[i] - mi) ** 2;
      }
      b = den > 0 ? num / den : 0;
      a = mh - b * mi;
    }
    // The runtime steers by the angle's high byte, so centre the start angle
    // in its 1/256 step rather than at its floor.
    let angle = (Math.round((a / TAU) * 65536) + 128) & 0xffff;
    let turn = L === 1 ? 0 : Math.round((b / TAU) * 65536);
    let amp = Math.max(1, Math.min(0x7fff, Math.round(mean * 256)));
    let best = evaluate(from, L, angle, turn, amp, !refine);
    if (!refine || best.ok && best.err < tol / 4) return best;
    const steps: [number, number, number][] = [
      [256, 0, 0],
      [-256, 0, 0],
      [64, 0, 0],
      [-64, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 8, 0],
      [0, -8, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0, 0, 8],
      [0, 0, -8],
    ];
    for (let iter = 0; iter < 24; iter++) {
      let improved = false;
      for (const [da, dt, dm] of steps) {
        if (L === 1 && dt) continue;
        const na = (angle + da) & 0xffff;
        const nt = turn + dt;
        const nm = Math.max(1, Math.min(0x7fff, amp + dm));
        const cand = evaluate(from, L, na, nt, nm, false);
        const better = (cand.ok && !best.ok) ||
          (cand.ok === best.ok && cand.err < best.err - 1e-9);
        if (better) {
          best = cand;
          angle = na;
          turn = nt;
          amp = nm;
          improved = true;
        }
      }
      if (!improved) break;
    }
    return best;
  };

  /** Refine only short rows: long ones either fit outright or are split. */
  const REFINE_UP_TO = 12;
  const tryRow = (from: number, L: number) =>
    fitRow(from, L, L <= REFINE_UP_TO);

  let lastL = 8;
  while (k < K) {
    const limit = Math.min(maxRow, runEnd(k) - k);
    // Gallop up from the last row's length, then halve back down.
    let fit = tryRow(k, 1);
    let lo = 1;
    let hi = limit + 1;
    let probe = Math.min(limit, Math.max(2, lastL));
    while (probe > lo && probe < hi) {
      const f = tryRow(k, probe);
      if (f.ok) {
        fit = f;
        lo = probe;
        if (probe === limit) break;
        probe = Math.min(limit, probe * 2);
      } else {
        hi = probe;
        break;
      }
    }
    let a = lo + 1, b = hi - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      const f = tryRow(k, mid);
      if (f.ok) {
        fit = f;
        lo = mid;
        a = mid + 1;
      } else {
        b = mid - 1;
      }
    }
    const L = lo;
    lastL = L;
    if (fit.pts.length !== L) fit = fitRow(k, L, true);
    const flags = ENTRY_ADVANCE | (target.fire[k] ? 0 : ENTRY_NO_FIRE);
    rows.push([L - 1, fit.angle, fit.turn, fit.amp, flags]);
    for (let j = 1; j <= L; j++) {
      const p = fit.pts[j - 1];
      sim.push(p);
      if (!target.hidden[k + j]) {
        const t = target.pos[k + j];
        worst = Math.max(worst, Math.hypot(p.x - t.x, p.y - t.y));
      }
    }
    q = fit.pts[L - 1];
    k += L;
  }
  return { rows, sim, maxVisibleError: worst };
}

/** The angle a row needs to fly screen heading (dx, dy), mirror included. */
export function angleFor(dx: number, dy: number, mirror: boolean): number {
  const h = Math.atan2(-dy, mirror ? -dx : dx);
  return (Math.round((h / TAU) * 65536) + 128 + 65536) & 0xffff;
}
