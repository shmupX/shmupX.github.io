// AthenaEnv's own globals, rebuilt over svelte-ps2's browser runtime.
//
// The browser build runs a build's main.js unmodified, and main.js does not
// draw through svelte-ps2's browser API: it calls `createNativeRuntime()`,
// the adapter meant for a console, which wraps whatever `Screen`, `Draw`,
// `Image`, `Font`, `Pads`, `std` and `Timer` the global object holds and
// expects AthenaEnv's conventions from them. So the page has to provide a
// console's surface, and this builds one on top of
// `createRuntime(createPhaserHost(...))`. The two differ in exactly the ways
// the native adapter papers over, and here they are papered back:
//
//   * Colours. The native adapter rescales every Image tint and Font colour
//     from the browser convention (255 = untinted) to the GS one (128 =
//     untinted) before handing it over; `toShimColor` undoes that. Draw.rect
//     and Screen.clear colours pass through untouched both ways.
//   * Frames. A console clears in `Screen.clear` and presents in
//     `Screen.flip`. In the browser the host's tick brackets the frame
//     instead, so clear draws a full-screen rect and flip does nothing.
//   * Images and fonts. AthenaEnv's Image draws at its own width/height from
//     its startx..endy crop; the browser Image takes the size as arguments.
//     AthenaEnv's `new Font()` is its built-in font; the browser asks for
//     'default'.
//   * Files. `std.loadFile` answers from the build's text files, fetched
//     before main.js runs, and `std.open(path, "rb")` — runtime-sound.ts's
//     probe before every Sfx — answers from the build's file list. What the
//     game writes (its high score) goes to `storage`.
//
// Nothing here imports Phaser, so it can be exercised under Deno with any
// PS2Host behind it.

import {
  Color,
  type PS2FontInstance,
  type PS2ImageInstance,
  type PS2Runtime,
} from "@easierbycode/svelte-ps2";

/** The build's files, as main.js may ask for them. */
export interface BuildFiles {
  /** Does the build carry this file? */
  has(path: string): boolean;
  /** A text file's contents, when it was fetched as text. */
  text(path: string): string | null;
}

/** Where `std.open(path, "w")` writes go, and where they are read back. */
export interface HostStorage {
  load(path: string): string | null;
  save(path: string, data: string): void;
}

/** AthenaEnv's Timer module: microsecond timers. */
export interface AthenaTimer {
  "new"(): FrameTimerState;
  getTime(timer: FrameTimerState): number;
  setTime(timer: FrameTimerState, us: number): void;
  pause(timer: FrameTimerState): void;
  resume(timer: FrameTimerState): void;
  reset(timer: FrameTimerState): void;
  destroy(timer: FrameTimerState): void;
}

export interface FrameTimerState {
  base: number;
  pausedAt: number | null;
}

export interface NativeGlobalsOptions {
  /** `createRuntime(host)`: the browser half every global here draws through. */
  runtime: PS2Runtime;
  files: BuildFiles;
  storage: HostStorage;
  /** The clock every Timer reads, in milliseconds. */
  now: () => number;
  /** Installed as `Sound`. */
  sound: unknown;
}

/**
 * A path the way the build's file list names it.
 *
 * The game asks for `assets/game_ui.png`, but a console path can carry a
 * device (`cdfs:/`, `mass:/`, `cdrom0:\`), backslashes, a leading `./` or an
 * ISO version suffix (`;1`), and any of those has to land on the same file.
 */
export function athenaPath(path: string): string {
  return String(path)
    .replace(/\\/g, "/")
    .replace(/^[a-z][a-z0-9]*:\/*/i, "")
    .replace(/;\d+$/, "")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

/**
 * A GS colour word (128 = untinted) back to the browser convention (255 =
 * untinted). Alpha is the same in both — 128 is opaque — and is kept. GS
 * values above 128 over-brighten on a console; the browser cannot, so they
 * clamp to white.
 */
export function toShimColor(native: number): number {
  const up = (v: number) => Math.min(255, Math.round((v * 255) / 128));
  const r = native & 0xff;
  const g = (native >>> 8) & 0xff;
  const b = (native >>> 16) & 0xff;
  const a = (native >>> 24) & 0xff;
  return Color.new(up(r), up(g), up(b), a);
}

/** AthenaEnv's Timer over an injected clock. */
export function createFrameTimer(now: () => number): AthenaTimer {
  const current = (t: FrameTimerState) => t.pausedAt ?? now();
  return {
    new: () => ({ base: now(), pausedAt: null }),
    getTime: (t) => Math.round((current(t) - t.base) * 1000),
    setTime: (t, us) => {
      t.base = current(t) - us / 1000;
    },
    pause: (t) => {
      if (t.pausedAt === null) t.pausedAt = now();
    },
    resume: (t) => {
      if (t.pausedAt !== null) {
        t.base += now() - t.pausedAt;
        t.pausedAt = null;
      }
    },
    reset: (t) => {
      t.base = now();
      t.pausedAt = null;
    },
    destroy: () => {},
  };
}

/** QuickJS `std` file object, as much of it as anything here needs. */
interface StdFile {
  puts(data: string): void;
  write?(data: string): void;
  getline(): string | null;
  readAsString(): string;
  close(): void;
}

/**
 * Every global a console provides that main.js reads, keyed by its name.
 * `installNativeGlobals` puts them on the global object.
 */
export function createNativeGlobals(
  options: NativeGlobalsOptions,
): Record<string, unknown> {
  const { runtime, files, storage } = options;
  const mode = runtime.Screen.getMode();
  const NEUTRAL = Color.new(128, 128, 128, 128);

  const Screen = {
    getMode: () => runtime.Screen.getMode(),
    setVSync: (on: boolean) => runtime.Screen.setVSync(on),
    // The host's beginFrame already started the frame; this paints the clear
    // colour the native adapter asked for over it.
    clear: (color?: number) =>
      runtime.Draw.rect(
        0,
        0,
        mode.width,
        mode.height,
        color ?? Color.new(0, 0, 0, 128),
      ),
    // The host's endFrame presents.
    flip: () => {},
  };

  const Draw = {
    rect: (x: number, y: number, w: number, h: number, color: number) =>
      runtime.Draw.rect(x, y, w, h, color),
  };

  class Image {
    width: number;
    height: number;
    startx = 0;
    starty = 0;
    endx: number;
    endy: number;
    filter: number = runtime.LINEAR;
    color: number = NEUTRAL;
    #image: PS2ImageInstance;

    constructor(path: string) {
      this.#image = new runtime.Image(athenaPath(path));
      this.width = this.endx = this.#image.width;
      this.height = this.endy = this.#image.height;
    }

    draw(x: number, y: number): void {
      const image = this.#image;
      image.startx = this.startx;
      image.starty = this.starty;
      image.endx = this.endx;
      image.endy = this.endy;
      image.filter = this.filter;
      image.color = toShimColor(this.color);
      image.draw(x, y, this.width, this.height);
    }
  }

  class Font {
    scale = 1;
    color: number = NEUTRAL;
    #font: PS2FontInstance;

    constructor(path?: string) {
      this.#font = new runtime.Font(
        path === undefined ? "default" : athenaPath(path),
      );
    }

    print(x: number, y: number, text: string): void {
      this.#font.scale = this.scale;
      this.#font.print(x, y, String(text), toShimColor(this.color));
    }

    getTextSize(text: string): { width: number; height: number } {
      this.#font.scale = this.scale;
      return this.#font.getTextSize(String(text));
    }
  }

  const readable = (path: string): string | null =>
    storage.load(path) ?? files.text(path);

  const std = {
    loadFile: (path: string): string | null => readable(athenaPath(path)),
    open: (path: string, mode = "r"): StdFile | null => {
      const at = athenaPath(path);
      if (/[wa+]/.test(mode)) {
        let buffer = /a/.test(mode) ? storage.load(at) ?? "" : "";
        return {
          puts: (data: string) => void (buffer += String(data)),
          write: (data: string) => void (buffer += String(data)),
          getline: () => null,
          readAsString: () => buffer,
          close: () => storage.save(at, buffer),
        };
      }
      // A read: a file the build carries opens even when its bytes were never
      // fetched as text (a probe only wants to know it is there).
      const text = readable(at);
      if (text === null && !files.has(at)) return null;
      const lines = (text ?? "").split("\n");
      let line = 0;
      return {
        puts: () => {},
        getline: () => (line < lines.length ? lines[line++] : null),
        readAsString: () => text ?? "",
        close: () => {},
      };
    },
  };

  return {
    Screen,
    Draw,
    Color: runtime.Color,
    Pads: runtime.Pads,
    Image,
    Font,
    Timer: createFrameTimer(options.now),
    std,
    Sound: options.sound,
    // The browser runtime's own filter constants: the native adapter reads
    // these globals and hands them back unchanged, and the browser Image
    // compares against the same values.
    NEAREST: runtime.NEAREST,
    LINEAR: runtime.LINEAR,
  };
}

/**
 * Put the globals on `target`, as AthenaEnv has them before main.js runs.
 * Some shadow the page's own (`Image`, `Screen`), so this has to come after
 * anything that still needs those — Phaser's loader builds `new Image()`s.
 */
export function installNativeGlobals(
  globals: Record<string, unknown>,
  target: Record<string, unknown> = globalThis as unknown as Record<
    string,
    unknown
  >,
): void {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(target, name, {
      value,
      writable: true,
      configurable: true,
    });
  }
}
