// What the browser build and the page writer agree on: the file list a web
// build carries beside the game (files.json), and how athena.ini is read.
//
// lib/ps2/web-build.ts writes these from Deno; lib/ps2/web-host.ts reads them
// in the browser, which cannot list a directory over HTTP. Both import this,
// so it touches neither Deno nor the DOM.

import type { SoundEvent } from "./web-sound.ts";

/** files.json: every file of the build the page may ask for. */
export interface WebManifest {
  version: 1;
  /** Paths relative to the build folder, `/`-separated, sorted. */
  files: { path: string; size: number }[];
}

/** What the page publishes as `globalThis.__PS2_HOST__`. */
export interface HostState {
  /** main.js has run and handed over its frame. */
  ready: boolean;
  /** Frames ticked since then. */
  frames: number;
  /** Why the page stopped, when it did. */
  error: string | null;
  /** Every sound the game asked for, newest last (capped). */
  sounds: readonly SoundEvent[];
  /**
   * The page's AudioContext: "suspended" until the page is touched (browsers
   * hold sound back until then), "none" for a silent build.
   */
  audio: string;
  /** The build folder the page loaded, as an absolute URL. */
  base: string;
}

/**
 * Files only a console opens. A browser never boots the ELF or reads the
 * disc's boot record, and the ELF alone is most of a silent build.
 */
export const HARDWARE_ONLY: ReadonlySet<string> = new Set([
  "athena.elf",
  "ATHENA.ELF",
  "SYSTEM.CNF",
]);

/** The file list for a build's tree, minus what only a console opens. */
export function webManifest(
  entries: readonly { path: string; size: number }[],
): WebManifest {
  return {
    version: 1,
    files: entries
      .map((entry) => ({
        path: entry.path.replace(/\\/g, "/"),
        size: entry.size,
      }))
      .filter((entry) => !HARDWARE_ONLY.has(entry.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/**
 * athena.ini's `key = value` lines, quotes off. AthenaEnv's own reader is no
 * stricter: one setting per line, `#` or `;` starts a comment.
 */
export function parseAthenaIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** The script AthenaEnv boots: athena.ini's `default_script`, or main.js. */
export function bootScript(ini: Record<string, string>): string {
  const script = (ini.default_script ?? "").replace(/^(\.\/)+/, "");
  return script || "main.js";
}

/** Files main.js may `std.loadFile`, fetched as text before it runs. */
export function isTextPath(path: string): boolean {
  return /\.(json|txt|ini|cfg)$/i.test(path);
}

/**
 * The effects to decode before main.js runs: the sound pack's, which sits
 * flat in assets/sounds/. Anything deeper (the tone bank) decodes on first
 * use, so a build with hundreds of instrument samples does not hold the title
 * back for them.
 */
export function sfxPreloadPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => /^assets\/sounds\/[^/]+\.adp$/i.test(path));
}
