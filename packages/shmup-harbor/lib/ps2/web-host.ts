// The web build of AthenaEnv: a page that runs a `deno task build:ps2`
// output's own main.js, unmodified, in the browser.
//
// `deno bundle` turns this file into the self-contained host.js that
// lib/ps2/web-build.ts writes beside a build's tree (`writeWebBuild`). The
// page loads it, and it:
//
//   1. reads the build's file list (files.json, written by writeWebBuild) and
//      athena.ini, from the folder the page names — `data-build` on #ps2, or
//      `?build=` — relative to the page;
//   2. fetches the text files main.js will `std.loadFile`, and decodes the
//      `.adp` effects it will play;
//   3. starts a Phaser game whose one scene preloads every PNG the build ships
//      as a texture keyed by its AthenaEnv path (`assets/game_ui.png`);
//   4. builds svelte-ps2's browser runtime over that scene —
//      `createRuntime(createPhaserHost(...))` — and AthenaEnv's own globals
//      over that (./web-native.ts), since main.js talks to the console's;
//   5. imports main.js, which runs exactly the code a console runs, title
//      secrets and runtime patches included. Its last statement would spin
//      forever on a console; here it finds `__PS2_HOST_LOOP__` and hands its
//      frame over instead (runtime-entry.ts), and every Phaser frame ticks it.
//
// For the bot (scripts/testdrive-parity.ts) the page publishes:
//
//   __PS2_PADS__    set(mask) / clear() / get() / held() / BUTTONS
//   __PS2_CTX__     the game's context — main.js sets it
//   __PS2_HOST__    { ready, frames, error, sounds, audio, base }
//   __PHASER_GAME__ the Phaser game, for scripts/lib/game-debug.ts's probe
//
// Its Timer reads the Phaser loop's own clock rather than performance.now(),
// so a debugger that takes over requestAnimationFrame and steps it steps the
// game's logic too, deterministically.

import Phaser from "phaser";
import { createRuntime, type PS2Runtime } from "@easierbycode/svelte-ps2";
import {
  createPhaserHost,
  registerCanvasBitmapFont,
} from "@easierbycode/svelte-ps2/phaser";
import { WebPadSource } from "./web-pads.ts";
import { registerProportionalCanvasFont } from "./web-font.ts";
import { createWebSound, type SoundEvent, type WebSound } from "./web-sound.ts";
import {
  athenaPath,
  type BuildFiles,
  createNativeGlobals,
  type HostStorage,
  installNativeGlobals,
} from "./web-native.ts";
import {
  bootScript,
  type HostState,
  isTextPath,
  parseAthenaIni,
  sfxPreloadPaths,
  type WebManifest,
} from "./web-files.ts";

const SCREEN = { width: 640, height: 448 };
const FONT_KEY = "ps2-default-font";

const g = globalThis as unknown as Record<string, unknown>;
const params = new URLSearchParams(location.search);
const mount = document.getElementById("ps2") ?? document.body;
const base = new URL(
  params.get("build") ?? mount.dataset.build ?? "./",
  location.href,
);
if (!base.pathname.endsWith("/")) base.pathname += "/";
const debug = params.has("debug");

const state: HostState = {
  ready: false,
  frames: 0,
  error: null,
  sounds: [],
  audio: "none",
  base: base.href,
};
g.__PS2_HOST__ = state;

const status = document.createElement("div");
status.className = "ps2-status";
mount.appendChild(status);
const say = (text: string) => (status.textContent = text);

function fail(error: unknown): void {
  const message = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
  state.error = message;
  status.classList.add("ps2-error");
  say(message);
  console.error("[ps2 host]", error);
}

const url = (path: string) => new URL(path, base).href;

async function fetchBytes(path: string): Promise<Uint8Array | null> {
  const response = await fetch(url(path));
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(path: string): Promise<string | null> {
  const response = await fetch(url(path));
  return response.ok ? await response.text() : null;
}

/** High scores and the like, per build, in this browser. */
function hostStorage(): HostStorage {
  const prefix = `shmupx-ps2:${base.pathname}:`;
  return {
    load(path) {
      try {
        return localStorage.getItem(prefix + path);
      } catch {
        return null;
      }
    },
    save(path, data) {
      try {
        localStorage.setItem(prefix + path, data);
      } catch {
        // Private windows and full quotas lose the high score, nothing else.
      }
    },
  };
}

/** A line of what the game just played, at the screen's foot, with ?debug. */
function soundHud(): (event: SoundEvent) => void {
  if (!debug) return () => {};
  const hud = document.createElement("div");
  hud.className = "ps2-hud";
  mount.appendChild(hud);
  const recent: string[] = [];
  return (event) => {
    recent.push(`♪ ${event.key}${event.audible ? "" : " (muted)"}`);
    if (recent.length > 4) recent.shift();
    hud.textContent = recent.join("   ");
  };
}

async function boot(): Promise<void> {
  say("loading…");
  const listing = await fetchText("files.json");
  if (listing === null) {
    throw new Error(
      `no files.json in ${base.href} — write the page with writeWebBuild() ` +
        `(packages/shmup-harbor/lib/ps2/web-build.ts)`,
    );
  }
  const manifest = JSON.parse(listing) as WebManifest;
  const paths = manifest.files.map((file) => file.path);
  const known = new Set(paths);

  const ini = parseAthenaIni(await fetchText("athena.ini") ?? "");
  const script = bootScript(ini);
  const mainText = await fetchText(script);
  if (mainText === null) throw new Error(`the build has no ${script}`);
  if (!mainText.includes("__PS2_HOST_LOOP__")) {
    // An older main.js ends in a loop that never yields to the page; importing
    // it would hang the tab for good.
    throw new Error(
      `${script} predates the browser host (it never yields its frame). ` +
        "Rebuild it with `deno task build:ps2`.",
    );
  }

  const texts = new Map<string, string>();
  await Promise.all(
    paths.filter(isTextPath).map(async (path) => {
      const text = await fetchText(path);
      if (text !== null) texts.set(path, text);
    }),
  );
  const files: BuildFiles = {
    has: (path) => known.has(path),
    text: (path) => texts.get(path) ?? null,
  };

  // No AudioContext for a build without audio: nothing would use it, and a
  // suspended one only earns an autoplay warning.
  const hasAudio = ini.audsrv !== "false" &&
    paths.some((path) => /\.(adp|wav)$/i.test(path));
  const Context = (globalThis as { AudioContext?: typeof AudioContext })
    .AudioContext;
  const hud = soundHud();
  const sound: WebSound = createWebSound({
    context: hasAudio && Context ? new Context() : null,
    load: (path) =>
      known.has(athenaPath(path))
        ? fetchBytes(athenaPath(path))
        : Promise.resolve(null),
    onEvent: hud,
  });
  state.sounds = sound.log;
  Object.defineProperty(state, "audio", { get: () => sound.state });
  for (const type of ["keydown", "pointerdown", "touchend"]) {
    addEventListener(type, () => sound.resume(), { passive: true });
  }
  if (hasAudio) {
    say("decoding sound…");
    await sound.preload(sfxPreloadPaths(paths));
  }

  const pads = new WebPadSource();
  g.__PS2_PADS__ = pads.scripted;

  // A TrueType face the build ships (lib/ps2/build.ts — Orbitron by default)
  // is the one main.js asks for by path; the page loads it before the game
  // starts, so the canvas font it backs is drawn in it and not a fallback.
  const fonts = new Map<string, string>();
  const faces = paths.filter((path) => /\.(ttf|otf)$/i.test(path));
  for (let i = 0; i < faces.length; i++) {
    const family = `ps2-face-${i}`;
    try {
      const face = new FontFace(family, `url(${url(faces[i])})`);
      await face.load();
      document.fonts.add(face);
      fonts.set(faces[i], family);
    } catch (error) {
      console.warn(`[ps2 host] ${faces[i]} did not load as a font`, error);
    }
  }

  say("");
  startGame({
    pngs: paths.filter((path) => /\.png$/i.test(path)),
    mainUrl: url(script),
    files,
    pads,
    sound,
    fonts,
  });
}

interface GameSetup {
  pngs: string[];
  mainUrl: string;
  files: BuildFiles;
  pads: WebPadSource;
  sound: WebSound;
  /** The build's own font files, by AthenaEnv path → the CSS family loaded. */
  fonts: Map<string, string>;
}

function startGame(setup: GameSetup): void {
  class Ps2Scene extends Phaser.Scene {
    private runtime: PS2Runtime | null = null;
    private frame: (() => void) | null = null;

    constructor() {
      super({ key: "Ps2Scene" });
    }

    preload() {
      for (const path of setup.pngs) this.load.image(path, url(path));
      this.load.on(
        "progress",
        (value: number) =>
          say(value < 1 ? `loading ${Math.round(value * 100)}%` : ""),
      );
    }

    create() {
      // AthenaEnv's built-in font, near enough: the port lays its title and
      // HUD out for glyphs about seven pixels wide.
      registerCanvasBitmapFont(this, FONT_KEY, {
        fontFamily: 'Consolas, "Lucida Console", "Courier New", monospace',
        fontSize: 12,
      });
      // The build's own faces, each a proportional canvas font (./web-font.ts)
      // at the size AthenaEnv draws a TrueType face before scaling — about 21
      // pixels to the em, measured in PCSX2 — so the scale main.js puts on it
      // (`__PS2_FONT_SCALE__`, lib/ps2/build.ts) sizes it as on a console.
      const faceKeys = new Map<string, string>();
      for (const [path, family] of setup.fonts) {
        const key = `ps2-font-${family}`;
        registerProportionalCanvasFont(this, key, {
          fontFamily: `"${family}", Consolas, monospace`,
          fontSize: 21,
          tracking: 1,
        });
        faceKeys.set(path, key);
      }
      const { host } = createPhaserHost({
        scene: this,
        screen: SCREEN,
        pads: setup.pads,
        // Screen.clear paints the clear colour main.js asks for.
        clear: false,
        resolveTexture: athenaPath,
        resolveFont: (path: string) => ({
          key: faceKeys.get(athenaPath(path)) ?? FONT_KEY,
        }),
      });
      const runtime = createRuntime(host);
      this.runtime = runtime;
      const loop = this.game.loop;

      installNativeGlobals(createNativeGlobals({
        runtime,
        files: setup.files,
        storage: hostStorage(),
        now: () => loop.now,
        sound: setup.sound.module,
      }));
      g.__PS2_HOST_LOOP__ = (frame: () => void) => {
        this.frame = frame;
        runtime.Screen.display(frame);
      };

      import(setup.mainUrl).then(() => {
        if (!this.frame) {
          throw new Error("main.js finished without handing over its frame");
        }
        state.ready = true;
      }).catch(fail);
    }

    override update() {
      if (!state.ready || !this.runtime || state.error) return;
      setup.pads.refresh();
      try {
        this.runtime.tick();
        state.frames++;
      } catch (error) {
        fail(error);
      }
    }
  }

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: mount,
    width: SCREEN.width,
    height: SCREEN.height,
    backgroundColor: "#000000",
    banner: false,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    // Input and sound are the host's own (./web-pads.ts, ./web-sound.ts);
    // Phaser's would only compete for the same keys and a second
    // AudioContext.
    input: { keyboard: false, mouse: false, touch: false, gamepad: false },
    audio: { noAudio: true },
    scene: [Ps2Scene],
  });
  g.__PHASER_GAME__ = game;
}

boot().catch(fail);
