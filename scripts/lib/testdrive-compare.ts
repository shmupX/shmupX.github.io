// The offline half of the side-by-side test drives (scripts/testdrive-ps2-*.ts):
// the page that seats two games beside each other, the probes that read and
// freeze each one, the in-page autopilot, and the arithmetic that turns a
// screencast's irregular frames into a constant-rate GIF. Nothing here opens
// a browser or a socket, which is what lets tests/testdrive_compare_test.ts
// pin all of it. The browser half is scripts/lib/testdrive-rig.ts.
//
// WHY ONE PAGE AND TWO IFRAMES, NOT TWO BROWSERS. A screencast is per page, so
// two pages would be two streams on two clocks to be stitched afterwards, and
// the stitch is where the Saturn profiler spends most of its code. Two
// same-origin iframes in one page are one compositor, one stream and one
// clock: a frame IS the side-by-side, and "the same moment" is not a claim the
// stitch has to defend. It also gives the parent a hand on both games — the
// probe reads each frame's Phaser instance and the autopilot steers both ships.

import { GAME_HEIGHT, GAME_WIDTH } from "./game-debug.ts";

/** The runtime's route, the one both panes play. */
export const GAME_PATH = "/games/2028-ai";

/** Space around and between the two panes, and the caption above each. */
export const GUTTER = 8;
export const CAPTION_HEIGHT = 22;

export type Side = "og" | "mod";

/** One seat in the harness: the iframe's id, the caption over it, its URL. */
export interface Pane {
  id: string;
  label: string;
  url: string;
}

/**
 * The two URLs of the OG-against-MOD drive: the same cloud level, the same
 * stage, the ship invincible on both, and only `version` differing.
 * `version=og` is written out even though the runtime reads a missing
 * parameter the same way, so a report or a screenshot's address bar says
 * which pane it is.
 */
export function compareUrls(
  origin: string,
  level: string,
  opts: { stage?: number; god?: boolean } = {},
): Record<Side, string> {
  const base = new URL(GAME_PATH, origin);
  const stage = opts.stage ?? 0;
  const god = opts.god ?? true;
  const make = (version: Side) => {
    const u = new URL(base);
    u.searchParams.set("level", level);
    // `?stage=` skips the title and boots straight into the stage, which is
    // what makes a timed capture compare play and not two title screens.
    u.searchParams.set("stage", String(stage));
    if (god) u.searchParams.set("god", "1");
    u.searchParams.set("version", version);
    return u.toString();
  };
  return { og: make("og"), mod: make("mod") };
}

/** The viewport a harness of `panes` panes needs, at game pixels. */
export function harnessSize(panes = 2): { width: number; height: number } {
  return {
    width: GAME_WIDTH * panes + GUTTER * (panes + 1),
    height: GAME_HEIGHT + CAPTION_HEIGHT + GUTTER * 2,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
    /"/g,
    "&quot;",
  );
}

/**
 * The page the browser is handed: captioned iframes, each exactly the game's
 * 256×480, on black. The route's own fit script scales the canvas to its
 * window, so a frame that size shows the game 1:1. A pane is a fixed column
 * and the page clips: a caption longer than 256px is cut with an ellipsis,
 * never allowed to widen the row, which once put scrollbars across the
 * harness and the right pane's edge off the screencast.
 */
export function harnessHtml(panes: Pane[], title: string): string {
  const pane = (p: Pane) =>
    `<figure class="pane" id="pane-${esc(p.id)}">` +
    `<figcaption>${esc(p.label)}</figcaption>` +
    `<iframe id="${esc(p.id)}" src="${
      esc(p.url)
    }" width="${GAME_WIDTH}" height="${GAME_HEIGHT}" allow="autoplay"></iframe>` +
    `</figure>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
html, body { margin: 0; background: #000; color: #fff; overflow: hidden; }
body { font: bold 11px/${CAPTION_HEIGHT}px ui-monospace, Menlo, monospace; }
.row { display: flex; gap: ${GUTTER}px; padding: ${GUTTER}px; }
.pane { margin: 0; width: ${GAME_WIDTH}px; flex: 0 0 ${GAME_WIDTH}px; }
figcaption { height: ${CAPTION_HEIGHT}px; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
iframe { display: block; border: 0; background: #000; }
</style></head>
<body><div class="row">${panes.map(pane).join("")}</div></body></html>`;
}

/**
 * What one pane is doing, read through its own Phaser instance. Evaluated in
 * the harness page; `id` is the iframe's id.
 */
export function paneStateExpr(id: string): string {
  return `(function () {
    var f = document.getElementById(${JSON.stringify(id)});
    var w = f && f.contentWindow;
    var out = { id: ${
    JSON.stringify(id)
  }, href: null, game: false, scenes: [], started: false, god: null, version: null, frozen: false };
    if (!w) return out;
    try { out.href = w.location.href; } catch (e) { return out; }
    var g = w.__PHASER_4_GAME__ || w.__PHASER_GAME__;
    if (!g || !g.scene) return out;
    out.game = true;
    out.scenes = g.scene.getScenes(true).map(function (s) { return s.sys.settings.key; });
    var gs = g.scene.getScene("PhaserGameScene");
    out.started = !!(gs && g.scene.isActive("PhaserGameScene") && gs.gameStarted);
    var st = w.__GAME_STATE__;
    out.god = st ? !!st.godFlg : null;
    out.version = new w.URLSearchParams(w.location.search).get("version");
    out.frozen = !!(g.loop && g.loop.running === false);
    return out;
  })()`;
}

export interface PaneState {
  id: string;
  href: string | null;
  game: boolean;
  scenes: string[];
  started: boolean;
  god: boolean | null;
  version: string | null;
  frozen: boolean;
}

/** Put one pane's game to sleep (`on`) or wake it; returns whether it took. */
export function freezeExpr(id: string, on: boolean): string {
  return `(function () {
    var w = document.getElementById(${JSON.stringify(id)}).contentWindow;
    var g = w.__PHASER_4_GAME__ || w.__PHASER_GAME__;
    if (!g || !g.loop) return false;
    if (${on ? "true" : "false"}) { if (g.loop.running) g.loop.sleep(); }
    else if (!g.loop.running) g.loop.wake();
    return g.loop.running === ${on ? "false" : "true"};
  })()`;
}

/**
 * The autopilot, installed in the harness page. The runtime autofires, so the
 * ship needs only to be moved: it sways left and right across the lower
 * playfield on a slow cycle, the same keys at the same moments into every
 * iframe, so whatever differs between the panes is what they were given and
 * not the flying. Keys arrive as synthetic KeyboardEvents on each frame's
 * window, which is where Phaser listens; a DevTools key press would reach
 * only the focused frame.
 */
export const AUTOPILOT = `(function () {
  if (window.__autopilot) return "already";
  var LEFT = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 };
  var RIGHT = { key: "ArrowRight", code: "ArrowRight", keyCode: 39 };
  var held = null;
  function frames() {
    return Array.prototype.map.call(document.querySelectorAll("iframe"), function (f) { return f.contentWindow; }).filter(Boolean);
  }
  function send(type, k) {
    frames().forEach(function (w) {
      try { w.dispatchEvent(new w.KeyboardEvent(type, { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, bubbles: true })); } catch (e) {}
    });
  }
  function hold(k) {
    if (held === k) return;
    if (held) send("keyup", held);
    held = k;
    if (k) send("keydown", k);
  }
  var t0 = null;
  var timer = setInterval(function () {
    if (!window.__autopilot.on) { if (held) hold(null); t0 = null; return; }
    if (t0 === null) t0 = performance.now();
    // A 4 s cycle: 1.6 s left, a 0.4 s pause, 1.6 s right, a 0.4 s pause.
    var p = ((performance.now() - t0) / 1000) % 4;
    hold(p < 1.6 ? LEFT : p < 2 ? null : p < 3.6 ? RIGHT : null);
  }, 50);
  window.__autopilot = { on: false, stop: function () { clearInterval(timer); hold(null); } };
  return "installed";
})()`;

/** One screencast frame: where it was written and when it was painted. */
export interface Frame {
  file: string;
  /** Wall-clock milliseconds. */
  t: number;
}

/**
 * The frames a constant-rate GIF of `seconds` at `fps` is made of.
 *
 * A screencast delivers a frame when the compositor paints one, at whatever
 * rate that happens to be — two WebGL games in software can be 10 or 40 a
 * second, and a repaint-free stretch (a pane frozen for its partner to boot)
 * is no frames at all. A GIF wants one picture per tick, so each tick takes
 * the latest frame painted at or before it, which keeps the GIF's clock the
 * capture's: a slow stretch repeats a frame rather than compressing time.
 * Ticks before the first frame get the first frame.
 */
export function resample(
  frames: Frame[],
  fps: number,
  seconds: number,
  from?: number,
): string[] {
  if (!frames.length) return [];
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  const t0 = from ?? sorted[0].t;
  const ticks = Math.max(1, Math.round(fps * seconds));
  const out: string[] = [];
  let i = 0;
  for (let k = 0; k < ticks; k++) {
    const at = t0 + (k * 1000) / fps;
    while (i + 1 < sorted.length && sorted[i + 1].t <= at) i++;
    out.push(sorted[i].file);
  }
  return out;
}

/**
 * ffmpeg's command line for the GIF: the frames by a concat list (one line per
 * picture, so a repeated frame costs a line and not a copy), a palette built
 * from the frame differences, and no dithering. A pixel-art shooter is flat
 * colours, which a 256-entry palette holds outright; dithering them only adds
 * noise that the starfield, already changing every pixel every frame, makes
 * the GIF pay for (measured on a 25 s capture: 23.8 MB with Bayer, 19.7
 * without, and no visible difference).
 */
export function gifArgs(listFile: string, fps: number, out: string): string[] {
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
    `fps=${fps},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    "-loop",
    "0",
    out,
  ];
}

/** The concat list `gifArgs` reads: ffmpeg's syntax, paths quoted. */
export function concatList(files: string[], fps: number): string {
  const dur = 1 / fps;
  const q = (f: string) => `file '${f.replace(/'/g, "'\\''")}'`;
  const lines = files.map((f) => `${q(f)}\nduration ${dur}`);
  // concat holds the last entry's duration only when the file is named once
  // more after it.
  if (files.length) lines.push(q(files[files.length - 1]));
  return lines.join("\n") + "\n";
}

/**
 * The recording's defaults, set by the GIF's size and not by taste. A GIF of
 * two scrolling starfields changes every pixel every frame, so it costs about
 * 65 KB a frame whatever the rate, and 25 s at 12 fps came out at 19 MB —
 * too big to drop into a pull request or a chat. Ten seconds at 6 fps is
 * sixty frames, measured at 3.9 MB on the 2019-PS2 stage, under the 5 MB
 * budget with room for a busier stage; the budget itself is enforced by
 * fpsLadder below when a run outgrows it.
 */
export const DEFAULT_SECONDS = 10;
export const DEFAULT_FPS = 6;
export const DEFAULT_MAX_MB = 5;

/** The rates a GIF over its budget is re-encoded at, highest first. */
const FPS_LADDER = [15, 12, 10, 8, 6, 5, 4, 3, 2];

/**
 * The frame rates to try for a GIF that must fit a size budget: the one asked
 * for, then each lower rung of the ladder. Fewer frames is the one knob that
 * shrinks the file without touching the window's length or the picture, so
 * it is the one that turns on its own; a run still over at 2 fps is told to
 * shorten --seconds instead.
 */
export function fpsLadder(fps: number): number[] {
  return [fps, ...FPS_LADDER.filter((f) => f < fps)];
}

/**
 * The Flatpak fallback for a machine with no Chrome on its PATH: Google's
 * Chrome from Flathub, run with the repo granted to its sandbox so the
 * profile directory under build/ is writable. `dirs` are the paths it must
 * see. The DevTools port is reachable at 127.0.0.1 because the Flatpak shares
 * the host's network namespace.
 */
export function flatpakChrome(appId: string, dirs: string[]): string[] {
  return ["flatpak", "run", ...dirs.map((d) => `--filesystem=${d}`), appId];
}

export const FLATPAK_CHROME_IDS = [
  "com.google.Chrome",
  "org.chromium.Chromium",
  "com.google.ChromeDev",
];

/** A level's name as a directory name. */
export function slugOf(level: string): string {
  return level.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-|-$/g,
    "",
  ) || "level";
}
