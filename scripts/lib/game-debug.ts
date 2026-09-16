/**
 * Pausing, stepping and driving the 2028-ai runtime over the DevTools protocol.
 *
 * The shared half of `deno task game:debug` and the `shmupx_debug_*` MCP tools.
 * Both are DevTools clients against the same browser, so the debug state lives
 * in the PAGE rather than in either process: the task opens the browser, walks
 * it to the first frame of the stage and pauses it, and anything that can reach
 * the DevTools port afterwards — the task's own prompt, an MCP tool, a person
 * with curl — drives it from there. Nothing has to hand a session object over.
 *
 * ── Why the animation-frame queue, and not Phaser's own loop ──────────────
 *
 * `game.loop.sleep()` stops the clock but gives no way to advance it by exactly
 * one tick, and Phaser 4's TimeStep internals are not a contract worth building
 * on. So the probe installs BEFORE the bundle boots and takes over
 * requestAnimationFrame outright: every callback the page registers lands in a
 * queue this module owns, and a "frame" is the batch of callbacks standing in
 * that queue at the moment it is drained. Phaser registers one callback per
 * tick, so one drain is one tick, exactly.
 *
 * The clock handed to those callbacks is synthetic and advances by a fixed
 * 1/60s per frame. That is the part that makes stepping usable: a wall-clock
 * timestamp after a pause of any length arrives as one enormous delta, and
 * Phaser answers it by lurching the whole world forward. Measured on the real
 * bundle, this keeps `game.loop.time` moving 17ms per step with no jump across
 * a pause of any duration.
 *
 * ── The pad ──────────────────────────────────────────────────────────────
 *
 * The game reads `navigator.getGamepads()`, and static/gamepad-support.js
 * latches onto a pad when it hears `gamepadconnected`, so the probe answers
 * that call with one synthetic pad and fires the event once installed. Its id
 * deliberately does not end in "[R]": the bundle's cmgSplitTwoPlayer() reads
 * that suffix as the right half of a split controller and starts two-player.
 */

import { join } from "@std/path";
import {
  Cdp,
  findChrome,
  startServer,
} from "../../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";

export const DEFAULT_CDP_PORT = 9223;
export const DEFAULT_SERVE_PORT = 8824;

/** The game's own pixels, so a capture is 1:1 and not a scaled guess. */
export const GAME_WIDTH = 256;
export const GAME_HEIGHT = 480;

/** Bumped when PROBE changes, so a client can refuse a stale page. */
export const PROBE_VERSION = 1;

/**
 * Standard-mapping button indices, under the names a shmup player would use.
 * `navigator.getGamepads()` reports the W3C standard layout, and
 * static/gamepad-support.js indexes straight into `buttons[]`.
 */
export const PAD_BUTTONS: Record<string, number> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  l: 4,
  r: 5,
  lt: 6,
  rt: 7,
  select: 8,
  start: 9,
  ls: 10,
  rs: 11,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};

export function padButtonIndex(name: string): number {
  const i = PAD_BUTTONS[name.toLowerCase()];
  if (i === undefined) {
    throw new Error(
      `unknown pad button "${name}". Known: ${
        Object.keys(PAD_BUTTONS).join(", ")
      }`,
    );
  }
  return i;
}

/** Keys the runtime actually reads, for --keys and the key tool. */
export const KEY_SPECS: Record<
  string,
  { key: string; code: string; vk: number }
> = {
  enter: { key: "Enter", code: "Enter", vk: 13 },
  space: { key: " ", code: "Space", vk: 32 },
  shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  z: { key: "z", code: "KeyZ", vk: 90 },
  s: { key: "s", code: "KeyS", vk: 83 },
  w: { key: "w", code: "KeyW", vk: 87 },
};

export function keySpec(name: string) {
  const s = KEY_SPECS[name.toLowerCase()];
  if (!s) {
    throw new Error(
      `unknown key "${name}". Known: ${Object.keys(KEY_SPECS).join(", ")}`,
    );
  }
  return s;
}

/**
 * Installed with Page.addScriptToEvaluateOnNewDocument, so it runs before the
 * bundle and owns the animation-frame queue the bundle then registers against.
 */
export const PROBE = `
(function () {
  if (window.__dbg && window.__dbg.version === ${PROBE_VERSION}) return "already";
  var raf = window.requestAnimationFrame.bind(window);
  var dbg = window.__dbg = {
    version: ${PROBE_VERSION},
    paused: false,
    frame: 0,
    queue: [],
    dt: 1000 / 60,
    t: performance.now(),
    lastError: null,
  };

  // --- the frame queue -----------------------------------------------------
  var nextId = 1;
  window.requestAnimationFrame = function (cb) {
    var id = nextId++;
    dbg.queue.push({ id: id, cb: cb });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    dbg.queue = dbg.queue.filter(function (e) { return e.id !== id; });
  };
  dbg.stepOnce = function () {
    dbg.t += dbg.dt;
    var batch = dbg.queue;
    dbg.queue = [];
    for (var i = 0; i < batch.length; i++) {
      try { batch[i].cb(dbg.t); } catch (e) { dbg.lastError = String(e); }
    }
    return ++dbg.frame;
  };
  dbg.step = function (n) {
    for (var i = 0; i < (n || 1); i++) dbg.stepOnce();
    return dbg.frame;
  };
  // The real animation frame is only a pump now: while running it drains one
  // batch per tick, which is what the page would have done unaided.
  (function pump() {
    if (!dbg.paused) dbg.stepOnce();
    raf(pump);
  })();

  // --- the synthetic pad ---------------------------------------------------
  function blankButtons() {
    var b = [];
    for (var i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
    return b;
  }
  dbg.pad = {
    id: "shmupX debug pad (Vendor: 0000 Product: 0000)",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: blankButtons(),
  };
  dbg.setButtons = function (indices, down) {
    for (var i = 0; i < indices.length; i++) {
      var b = dbg.pad.buttons[indices[i]];
      if (!b) continue;
      b.pressed = !!down;
      b.touched = !!down;
      b.value = down ? 1 : 0;
    }
    dbg.pad.timestamp = dbg.t;
    return dbg.pressed();
  };
  dbg.clearPad = function () {
    dbg.pad.buttons = blankButtons();
    dbg.pad.axes = [0, 0, 0, 0];
    return dbg.pressed();
  };
  dbg.setAxes = function (axes) {
    for (var i = 0; i < axes.length && i < 4; i++) dbg.pad.axes[i] = axes[i];
    dbg.pad.timestamp = dbg.t;
    return dbg.pad.axes.slice();
  };
  dbg.pressed = function () {
    var out = [];
    for (var i = 0; i < dbg.pad.buttons.length; i++) {
      if (dbg.pad.buttons[i].pressed) out.push(i);
    }
    return out;
  };
  var realGetGamepads = navigator.getGamepads
    ? navigator.getGamepads.bind(navigator)
    : function () { return []; };
  dbg.realGamepads = function () { return realGetGamepads(); };
  navigator.getGamepads = function () { return [dbg.pad]; };
  try {
    var ev;
    try {
      ev = new GamepadEvent("gamepadconnected", { gamepad: dbg.pad });
    } catch (e) {
      ev = new Event("gamepadconnected");
      ev.gamepad = dbg.pad;
    }
    window.dispatchEvent(ev);
  } catch (e) { dbg.lastError = String(e); }

  // --- looking at the game -------------------------------------------------
  dbg.game = function () {
    return window.__PHASER_4_GAME__ || window.__PHASER_GAME__ || null;
  };
  dbg.scenes = function () {
    var g = dbg.game();
    if (!g || !g.scene) return [];
    return g.scene.scenes
      .filter(function (s) { return s.sys.settings.active; })
      .map(function (s) { return s.sys.settings.key; });
  };
  dbg.status = function () {
    var g = dbg.game();
    return {
      probe: dbg.version,
      frame: dbg.frame,
      paused: !!dbg.paused,
      scenes: dbg.scenes(),
      loopTime: g && g.loop ? Math.round(g.loop.time) : null,
      queued: dbg.queue.length,
      pad: dbg.pressed(),
      axes: dbg.pad.axes.slice(),
      lastError: dbg.lastError,
    };
  };
  // A count per frame name is the cheap way to see what is on screen without
  // shipping the whole display list over the wire.
  dbg.inspect = function () {
    var g = dbg.game();
    if (!g) return { error: "no game" };
    var counts = {}, total = 0, player = null;
    var scenes = g.scene.scenes.filter(function (s) { return s.sys.settings.active; });
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i];
      if (s.player) {
        player = { x: Math.round(s.player.x), y: Math.round(s.player.y), alive: !!s.player.active };
      }
      if (!s.children) continue;
      (function walk(list) {
        for (var j = 0; j < (list || []).length; j++) {
          var c = list[j];
          total++;
          var f = c.frame && c.frame.name;
          if (typeof f === "string" && c.visible) counts[f] = (counts[f] || 0) + 1;
          if (c.list) walk(c.list);
        }
      })(s.children.list);
    }
    return {
      scenes: dbg.scenes(),
      frame: dbg.frame,
      displayObjects: total,
      player: player,
      visibleFrames: counts,
    };
  };
  return "installed";
})()
`;

export interface DebugStatus {
  probe: number;
  frame: number;
  paused: boolean;
  scenes: string[];
  loopTime: number | null;
  queued: number;
  pad: number[];
  axes: number[];
  lastError: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find the debug browser's page target and connect to it. */
export async function attachCdp(
  port = DEFAULT_CDP_PORT,
  timeoutMs = 20_000,
): Promise<Cdp> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json() as {
        type: string;
        webSocketDebuggerUrl?: string;
      }[];
      const page = targets.find((t) =>
        t.type === "page" && t.webSocketDebuggerUrl
      );
      if (page?.webSocketDebuggerUrl) {
        const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        return cdp;
      }
      lastErr = "no page target";
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(
    `no debug browser on DevTools port ${port} (${lastErr}). ` +
      `Start one with: deno task game:debug`,
  );
}

/** Install the probe for every document this page becomes, and for this one. */
export async function installProbe(cdp: Cdp): Promise<void> {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  await cdp.eval(PROBE);
}

/**
 * Walk the runtime from wherever it is to the first frame of the stage.
 *
 * There is no way to skip any of it: the runtime reads only `bossRush` and
 * `stage` from the URL, the title waits on a press, and the story boxes are a
 * typewriter, so a press completes the line it is on rather than skipping
 * ahead. Enter and Space are both sent because the title and the story boxes
 * do not read the same one.
 */
export async function driveToGame(
  cdp: Cdp,
  { timeoutMs = 420_000, log = (_: string) => {} }: {
    timeoutMs?: number;
    log?: (s: string) => void;
  } = {},
): Promise<DebugStatus> {
  const deadline = Date.now() + timeoutMs;
  let announced = "";
  while (Date.now() < deadline) {
    const st = await cdp.eval<DebugStatus>(`window.__dbg.status()`);
    const where = st.scenes.join(",");
    if (where && where !== announced) {
      log(`  scene: ${where}`);
      announced = where;
    }
    // The stage is reached when the game scene is up and the story scene is
    // not: PhaserGameScene is also active underneath the story.
    if (
      st.scenes.includes("PhaserGameScene") &&
      !st.scenes.includes("PhaserAdvScene") &&
      !st.scenes.includes("PhaserTitleScene")
    ) {
      return st;
    }
    for (const name of ["enter", "space"]) {
      const k = keySpec(name);
      for (const type of ["keyDown", "keyUp"]) {
        await cdp.send("Input.dispatchKeyEvent", {
          type,
          key: k.key,
          code: k.code,
          windowsVirtualKeyCode: k.vk,
          nativeVirtualKeyCode: k.vk,
        });
      }
    }
    await sleep(450);
  }
  throw new Error(
    `the runtime never reached PhaserGameScene within ${
      Math.round(timeoutMs / 1000)
    }s`,
  );
}

/** A live handle on the paused game. Cheap to make; make one per operation. */
export class GameDebug {
  private constructor(readonly cdp: Cdp) {}

  static async attach(port = DEFAULT_CDP_PORT): Promise<GameDebug> {
    const cdp = await attachCdp(port);
    const probe = await cdp.eval<number | null>(
      `window.__dbg ? window.__dbg.version : null`,
    );
    if (probe === null) {
      cdp.close();
      throw new Error(
        "the page on that port has no debug probe — it was not started by " +
          "`deno task game:debug`",
      );
    }
    if (probe !== PROBE_VERSION) {
      cdp.close();
      throw new Error(
        `that page carries probe v${probe} but this build expects ` +
          `v${PROBE_VERSION}; restart \`deno task game:debug\``,
      );
    }
    return new GameDebug(cdp);
  }

  status(): Promise<DebugStatus> {
    return this.cdp.eval<DebugStatus>(`window.__dbg.status()`);
  }

  inspect(): Promise<Record<string, unknown>> {
    return this.cdp.eval(
      `JSON.parse(JSON.stringify(window.__dbg.inspect()))`,
    );
  }

  async pause(): Promise<DebugStatus> {
    await this.cdp.eval(`window.__dbg.paused = true`);
    return this.status();
  }

  async resume(): Promise<DebugStatus> {
    await this.cdp.eval(`window.__dbg.paused = false`);
    return this.status();
  }

  /** Advance exactly `frames` ticks. Pauses first: stepping a running game is
   * meaningless, and silently doing nothing would be worse. */
  async step(frames = 1): Promise<DebugStatus> {
    if (!Number.isInteger(frames) || frames < 1 || frames > 3600) {
      throw new Error(`step wants 1..3600 frames, got ${frames}`);
    }
    await this.cdp.eval(`window.__dbg.paused = true`);
    await this.cdp.eval(`window.__dbg.step(${frames})`);
    return this.status();
  }

  async evaluate<T>(expression: string): Promise<T> {
    return await this.cdp.eval<T>(expression);
  }

  /**
   * Hold pad buttons across `frames` ticks, then release.
   *
   * While paused this is exact: the buttons go down, the game is stepped that
   * many frames with them down, and they come up. A single frame is usually
   * too short for the runtime's JustDown edge detection to be seen by
   * everything that looks for it, which is why frames defaults to 2.
   */
  async press(buttons: string[], frames = 2): Promise<DebugStatus> {
    const idx = buttons.map(padButtonIndex);
    if (!idx.length) throw new Error("press wants at least one button");
    await this.cdp.eval(
      `window.__dbg.setButtons(${JSON.stringify(idx)}, true)`,
    );
    const st = await this.step(frames);
    await this.cdp.eval(`window.__dbg.clearPad()`);
    return st;
  }

  /** Point the left stick, in the -1..1 the game deadzones. */
  async axes(values: number[], frames = 2): Promise<DebugStatus> {
    const clamped = values.slice(0, 4).map((v) => Math.max(-1, Math.min(1, v)));
    await this.cdp.eval(`window.__dbg.setAxes(${JSON.stringify(clamped)})`);
    const st = await this.step(frames);
    await this.cdp.eval(`window.__dbg.clearPad()`);
    return st;
  }

  /** Send real key events, for the title and story boxes the pad cannot pass. */
  async keys(names: string[], frames = 2): Promise<DebugStatus> {
    const specs = names.map(keySpec);
    for (const k of specs) {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
      });
    }
    const st = await this.step(frames);
    for (const k of specs) {
      await this.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: k.key,
        code: k.code,
        windowsVirtualKeyCode: k.vk,
        nativeVirtualKeyCode: k.vk,
      });
    }
    return st;
  }

  async screenshot(
    path: string,
  ): Promise<{ path: string; bytes: number; frame: number }> {
    const st = await this.status();
    const r = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    await Deno.mkdir(join(path, ".."), { recursive: true }).catch(() => {});
    await Deno.writeFile(path, bytes);
    return { path, bytes: bytes.length, frame: st.frame };
  }

  close(): void {
    this.cdp.close();
  }
}

/** Serve the level and open a debug browser on it, probe installed pre-boot. */
export async function launchDebugBrowser(opts: {
  record: Record<string, unknown>;
  servePort?: number;
  cdpPort?: number;
  headless?: boolean;
  bossRush?: boolean;
  stage?: number;
  chromeBin?: string | null;
  log?: (s: string) => void;
}): Promise<{
  cdp: Cdp;
  url: string;
  cdpPort: number;
  stopServer: () => Promise<void>;
  kill: () => void;
}> {
  const log = opts.log ?? (() => {});
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;
  const cdpPort = opts.cdpPort ?? DEFAULT_CDP_PORT;
  const server = startServer(opts.record, { port: servePort });
  const params = new URLSearchParams();
  if (opts.stage) params.set("stage", String(opts.stage));
  if (opts.bossRush ?? true) params.set("bossRush", "1");
  const q = params.toString();
  const url = `http://127.0.0.1:${servePort}/games/2028-ai${q ? `?${q}` : ""}`;

  const bin = await findChrome(opts.chromeBin ?? null);
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--window-size=${GAME_WIDTH},${GAME_HEIGHT}`,
    // Without these a backgrounded or occluded window is throttled to a crawl,
    // which for a stepped game reads as the step having hung.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI",
  ];
  if (opts.headless ?? true) {
    args.push(
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    );
  }
  args.push(url);
  log(`chrome ${opts.headless ?? true ? "(headless) " : ""}-> ${url}`);
  const child = new Deno.Command(bin, {
    args,
    stdout: "null",
    stderr: "null",
    stdin: "null",
  }).spawn();

  const cdp = await attachCdp(cdpPort, 40_000);
  // Install, then reload: the document Chrome first answers with has already
  // run its scripts, so only a fresh one is owned from before the bundle boots.
  await installProbe(cdp);
  await cdp.send("Page.reload", { ignoreCache: true });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const v = await cdp.eval<number | null>(
      `window.__dbg ? window.__dbg.version : null`,
    ).catch(() => null);
    if (v === PROBE_VERSION) break;
    await sleep(250);
  }
  return {
    cdp,
    url,
    cdpPort,
    stopServer: () => server.close(),
    kill: () => {
      try {
        child.kill("SIGKILL");
      } catch { /* gone */ }
    },
  };
}
