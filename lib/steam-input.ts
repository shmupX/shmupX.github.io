// Steam Input, switched off for shmupX's own Steam entries on macOS.
//
// Steam Input works by hiding the real pad from the game and presenting a
// virtual one in its place. On Windows and Linux that virtual pad is an Xbox
// controller the launcher's page reads like any other. macOS has no virtual
// gamepad for Steam to present, so a non-Steam game there gets the pad through
// Steam Input only as keyboard and mouse — and with the template Steam picks
// for a shortcut, not at all. Meanwhile Steam keeps the pad open and keeps
// talking to it (a Switch Pro controller is driven in a mode of Steam's own),
// so from Big Picture the player's presses go nowhere the launcher can see.
//
// Turning Steam Input off for the entry is what hands the pad back: the page
// then reads it natively through the Gamepad API, as it does outside Steam.
// That is a per-game choice Steam keeps in each account's localconfig.vdf —
//
//   "UserLocalConfigStore" { "apps" { "<appid>" { "UseSteamControllerConfig" "0" } } }
//
// where <appid> is the entry's unsigned 32-bit id, "0" is off and "2" is on;
// absent means the client's default. It is the same key Steam's own Controller
// settings write, and what Steam ROM Manager writes for the shortcuts it adds.
//
// Two rules follow from the file belonging to Steam:
//
//   * Steam rewrites localconfig.vdf from memory the whole time it runs, so an
//     edit made underneath a running client is lost. This only writes while
//     Steam is closed, and keepSteamInputOff waits for that moment if it has to.
//   * A player who chose a setting for the entry keeps it: an id that already
//     has UseSteamControllerConfig is left alone, whatever its value.
//
// The edit never re-serialises the file. It is somebody's entire local Steam
// state in a text format this code only partly knows, so the parser below
// records where every block closes and the edit is a pure insertion before a
// closing brace — every byte that was there stays where it was.

import { join } from "@std/path";
import {
  FAVORITES_TAG,
  quotePath,
  shortcutAppId,
  shortcutsOf,
  tagsOf,
  unquotePath,
} from "./steam-shortcut.ts";
import {
  steamAccounts,
  steamIsRunning,
  type SteamOs,
  steamRoots,
} from "./steam-library.ts";
import { parseBinaryVdf, VdfError, type VdfMap } from "./steam-vdf.ts";

/** The file, beside shortcuts.vdf in each account's config directory. */
export const LOCAL_CONFIG = "localconfig.vdf";

/** What Steam writes for a game whose Steam Input was switched off. */
export const STEAM_INPUT_OFF: ReadonlyArray<readonly [string, string]> = [
  ["UseSteamControllerConfig", "0"],
  // Steam writes these two beside it with their defaults; so does SRM.
  ["SteamControllerRumble", "-1"],
  ["SteamControllerRumbleIntensity", "320"],
];

// ------------------------------------------------------------- text format

/** A `{ … }` in a text KeyValues file, with where its braces are. */
export interface TextBlock {
  /** Offset of the `{`. */
  open: number;
  /** Offset of the matching `}`; the end of the text for the top level. */
  close: number;
  /** Nesting: 0 for a block that is itself at the top level. */
  depth: number;
  entries: TextEntry[];
}

export interface TextEntry {
  key: string;
  value: string | TextBlock;
}

type Token =
  | { kind: "string"; value: string; at: number }
  | { kind: "open" | "close"; at: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "{" || c === "}") {
      tokens.push({ kind: c === "{" ? "open" : "close", at: i });
      i++;
    } else if (c === "[") {
      // A platform conditional ([$WIN32]) qualifies the entry before it.
      // Nothing here needs to know which platform it names.
      const end = text.indexOf("]", i);
      if (end < 0) throw new VdfError(`unterminated conditional at ${i}`);
      i = end + 1;
    } else if (c === '"') {
      const at = i++;
      let value = "";
      while (true) {
        if (i >= text.length) {
          throw new VdfError(`unterminated string at ${at}`);
        }
        const d = text[i++];
        if (d === '"') break;
        if (d === "\\" && i < text.length) {
          const e = text[i++];
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else value += d;
      }
      tokens.push({ kind: "string", value, at });
    } else {
      const at = i;
      while (i < text.length && !/[\s{}"]/.test(text[i])) i++;
      tokens.push({ kind: "string", value: text.slice(at, i), at });
    }
  }
  return tokens;
}

/**
 * A text KeyValues file as nested blocks, each knowing where it closes.
 *
 * The top level is a block with no braces (open -1, close = text.length).
 */
export function parseTextVdf(text: string): TextBlock {
  const tokens = tokenize(text);
  let t = 0;
  const readBlock = (open: number, depth: number, top: boolean): TextBlock => {
    const block: TextBlock = { open, close: text.length, depth, entries: [] };
    while (t < tokens.length) {
      const key = tokens[t++];
      if (key.kind === "close") {
        if (top) throw new VdfError(`unexpected } at ${key.at}`);
        block.close = key.at;
        return block;
      }
      if (key.kind !== "string") {
        throw new VdfError(`expected a key at ${key.at}`);
      }
      const next = tokens[t++];
      if (!next) throw new VdfError(`"${key.value}" has no value`);
      if (next.kind === "string") {
        block.entries.push({ key: key.value, value: next.value });
      } else if (next.kind === "open") {
        block.entries.push({
          key: key.value,
          value: readBlock(next.at, top ? depth : depth + 1, false),
        });
      } else {
        throw new VdfError(`"${key.value}" is followed by } at ${next.at}`);
      }
    }
    if (!top) throw new VdfError(`a block opened at ${open} never closes`);
    return block;
  };
  return readBlock(-1, 0, true);
}

/** An entry by key. KeyValues keys are case-insensitive, as Steam reads them. */
export function findEntry(
  block: TextBlock,
  key: string,
): TextEntry | undefined {
  const wanted = key.toLowerCase();
  return block.entries.find((e) => e.key.toLowerCase() === wanted);
}

type Lines = ReadonlyArray<readonly [string, string | Lines]>;

function render(entries: Lines, indent: number): string[] {
  const tabs = "\t".repeat(indent);
  const out: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      out.push(`${tabs}"${key}"\t\t"${value}"`);
    } else {
      out.push(`${tabs}"${key}"`, `${tabs}{`, ...render(value, indent + 1));
      out.push(`${tabs}}`);
    }
  }
  return out;
}

/** `text` with `entries` added as the last children of `block`. */
function insertInto(text: string, block: TextBlock, entries: Lines): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = render(entries, block.depth + 1);
  const lineStart = text.lastIndexOf("\n", block.close - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, block.close))) {
    // The usual shape: the } on a line of its own. The new lines go in front
    // of that line, so its indentation stays exactly as it was.
    return text.slice(0, lineStart) + lines.join(nl) + nl +
      text.slice(lineStart);
  }
  return text.slice(0, block.close) + nl + lines.join(nl) + nl +
    "\t".repeat(block.depth) + text.slice(block.close);
}

export interface SteamInputEdit {
  text: string;
  /** Ids that now say off. */
  changed: number[];
  /** Ids that already carried a choice, left as they were. */
  kept: number[];
}

/**
 * localconfig.vdf's text with Steam Input off for each of `appIds`, except
 * where the player already chose.
 *
 * Throws VdfError for a file this cannot read with confidence, which the
 * caller turns into "left untouched".
 */
export function withSteamInputOff(
  text: string,
  appIds: readonly number[],
): SteamInputEdit {
  const changed: number[] = [];
  const kept: number[] = [];
  for (const appId of new Set(appIds)) {
    const id = String(appId >>> 0);
    const store = findEntry(parseTextVdf(text), "UserLocalConfigStore");
    if (!store || typeof store.value === "string") {
      throw new VdfError("no UserLocalConfigStore block");
    }
    const apps = findEntry(store.value, "apps");
    if (apps && typeof apps.value === "string") {
      throw new VdfError('"apps" is a value, not a block');
    }
    const app = apps ? findEntry(apps.value as TextBlock, id) : undefined;
    if (!apps) {
      text = insertInto(text, store.value, [["apps", [[id, STEAM_INPUT_OFF]]]]);
    } else if (!app) {
      text = insertInto(text, apps.value as TextBlock, [[id, STEAM_INPUT_OFF]]);
    } else if (typeof app.value === "string") {
      kept.push(appId >>> 0);
      continue;
    } else if (findEntry(app.value, "UseSteamControllerConfig")) {
      kept.push(appId >>> 0);
      continue;
    } else {
      const block = app.value;
      text = insertInto(
        text,
        block,
        STEAM_INPUT_OFF.filter(([key]) => !findEntry(block, key)),
      );
    }
    changed.push(appId >>> 0);
  }
  // Read back what was written: every id it claims to have changed must say
  // off, or none of it is used.
  if (changed.length) {
    const apps = findEntry(
      findEntry(parseTextVdf(text), "UserLocalConfigStore")!
        .value as TextBlock,
      "apps",
    )!.value as TextBlock;
    for (const id of changed) {
      const app = findEntry(apps, String(id))?.value;
      const value = typeof app === "object"
        ? findEntry(app, "UseSteamControllerConfig")?.value
        : undefined;
      if (value !== "0") {
        throw new VdfError(`the edit for ${id} did not read back as off`);
      }
    }
  }
  return { text, changed, kept };
}

// ------------------------------------------------------------- which ids

/**
 * The ids of shmupX's own entries in a shortcuts.vdf: the launcher's, and each
 * favorite's (lib/steam-favorites.ts). Matched on the tags this project files
 * them under, or on running one of `exes` — a player can drop an entry from a
 * collection, but it still runs the launcher.
 */
export function shmupxShortcutIds(
  root: VdfMap,
  exes: readonly string[],
): number[] {
  const wanted = new Set(exes.filter(Boolean).map((e) => unquotePath(e)));
  const out: number[] = [];
  for (const value of Object.values(shortcutsOf(root))) {
    if (!value || typeof value !== "object") continue;
    const entry = value as VdfMap;
    const tags = tagsOf(entry);
    const exe = unquotePath(entry.Exe);
    if (
      !tags.includes("shmupX") && !tags.includes(FAVORITES_TAG) &&
      !wanted.has(exe)
    ) continue;
    out.push(
      typeof entry.appid === "number"
        ? entry.appid >>> 0
        : shortcutAppId(quotePath(exe), String(entry.AppName ?? "")),
    );
  }
  return out;
}

// --------------------------------------------------------------------- disk

export interface SteamInputReport {
  /**
   * done — every account was looked at; steam-open — nothing was touched
   * because the client is running; no-steam — nothing to touch; skipped — not
   * macOS, where Steam Input is what makes a pad work at all.
   */
  state: "done" | "steam-open" | "no-steam" | "skipped";
  /** Entries switched off by this run. */
  changed: number;
  /** Entries that already carried the player's own choice. */
  kept: number;
  problems: string[];
}

/** Switch Steam Input off for shmupX's entries in every account, if Steam is closed. */
export async function turnOffSteamInput(opts: {
  os: SteamOs;
  env: Record<string, string>;
  /** The files shmupX's entries run (lib/steam-favorites.ts favoriteExe). */
  exes: readonly string[];
}): Promise<SteamInputReport> {
  const report: SteamInputReport = {
    state: "done",
    changed: 0,
    kept: 0,
    problems: [],
  };
  if (opts.os !== "darwin") return { ...report, state: "skipped" };
  const roots = await steamRoots(opts.os, opts.env);
  if (!roots.length) return { ...report, state: "no-steam" };
  if (await steamIsRunning(opts.os, opts.env)) {
    return { ...report, state: "steam-open" };
  }
  for (const root of roots) {
    for (const config of await steamAccounts(root)) {
      let ids: number[];
      try {
        ids = shmupxShortcutIds(
          parseBinaryVdf(await Deno.readFile(join(config, "shortcuts.vdf"))),
          opts.exes,
        );
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          report.problems.push(`${config}: ${(e as Error).message}`);
        }
        continue;
      }
      if (!ids.length) continue;
      const path = join(config, LOCAL_CONFIG);
      let edit: SteamInputEdit;
      try {
        edit = withSteamInputOff(await Deno.readTextFile(path), ids);
      } catch (e) {
        // No file yet is an account Steam has not finished setting up; it
        // writes one of its own, and the next run gets to it.
        if (!(e instanceof Deno.errors.NotFound)) {
          report.problems.push(
            `${path}: ${(e as Error).message}` +
              (e instanceof VdfError ? " — left untouched" : ""),
          );
        }
        continue;
      }
      report.kept += edit.kept.length;
      if (!edit.changed.length) continue;
      try {
        const temp = join(config, `.${LOCAL_CONFIG}.${crypto.randomUUID()}`);
        await Deno.writeTextFile(temp, edit.text);
        // The rename replaces the file, so it takes the temp file's mode
        // unless given Steam's back.
        const mode = (await Deno.stat(path)).mode;
        if (mode !== null) await Deno.chmod(temp, mode & 0o7777);
        await Deno.rename(temp, path);
        report.changed += edit.changed.length;
      } catch (e) {
        report.problems.push(`${path}: ${(e as Error).message}`);
      }
    }
  }
  return report;
}

interface Watch {
  opts: Parameters<typeof turnOffSteamInput>[0];
  timer: number | null;
  log: (line: string) => void;
}

// On globalThis because desktop.ts and the built server are two module graphs
// in one process, and both ask; one watch between them is enough.
const KEY = "__shmupxSteamInputWatch";

const switchedOff = (n: number) =>
  `  Steam Input: switched off for ${n} shmupX ${
    n === 1 ? "entry" : "entries"
  }`;

/** How often a pending change looks for Steam to have closed. */
export const STEAM_CLOSED_POLL_MS = 5000;

/**
 * turnOffSteamInput now — and if Steam is open, again the first moment it is
 * closed, for as long as this launcher runs. Quitting Steam to restart it,
 * which adding an entry asks for anyway, is that moment.
 */
export async function keepSteamInputOff(
  opts: Parameters<typeof turnOffSteamInput>[0],
  log: (line: string) => void = () => {},
): Promise<SteamInputReport> {
  const g = globalThis as unknown as Record<string, Watch | undefined>;
  const watch = g[KEY] ??= { opts, timer: null, log };
  watch.opts = opts;
  watch.log = log;
  const report = await turnOffSteamInput(opts);
  if (report.changed) log(switchedOff(report.changed));
  if (report.state !== "steam-open" || watch.timer !== null) return report;
  watch.timer = setInterval(async () => {
    try {
      const later = await turnOffSteamInput(watch.opts);
      if (later.state === "steam-open") return;
      if (later.changed) watch.log(switchedOff(later.changed));
    } catch { /* tried again next time Steam is seen closed */ }
    if (watch.timer !== null) clearInterval(watch.timer);
    watch.timer = null;
  }, STEAM_CLOSED_POLL_MS);
  // Waiting for Steam must never be what keeps the launcher alive.
  Deno.unrefTimer(watch.timer);
  return report;
}
