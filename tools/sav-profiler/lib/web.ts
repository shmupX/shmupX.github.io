// The shmupX half of the profiler: the runtime in a real Chrome, fed the
// level directly.
//
// The runtime (static/games/2028-ai/game.bundle.js) fetches one fixed URL,
// /games/2028-ai/foo.json, before Phaser boots and plays whatever record it
// gets. A cloud level or an editor recipe takes the same shape, and so does
// what lib/shelf.ts builds from a .sav headlessly — so a small server here
// serves static/ as-is and answers that one URL with the cart's record. No
// editor, no localStorage/IndexedDB hand-off, no Firebase.
//
// Chrome is driven over the DevTools protocol: the title screen is watched
// until it takes input, the Start press is a synthetic Enter, the game scene
// is sampled for every enemy's position/scale/alpha, and the window of
// interest is captured with Page.startScreencast — timestamped frames of the
// live canvas, the same clock as the Saturn's Start press.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { serveDir } from "@std/http/file-server";

export class WebError extends Error {
  override name = "WebError";
}

export type Log = (line: string) => void;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The checkout's static/ directory: beside this module in a checkout, or
 * under the working directory when the code runs out of the built server
 * bundle (_fresh/server/assets), where import.meta.url no longer points
 * into the tree.
 */
export function staticDir(): string {
  const candidates = [
    new URL("../../../static/", import.meta.url).pathname,
    `${Deno.cwd()}/static/`,
  ];
  for (const c of candidates) {
    try {
      if (Deno.statSync(`${c}games/2028-ai/game.bundle.js`).isFile) return c;
    } catch { /* next */ }
  }
  return candidates[0];
}
const STATIC_DIR = staticDir();

// The host page, cut down from routes/games/2028-ai.tsx: the same canvas
// fit, the same font, the same helper scripts, none of the launcher bridges.
function shellHtml(): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>sav-profiler</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
@font-face { font-family: 'athenaFont'; src: url('/games/2028-ai/assets/fonts/athenaFont.ttf') format('truetype'); font-display: swap; }
html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
#phaser-canvas { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
#phaser-canvas canvas { image-rendering: pixelated; image-rendering: crisp-edges; }
</style>
<script type="importmap">{"imports":{"phaser":"/phaser-plugins/phaser-global.js"}}</script>
<script src="/gamepad-compatibility-plugin.js"></script>
<script src="/firebase-config.js"></script>
<script>
if (document.fonts && document.fonts.load) document.fonts.load("8px athenaFont").catch(function () {});
(function () {
  var GW = 256, GH = 480;
  function fit() {
    var pc = document.querySelector("#phaser-canvas canvas");
    if (!pc) return;
    var scale = Math.min(window.innerWidth / GW, window.innerHeight / GH);
    pc.style.width = Math.floor(GW * scale) + "px";
    pc.style.height = Math.floor(GH * scale) + "px";
    var g = window.__PHASER_4_GAME__;
    if (g && g.scale && typeof g.scale.refresh === "function") g.scale.refresh();
  }
  window.addEventListener("resize", fit);
  document.addEventListener("DOMContentLoaded", function () {
    var c = document.getElementById("phaser-canvas");
    new MutationObserver(function () { fit(); }).observe(c, { childList: true });
  });
})();
</script>
</head><body>
<div id="baseUrl" hidden>./</div>
<div id="phaser-canvas"></div>
<script src="/games/2028-ai/lib/phaser.min.js" defer></script>
<script src="/games/2028-ai/game.bundle.js" defer></script>
</body></html>`;
}

/** Serve static/ with the level record in place of foo.json. */
export function startServer(
  record: Record<string, unknown>,
  { port = 8823, log = () => {} }: { port?: number; log?: Log } = {},
): { url: string; close: () => Promise<void> } {
  const body = JSON.stringify(record);
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/games/2028-ai" || pathname === "/games/2028-ai/") {
        return new Response(shellHtml(), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      if (pathname === "/games/2028-ai/foo.json") {
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      }
      // The Chrome profile persists between runs; a cached bundle would make
      // an edit to the runtime look like it changed nothing.
      return serveDir(req, { fsRoot: STATIC_DIR, quiet: true }).then((res) => {
        const headers = new Headers(res.headers);
        headers.set("cache-control", "no-store");
        headers.delete("etag");
        headers.delete("last-modified");
        return new Response(res.body, { status: res.status, headers });
      });
    },
  );
  const url = `http://127.0.0.1:${port}`;
  log(`serving ${url} (record ${(body.length / 1024 / 1024).toFixed(1)} MB)`);
  return { url, close: () => server.shutdown() };
}

// ---- Chrome + DevTools -----------------------------------------------------

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export async function findChrome(flag: string | null = null): Promise<string> {
  const candidates = [flag, Deno.env.get("CHROME_BIN"), ...CHROME_CANDIDATES]
    .filter((p): p is string => !!p);
  for (const c of candidates) {
    try {
      if ((await Deno.stat(c)).isFile) return c;
    } catch { /* next */ }
  }
  throw new WebError(
    "no Chrome found — set CHROME_BIN to a Chrome/Chromium executable",
  );
}

type Handler = (params: Record<string, unknown>) => void;

/** A minimal DevTools client over one page target. */
export class Cdp {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #handlers = new Map<string, Handler[]>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.id !== undefined) {
        const p = this.#pending.get(m.id);
        if (!p) return;
        this.#pending.delete(m.id);
        if (m.error) {
          p.reject(new WebError(`${m.error.message} (${m.error.code})`));
        } else p.resolve(m.result);
      } else if (m.method) {
        for (const h of this.#handlers.get(m.method) ?? []) h(m.params ?? {});
      }
    };
  }

  static connect(wsUrl: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new WebError(`could not connect to ${wsUrl}`));
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = ++this.#id;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: Handler): void {
    const list = this.#handlers.get(method) ?? [];
    list.push(handler);
    this.#handlers.set(method, list);
  }

  off(method: string, handler: Handler): void {
    const list = (this.#handlers.get(method) ?? []).filter((h) =>
      h !== handler
    );
    this.#handlers.set(method, list);
  }

  /** Evaluate an expression in the page and return its value (awaited). */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<
      {
        result: { value?: T; description?: string; type: string };
        exceptionDetails?: {
          text: string;
          exception?: { description?: string };
        };
      }
    >(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    );
    if (r.exceptionDetails) {
      throw new WebError(
        `page threw: ${
          r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
        }`,
      );
    }
    return r.result.value as T;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch { /* closed */ }
  }
}

export class Browser {
  #child: Deno.ChildProcess;
  readonly cdp: Cdp;
  readonly port: number;

  private constructor(child: Deno.ChildProcess, cdp: Cdp, port: number) {
    this.#child = child;
    this.cdp = cdp;
    this.port = port;
  }

  /** Launch Chrome with a throw-away profile and connect to its first page. */
  static async launch(opts: {
    bin: string;
    userDataDir: string;
    url: string;
    port?: number;
    window?: { x: number; y: number; w: number; h: number };
    log?: Log;
  }): Promise<Browser> {
    const port = opts.port ?? 9333;
    const win = opts.window ?? { x: 940, y: 40, w: 300, h: 560 };
    await ensureDir(opts.userDataDir);
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${opts.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=TranslateUI",
      "--disable-infobars",
      // A first-run profile keeps Chrome busy (component updates, caches)
      // for the first minute — the length of a run — so the profile is kept
      // between runs, and its disk cache is turned off instead so an edited
      // runtime is never served stale.
      "--disk-cache-size=1",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-extensions",
      "--no-service-autorun",
      `--window-position=${win.x},${win.y}`,
      `--window-size=${win.w},${win.h}`,
      "--app=" + opts.url,
    ];
    opts.log?.(`chrome ${args.slice(-1)[0]}`);
    const child = new Deno.Command(opts.bin, {
      args,
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn();
    let wsUrl: string | null = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !wsUrl) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await res.json() as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        const page = targets.find((t) =>
          t.type === "page" && t.url.startsWith(opts.url.split("?")[0])
        );
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
    }
    if (!wsUrl) {
      try {
        child.kill("SIGKILL");
      } catch { /* gone */ }
      throw new WebError("Chrome did not expose its DevTools page in time");
    }
    const cdp = await Cdp.connect(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return new Browser(child, cdp, port);
  }

  async close(): Promise<void> {
    try {
      await this.cdp.send("Browser.close");
    } catch { /* already going */ }
    this.cdp.close();
    const t = Date.now();
    let done = false;
    this.#child.status.then(() => (done = true));
    while (!done && Date.now() - t < 3000) await sleep(100);
    if (!done) {
      try {
        this.#child.kill("SIGKILL");
      } catch { /* gone */ }
    }
  }
}

// ---- the game, through the page ------------------------------------------

/** Installed once the page is up: marks, enemy samples, a Start hook. */
const PROBE = `
(function () {
  if (window.__prof) return "already";
  var prof = window.__prof = { marks: {}, samples: [], gameStartedAt: null, scene: null };
  function game() { return window.__PHASER_4_GAME__ || window.__PHASER_GAME__ || null; }
  function now() { return performance.timeOrigin + performance.now(); }
  prof.now = now;
  prof.mark = function (k) { prof.marks[k] = now(); };
  prof.sampling = false;
  function enemies(scene) {
    var list = scene.enemies;
    if (!list) return [];
    if (typeof list.getChildren === "function") list = list.getChildren();
    if (!Array.isArray(list)) list = Array.from(list);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.active) continue;
      var sh = e.getData && e.getData("shadow");
      out.push({
        name: (e.getData && e.getData("name")) || e.name || e.frame && e.frame.name || "?",
        x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10,
        sx: Math.round(e.scaleX * 1000) / 1000, sy: Math.round(e.scaleY * 1000) / 1000,
        alpha: Math.round(e.alpha * 1000) / 1000,
        // The Saturn's drop-shadow pass as the runtime draws it: where the
        // shadow sprite sits relative to its owner, and how faint it is.
        shadow: sh && sh.active && sh.visible
          ? { dx: Math.round((sh.x - e.x) * 10) / 10, dy: Math.round((sh.y - e.y) * 10) / 10,
              sx: Math.round(sh.scaleX * 1000) / 1000, alpha: Math.round(sh.alpha * 1000) / 1000 }
          : null,
      });
    }
    return out;
  }
  setInterval(function () {
    var g = game(); if (!g) return;
    var scene = g.scene && g.scene.getScene && g.scene.getScene("PhaserGameScene");
    if (!scene || !g.scene.isActive("PhaserGameScene")) return;
    if (scene.gameStarted && prof.gameStartedAt === null) prof.gameStartedAt = now();
    if (!prof.sampling) return;
    prof.samples.push({ t: now(), worldTime: scene.worldTime || 0, scroll: scene.dezaBg ? scene.dezaBg.scrollPos : null, enemies: enemies(scene) });
  }, 50);
  return "installed";
})();
`;

export interface EnemySample {
  name: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
  alpha: number;
  /** The enemy's shadow sprite, when one is drawn: offset from the enemy,
   * its scale and alpha. */
  shadow: { dx: number; dy: number; sx: number; alpha: number } | null;
}

export interface Sample {
  t: number;
  worldTime: number;
  scroll: number | null;
  enemies: EnemySample[];
}

export class Runtime {
  constructor(readonly cdp: Cdp, readonly log: Log) {}

  /** Install the probe — for every document this page becomes (the bundle's
   * boot can still be reloading when Chrome first answers) and the current
   * one. */
  async install(): Promise<void> {
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: PROBE,
    });
    await this.cdp.eval(PROBE);
  }

  /** Wait for the title to accept a Start: the Dezaemon logo entrance must
   * have finished, since a press during it only snaps the logos. */
  async waitForTitle(timeoutMs = 60_000): Promise<string> {
    const t = Date.now();
    while (Date.now() - t < timeoutMs) {
      const state = await this.cdp.eval<string>(`(function () {
        var g = window.__PHASER_4_GAME__ || window.__PHASER_GAME__;
        if (!g || !g.scene) return "no-game";
        if (g.scene.isActive("PhaserGameScene")) return "game";
        if (!g.scene.isActive("PhaserTitleScene")) return "booting";
        var s = g.scene.getScene("PhaserTitleScene");
        if (s.dezaTitle) return s._dezaPhase === "idle" ? "ready" : "title-" + s._dezaPhase;
        return s.startText ? "ready" : "title";
      })()`);
      if (state === "ready") return state;
      if (state === "game") {
        throw new WebError(
          "the game scene started on its own (no title to arm on)",
        );
      }
      await sleep(200);
    }
    throw new WebError("the title screen never became ready");
  }

  /** The Start press: Enter, which the title reads with JustDown. */
  async pressStart(): Promise<number> {
    await this.cdp.eval(`window.__prof && window.__prof.mark("start")`);
    const t = Date.now();
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await sleep(60);
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    return t;
  }

  async setSampling(on: boolean): Promise<void> {
    const flag = on ? "true" : "false";
    const r = await this.cdp.eval<string>(
      `window.__prof ? (window.__prof.sampling = ${flag}, "ok") : "missing"`,
    );
    if (r === "missing") {
      await this.install();
      await this.cdp.eval(`window.__prof.sampling = ${flag}`);
    }
  }

  async samples(): Promise<
    {
      samples: Sample[];
      marks: Record<string, number>;
      gameStartedAt: number | null;
    }
  > {
    return await this.cdp.eval(
      `JSON.parse(JSON.stringify({ samples: window.__prof.samples, marks: window.__prof.marks, gameStartedAt: window.__prof.gameStartedAt }))`,
    );
  }

  /** Capture screencast frames while `active()` holds; frames land in `dir`
   * as PNGs with their wall-clock timestamps returned. */
  async screencast(
    dir: string,
    active: () => boolean,
    { width = 256, height = 480 }: { width?: number; height?: number } = {},
  ): Promise<{ file: string; t: number }[]> {
    await ensureDir(dir);
    const frames: { file: string; t: number }[] = [];
    let n = 0;
    const handler = (p: Record<string, unknown>) => {
      const sessionId = p.sessionId as number;
      const meta = p.metadata as { timestamp?: number };
      const data = p.data as string;
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      if (!active()) return;
      const t = (meta?.timestamp ?? Date.now() / 1000) * 1000;
      const file = join(dir, `w${String(n++).padStart(5, "0")}.png`);
      frames.push({ file, t });
      Deno.writeFile(file, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
        .catch(() => {});
    };
    this.cdp.on("Page.screencastFrame", handler);
    await this.cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 2, // 30 fps is plenty for a 10 fps cut, and half the encode load
    });
    while (active()) await sleep(50);
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    this.cdp.off("Page.screencastFrame", handler);
    await sleep(200);
    return frames;
  }
}

/** Size the page to the game's own pixels so captured frames are 1:1. */
export async function fitViewport(
  cdp: Cdp,
  width = 256,
  height = 480,
): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}
