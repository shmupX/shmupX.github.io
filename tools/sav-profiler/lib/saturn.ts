// The Saturn half of the profiler: Mednafen, driven from outside.
//
// Mednafen has no scripting, so a level is brought to its start the way a
// person would — but only once per level. The first run boots the disc, walks
// Dezaemon 2's pointer menus (OPTION → LOAD → cartridge → slot 1 → ALL → OK →
// はい → OK → RETURN → 組立 → EDIT START → TEST), switches MUTEKI on and
// saves a state on the TEST PLAY panel with the pointer over START. Every
// later run loads that state a few seconds after launch and is armed: one A
// press is the level start, with the player invincible like the web's ?god=1.
//
// Everything lives in a profile directory of its own — the cart (built from
// the .sav by lib/cart-inject.ts into an otherwise empty cartridge), the state,
// the snapshots, and an override config that pins the save/state paths and
// every key — so the user's mednafen.cfg, cart and states are never touched.
// The override goes in through `-ovconfig`, which Mednafen does not write back
// to mednafen.cfg the way a `-setting value` argument is.
//
// Dezaemon 2's menus are pointer-driven: the pad moves an arrow at ~2.8 px per
// frame, and A clicks whatever is under its tip. Moves are timed holds, so a
// click can miss by a few pixels; every click is verified by the screen
// changing, and retried with a nudge when it did not. The pointer's absolute
// position is re-found by driving it into the top-left corner, where it stops.

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { injectCart } from "../../../lib/cart-inject.ts";
import { decodePng, type Raster } from "../../../lib/ps2/png.ts";
import {
  activate,
  ensurePostKey,
  Keyboard,
  keyConfigLines,
  placeWindow,
} from "./keys.ts";

export class SaturnError extends Error {
  override name = "SaturnError";
}

export interface SaturnProfile {
  /** The profile directory. */
  dir: string;
  /** Mednafen's save dir for this profile (holds the cart). */
  savDir: string;
  stateDir: string;
  snapDir: string;
  /** The override config passed with -ovconfig. */
  cfgPath: string;
  /** The key helper binary. */
  postKey: string;
  disc: string;
  bin: string;
  /** The disc's base name: what the cart, state and snapshots are called. */
  name: string;
  cartPath: string;
  statePath: string;
}

export type Log = (line: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pointer speed in Dezaemon 2's menus, measured: ~2.8 px per 60 Hz frame. */
const POINTER_PX_PER_SEC = 168;

/** The hold that moves the pointer `px`: it takes ~40 ms to get going
 * (a 35 ms tap moves it nothing, 100 ms about 13 px), then runs at
 * POINTER_PX_PER_SEC. */
function holdFor(px: number): number {
  return Math.max(
    45,
    Math.round(Math.abs(px) / POINTER_PX_PER_SEC * 1000) + 40,
  );
}

/** Where the pointer's template box sits when driven into the corner. */
const POINTER_HOME = { x: 5, y: 9 };

/**
 * Set a profile up: the cart with this level alone in slot 1, the override
 * config, the key helper. Idempotent — a cart that already holds this exact
 * level is left as it is (lib/cart-inject.ts compares before writing).
 */
export async function prepareProfile(opts: {
  dir: string;
  sav: Uint8Array;
  disc: string;
  bin: string;
  log?: Log;
}): Promise<SaturnProfile> {
  const log = opts.log ?? (() => {});
  const name = baseName(opts.disc);
  const savDir = join(opts.dir, "sav");
  const stateDir = join(opts.dir, "mcs");
  const snapDir = join(opts.dir, "snaps");
  const binDir = join(opts.dir, "..", "bin");
  for (const d of [savDir, stateDir, snapDir]) await ensureDir(d);
  const postKey = await ensurePostKey(binDir);
  const cartPath = join(savDir, `${name}.bcr`);
  const r = await injectCart({
    sav: opts.sav,
    cart: cartPath,
    slot: "1",
    emulator: "Mednafen",
    advice: "this is the profiler's own cart, delete the profile to reset it",
    log: (line) => log(`  cart: ${line}`),
  });
  log(
    `cart: ${r.filename} "${r.comment}" ${r.replaced ? "replaced" : "written"}`,
  );
  const cfgPath = join(opts.dir, "profiler.cfg");
  const cfg = [
    "filesys.fname_sav %f.%x",
    `filesys.path_sav ${savDir}`,
    `filesys.path_state ${stateDir}`,
    "filesys.fname_state %f.%X",
    `filesys.path_snap ${snapDir}`,
    "filesys.fname_snap %f-%p.%x",
    `filesys.path_movie ${stateDir}`,
    "video.fs 0",
    "video.frameskip 0",
    // Mednafen paces itself; a GL swap that waits for vsync would let macOS
    // throttle emulation whenever the window is not frontmost.
    "video.glvsync 0",
    "nothrottle 0",
    "autosave 0",
    "qtrecord.vcodec cscd",
    "qtrecord.w_double 0",
    "qtrecord.h_double 0",
    ...keyConfigLines(),
  ];
  await Deno.writeTextFile(cfgPath, cfg.join("\n") + "\n");
  return {
    dir: opts.dir,
    savDir,
    stateDir,
    snapDir,
    cfgPath,
    postKey,
    disc: opts.disc,
    bin: opts.bin,
    name,
    cartPath,
    statePath: join(stateDir, `${name}.mc0`),
  };
}

/** What the armed state is: written by prepareState, read by armRun. */
export function armedInfoPath(profile: SaturnProfile): string {
  return join(profile.dir, "armed.json");
}

export function baseName(path: string): string {
  const file = path.replace(/\\/g, "/").split("/").pop() || path;
  return file.replace(/\.[^.]+$/, "");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A running Mednafen. */
export class Saturn {
  readonly kb: Keyboard;
  readonly spawnedAt: number;
  exitedAt: number | null = null;
  #child: Deno.ChildProcess;
  #status: Promise<Deno.CommandStatus>;
  #snapCounter = 0;
  readonly log: Log;
  readonly profile: SaturnProfile;
  /** Where verification snapshots are copied to, when set. */
  snapCopyDir: string | null = null;
  /** The armed GAME START menu, as armRun saw it: the frame the Start press ends. */
  armedFrame: Raster | null = null;
  #keepFront: number | null = null;
  /** The pad button that starts the level from the armed state: A on the
   * TEST PLAY panel's START (pointer already on it), Start on an old GAME
   * START-menu state. */
  startButton: "a" | "start" = "start";

  private constructor(
    profile: SaturnProfile,
    child: Deno.ChildProcess,
    log: Log,
  ) {
    this.profile = profile;
    this.#child = child;
    this.#status = child.status;
    this.kb = new Keyboard(profile.postKey, child.pid);
    this.spawnedAt = Date.now();
    this.log = log;
    this.#status.then(() => {
      this.exitedAt = Date.now();
    });
  }

  get pid(): number {
    return this.#child.pid;
  }

  get exited(): boolean {
    return this.exitedAt !== null;
  }

  /** Launch on the profile's disc; `record` names a QuickTime file to write. */
  static async launch(
    profile: SaturnProfile,
    { record = null, log = () => {}, logFile = null }: {
      record?: string | null;
      log?: Log;
      logFile?: string | null;
    } = {},
  ): Promise<Saturn> {
    const args = ["-ovconfig", profile.cfgPath];
    if (record) args.push("-qtrecord", record);
    args.push(profile.disc);
    log(`mednafen ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(profile.bin, {
        args,
        stdout: logFile ? "piped" : "null",
        stderr: "null",
        stdin: "null",
      }).spawn();
      if (logFile) {
        const out = await Deno.open(logFile, {
          write: true,
          create: true,
          truncate: true,
        });
        child.stdout.pipeTo(out.writable).catch(() => {});
      }
    } catch (e) {
      throw new SaturnError(
        `could not launch "${profile.bin}": ${(e as Error).message}. ` +
          "Set MEDNAFEN_BIN (or brew install mednafen).",
      );
    }
    const s = new Saturn(profile, child, log);
    // SDL needs a moment before the window exists and can be fronted.
    await sleep(2500);
    if (s.exited) {
      throw new SaturnError(
        `Mednafen exited right after launch${
          logFile ? ` — see ${logFile}` : ""
        }`,
      );
    }
    await activate(child.pid);
    await placeWindow(child.pid, 0, 40);
    await sleep(300);
    // Keep the window in front for the life of the process: SDL takes keys
    // only there, and macOS naps a bare binary that loses the front, which
    // drags emulation behind real time.
    s.#keepFront = setInterval(() => {
      if (!s.exited) activate(child.pid).catch(() => {});
    }, 2500);
    return s;
  }

  /** Ask Mednafen to quit (the exit hotkey), and wait for it. */
  async quit(timeoutMs = 8000): Promise<void> {
    if (this.#keepFront !== null) clearInterval(this.#keepFront);
    this.#keepFront = null;
    if (this.exited) return;
    try {
      await activate(this.pid);
      await this.kb.hotkey("exit");
    } catch { /* fall through to the kill */ }
    const t = Date.now();
    while (!this.exited && Date.now() - t < timeoutMs) await sleep(100);
    if (!this.exited) {
      this.log("Mednafen ignored the exit key; killing it");
      try {
        this.#child.kill("SIGTERM");
      } catch { /* gone */ }
      await this.#status;
    }
  }

  kill(): void {
    if (this.#keepFront !== null) clearInterval(this.#keepFront);
    this.#keepFront = null;
    if (this.exited) return;
    try {
      this.#child.kill("SIGKILL");
    } catch { /* gone */ }
  }

  /** Take a snapshot (Mednafen's own, of the emulated frame) and read it. */
  async snapshot(label = "snap"): Promise<{ path: string; raster: Raster }> {
    const before = new Set(await listPngs(this.profile.snapDir));
    let path: string | null = null;
    // A key only lands while Mednafen is in front; if nothing was written,
    // bring it forward and try once more.
    for (let attempt = 0; attempt < 2 && !path; attempt++) {
      if (attempt) await activate(this.pid);
      await this.kb.hotkey("take_snapshot");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await sleep(120);
        const now = await listPngs(this.profile.snapDir);
        const fresh = now.filter((p) => !before.has(p));
        if (fresh.length) {
          path = fresh.sort().pop()!;
          break;
        }
      }
    }
    if (!path) {
      throw new SaturnError(
        "Mednafen wrote no snapshot (is its window in front?)",
      );
    }
    // The file is written in one go but let a slow disk finish.
    let bytes = await Deno.readFile(path);
    for (let i = 0; i < 10 && !isCompletePng(bytes); i++) {
      await sleep(100);
      bytes = await Deno.readFile(path);
    }
    if (this.snapCopyDir) {
      await ensureDir(this.snapCopyDir);
      const n = String(this.#snapCounter++).padStart(2, "0");
      await Deno.writeFile(join(this.snapCopyDir, `${n}-${label}.png`), bytes);
    }
    return { path, raster: await decodePng(bytes) };
  }

  /** Wait until the Dezaemon 2 title screen is up (the disc has booted). */
  async waitForTitle(timeoutMs = 120_000): Promise<void> {
    const t0 = Date.now();
    await sleep(15_000);
    while (Date.now() - t0 < timeoutMs) {
      const { raster } = await this.snapshot("boot");
      if (isDezaTitle(raster)) return;
      await sleep(2000);
    }
    throw new SaturnError(
      "Dezaemon 2's title screen never appeared (BIOS in ~/.mednafen/firmware? right disc?)",
    );
  }

  /** Drive the pointer into the top-left corner, where it stops, and read
   * back where that is. */
  async homePointer(): Promise<Pointer> {
    await this.kb.pad("left", 2200);
    await this.kb.pad("up", 1700);
    await sleep(150);
    const found = findPointer((await this.snapshot("home")).raster);
    return new Pointer(
      this,
      found?.x ?? POINTER_HOME.x,
      found?.y ?? POINTER_HOME.y,
    );
  }
}

/**
 * The menu pointer. Positions are of its template box (findPointer); a
 * click lands where the tip is, POINTER_TIP inside that box. Moves are timed
 * holds, checked against a snapshot and corrected — a hold is occasionally
 * lost, and the speed is only approximately known.
 */
export class Pointer {
  constructor(readonly saturn: Saturn, public x: number, public y: number) {}

  /** Bring the TIP to (x, y). */
  async moveTo(x: number, y: number, label = "move"): Promise<void> {
    const tx = x - POINTER_TIP.x, ty = y - POINTER_TIP.y;
    for (let i = 0; i < 5; i++) {
      const dx = tx - this.x;
      const dy = ty - this.y;
      if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) return;
      // Vertical first, horizontal last: a value widget (the TEST PLAY
      // panel's MUTEKI arrows) takes the pointer as hovering only after a
      // horizontal move onto it — arriving from above, A does nothing.
      if (Math.abs(dy) > 2) {
        await this.saturn.kb.pad(dy > 0 ? "down" : "up", holdFor(dy));
      }
      if (Math.abs(dx) > 2) {
        await this.saturn.kb.pad(dx > 0 ? "right" : "left", holdFor(dx));
      }
      await sleep(150);
      const found = findPointer(
        (await this.saturn.snapshot(`${label}-move${i}`)).raster,
        { x: tx, y: ty },
      );
      if (!found) {
        // Hidden or restyled pointer: trust the reckoning and stop.
        this.x = tx;
        this.y = ty;
        return;
      }
      this.x = found.x;
      this.y = found.y;
    }
    this.saturn.log(
      `  pointer settled ${this.x - tx},${this.y - ty} px off ${label}`,
    );
  }

  /**
   * Click at (x, y) and make sure the screen reacted. A menu click that
   * changes nothing but the pointer is a miss: nudge and try again, up to
   * `tries` times. `settleMs` is how long the screen takes to react.
   */
  async click(
    x: number,
    y: number,
    label: string,
    {
      settleMs = 1500,
      tries = 7,
      nudge = [[-5, -5], [5, 5], [-8, 0], [0, -8], [8, 0], [0, 8]],
      expect = null,
    }: {
      settleMs?: number;
      tries?: number;
      nudge?: number[][];
      /** The screen the click must produce; without it, any change counts. */
      expect?: ((r: Raster) => boolean) | null;
    } = {},
  ): Promise<Raster> {
    let target = { x, y };
    const before = (await this.saturn.snapshot(`${label}-before`)).raster;
    for (let i = 0; i < tries; i++) {
      await this.moveTo(target.x, target.y, label);
      await this.saturn.kb.pad("a", 100);
      await sleep(settleMs);
      const after =
        (await this.saturn.snapshot(`${label}-after${i ? i : ""}`)).raster;
      const changed = changedFraction(before, after);
      this.saturn.log(
        `  click ${label} @${target.x},${target.y}: ${
          (changed * 100).toFixed(1)
        }% of the screen changed`,
      );
      // The pointer alone moves ~0.35% of the screen; a panel opening ~2%.
      const ok = expect ? expect(after) : changed > 0.012;
      if (ok) return after;
      const n = nudge[i % nudge.length];
      target = { x: x + n[0], y: y + n[1] };
    }
    throw new SaturnError(
      `the ${label} click never took (pointer at ${target.x},${target.y}); see the snapshots in the profile`,
    );
  }
}

/**
 * From a fresh boot, load the cart's slot 1 and save a state on the level's
 * GAME START menu. The state is the profile's `statePath` afterwards.
 */
export async function prepareState(
  profile: SaturnProfile,
  { log = () => {}, keep = false, stopAtTestPanel = false }: {
    log?: Log;
    keep?: boolean;
    /** Debugging: stop on the TEST PLAY panel and hand the emulator back. */
    stopAtTestPanel?: boolean;
  } = {},
): Promise<Saturn | void> {
  const prepDir = join(profile.dir, "prep");
  try {
    await Deno.remove(prepDir, { recursive: true });
  } catch { /* none */ }
  const s = await Saturn.launch(profile, {
    log,
    logFile: join(profile.dir, "prepare.log"),
  });
  s.snapCopyDir = prepDir;
  try {
    log("booting the disc…");
    await s.waitForTitle();
    log("title screen; opening the main menu");
    await s.kb.pad("start", 100);
    await sleep(3500);
    let p = await s.homePointer();
    await p.click(280, 214, "option", {
      settleMs: 1200,
      expect: isOptionPanel,
    });
    await p.click(280, 159, "load", { settleMs: 7000, expect: isLoadScreen }); // NOW LOADING
    p = await s.homePointer();
    await p.click(95, 68, "cartridge", { settleMs: 2000, expect: isSlotList });
    await p.click(105, 66, "slot1", { settleMs: 1500, expect: isPartsPanel });
    await p.click(263, 66, "all", { settleMs: 1000, expect: isOkShown });
    await p.click(265, 178, "ok", { settleMs: 1500, expect: isConfirmDialog });
    await p.click(124, 147, "yes", { settleMs: 4500, expect: isLoadedDialog }); // the read itself
    await p.click(162, 147, "done", { settleMs: 2500, expect: isLoadScreen });
    p = await s.homePointer();
    await p.click(290, 18, "return", { settleMs: 4000, expect: isMainMenu });
    // TEST PLAY, the editor's own run of the stage: the player is invincible
    // (MUTEKI), which is what the web side's ?god=1 is, and the stage starts
    // about two seconds after START with no title in between.
    p = await s.homePointer();
    await p.click(217, 169, "kumiko", { settleMs: 6000, expect: isKumiko });
    await p.click(255, 72, "edit-start", {
      settleMs: 6000,
      expect: isStageEditor,
    });
    await p.click(268, 20, "test", { settleMs: 2500, expect: isTestPanel });
    if (stopAtTestPanel) return s;
    // The value is set from its arrows: ► (tip x 242-247, y 123-126) turns
    // it ON, ◄ turns it OFF; a press on the text between does nothing, and
    // two pixels right of the arrow is already outside it.
    const spots = [[245, 125], [244, 124], [246, 126], [243, 123], [247, 125]];
    let muteki = false;
    for (let i = 0; i < spots.length && !muteki; i++) {
      await p.moveTo(spots[i][0], spots[i][1], "muteki");
      await sleep(600);
      await s.kb.pad("a", 100);
      await sleep(800);
      await p.moveTo(159, 18, "start");
      muteki = isMutekiOn((await s.snapshot(`muteki-check${i}`)).raster);
      log(`  MUTEKI ${muteki ? "ON" : "still OFF"}`);
    }
    if (!muteki) {
      throw new SaturnError(
        "could not switch MUTEKI on in the TEST PLAY panel — see prep/ snapshots",
      );
    }
    await p.moveTo(159, 18, "start");
    log("armed on the TEST PLAY panel, pointer on START");
    await s.kb.hotkey("save_state");
    await sleep(1500);
    if (!(await exists(profile.statePath))) {
      throw new SaturnError(`no state was written at ${profile.statePath}`);
    }
    await Deno.writeTextFile(
      armedInfoPath(profile),
      JSON.stringify({ mode: "testplay", startButton: "a" }, null, 2) + "\n",
    );
    log(`state saved: ${profile.statePath}`);
  } finally {
    if (!stopAtTestPanel) await s.quit();
    if (!keep) { /* snapshots stay for diagnosis; nothing else to clean */ }
  }
}

/**
 * Launch for a run, recording to `record`, load the state and stop on the
 * GAME START menu. Returns the running emulator; the caller presses Start.
 */
export async function armRun(
  profile: SaturnProfile,
  record: string,
  log: Log = () => {},
): Promise<Saturn> {
  if (!(await exists(profile.statePath))) {
    throw new SaturnError(
      "no armed state for this level — run prepareState first",
    );
  }
  const s = await Saturn.launch(profile, {
    record,
    log,
    logFile: join(profile.dir, "run.log"),
  });
  await sleep(1500);
  await s.kb.hotkey("load_state");
  await sleep(1200);
  const { raster } = await s.snapshot("armed");
  s.armedFrame = raster;
  try {
    const info = JSON.parse(await Deno.readTextFile(armedInfoPath(profile)));
    if (info.startButton === "a" || info.startButton === "start") {
      s.startButton = info.startButton;
    }
  } catch { /* an older profile: armed on the GAME START menu, Start key */ }
  if (meanLuma(raster) > 200) {
    await s.quit();
    throw new SaturnError(
      "the state did not load (bright screen after the load key); delete the profile's mcs/ to rebuild it",
    );
  }
  return s;
}

// ---- screen checks ---------------------------------------------------------

async function listPngs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.toLowerCase().endsWith(".png")) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

function isCompletePng(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const tail = new TextDecoder("latin1").decode(b.subarray(b.length - 8));
  return tail.includes("IEND");
}

/** Mean of a region's RGB, in the raster's own coordinates. */
export function regionMean(
  r: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number, number] {
  let n = 0, rs = 0, gs = 0, bs = 0;
  for (let y = Math.max(0, y0); y < Math.min(r.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(r.width, x1); x++) {
      const i = (y * r.width + x) * 4;
      rs += r.data[i];
      gs += r.data[i + 1];
      bs += r.data[i + 2];
      n++;
    }
  }
  return n ? [rs / n, gs / n, bs / n] : [0, 0, 0];
}

export function meanLuma(r: Raster): number {
  const [a, b, c] = regionMean(r, 0, 0, r.width, r.height);
  return (a + b + c) / 3;
}

// ---- Dezaemon 2 menu screens, by the colour of one telling region each
// (measured on 330x240 snapshots; see the prep/ snapshots of any profile).

const luma = ([r, g, b]: [number, number, number]) => (r + g + b) / 3;

/** The OPTION panel is open: its dark green LOAD/SAVE/CONTROL/SYSTEM box. */
export const isOptionPanel = (r: Raster): boolean => {
  const [red, green] = regionMean(r, 258, 150, 300, 208);
  return red < 60 && green > red + 25;
};

/** The LOAD screen (cartridge / expansion source): its dark banner. */
export const isLoadScreen = (r: Raster): boolean => {
  const m = regionMean(r, 10, 15, 120, 30);
  return luma(m) < 40 && m[1] > m[0] + 10 &&
    luma(regionMean(r, 100, 60, 230, 180)) > 20;
};

/** The slot list is up: its green NO DATA rows. */
export const isSlotList = (r: Raster): boolean => {
  const [red, green] = regionMean(r, 100, 108, 230, 130);
  return green > 70 && green > red + 50;
};

/** The parts panel (ALL / graphics / ...) beside the slot list. */
export const isPartsPanel = (r: Raster): boolean =>
  isSlotList(r) && luma(regionMean(r, 180, 150, 300, 200)) > 70;

/** The parts panel with its OK button showing (a pale blue box). */
export const isOkShown = (r: Raster): boolean => {
  const [red, , blue] = regionMean(r, 255, 176, 290, 190);
  return isPartsPanel(r) && blue > red + 15;
};

const isGreenDialog = (r: Raster): boolean => {
  const [red, green] = regionMean(r, 40, 80, 290, 140);
  return green > 80 && green > red + 50;
};

/** 読み込むと…よろしいですか? — the green dialog with はい / いいえ (white
 * boxes at x 110-154 and 174-220, y 141-153). */
export const isConfirmDialog = (r: Raster): boolean =>
  isGreenDialog(r) && luma(regionMean(r, 112, 142, 150, 152)) > 130 &&
  luma(regionMean(r, 178, 142, 216, 152)) > 130;

/** 読み込みが終了しました — the green dialog with one OK box at x 150-180. */
export const isLoadedDialog = (r: Raster): boolean =>
  isGreenDialog(r) && luma(regionMean(r, 150, 141, 180, 143)) > 170 &&
  luma(regionMean(r, 112, 142, 145, 152)) < 100;

/** The main menu: grey chequered ground behind both panels. */
export const isMainMenu = (r: Raster): boolean => {
  const m = regionMean(r, 258, 150, 300, 208);
  return Math.abs(m[0] - m[1]) < 12 && m[0] > 80 &&
    luma(regionMean(r, 10, 15, 120, 30)) > 100;
};

/** A user game's own title: dark corners, and not the disc's sample. */
export const isUserGameTitle = (r: Raster): boolean =>
  luma(regionMean(r, 10, 15, 120, 30)) < 40 &&
  luma(regionMean(r, 100, 60, 230, 180)) > 15 && !isMainMenu(r) &&
  !isLoadScreen(r) && !looksLikeSampleTitle(r);

/** 組み子さん, the assembly editor's stage list: its orange PLAYER box. */
export const isKumiko = (r: Raster): boolean => {
  const [red, green, blue] = regionMean(r, 18, 62, 66, 78);
  return red > 90 && red > blue + 40 && green < red;
};

/** The stage editor: black under the toolbar, the toolbar itself blue-grey. */
export const isStageEditor = (r: Raster): boolean => {
  const bar = regionMean(r, 8, 10, 230, 26);
  return luma(regionMean(r, 18, 62, 66, 78)) < 10 && bar[2] > bar[0] + 15 &&
    luma(bar) > 80;
};

/** The TEST PLAY panel: PLAYER SELECT / STOCK / MUTEKI in orange-brown. */
export const isTestPanel = (r: Raster): boolean => {
  const [red, green, blue] = regionMean(r, 130, 48, 178, 60);
  return red > 55 && red > blue + 40 && green > blue + 20;
};

/** MUTEKI reads ON: the "O" of ON sits at x 218-222 where OFF's first letter
 * is darker, and the next column is dark where OFF's second letter is bright
 * (measured 118/89 for ON against 94/126 for OFF). The pointer must be off
 * the box (its box spans 16 px right of the tip). */
export const isMutekiOn = (r: Raster): boolean =>
  isTestPanel(r) && luma(regionMean(r, 218, 124, 222, 131)) > 106 &&
  luma(regionMean(r, 222, 124, 226, 131)) < 108;

/** Dezaemon 2's title: the green PRESS START BUTTON plate. */
export function isDezaTitle(r: Raster): boolean {
  const sx = r.width / 330, sy = r.height / 240;
  // The plate is a dark green that pulses (G 40-90, R under 20, B about
  // half of G); the menu behind it is grey and the boot screens blue/white.
  const [red, green, blue] = regionMean(
    r,
    110 * sx,
    153 * sy,
    225 * sx,
    166 * sy,
  );
  return green > 30 && red < 40 && green > red * 2 && green > blue * 1.4;
}

// The menu pointer, as it looks with its tip at the frame's top-left after a
// long hold into the corner (dbg snapshots of two boots agreed on every pixel
// kept here; "." is background). The tip is at (2, 1) of this box.
const POINTER_TEMPLATE = [
  ".BBB..........W.",
  "BBWBB........W..",
  ".BWWBBW.........",
  ".BBWWBB.........",
  "..BBWWBBBBBB....",
  "...BBWW....BB...",
  "...BB.WW....B...",
  "...B.B.WW...BB..",
  "..BB.BBWWW...B..",
  "..B.BBBWWWW..BBB",
  "..B....WWWWW...B",
  "..B.WWWWWWW.WW..",
  "..BB.WWWWW.WWBB.",
  "....BB....BWBB.B",
  "......BBBBB...BB",
  "..........BBBBB.",
];
const POINTER_PIXELS: { dx: number; dy: number; white: boolean }[] = [];
POINTER_TEMPLATE.forEach((row, dy) => {
  [...row].forEach((c, dx) => {
    if (c !== ".") POINTER_PIXELS.push({ dx, dy, white: c === "W" });
  });
});
/** Where the tip sits inside the template box. */
export const POINTER_TIP = { x: 2, y: 1 };

/** Locate the pointer (its template box's top-left) in a frame. On the
 * menu's chequered ground the arrow scores only ~0.6, so a weaker match is
 * accepted when it lies close to where the pointer was expected (`near`). */
export function findPointer(
  r: Raster,
  near: { x: number; y: number } | null = null,
): { x: number; y: number; score: number } | null {
  const sx = r.width / 330, sy = r.height / 240;
  if (Math.abs(sx - 1) > 0.05 || Math.abs(sy - 1) > 0.05) return null; // snapshots are 1:1
  let best = { x: 0, y: 0, score: 0 };
  const lumaAt = (x: number, y: number) => {
    const i = (y * r.width + x) * 4;
    return (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
  };
  for (let y = 0; y <= r.height - 16; y++) {
    for (let x = 0; x <= r.width - 16; x++) {
      let hit = 0;
      for (const p of POINTER_PIXELS) {
        const l = lumaAt(x + p.dx, y + p.dy);
        if (p.white ? l > 200 : l < 45) hit++;
      }
      if (hit > best.score) best = { x, y, score: hit };
    }
  }
  const score = best.score / POINTER_PIXELS.length;
  const close = near && Math.abs(best.x - near.x) < 40 &&
    Math.abs(best.y - near.y) < 40;
  return score >= 0.8 || (close && score >= 0.5)
    ? { x: best.x, y: best.y, score }
    : null;
}

// Bio Metal Gust, the disc's built-in sample, is what USER launches when the
// LOAD did not take. Its title as an 11x8 luma grid, to refuse that outcome.
const SAMPLE_TITLE_GRID = [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  19,
  73,
  102,
  112,
  130,
  70,
  92,
  68,
  1,
  0,
  0,
  20,
  81,
  88,
  102,
  144,
  46,
  80,
  67,
  4,
  0,
  0,
  8,
  16,
  37,
  62,
  98,
  64,
  29,
  15,
  7,
  0,
  0,
  0,
  0,
  5,
  12,
  76,
  12,
  5,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  19,
  7,
  3,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  2,
  24,
  8,
  9,
  0,
  0,
  0,
  0,
];

export function lumaGrid(r: Raster, gx = 11, gy = 8): number[] {
  const out: number[] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const [a, b, c] = regionMean(
        r,
        Math.floor(i * r.width / gx),
        Math.floor(j * r.height / gy),
        Math.floor((i + 1) * r.width / gx),
        Math.floor((j + 1) * r.height / gy),
      );
      out.push(Math.round((a + b + c) / 3));
    }
  }
  return out;
}

export function looksLikeSampleTitle(r: Raster): boolean {
  const g = lumaGrid(r);
  const diff =
    g.reduce((acc, v, i) => acc + Math.abs(v - SAMPLE_TITLE_GRID[i]), 0) /
    g.length;
  return diff < 12;
}

/** Fraction of pixels that differ noticeably between two frames. */
export function changedFraction(a: Raster, b: Raster): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let changed = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const d = Math.abs(a.data[j] - b.data[j]) +
      Math.abs(a.data[j + 1] - b.data[j + 1]) +
      Math.abs(a.data[j + 2] - b.data[j + 2]);
    if (d > 48) changed++;
  }
  return changed / n;
}

// ---- the recording ---------------------------------------------------------

export interface MovInfo {
  durationSec: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
}

export async function probeMov(path: string): Promise<MovInfo> {
  const out = await new Deno.Command("ffprobe", {
    args: [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=width,height,r_frame_rate,nb_read_frames,duration",
      "-of",
      "json",
      path,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new SaturnError(
      `ffprobe failed on ${path}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const j = JSON.parse(new TextDecoder().decode(out.stdout));
  const st = j.streams?.[0];
  if (!st) throw new SaturnError(`no video stream in ${path}`);
  const [num, den] = String(st.r_frame_rate).split("/").map(Number);
  const fps = den ? num / den : num;
  const frames = Number(st.nb_read_frames);
  const durationSec = Number(st.duration) || frames / fps;
  return {
    durationSec,
    fps,
    frames,
    width: Number(st.width),
    height: Number(st.height),
  };
}

/** Extract `[start, start+len)` seconds of the movie at `fps` into `dir`. */
export async function extractFrames(
  mov: string,
  dir: string,
  start: number,
  len: number,
  fps: number,
  prefix = "f",
): Promise<string[]> {
  await ensureDir(dir);
  // Mednafen records the Saturn at its widest horizontal mode (10560 px for
  // a 480-line frame) and leaves the true shape in the sample aspect ratio,
  // so every frame is squeezed back to what a TV would show.
  const out = await new Deno.Command("ffmpeg", {
    args: [
      "-v",
      "error",
      "-y",
      "-i",
      mov,
      "-ss",
      start.toFixed(3),
      "-t",
      len.toFixed(3),
      "-vf",
      `fps=${fps},scale=trunc(iw*sar/2)*2:ih,setsar=1`,
      "-start_number",
      "0",
      join(dir, `${prefix}%05d.png`),
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new SaturnError(
      `ffmpeg failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  const files = (await listPngs(dir)).filter((p) => p.includes(`/${prefix}`))
    .sort();
  return files;
}

/** A coarse luma thumbnail, so frames of different sizes can be compared. */
export function thumb(r: Raster, gx = 48, gy = 32): number[] {
  const out: number[] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const x = Math.floor((i + 0.5) * r.width / gx);
      const y = Math.floor((j + 0.5) * r.height / gy);
      const k = (y * r.width + x) * 4;
      out.push((r.data[k] + r.data[k + 1] + r.data[k + 2]) / 3);
    }
  }
  return out;
}

export function thumbDistance(a: number[], b: number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

/**
 * Find the Start press in the recording: the armed GAME START menu is a
 * still picture from the state load to the press, so the press is the first
 * frame after the FIRST run of frames matching the armed snapshot (armRun's).
 * Nothing here depends on the wall clock, so an emulator that fell behind
 * real time still yields the right frame. A 10 fps pass over the movie finds
 * the run; a full-rate pass around its end pins the frame. The last match
 * in the whole movie is deliberately not used: a dark menu and the black
 * frame Mednafen writes on exit can thumb alike.
 */
export async function findStartInMov(
  mov: string,
  info: MovInfo,
  armed: Raster,
  scratchDir: string,
): Promise<{ sec: number; frame: number }> {
  // Identical frames thumb to ~0 (CSCD is lossless); the level after the
  // menu is never that close, even when it opens black.
  const key = thumb(armed);
  const matches = async (file: string) =>
    thumbDistance(key, thumb(await decodePng(await Deno.readFile(file)))) < 3;
  const coarseFps = 10;
  const coarse = await extractFrames(
    mov,
    join(scratchDir, "coarse"),
    0,
    info.durationSec,
    coarseFps,
    "c",
  );
  let first = -1;
  let end = -1;
  for (let i = 0; i < coarse.length; i++) {
    const m = await matches(coarse[i]);
    if (m && first < 0) first = i;
    if (!m && first >= 0) {
      end = i;
      break;
    }
  }
  if (first < 0) {
    throw new SaturnError(
      "the armed GAME START menu never appears in the Saturn recording",
    );
  }
  if (end < 0) {
    throw new SaturnError(
      "the Start press was not followed by motion in the Saturn recording",
    );
  }
  // The press lies between coarse frames end-1 and end.
  const t0 = Math.max(0, (end - 1) / coarseFps - 0.05);
  const fine = await extractFrames(
    mov,
    join(scratchDir, "fine"),
    t0,
    0.2 + 1 / coarseFps,
    info.fps,
    "f",
  );
  let lastFine = -1;
  for (let i = 0; i < fine.length; i++) {
    if (await matches(fine[i])) lastFine = i;
    else if (lastFine >= 0) break;
  }
  if (lastFine < 0) lastFine = 0;
  const frame = Math.round(t0 * info.fps) + lastFine + 1;
  return { sec: frame / info.fps, frame };
}
