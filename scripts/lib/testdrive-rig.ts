// The browser half of the side-by-side test drives: a dev server, a Chrome
// with a DevTools port, the harness seated in it, every pane booted into its
// stage and frozen there, the screencast, and the GIF. scripts/testdrive-ps2-
// compare.ts and scripts/testdrive-ps2-textures.ts are each one short
// story told with these steps; what differs between them — which URLs, and
// what the panes are fed — stays in the scripts. The pure parts (the page,
// the probes, the resampling) are scripts/lib/testdrive-compare.ts, so
// everything in here touches a process or a socket.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import {
  Cdp,
  findChrome,
} from "../../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";
import { debugChromeArgs } from "./game-debug.ts";
import {
  AUTOPILOT,
  concatList,
  FLATPAK_CHROME_IDS,
  flatpakChrome,
  fpsLadder,
  type Frame,
  freezeExpr,
  GAME_PATH,
  gifArgs,
  type PaneState,
  paneStateExpr,
  resample,
} from "./testdrive-compare.ts";

export type Log = (line: string) => void;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A probe that has SEEN the answer is "no" throws this, and until() stops. */
export class Abort extends Error {}

export async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null | false | undefined>,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      if (e instanceof Abort) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(everyMs);
  }
  throw new Error(
    `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${
      lastErr ? ` (last error: ${lastErr})` : ""
    }`,
  );
}

export async function hasCommand(
  cmd: string,
  args: string[],
): Promise<boolean> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

/**
 * The browser to drive, as a command line prefix: findChrome's answer, or —
 * on a box whose only Chrome is a Flatpak, which no path search finds — the
 * Flatpak. A --chrome that names nothing usable is an error, never a fallback.
 */
export async function resolveBrowser(
  flag: string | null,
  root: string,
): Promise<string[]> {
  try {
    return [await findChrome(flag)];
  } catch (e) {
    if (flag) throw e;
    for (const id of FLATPAK_CHROME_IDS) {
      if (await hasCommand("flatpak", ["info", id])) {
        return flatpakChrome(id, [root]);
      }
    }
    throw new Error(
      `${e instanceof Error ? e.message : e}; nor is a Chrome Flatpak (${
        FLATPAK_CHROME_IDS.join(", ")
      }) installed`,
    );
  }
}

async function serving(origin: string): Promise<boolean> {
  try {
    const res = await fetch(new URL(GAME_PATH, origin), {
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export interface RigOptions {
  /** A dev server already up; without it vite is started on `servePort`. */
  origin?: string;
  servePort: number;
  cdpPort: number;
  chrome?: string | null;
  headed: boolean;
  /** The harness page's size, which the viewport is pinned to. */
  viewport: { width: number; height: number };
  /** Names the Chrome profile under build/testdrive/.cache. */
  profileName: string;
  log: Log;
}

/**
 * A dev server, a Chrome on a blank same-origin page, and a DevTools session
 * on it with the viewport pinned. close() takes down what start() started,
 * and nothing else: a server that was already up stays up.
 */
export class Rig {
  readonly cdp: Cdp;
  readonly origin: string;
  readonly browser: string;
  readonly startedVite: boolean;
  #children: Deno.ChildProcess[];

  private constructor(
    cdp: Cdp,
    origin: string,
    browser: string,
    startedVite: boolean,
    children: Deno.ChildProcess[],
  ) {
    this.cdp = cdp;
    this.origin = origin;
    this.browser = browser;
    this.startedVite = startedVite;
    this.#children = children;
  }

  static async start(opts: RigOptions): Promise<Rig> {
    const root = repoRoot();
    const { log } = opts;
    const children: Deno.ChildProcess[] = [];
    const abandon = async () => {
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch { /* gone */ }
      }
      await sleep(200);
    };
    try {
      const browser = await resolveBrowser(opts.chrome ?? null, root);

      // ── The server ──
      let origin: string;
      let startedVite = false;
      if (opts.origin) {
        origin = opts.origin.replace(/\/$/, "");
        if (!await serving(origin)) {
          throw new Error(
            `${origin}${GAME_PATH} does not answer; is the dev server up?`,
          );
        }
        log(`using the dev server at ${origin}`);
      } else {
        origin = `http://127.0.0.1:${opts.servePort}`;
        if (await serving(origin)) {
          log(`a server already answers at ${origin}; using it`);
        } else {
          log(`starting vite on ${origin}…`);
          children.push(
            new Deno.Command("deno", {
              args: [
                "run",
                "-A",
                "npm:vite",
                "--port",
                String(opts.servePort),
                "--strictPort",
                "--host",
                "127.0.0.1",
              ],
              cwd: root,
              stdout: "null",
              stderr: "null",
              stdin: "null",
            }).spawn(),
          );
          startedVite = true;
          await until(
            "vite to serve the game route",
            90_000,
            () => serving(origin),
            1000,
          ).catch((e) => {
            throw new Error(`${e.message}; try \`deno task dev:vite\` by hand`);
          });
        }
      }

      // ── Chrome on a blank same-origin page ──
      // Any same-origin document will do as the seat for the harness; the
      // game route with no level is not it (it would boot 2028.Ai), so a path
      // nothing serves is opened and its 404 page replaced.
      const profileDir = join(
        root,
        "build",
        "testdrive",
        ".cache",
        `chrome-${opts.profileName}-${opts.cdpPort}`,
      );
      await ensureDir(profileDir);
      const seatUrl = `${origin}/__testdrive-seat`;
      // The debug script's window is one game; this page is wider. A visible
      // window's size is its outer size, so the tab strip and the toolbar are
      // added on top of the page, which the viewport override below fixes at
      // harness size either way.
      const outerHeight = opts.viewport.height + (opts.headed ? 88 : 0);
      const args = debugChromeArgs({
        url: seatUrl,
        cdpPort: opts.cdpPort,
        profileDir,
        headless: !opts.headed,
      }).map((a) =>
        a.startsWith("--window-size=")
          ? `--window-size=${opts.viewport.width},${outerHeight}`
          : a
      );
      log(
        `launching ${browser[0]} ${
          opts.headed ? "(headed)" : "(headless)"
        } with DevTools on :${opts.cdpPort}…`,
      );
      children.push(
        new Deno.Command(browser[0], {
          args: [...browser.slice(1), ...args],
          stdout: "null",
          stderr: "null",
          stdin: "null",
        }).spawn(),
      );
      type Target = {
        type: string;
        url: string;
        webSocketDebuggerUrl?: string;
      };
      const target = await until<Target>(
        "the page on the DevTools port",
        30_000,
        async () => {
          const res = await fetch(`http://127.0.0.1:${opts.cdpPort}/json/list`);
          const list = await res.json() as Target[];
          return list.find((t) =>
            t.type === "page" && t.webSocketDebuggerUrl &&
            t.url.startsWith(origin)
          ) ?? null;
        },
        250,
      ).catch((e) => {
        throw new Error(`Chrome did not come up: ${e.message}`);
      });
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: opts.viewport.width,
        height: opts.viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return new Rig(cdp, origin, browser.join(" "), startedVite, children);
    } catch (e) {
      await abandon();
      throw e;
    }
  }

  /** Replace the seat page with the harness and install the autopilot. */
  async seat(html: string): Promise<void> {
    const { frameTree } = await this.cdp.send<
      { frameTree: { frame: { id: string } } }
    >("Page.getFrameTree");
    await this.cdp.send("Page.setDocumentContent", {
      frameId: frameTree.frame.id,
      html,
    });
    await this.cdp.eval(AUTOPILOT);
  }

  /**
   * Wait for every pane to reach its stage, stopping each on the first frame
   * of play as it gets there, so the one that boots first waits for the
   * others and all start the window together. Throws with every pane's last
   * state when one never arrives.
   */
  async bootPanes(
    ids: string[],
    opts: { timeoutMs: number; log: Log },
  ): Promise<Record<string, PaneState>> {
    const frozen = new Set<string>();
    const t0 = Date.now();
    const read = (id: string) =>
      this.cdp.eval<PaneState>(paneStateExpr(id)).catch(() => null);
    return await until<Record<string, PaneState>>(
      "every pane to reach the stage",
      opts.timeoutMs,
      async () => {
        const out: Record<string, PaneState> = {};
        for (const id of ids) {
          const s = await this.cdp.eval<PaneState>(paneStateExpr(id));
          out[id] = s;
          if (s.started && !frozen.has(id)) {
            if (await this.cdp.eval<boolean>(freezeExpr(id, true))) {
              frozen.add(id);
              opts.log(
                `${id.toUpperCase()} reached the stage after ${
                  ((Date.now() - t0) / 1000).toFixed(1)
                }s; held`,
              );
            }
          }
        }
        return frozen.size === ids.length ? out : null;
      },
      250,
    ).catch(async (e) => {
      const seen = await Promise.all(ids.map(read));
      throw new Error(`${e.message}: ${JSON.stringify(seen)}`);
    });
  }

  /**
   * Wake every pane on the same tick with the autopilot on, and screencast
   * the page for `seconds`. Frames land in `framesDir`; the moment of the
   * wake-up is returned as the GIF's clock origin.
   */
  async record(
    ids: string[],
    opts: {
      seconds: number;
      framesDir: string;
      viewport: { width: number; height: number };
      log: Log;
    },
  ): Promise<{ frames: Frame[]; t0: number; after: (PaneState | null)[] }> {
    await ensureDir(opts.framesDir);
    const frames: Frame[] = [];
    let n = 0;
    let recording = false;
    const onFrame = (p: Record<string, unknown>) => {
      this.cdp.send("Page.screencastFrameAck", {
        sessionId: p.sessionId as number,
      }).catch(() => {});
      if (!recording) return;
      const meta = p.metadata as { timestamp?: number } | undefined;
      const t = (meta?.timestamp ?? Date.now() / 1000) * 1000;
      const file = join(
        opts.framesDir,
        `f${String(n++).padStart(5, "0")}.png`,
      );
      frames.push({ file, t });
      Deno.writeFile(
        file,
        Uint8Array.from(atob(p.data as string), (c) => c.charCodeAt(0)),
      ).catch(() => {});
    };
    this.cdp.on("Page.screencastFrame", onFrame);
    await this.cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: opts.viewport.width,
      maxHeight: opts.viewport.height,
      everyNthFrame: 1,
    });
    recording = true;
    const t0 = Date.now();
    await this.cdp.eval(
      `(() => { ${
        ids.map((id) => freezeExpr(id, false)).join(";")
      }; window.__autopilot.on = true; return true; })()`,
    );
    let lastReport = 0;
    while (Date.now() - t0 < opts.seconds * 1000) {
      await sleep(100);
      const elapsed = Date.now() - t0;
      if (elapsed - lastReport >= 5000) {
        lastReport = elapsed;
        opts.log(`  ${(elapsed / 1000).toFixed(0)}s, ${frames.length} frames`);
      }
    }
    recording = false;
    await this.cdp.eval(`window.__autopilot.on = false; true`).catch(
      () => {},
    );
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    this.cdp.off("Page.screencastFrame", onFrame);
    await sleep(300);
    const after = await Promise.all(
      ids.map((id) =>
        this.cdp.eval<PaneState>(paneStateExpr(id)).catch(() => null)
      ),
    );
    if (frames.length < opts.seconds) {
      throw new Error(
        `the screencast delivered only ${frames.length} frames in ${opts.seconds}s; the panes were not drawing`,
      );
    }
    opts.log(
      `captured ${frames.length} frames (${
        (frames.length / opts.seconds).toFixed(1)
      }/s)`,
    );
    return { frames, t0, after };
  }

  /** Browser.close, then every process start() spawned. */
  async close(): Promise<void> {
    await this.cdp.send("Browser.close").catch(() => {});
    this.cdp.close();
    for (const c of this.#children) {
      try {
        c.kill("SIGTERM");
      } catch { /* gone */ }
    }
    await sleep(500);
    for (const c of this.#children) {
      try {
        c.kill("SIGKILL");
      } catch { /* gone */ }
    }
    this.#children = [];
  }
}

export interface GifResult {
  path: string;
  bytes: number;
  fps: number;
  askedFps: number;
  maxMb: number;
  overBudget: boolean;
  frames: number;
  distinct: number;
  /** The frames the GIF was cut from, first and last. */
  first: string;
  last: string;
}

/**
 * The GIF: encoded at the rate asked for, then — if that is over the budget —
 * down the ladder until it fits. Every pass reads the same raw frames, so the
 * caller keeps the frames directory until this returns.
 */
export async function writeGif(
  frames: Frame[],
  opts: {
    outDir: string;
    fps: number;
    seconds: number;
    maxMb: number;
    from: number;
    log: Log;
  },
): Promise<GifResult> {
  const listFile = join(opts.outDir, "frames.txt");
  const gifPath = join(opts.outDir, "compare.gif");
  const budget = opts.maxMb > 0 ? opts.maxMb * 1048576 : Infinity;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  let fps = opts.fps;
  let picked: string[] = [];
  let bytes = Infinity;
  for (const rate of fpsLadder(opts.fps)) {
    fps = rate;
    picked = resample(frames, fps, opts.seconds, opts.from);
    await Deno.writeTextFile(listFile, concatList(picked, fps));
    opts.log(`writing ${gifPath} (${picked.length} frames at ${fps} fps)…`);
    const ff = await new Deno.Command("ffmpeg", {
      args: gifArgs(listFile, fps, gifPath),
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!ff.success) {
      throw new Error(`ffmpeg failed: ${new TextDecoder().decode(ff.stderr)}`);
    }
    bytes = (await Deno.stat(gifPath)).size;
    if (bytes <= budget) break;
    opts.log(`  ${mb(bytes)} MB is over the ${opts.maxMb} MB budget`);
  }
  const overBudget = bytes > budget;
  if (overBudget) {
    opts.log(
      `still ${
        mb(bytes)
      } MB at ${fps} fps; shorten --seconds or raise --max-mb`,
    );
  }
  await Deno.remove(listFile).catch(() => {});
  return {
    path: gifPath,
    bytes,
    fps,
    askedFps: opts.fps,
    maxMb: opts.maxMb,
    overBudget,
    frames: picked.length,
    distinct: new Set(picked).size,
    first: picked[0],
    last: picked[picked.length - 1],
  };
}

/** The summary's GIF line, shared so both drives read alike. */
export function gifLine(g: GifResult): string {
  return `${g.path}  (${
    (g.bytes / 1048576).toFixed(1)
  } MB, ${g.frames} frames @ ${g.fps} fps${
    g.fps !== g.askedFps
      ? ` — down from ${g.askedFps} to fit ${g.maxMb} MB`
      : ""
  }${g.overBudget ? ", STILL OVER BUDGET" : ""})`;
}
