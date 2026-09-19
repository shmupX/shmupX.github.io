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

import { join, resolve } from "@std/path";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  Cdp,
  findChrome,
  fitViewport,
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

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The pixel size a PNG declares, or 0x0 if it is not a PNG at all.
 *
 * A PNG's first chunk is always IHDR, whose two big-endian u32s sit at a fixed
 * offset, so this is a read of twelve bytes rather than a decode. It exists so
 * a capture can report its own dimensions instead of trusting the window to be
 * the size it was asked for, which it is not (see launchDebugBrowser).
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const header = PNG_SIGNATURE.every((b, i) => bytes[i] === b) &&
    String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR";
  if (!header || bytes.length < 24) return { width: 0, height: 0 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * Find the debug browser's page target and connect to it.
 *
 * WHY THE CLOSING ADVICE BELONGS TO THE CALLER. There are two ways to be in
 * this function and they want opposite sentences at the end of the failure. An
 * MCP tool, or a second prompt, is ATTACHING to a browser somebody else was
 * supposed to have started, and "start one with `deno task game:debug`" is the
 * entire fix. launchDebugBrowser is the thing that just started one, and
 * handing it that same line tells a person to run the command that is failing
 * in front of them — which is what it did, on the one path where the advice was
 * worse than silence. It is a function rather than a string because the
 * launcher's version of the sentence quotes what Chrome wrote to stderr WHILE
 * this loop was polling, and none of that has been written at the moment of the
 * call.
 *
 * The signal is for a caller racing this against something that already knows
 * the answer — launchDebugBrowser races it against the browser's own exit — so
 * the loop gives up within one poll instead of spending the rest of a
 * forty-second deadline fetching a port nothing will ever answer on.
 */
export async function attachCdp(
  port = DEFAULT_CDP_PORT,
  timeoutMs = 20_000,
  opts: {
    advice?: (lastErr: string) => string;
    signal?: AbortSignal;
  } = {},
): Promise<Cdp> {
  const advice = opts.advice ?? (() => "Start one with: deno task game:debug");
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline && !opts.signal?.aborted) {
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
  const tail = advice(lastErr);
  throw new Error(
    `no debug browser on DevTools port ${port}${
      lastErr ? ` (${lastErr})` : ""
    }.${tail ? ` ${tail}` : ""}`,
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

  /**
   * Write the current frame to a PNG, and say how big it came out.
   *
   * WHY THE VIEWPORT IS RE-FITTED ON EVERY CAPTURE. Chrome's emulation
   * overrides are per DEVTOOLS SESSION, not per page. launchDebugBrowser fits
   * the viewport on its own connection, which is enough for the game to boot
   * at 256x480 — but this GameDebug is a different connection (and each MCP
   * tool call is a third, a fourth...), and a capture taken on a session with
   * no override of its own composites the page against the real OS window
   * instead. Measured: the launching session captured 256x480 while a second
   * session on the same paused page captured 500x340 of letterboxed, scaled
   * game, and one fitViewport call with no delay at all made that second
   * session's PNG byte-for-byte identical to the first's. Re-fitting is
   * therefore not belt-and-braces, it is the only thing that makes a capture
   * 1:1 from whoever happens to be holding the wire.
   *
   * The size is reported for the same reason: a PNG that is not
   * GAME_WIDTH x GAME_HEIGHT is a scaled render of the game rather than the
   * game's pixels, and nothing in the file itself says so.
   */
  async screenshot(
    path: string,
  ): Promise<
    {
      path: string;
      bytes: number;
      frame: number;
      width: number;
      height: number;
    }
  > {
    const st = await this.status();
    await fitViewport(this.cdp, GAME_WIDTH, GAME_HEIGHT);
    const r = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    await Deno.mkdir(join(path, ".."), { recursive: true }).catch(() => {});
    await Deno.writeFile(path, bytes);
    const { width, height } = pngSize(bytes);
    return { path, bytes: bytes.length, frame: st.frame, width, height };
  }

  close(): void {
    this.cdp.close();
  }
}

/**
 * A text sink that keeps the first and last `half` characters it is given.
 *
 * WHY BOTH ENDS AND NOT A PLAIN TAIL. The two questions a captured browser log
 * gets asked live at opposite ends of it. "Why would this launch not start" is
 * the first two seconds, where Chrome refuses the debugging port, or the
 * profile, or the socket, before it has drawn anything at all. "Why did the
 * page stop after an hour of stepping" is the last few lines. A tail ring
 * answers the second question and silently discards the first — which is the
 * one this module exists to surface — so both ends are kept and the middle,
 * which is component-update chatter, is the part that goes.
 */
export function makeCapture(half = 16_000): {
  push(text: string): void;
  text(): string;
} {
  let head = "";
  let tail = "";
  let elided = 0;
  return {
    push(text: string) {
      if (head.length < half) {
        const room = half - head.length;
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (!text) return;
      tail += text;
      if (tail.length > half) {
        elided += tail.length - half;
        tail = tail.slice(-half);
      }
    },
    text(): string {
      if (!elided) return (head + tail).trim();
      return `${head.trim()}\n... [${elided} characters elided] ...\n${tail.trim()}`;
    },
  };
}

/**
 * Drain a child's stderr into a capture, and hand back a reader for it.
 *
 * The draining is the obligation, not the reading: a "piped" stream nobody
 * consumes fills at about 64KB and the child blocks forever on its next write,
 * so this has to run for the whole session rather than being started once
 * something has gone wrong. Chrome is chatty on a healthy run too — a clean
 * launch produces a "DevTools listening" line, an allocator warning and a GCM
 * registration ERROR within five seconds — which is why the output is captured
 * rather than inherited: two lines of irrelevant noise, one of them tagged
 * ERROR, above every handover banner would teach people to ignore the place
 * the real explanation appears.
 */
function drainStderr(
  child: Deno.ChildProcess,
): { text: () => string; stop: () => void } {
  const capture = makeCapture();
  const decoder = new TextDecoder();
  // A reader is held rather than `for await (const c of child.stderr)`,
  // because the loop has to be stoppable from outside and `for await` owns the
  // lock, so cancel() on the stream itself throws. WHY IT HAS TO BE
  // STOPPABLE: SIGKILL on the browser does not close this pipe if anything the
  // browser started still holds the write end, and Chrome starts renderers.
  // The read then never completes, and a pending read op keeps the event loop
  // alive — invisible to `deno task game:debug`, which ends in Deno.exit(),
  // and a process that never returns for anything that calls this as a
  // library. Measured on a stand-in child that leaves one `sleep` behind: the
  // launch failed and reported correctly, and the process then sat there for
  // the remaining five minutes.
  const reader = child.stderr.getReader();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) return;
      capture.push(decoder.decode(value, { stream: true }));
    }
  })().catch(() => {
    // SIGKILL closes the pipe out from under the read, and Deno surfaces that
    // here as a BadResource. It is never the failure worth reporting —
    // whatever did the killing is already throwing — and an uncaught rejection
    // during teardown would take the process down before it printed that.
  });
  return {
    text: () => capture.text(),
    stop: () => void reader.cancel().catch(() => {}),
  };
}

/**
 * What Chrome's refusal to open a DevTools port means, and what to do about it.
 *
 * Pure, and returning lines rather than one sentence, for the reasons
 * explainTunnelError in lib/tailscale.ts is: the matching is against text a
 * browser prints and rewords between versions, so it has to live somewhere a
 * test can feed it a real capture and read the answer back. The strings matched
 * here were taken out of the installed binary's string table rather than
 * remembered.
 *
 * The rule with no exceptions: nothing this returns may tell the reader to run
 * `deno task game:debug`. Every caller of this function IS that command,
 * mid-failure, and that was the old advice's whole problem.
 * tests/game_debug_test.ts asserts it across every fixture.
 */
export function explainChromeLaunch(opts: {
  cdpPort: number;
  profileDir: string;
  /** Everything Chrome wrote to stderr while we waited. */
  said: string;
  /** The child's exit code, or null while it is still running. */
  exitCode: number | null;
  /** What attachCdp's last poll gave up with. */
  lastErr: string;
  /** Where the full capture was written, if it was worth writing. */
  logPath?: string;
}): string[] {
  const said = opts.said ?? "";
  const lines: string[] = [];

  if (/non-default data directory/i.test(said)) {
    lines.push(
      "Chrome refused the debugging port because of the profile it was given " +
        `(${opts.profileDir}): since Chrome 136 --remote-debugging-port is ` +
        "only honoured on a profile that is not the user's default one. Point " +
        "--profile at a directory of its own.",
    );
  } else if (/disallowed by the system admin/i.test(said)) {
    lines.push(
      "Remote debugging is switched off by enterprise policy " +
        "(DevToolsRemoteDebuggingAllowed). No flag works around that one — not " +
        "a different profile, not a different port. A Chromium the policy does " +
        "not cover, passed with --chrome, is the only way through.",
    );
  } else if (
    /address already in use|cannot start http server for devtools/i.test(said)
  ) {
    lines.push(
      `Something already holds DevTools port ${opts.cdpPort}: ` +
        `\`lsof -iTCP:${opts.cdpPort} -sTCP:LISTEN\` names it, and --cdp-port ` +
        "moves out of its way.",
    );
  }
  // Tested on its own rather than as another branch of the chain above: it
  // ACCOMPANIES the bind failure rather than replacing it, and it is the half
  // of that pair a reader mistakes for success.
  if (/DevTools listening on ws:\/\/\[::1\]/.test(said)) {
    lines.push(
      'Chrome did print a "DevTools listening" line, but on [::1] — it fell ' +
        "back to IPv6 after failing to bind IPv4. Everything here talks to " +
        "127.0.0.1, so that line is not the success it looks like.",
    );
  }

  if (!lines.length && opts.exitCode !== null) {
    lines.push(
      `Chrome exited with code ${opts.exitCode} instead of staying up. A ` +
        `browser already holding ${opts.profileDir} takes the URL off a second ` +
        "one and lets it quit, which looks exactly like this from out here: " +
        "one session per profile, and so one session per --cdp-port.",
    );
  }
  if (
    !lines.length &&
    (/no page target/i.test(opts.lastErr) ||
      new RegExp(`DevTools listening on ws://127\\.0\\.0\\.1:${opts.cdpPort}`)
        .test(said))
  ) {
    lines.push(
      "The port opened — Chrome says so — but no page target ever appeared on " +
        "it. That is a page that never loaded, not a port that never listened.",
    );
  }
  if (!lines.length) {
    lines.push(
      "Chrome is running and was given " +
        `--remote-debugging-port=${opts.cdpPort}, but nothing ever answered on ` +
        `it. Profile: ${opts.profileDir}.`,
    );
  }

  // Every branch ends pointing at the browser's own words, because every
  // branch above is an inference from them and the next unrecognised refusal
  // will only be legible in the raw text.
  if (said) {
    const last = said.trim().split("\n").slice(-3).join(" / ");
    lines.push(
      `Chrome wrote: ${last}` +
        (opts.logPath ? ` (all of it: ${opts.logPath})` : ""),
    );
  } else {
    lines.push("Chrome wrote nothing to stderr at all.");
  }
  return lines;
}

/**
 * The Chrome profile a debug browser runs on — one directory per DevTools
 * port, under the gitignored build/.
 *
 * WHY THIS IS NOT THE EVERYDAY PROFILE, AND WHY --headed DID NOT WORK WITHOUT
 * IT. Chrome 136 stopped honouring --remote-debugging-port when the
 * user-data-dir is the DEFAULT profile. It is a real fix for a real attack —
 * malware was starting the installed browser with a debugging port and reading
 * live cookies and sessions straight out of the profile — but the refusal is
 * silent in the worst available way: Chrome still starts, still opens the URL,
 * still puts a window on screen with the game running in it, and simply never
 * listens on the port. The only symptom is attachCdp polling for forty seconds
 * and then reporting a fetch failure against a browser the person can see.
 * Headless is exempt from the rule, and headless is this task's default, which
 * is precisely why this survived: the single flag that took the other branch
 * was the one flag that could not work.
 *
 * WHY PER PORT, AND NOT ONE SHARED DIRECTORY. --cdp-port and --serve-port exist
 * so two debug sessions can run side by side, and a Chromium profile takes a
 * singleton lock. A second Chrome pointed at a directory the first one holds
 * does not start a browser at all: it hands its URL to the running instance and
 * exits, so the tab opens in somebody else's window and the port being waited
 * on belongs to somebody else's game. That would trade this silent failure for
 * a stranger one. Keying on the port also means a given port keeps its
 * localStorage and IndexedDB between runs, so whatever the runtime saved last
 * session is still there this session.
 *
 * Nothing stale can come out of that persistence: startServer already answers
 * every request no-store and strips etag and last-modified, for exactly this
 * reason, and --disk-cache-size=1 below covers the rest.
 *
 * The root is a parameter so a test can ask the question without touching
 * repoRoot(), which caches its answer for the whole process and reads
 * $SHMUPX_ROOT on the way.
 */
export function debugProfileDir(
  cdpPort = DEFAULT_CDP_PORT,
  root = repoRoot(),
): string {
  return join(root, "build", "debug-profile", String(cdpPort));
}

/**
 * The command line the debug browser is started with.
 *
 * Split out from the spawn so it can be asserted without a browser. The
 * argument that earns that is --user-data-dir: invisible when it is right,
 * forty seconds and a wrong diagnosis when it is missing, and missing only in
 * the mode that is not the default. tests/game_debug_test.ts pins it.
 */
export function debugChromeArgs(opts: {
  url: string;
  cdpPort: number;
  profileDir: string;
  headless: boolean;
}): string[] {
  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    // Not hygiene, and not optional — see debugProfileDir. Without this line a
    // headed Chrome ignores the line above it and listens on nothing.
    `--user-data-dir=${opts.profileDir}`,
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
    // The same set the profiler's Browser.launch carries, and for the same
    // reason now that this profile persists too: a first-run profile spends
    // its opening minute on component updates and background networking, and
    // the opening minute here is the typewriter story that driveToGame has to
    // tap through. The disk cache is turned off rather than reused so an
    // edited runtime is never served from it.
    "--disk-cache-size=1",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--no-service-autorun",
    // The profile OUTLIVES the run now, and teardown ends the browser with
    // SIGKILL, so every launch after the first is a launch after an unclean
    // shutdown. Left alone Chrome greets that with the "Restore pages?"
    // bubble, which in a 256x480 headed window is most of the window — parked
    // in front of the first frame of the stage, the one thing anybody passes
    // --headed to look at.
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
  ];
  if (opts.headless) {
    args.push(
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    );
  }
  // Last: a bare URL sitting after a valueless flag is read as that flag's
  // value rather than as a page to open.
  args.push(opts.url);
  return args;
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
  userDataDir?: string;
  log?: (s: string) => void;
}): Promise<{
  cdp: Cdp;
  url: string;
  cdpPort: number;
  profileDir: string;
  chromeLog: () => string;
  stopServer: () => Promise<void>;
  kill: () => void;
}> {
  const log = opts.log ?? (() => {});
  const servePort = opts.servePort ?? DEFAULT_SERVE_PORT;
  const cdpPort = opts.cdpPort ?? DEFAULT_CDP_PORT;
  const headless = opts.headless ?? true;
  // Absolute, because this path is printed in the handover banner and in the
  // failure message and somebody has to be able to go and look in it. `||`
  // rather than `??`, because an override that arrived empty (`--profile=`)
  // would hand Chrome nothing at all and put it straight back on the default
  // profile — the one failure this directory exists to prevent, reintroduced
  // by a trailing equals sign.
  const profileDir = resolve(
    opts.userDataDir?.trim() || debugProfileDir(cdpPort),
  );
  const logPath = join(
    repoRoot(),
    "build",
    "debug-logs",
    `chrome-${cdpPort}.log`,
  );

  // Both of these happen BEFORE the port is bound. findChrome throws for a
  // --chrome that is not a file and mkdir throws for a build/ that cannot be
  // written, and a server already listening on --serve-port when either of
  // them does means the obvious next move — fix the typo, run it again — fails
  // on an address already in use and blames something unrelated. Making the
  // directory ourselves rather than leaving it to Chrome is the same trade:
  // our version of that error names the path, Chrome's goes to the stderr of a
  // browser that then exits 0.
  const bin = await findChrome(opts.chromeBin ?? null);
  await Deno.mkdir(profileDir, { recursive: true });

  const server = startServer(opts.record, { port: servePort });
  const params = new URLSearchParams();
  if (opts.stage) params.set("stage", String(opts.stage));
  if (opts.bossRush ?? true) params.set("bossRush", "1");
  const q = params.toString();
  const url = `http://127.0.0.1:${servePort}/games/2028-ai${q ? `?${q}` : ""}`;

  log(`chrome ${headless ? "(headless) " : ""}-> ${url}`);
  log(`  profile ${profileDir}`);
  const child = new Deno.Command(bin, {
    args: debugChromeArgs({ url, cdpPort, profileDir, headless }),
    stdout: "null",
    // WHY STDERR IS READ AND NOT THROWN AWAY. Everything Chrome has to say
    // about refusing to start the way it was asked — a profile another
    // instance holds the lock on, a port already taken, a debugging port a
    // policy or a default profile forbids — it says here, and then it exits 0
    // as though nothing had happened. With this set to "null" the whole
    // diagnosis available to anybody was attachCdp's "fetch failed", which
    // names the symptom and points at the wrong component. Measured: nothing
    // at all arrives on stdout, so there is one stream and one reader.
    stderr: "piped",
    stdin: "null",
  }).spawn();
  const chrome = drainStderr(child);
  const chromeSaid = chrome.text;

  // WHY THE FAILURE PATH CLEANS UP IN HERE AND NOT AT THE CALLER. The child
  // and the server are reachable only through the object returned below, and a
  // throw does not return one — so a caller's teardown has nothing to work
  // with however carefully it is written. debug-game.ts's teardown() is the
  // demonstration: `launched?.kill()` against a `launched` that is still null
  // on this exact path, i.e. a no-op, which is how a failed --headed launch
  // left a live Chrome holding a window on an origin that stopped existing the
  // moment the task exited. The server is the same problem one process in: it
  // holds --serve-port, and the next thing anybody does after a failed launch
  // is launch again.
  const abandon = async (): Promise<void> => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
    chrome.stop();
    // Awaited, not merely signalled: an unreaped child stays a zombie for as
    // long as this process lives, and a library caller's process is meant to.
    await Promise.race([child.status, sleep(2000)]).catch(() => {});
    await Promise.race([server.close(), sleep(3000)]).catch(() => {});
  };

  // A Chrome that loses the singleton lock on the profile directory does not
  // fail slowly — it hands its URL to the instance already holding the lock
  // and exits within the second. Racing the attach against the child's own
  // exit turns that into an immediate, named error instead of forty seconds of
  // polling a port nothing is going to open, and the abort stops the poller
  // dead rather than leaving it fetching into the rest of its deadline.
  const abort = new AbortController();
  const died = child.status.then((status): never => {
    throw new Error(
      `Chrome exited before a DevTools port opened on ${cdpPort}. ` +
        explainChromeLaunch({
          cdpPort,
          profileDir,
          said: chromeSaid(),
          exitCode: status.code,
          lastErr: "the browser exited",
          logPath,
        }).join(" "),
    );
  });
  // On the happy path this rejects at teardown, long after the race that was
  // listening has settled.
  died.catch(() => {});

  // Held outside the try so the failure path can close it: everything between
  // the attach and the return can throw, and a socket left open against a
  // browser that is about to be SIGKILLed is an op this process never finishes.
  let cdp: Cdp | null = null;
  try {
    cdp = await Promise.race([
      attachCdp(cdpPort, 40_000, {
        signal: abort.signal,
        advice: (lastErr) =>
          explainChromeLaunch({
            cdpPort,
            profileDir,
            said: chromeSaid(),
            exitCode: null,
            lastErr,
            logPath,
          }).join(" "),
      }),
      died,
    ]);
    // WHY THE VIEWPORT IS OVERRIDDEN AND --window-size IS NOT ENOUGH.
    // --window-size asks for an OS WINDOW, and Chrome clamps its width to a
    // minimum — measured in this container, `--window-size=256,480` produced an
    // innerWidth/innerHeight of 500x340. The page then does the right thing with
    // a window that shape and fits the 256x480 game into it, letterboxed and
    // scaled DOWN to about 182x340, so the game boots believing it has a
    // landscape-ish viewport. fitViewport sizes the viewport itself instead, and
    // it is done BEFORE the boot reload so the bundle sizes itself once on the
    // way up rather than being resized underneath a paused game that cannot
    // repaint until the next step.
    await fitViewport(cdp, GAME_WIDTH, GAME_HEIGHT);
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
      profileDir,
      chromeLog: chromeSaid,
      stopServer: () => server.close(),
      kill: () => {
        try {
          child.kill("SIGKILL");
        } catch { /* gone */ }
        chrome.stop();
        // Fire and forget: the caller's teardown is not waiting on this, but
        // an unawaited status leaves a zombie behind in any caller that does
        // not exit immediately afterwards.
        child.status.catch(() => {});
      },
    };
  } catch (err) {
    abort.abort();
    try {
      cdp?.close();
    } catch { /* the child is going anyway */ }
    await abandon();
    // The message this is about to rethrow already names logPath, so the file
    // has to exist by the time anybody reads it. build/ is known writable —
    // the profile directory went into it a moment ago — and it is written
    // after abandon() so the kill's last words are in it too.
    const said = chromeSaid();
    if (said) {
      await Deno.mkdir(join(logPath, ".."), { recursive: true }).catch(
        () => {},
      );
      await Deno.writeTextFile(logPath, `${said}\n`).catch(() => {});
    }
    throw err;
  }
}
