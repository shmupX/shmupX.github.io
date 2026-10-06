// The offline half of scripts/testdrive-ps2-compare.ts: the two URLs a
// comparison plays, the page that seats them side by side, the in-page
// autopilot, and the arithmetic that turns a screencast's irregular frames
// into a constant-rate GIF. Nothing here opens a browser or a socket, which is
// what lets tests/testdrive_compare_test.ts pin all of it.
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

/**
 * The two URLs: the same cloud level, the same stage, the ship invincible on
 * both, and only `version` differing. `version=og` is written out even though
 * the runtime reads a missing parameter the same way, so a report or a
 * screenshot's address bar says which pane it is.
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

/** The viewport the harness needs, at game pixels. */
export function harnessSize(): { width: number; height: number } {
  return {
    width: GAME_WIDTH * 2 + GUTTER * 3,
    height: GAME_HEIGHT + CAPTION_HEIGHT + GUTTER * 2,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * The page the browser is handed: two captioned iframes, each exactly the
 * game's 256×480, on black. The route's own fit script scales the canvas to
 * its window, so a frame that size shows the game 1:1.
 */
export function harnessHtml(urls: Record<Side, string>, level: string): string {
  const pane = (side: Side, label: string) =>
    `<figure class="pane" id="pane-${side}">` +
    `<figcaption>${label}</figcaption>` +
    `<iframe id="${side}" src="${
      esc(urls[side])
    }" width="${GAME_WIDTH}" height="${GAME_HEIGHT}" allow="autoplay"></iframe>` +
    `</figure>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(level)} — OG vs MOD</title>
<style>
html, body { margin: 0; background: #000; color: #fff; }
body { font: bold 13px/${CAPTION_HEIGHT}px ui-monospace, Menlo, monospace; }
.row { display: flex; gap: ${GUTTER}px; padding: ${GUTTER}px; }
.pane { margin: 0; }
figcaption { height: ${CAPTION_HEIGHT}px; letter-spacing: 0.08em; text-transform: uppercase; }
iframe { display: block; border: 0; background: #000; }
</style></head>
<body><div class="row">${pane("og", "OG")}${
    pane("mod", "MOD")
  }</div></body></html>`;
}

/**
 * What one pane is doing, read through its own Phaser instance. Evaluated in
 * the harness page; `side` is the iframe's id.
 */
export function paneStateExpr(side: Side): string {
  return `(function () {
    var f = document.getElementById(${JSON.stringify(side)});
    var w = f && f.contentWindow;
    var out = { side: ${
    JSON.stringify(side)
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
  side: Side;
  href: string | null;
  game: boolean;
  scenes: string[];
  started: boolean;
  god: boolean | null;
  version: string | null;
  frozen: boolean;
}

/** Put one pane's game to sleep (`on`) or wake it; returns whether it took. */
export function freezeExpr(side: Side, on: boolean): string {
  return `(function () {
    var w = document.getElementById(${JSON.stringify(side)}).contentWindow;
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
 * playfield on a slow cycle, the same keys at the same moments into both
 * iframes, so whatever differs between the panes is the version and not the
 * flying. Keys arrive as synthetic KeyboardEvents on each frame's window,
 * which is where Phaser listens; a DevTools key press would reach only the
 * focused frame.
 */
export const AUTOPILOT = `(function () {
  if (window.__autopilot) return "already";
  var LEFT = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 };
  var RIGHT = { key: "ArrowRight", code: "ArrowRight", keyCode: 39 };
  var held = null;
  function frames() {
    return ["og", "mod"].map(function (id) { var f = document.getElementById(id); return f && f.contentWindow; }).filter(Boolean);
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
  const lines = files.map((f) =>
    `file '${f.replace(/'/g, "'\\''")}'\nduration ${dur}`
  );
  // concat holds the last entry's duration only when the file is named once
  // more after it.
  if (files.length) {
    lines.push(`file '${files[files.length - 1].replace(/'/g, "'\\''")}'`);
  }
  return lines.join("\n") + "\n";
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
