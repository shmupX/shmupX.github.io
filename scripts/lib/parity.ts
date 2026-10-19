// The pure half of `deno task testdrive:parity`: what the seven panes are, how
// a boss's projectiles are told apart, how a pane's frames become its clip,
// how a bot's inputs are logged for the attract mode, and the ffmpeg command
// lines that cut each clip and lay the seven into one grid. Nothing in here
// touches a process, a socket or the disk; scripts/testdrive-parity.ts does.

/** The seven targets, in the order the grid shows them. */
export const PANE_IDS = [
  "web",
  "ps2",
  "sfc",
  "saturn",
  "kids",
  "plus",
  "n64dd",
] as const;
export type PaneId = typeof PANE_IDS[number];

export interface PaneSpec {
  id: PaneId;
  /** The caption over the pane in the grid. */
  label: string;
  /** The page's own size: the viewport the pane is recorded at. */
  width: number;
  height: number;
  /**
   * Whether the boss's second stage (the dragon) exists on this target, as
   * far as this repo knows: the web runtime has it; the PS2 port and the
   * console writers are being taught it (or an approximation of it), and the
   * pane's report says what was actually seen.
   */
  stage2: "native" | "port" | "approximated";
  /**
   * The playfield inside the page, where the page is wider than the game: the
   * PS2's 640x448 screen draws the 256x480 field at 448/480 scale, centred —
   * 240 pixels wide from x 200. The clip is cut to it.
   */
  crop?: { w: number; h: number; x: number; y: number };
}

export const PANES: Record<PaneId, PaneSpec> = {
  web: { id: "web", label: "WEB", width: 256, height: 480, stage2: "native" },
  ps2: {
    id: "ps2",
    label: "PS2",
    width: 640,
    height: 448,
    stage2: "port",
    crop: { w: 240, h: 448, x: 200, y: 0 },
  },
  sfc: {
    id: "sfc",
    label: "SUPER FAMICOM",
    width: 256,
    height: 224,
    stage2: "approximated",
  },
  saturn: {
    id: "saturn",
    label: "SATURN",
    width: 320,
    height: 224,
    stage2: "approximated",
  },
  kids: {
    id: "kids",
    label: "PS1 KIDS!",
    width: 320,
    height: 240,
    stage2: "approximated",
  },
  plus: {
    id: "plus",
    label: "PS1 DEZAEMON+",
    width: 320,
    height: 240,
    stage2: "approximated",
  },
  n64dd: {
    id: "n64dd",
    label: "64DD",
    width: 320,
    height: 240,
    stage2: "approximated",
  },
};

/** Parse `--targets web,sfc` (or `all`) into pane ids, in grid order. */
export function parseTargets(value: string | undefined): PaneId[] {
  if (!value || value === "all") return [...PANE_IDS];
  // Nothing to capture: with --reuse, only the grid and the GIF are rewritten.
  if (value === "none") return [];
  const asked = value.split(",").map((s) => s.trim().toLowerCase()).filter(
    Boolean,
  );
  for (const a of asked) {
    if (!(PANE_IDS as readonly string[]).includes(a)) {
      throw new Error(
        `unknown target "${a}" — one of ${PANE_IDS.join(", ")}, or all`,
      );
    }
  }
  return PANE_IDS.filter((id) => asked.includes(id));
}

// deno-lint-ignore no-explicit-any
type Json = any;

/** A frame name as the runtime keys it: the editor's "․" back to ".". */
const frameKey = (name: string) => name.replace(/․/g, ".");

/**
 * The boss's projectiles, one kind per distinct set of bullet textures across
 * its weapon slots and its second stage's — gs's Daltonius has three: RAM_0
 * (slot A), laptop0/1 (slot B) and, once it is the dragon, deza1_52_0/1 (both
 * of the dragon's slots, which share one texture set and so are one kind).
 * The kind is named after the slot that first fires it, `stage2:` prefixed
 * for the dragon's.
 */
export function projectileKinds(boss: Json): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  const add = (prefix: string, rec: Json) => {
    if (!rec || typeof rec !== "object") return;
    for (
      const slot of ["bulletData", "bulletDataA", "bulletDataB", "bulletDataC"]
    ) {
      const tex = rec[slot]?.texture;
      const frames =
        (Array.isArray(tex) ? tex : typeof tex === "string" ? [tex] : [])
          .filter((t: unknown) => typeof t === "string" && t)
          .map(frameKey);
      if (!frames.length) continue;
      const key = [...frames].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out[`${prefix}${slot.replace("bulletData", "") || "main"}`] = frames;
    }
  };
  add("", boss);
  add("stage2:", boss?.stage2);
  return out;
}

/** Which kind a bullet frame belongs to, or null for none of the boss's. */
export function kindOf(
  kinds: Record<string, string[]>,
  frame: string,
): string | null {
  const f = frameKey(frame);
  for (const [kind, frames] of Object.entries(kinds)) {
    if (frames.includes(f)) return kind;
  }
  return null;
}

/** One screencast frame: where it was written and its wall-clock time (ms). */
export interface Frame {
  file: string;
  t: number;
}

/**
 * A pane's clip: the frames painted between `from` and `to` (wall ms),
 * resampled onto a steady `fps` clock — each tick takes the latest frame
 * painted at or before it, so a slow stretch repeats a frame instead of
 * speeding the clip up. The frame painted last before `from` opens it, so a
 * window that starts between two paints starts on the picture then showing.
 */
export function clipFrames(
  frames: Frame[],
  from: number,
  to: number,
  fps: number,
): string[] {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  if (!sorted.length || to <= from) return [];
  const ticks = Math.max(1, Math.round(((to - from) / 1000) * fps));
  const out: string[] = [];
  let i = 0;
  for (let k = 0; k < ticks; k++) {
    const at = from + (k * 1000) / fps;
    while (i + 1 < sorted.length && sorted[i + 1].t <= at) i++;
    out.push(sorted[i].file);
  }
  return out;
}

/**
 * Where a pane's clip opens: the window's own start (the boss down to
 * `fromHp`), or earlier when a kind the boss fires only before its second
 * stage last appeared before that — `leadMs` ahead of its last appearance, so
 * the volley is seen leaving the boss. Returns the wall time and the kinds it
 * was moved for.
 */
export function clipStart(
  windowStart: number,
  preMorph: Record<string, { wall: number }>,
  preMorphKinds: string[],
  leadMs = 400,
): { at: number; pulledBy: string[] } {
  let at = windowStart;
  const pulledBy: string[] = [];
  for (const kind of preMorphKinds) {
    const seen = preMorph[kind];
    if (!seen) continue;
    if (seen.wall - leadMs < at) {
      at = seen.wall - leadMs;
      pulledBy.push(kind);
    }
  }
  return { at, pulledBy };
}

/** The concat list ffmpeg reads a clip from (one line per picture). */
export function concatList(files: string[], fps: number): string {
  const dur = 1 / fps;
  const q = (f: string) =>
    `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
  const lines = files.map((f) => `${q(f)}\nduration ${dur}`);
  if (files.length) lines.push(q(files[files.length - 1]));
  return lines.join("\n") + "\n";
}

/** A pane clip as an mp4 at full rate: the attract mode's source. */
export function clipArgs(
  listFile: string,
  fps: number,
  out: string,
  crop?: PaneSpec["crop"],
): string[] {
  const cut = crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : "";
  return [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-r",
    String(fps),
    "-i",
    listFile,
    "-vf",
    `fps=${fps},${cut}pad=ceil(iw/2)*2:ceil(ih/2)*2`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    out,
  ];
}

/**
 * The buttons a bot holds, as bits — the attract mode replays these. One
 * mask per step would be thousands of numbers for a minute of play, so the
 * log keeps only the steps the mask changes on: [[step, mask], …].
 */
export const BUTTON_BITS = {
  up: 1,
  down: 2,
  left: 4,
  right: 8,
  fire: 16,
  sp: 32,
  start: 64,
  select: 128,
  l: 256,
  r: 512,
} as const;

export function encodeInputs(masks: number[]): [number, number][] {
  const out: [number, number][] = [];
  let last = -1;
  masks.forEach((m, step) => {
    if (m !== last) out.push([step, m]);
    last = m;
  });
  return out;
}

export function decodeInputs(log: [number, number][], steps: number): number[] {
  const out = new Array<number>(steps).fill(0);
  for (let i = 0; i < log.length; i++) {
    const [from, mask] = log[i];
    const to = i + 1 < log.length ? log[i + 1][0] : steps;
    for (let s = from; s < to && s < steps; s++) out[s] = mask;
  }
  return out;
}

/** Where each pane sits in the grid: four across, then the rest centred. */
export interface Cell {
  id: string;
  x: number;
  y: number;
}

export function gridCells(
  ids: string[],
  cellW: number,
  cellH: number,
  cols = 4,
): { cells: Cell[]; width: number; height: number } {
  const rows = Math.ceil(ids.length / cols) || 1;
  const width = Math.min(ids.length, cols) * cellW;
  const cells = ids.map((id, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, ids.length - row * cols);
    const offset = ((Math.min(ids.length, cols) - inRow) * cellW) / 2;
    return { id, x: offset + (i % cols) * cellW, y: row * cellH };
  });
  return { cells, width, height: rows * cellH };
}

export interface GridInput {
  id: string;
  /** The pane's clip, or null for a pane that has none (a blocked target). */
  clip: string | null;
  caption: string;
  /** Seconds the clip runs; the grid runs as long as the longest. */
  seconds: number;
}

/**
 * ffmpeg's command line for the grid: every clip scaled to fit its cell
 * (letterboxed, pixel art kept sharp), its caption drawn in the bar above it,
 * each held on its last frame until the longest has finished, a blocked
 * pane drawn as its caption over black, and the lot stacked with xstack.
 * `font` is a TrueType file drawtext can open — a Windows path's drive colon
 * escaped, as the filter syntax needs.
 */
export function gridArgs(
  inputs: GridInput[],
  opts: {
    cellW: number;
    cellH: number;
    captionH: number;
    fps: number;
    /** A TrueType file for the captions; null draws the grid without them. */
    font: string | null;
    out: string;
    cols?: number;
  },
): string[] {
  const { cellW, cellH, captionH, fps } = opts;
  const total = Math.max(1, ...inputs.map((i) => i.seconds));
  const font = opts.font?.replace(/\\/g, "/").replace(/:/g, "\\:") ?? null;
  const text = (s: string) =>
    s.replace(/\\/g, "\\\\").replace(/'/g, "’").replace(/:/g, "\\:")
      .replace(/%/g, "\\%");
  const args = ["-y", "-loglevel", "error"];
  const chains: string[] = [];
  let n = 0;
  inputs.forEach((input, i) => {
    const caption = font
      ? `drawtext=fontfile='${font}':text='${text(input.caption)}':fontsize=${
        Math.round(captionH * 0.62)
      }:fontcolor=white:x=(w-tw)/2:y=${Math.round(captionH * 0.18)}`
      : "null";
    if (input.clip) {
      args.push("-i", input.clip);
      chains.push(
        `[${n}:v]fps=${fps},scale=${cellW}:${
          cellH - captionH
        }:force_original_aspect_ratio=decrease:flags=neighbor,` +
          `pad=${cellW}:${
            cellH - captionH
          }:(ow-iw)/2:(oh-ih)/2:black,pad=${cellW}:${cellH}:0:${captionH}:0x111111,` +
          `${caption},tpad=stop_mode=clone:stop_duration=${
            (total - input.seconds + 1).toFixed(2)
          },trim=duration=${total.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`,
      );
      n++;
    } else {
      args.push(
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${cellW}x${cellH}:r=${fps}:d=${total.toFixed(2)}`,
      );
      chains.push(`[${n}:v]${caption}[v${i}]`);
      n++;
    }
  });
  const { cells } = gridCells(
    inputs.map((i) => i.id),
    cellW,
    cellH,
    opts.cols ?? 4,
  );
  const layout = cells.map((c) => `${c.x}_${c.y}`).join("|");
  const stacked = inputs.length === 1
    ? `[v0]null[grid]`
    : `${
      inputs.map((_, i) => `[v${i}]`).join("")
    }xstack=inputs=${inputs.length}:layout=${layout}:fill=black[grid]`;
  args.push(
    "-filter_complex",
    [...chains, stacked].join(";"),
    "-map",
    "[grid]",
    "-r",
    String(fps),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    opts.out,
  );
  return args;
}

/** The GIF from the grid's mp4: a palette from frame differences, no dither. */
export function gridGifArgs(
  mp4: string,
  fps: number,
  scale: number,
  out: string,
): string[] {
  const s = scale === 1 ? "" : `scale=iw*${scale}:ih*${scale}:flags=neighbor,`;
  return [
    "-y",
    "-loglevel",
    "error",
    "-i",
    mp4,
    "-vf",
    `fps=${fps},${s}split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    "-loop",
    "0",
    out,
  ];
}

/** Rates, then scales, a GIF over its budget is re-encoded at, best first. */
export function gifLadder(fps: number): { fps: number; scale: number }[] {
  const rates = [fps, ...[12, 10, 8, 6].filter((f) => f < fps)];
  const out: { fps: number; scale: number }[] = [];
  for (const scale of [1, 0.75, 0.5]) {
    for (const f of rates) out.push({ fps: f, scale });
  }
  return out;
}
