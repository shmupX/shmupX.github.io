/**
 * What `deno task refresh:compare` measures, shared by its emulated runs (in
 * Deno, over per-frame records) and its live runs (in the page, frame by
 * frame, on a real display). See scripts/refresh-compare.ts.
 */

/**
 * One tracked object on one frame: [id, drawnX, drawnY, logicX, logicY,
 * what it shows], then optionally the same four positions on the game's pixel
 * grid, the way the renderer puts them on screen (see PIXELS_JS in
 * refresh-page.ts). On a stock page the drawn and logic positions are one.
 */
export type ObjectSample =
  | [string, number, number, number, number, string]
  | [
    string,
    number,
    number,
    number,
    number,
    string,
    number,
    number,
    number,
    number,
  ];

export interface FrameRecord {
  frame: number;
  scene: string | null;
  on: boolean;
  objs: ObjectSample[];
  /** Whether each half's pixels differ from its previous frame: [stock, max]. */
  changed?: [boolean, boolean];
}

export interface ViewCadence {
  /** Frames on which a moving object was drawn somewhere new, as a share. */
  moved: number;
  /** moved × hz: how many times a second its motion is drawn. */
  drawnHz: number;
  /** 1 = every frame moves it as far as the last; 0 = 0/2× alternation. */
  evenness: number;
  /** Share of frames whose pixels differ from the frame before (emulated). */
  pixelsChanged: number | null;
  samples: number;
}

/** A cadence tally before the display rate is known: what CADENCE_JS returns. */
export interface RawCadence {
  samples: number;
  moved: number;
  evenness: number;
}

/**
 * The cadence meter, as JavaScript, because it runs in two places: in Deno
 * over an emulated run's records (`cadence` below), and inside the page on a
 * live run, where shipping every object's position every frame back to Deno
 * at 500 Hz would cost more than the frame. One source, so both count alike.
 *
 * A body counts on a frame when its LOGIC moved within the last `span`
 * frames — the display frames one 120 Hz step can take, rounded up
 * (`stepSpan`), so a body in motion has certainly been stepped in that
 * window whatever the display rate — without a warp (more than a step's
 * 48 px in one frame) in it, and it was on screen for all of it. Each view's
 * own positions then say whether it was drawn somewhere new this frame, and
 * how evenly against the frame before. Views: 0 the logic's positions (the
 * stock picture), 1 the drawn ones, 2 and 3 the same two on the game's pixel
 * grid — what actually changes on screen — when the caller passes them. A
 * body is keyed by an id string or by the object.
 */
export const CADENCE_JS = `function cadenceMeter(span) {
  span = Math.max(2, span || 2);
  var weak = new WeakMap(), strong = new Map(), now = 0, ring = span + 1;
  var views = [tally(), tally(), tally(), tally()];
  function tally() { return { samples: 0, moved: 0, evenSum: 0, evenN: 0 }; }
  function count(v, x0, y0, x1, y1, x2, y2) {
    var d0 = Math.hypot(x1 - x0, y1 - y0), d1 = Math.hypot(x2 - x1, y2 - y1);
    v.samples++;
    if (d1 > 1e-6) v.moved++;
    var hi = Math.max(d0, d1);
    if (hi > 1e-6) { v.evenSum += Math.min(d0, d1) / hi; v.evenN++; }
  }
  return {
    span: span,
    frame: function (n) { now = n; },
    body: function (key, dx, dy, lx, ly, pdx, pdy, plx, ply) {
      var map = typeof key === "object" ? weak : strong;
      var h = map.get(key);
      if (!h) {
        // p1, p2: [dx, dy, lx, ly, pdx, pdy, plx, ply] one and two frames
        // back; logic: the logic's x, y for the last span + 1 frames.
        h = { at: -9, since: now, warpAt: -1e9, p1: new Array(8), p2: new Array(8),
          logic: new Float64Array(ring * 2) };
        map.set(key, h);
      }
      if (h.at !== now - 1) h.since = now;
      else if (Math.hypot(lx - h.p1[2], ly - h.p1[3]) > 48) h.warpAt = now;
      if (now - h.since >= span && now - h.warpAt > span) {
        var old = ((now - span) % ring) * 2;
        if (lx !== h.logic[old] || ly !== h.logic[old + 1]) {
          var a = h.p2, b = h.p1;
          count(views[0], a[2], a[3], b[2], b[3], lx, ly);
          count(views[1], a[0], a[1], b[0], b[1], dx, dy);
          if (pdx !== undefined && a[4] !== undefined && b[4] !== undefined) {
            count(views[2], a[6], a[7], b[6], b[7], plx, ply);
            count(views[3], a[4], a[5], b[4], b[5], pdx, pdy);
          }
        }
      }
      var cur = (now % ring) * 2;
      h.logic[cur] = lx;
      h.logic[cur + 1] = ly;
      var t = h.p2;
      h.p2 = h.p1;
      h.p1 = t;
      t[0] = dx; t[1] = dy; t[2] = lx; t[3] = ly;
      t[4] = pdx; t[5] = pdy; t[6] = plx; t[7] = ply;
      h.at = now;
    },
    result: function () {
      return views.map(function (v) {
        return {
          samples: v.samples,
          moved: v.samples ? v.moved / v.samples : 0,
          evenness: v.evenN ? v.evenSum / v.evenN : 0,
        };
      });
    },
  };
}`;

/** Display frames one 120 Hz logic step can span at `hz`, rounded up. */
export function stepSpan(hz: number): number {
  return Math.max(2, Math.ceil(hz / 120 - 0.01));
}

interface CadenceMeter {
  span: number;
  frame(n: number): void;
  body(
    key: unknown,
    dx: number,
    dy: number,
    lx: number,
    ly: number,
    pdx?: number,
    pdy?: number,
    plx?: number,
    ply?: number,
  ): void;
  result(): [RawCadence, RawCadence, RawCadence, RawCadence];
}

const cadenceMeter = new Function(
  `${CADENCE_JS}\nreturn cadenceMeter;`,
)() as (span: number) => CadenceMeter;

/** A raw tally at a display rate. */
export function viewCadence(
  raw: RawCadence,
  hz: number,
  pixelsChanged: number | null = null,
): ViewCadence {
  return {
    moved: raw.moved,
    drawnHz: raw.moved * hz,
    evenness: raw.evenness,
    pixelsChanged,
    samples: raw.samples,
  };
}

export interface Cadence {
  stock: ViewCadence;
  max: ViewCadence;
  /** The same on the game's pixel grid, when the samples carried it. */
  pixels: { stock: ViewCadence; max: ViewCadence } | null;
}

/**
 * How often each half of an emulated run draws motion: the stock half by the
 * logic's positions, the max half by the drawn ones.
 */
export function cadence(frames: FrameRecord[], hz: number): Cadence {
  const meter = cadenceMeter(stepSpan(hz));
  frames.forEach((f, t) => {
    meter.frame(t);
    for (const o of f.objs) {
      meter.body(o[0], o[1], o[2], o[3], o[4], o[6], o[7], o[8], o[9]);
    }
  });
  const [logic, drawn, logicPx, drawnPx] = meter.result();
  const changed = (pick: 0 | 1) =>
    frames.length > 1
      ? frames.slice(1).filter((f) => f.changed?.[pick]).length /
        (frames.length - 1)
      : 0;
  return {
    stock: viewCadence(logic, hz, changed(0)),
    max: viewCadence(drawn, hz, changed(1)),
    pixels: logicPx.samples
      ? { stock: viewCadence(logicPx, hz), max: viewCadence(drawnPx, hz) }
      : null,
  };
}

/**
 * The assertions `--check` makes, as messages; empty means it passed. A
 * display no faster than the 120 Hz logic has nothing to show: every frame
 * already gets a step.
 */
export function judge(
  c: {
    stock: ViewCadence;
    max: ViewCadence;
    pixels?: { stock: ViewCadence; max: ViewCadence } | null;
  },
  hz: number,
): string[] {
  const out: string[] = [];
  if (c.max.samples < 200) {
    out.push(`only ${c.max.samples} moving-object samples; nothing to judge`);
    return out;
  }
  if (hz <= 130) return out;
  // The stock half is the control: it proves the display really is outrunning
  // the 120 Hz logic, or the max half's numbers would mean nothing.
  if (c.stock.moved > 0.75) {
    out.push(
      `stock drew motion on ${pct(c.stock.moved)} of frames at ${hz} Hz; ` +
        `the display is not outrunning the logic, so this proves nothing`,
    );
  }
  if (c.max.moved < 0.9) {
    out.push(
      `max refresh drew motion on only ${pct(c.max.moved)} of frames ` +
        `(${c.max.drawnHz.toFixed(0)} of ${hz} per second)`,
    );
  }
  if (c.max.evenness < 0.75) {
    out.push(
      `max refresh motion is uneven frame to frame (evenness ` +
        `${c.max.evenness.toFixed(2)}, stock ${c.stock.evenness.toFixed(2)})`,
    );
  }
  // On screen a sprite moves a whole pixel or not at all, so slow movers
  // cannot gain; but nothing may move on fewer frames than it did stock.
  if (c.pixels && c.pixels.max.moved + 0.01 < c.pixels.stock.moved) {
    out.push(
      `on screen, max refresh moved things on fewer frames than stock ` +
        `(${pct(c.pixels.max.moved)} against ${pct(c.pixels.stock.moved)})`,
    );
  }
  return out;
}

/**
 * Where a stock run and a max-refresh run of the same seed first part ways,
 * by the logic's own positions; null when every frame agrees. Max refresh
 * only moves what is drawn, so they never should.
 */
export function firstDivergence(
  max: FrameRecord[],
  stock: FrameRecord[],
): string | null {
  if (max.length !== stock.length) {
    return `${max.length} frames against ${stock.length}`;
  }
  for (let i = 0; i < max.length; i++) {
    const a = max[i].objs, b = stock[i].objs;
    if (a.length !== b.length) {
      return `frame ${i}: ${a.length} objects under max refresh, ` +
        `${b.length} stock`;
    }
    for (let j = 0; j < a.length; j++) {
      const [ida, , , ax, ay, wa] = a[j];
      const [idb, , , bx, by, wb] = b[j];
      if (ida !== idb || ax !== bx || ay !== by || wa !== wb) {
        return `frame ${i}: ${wa} #${ida} at (${ax}, ${ay}) under max ` +
          `refresh, ${wb} #${idb} at (${bx}, ${by}) stock`;
      }
    }
  }
  return null;
}

/** A distribution, in the unit it was measured in. */
export interface Spread {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  stdev: number;
}

/** Nearest-rank percentiles, mean and spread of `xs`. */
export function spread(xs: ArrayLike<number>): Spread {
  const s = Array.from(xs).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, stdev: 0 };
  const at = (p: number) =>
    s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    n,
    mean,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[n - 1],
    stdev: Math.sqrt(variance),
  };
}

/** One mode's frames, as the page recorded them. */
export interface RawRun {
  /** ms from the frame before; the first frame of a slice may be 0. */
  interval: number[];
  /** ms of main-thread work: update + draw. */
  work: number[];
  /** ms from 'prestep' to 'prerender': the scenes' updates and the steps. */
  update: number[];
  /** ms from 'prerender' to 'postrender': the draw calls. */
  draw: number[];
  /** Fixed 120 Hz steps the frame ran. */
  steps: number[];
  /** 1 when the frame was drawn with the blend on. */
  on: number[];
}

export interface Timing {
  frames: number;
  /** The display rate the frames came at: 1000 / the median interval. */
  hz: number;
  intervalMs: Spread;
  /** Share of frames that came 1.5 intervals or more after the last. */
  missed: number;
  workMs: Spread;
  updateMs: Spread;
  drawMs: Spread;
  /** p95 work as a share of the median interval: >1 is a frame not kept. */
  budget: number;
  /** Share of frames by steps run: 0, 1, 2, and 3 or more. */
  steps: [number, number, number, number];
  /** Share of frames drawn with the blend on. */
  blended: number;
}

/** Frame pacing, work and step cadence of one recorded mode. */
export function timing(raw: RawRun): Timing {
  const intervals = raw.interval.filter((x) => x > 0);
  const iv = spread(intervals);
  const work = spread(raw.work);
  const n = raw.work.length;
  const steps: [number, number, number, number] = [0, 0, 0, 0];
  for (const s of raw.steps) steps[Math.min(3, s)]++;
  return {
    frames: n,
    hz: iv.p50 ? 1000 / iv.p50 : 0,
    intervalMs: iv,
    missed: intervals.length
      ? intervals.filter((x) => x >= iv.p50 * 1.5).length / intervals.length
      : 0,
    workMs: work,
    updateMs: spread(raw.update),
    drawMs: spread(raw.draw),
    budget: iv.p50 ? work.p95 / iv.p50 : 0,
    steps: steps.map((c) => (n ? c / n : 0)) as Timing["steps"],
    blended: n ? raw.on.reduce((a, b) => a + b, 0) / n : 0,
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
