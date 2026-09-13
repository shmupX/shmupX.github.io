// "Add to Steam": the shortcut entry, and where Steam keeps the file it goes in.
//
// The launcher is already meant to be played from Steam — closing its window
// quits the process because that is what Steam needs to see the game end
// (desktop.ts:14), and lib/desktop-browser.ts scrubs Steam's environment off
// anything it spawns so the overlay's LD_PRELOAD does not crash a borrowed
// browser. What was never automated is the step before all that: adding the
// binary as a non-Steam game, which on a handheld in Game Mode means a file
// picker, a desktop session, and knowing where the AppImage landed.
//
// This is the part that can be a button. Everything here is a pure function of
// paths and bytes — lib/steam-library.ts finds the files and writes them, and
// routes/api/steam.ts is the button — so tests/steam_shortcut_test.ts can check
// the rules on a machine with no Steam on it at all.
//
// WHAT IS AND IS NOT KNOWN
// The binary KeyValues grammar (lib/steam-vdf.ts) and the key names below are
// reverse-engineered, not documented by Valve. Two consequences are designed
// around rather than asserted: a client that does not recognise a key leaves it
// alone, so writing the full set is safe; and the appid derivation is the
// community's, used by every third-party tool, so if it is wrong the only thing
// that breaks is which filename custom artwork has to use — Steam accepts
// whatever appid the file carries. `addShortcut` therefore never recomputes an
// appid for an entry that already exists.

import { crc32 } from "@shmupx/shmup-harbor/zip";
import type { VdfMap } from "./steam-vdf.ts";

/** Every key Steam writes for a non-Steam game, with the defaults to use. */
export interface ShortcutInput {
  /** What the library shows. */
  appName: string;
  /** The binary to run — an absolute path. */
  exe: string;
  /** Working directory; defaults to the directory holding `exe`. */
  startDir?: string;
  /** Icon file, or "" for Steam's placeholder. */
  icon?: string;
  /** Arguments, as one command-line string. */
  launchOptions?: string;
  /** Collections to file it under. */
  tags?: string[];
}

/**
 * Steam stores Exe and StartDir WRAPPED IN LITERAL DOUBLE QUOTES — the value
 * really does begin and end with a `"` character — because the field is a
 * command line rather than a path. A path written bare still launches, but it
 * does not match what Steam itself would write, so a later edit in the client
 * rewrites it and the appid (derived from this exact string) changes with it.
 */
export function quotePath(path: string): string {
  const bare = path.replace(/^"+|"+$/g, "");
  return `"${bare}"`;
}

/** The reverse, for comparing an entry already in the file against a path. */
export function unquotePath(value: unknown): string {
  return String(value ?? "").replace(/^"+|"+$/g, "");
}

/**
 * The id Steam files a non-Steam game's artwork under.
 *
 * CRC32 of the quoted Exe followed by the AppName, with the top bit set. The
 * unsigned result names the grid files (`grid/<id>p.png`, `<id>_hero.jpg`); the
 * same 32 bits read as SIGNED are what goes in the vdf's `appid` field, which
 * is why it is usually a negative number in there.
 */
export function shortcutAppId(exeQuoted: string, appName: string): number {
  const bytes = new TextEncoder().encode(exeQuoted + appName);
  return (crc32(bytes) | 0x80000000) >>> 0;
}

/** That id as the signed int32 the file stores. */
export function signedAppId(appId: number): number {
  return appId | 0;
}

/** `steam://rungameid/<id>` — the link that launches it. */
export function runGameId(appId: number): string {
  return ((BigInt(appId) << 32n) | 0x02000000n).toString();
}

/**
 * One shortcut, with every key a current client writes.
 *
 * `LastPlayTime` is 0 rather than now: it is Steam's to set, and a launcher
 * that stamped it would make a game look played that never was.
 */
export function makeShortcut(input: ShortcutInput): VdfMap {
  const exe = quotePath(input.exe);
  const startDir = quotePath(
    input.startDir ?? input.exe.replace(/[^/\\]+$/, "") ?? "",
  );
  const appId = shortcutAppId(exe, input.appName);
  const tags: VdfMap = {};
  (input.tags ?? []).forEach((tag, i) => {
    tags[String(i)] = tag;
  });
  return {
    appid: signedAppId(appId),
    AppName: input.appName,
    Exe: exe,
    StartDir: startDir,
    icon: input.icon ?? "",
    ShortcutPath: "",
    LaunchOptions: input.launchOptions ?? "",
    IsHidden: 0,
    AllowDesktopConfig: 1,
    AllowOverlay: 1,
    OpenVR: 0,
    Devkit: 0,
    DevkitGameID: "",
    DevkitOverrideAppID: 0,
    LastPlayTime: 0,
    FlatpakAppID: "",
    tags,
  };
}

/** The `shortcuts` map of a parsed file, or an empty one. */
function shortcutsOf(root: VdfMap): VdfMap {
  const found = root.shortcuts;
  return found && typeof found === "object" ? found as VdfMap : {};
}

export interface AddResult {
  /** The whole file, ready for writeBinaryVdf. */
  root: VdfMap;
  /** What happened: a new row, an existing one brought up to date, or nothing. */
  action: "added" | "updated" | "unchanged";
  /** Which index it sits at. */
  index: number;
  /** The artwork id — the existing one when the entry was already there. */
  appId: number;
}

/**
 * Put this shortcut in the file, replacing the launcher's own previous entry.
 *
 * "The launcher's own" is matched on the resolved Exe path OR the AppName, not
 * on the appid: the appid is derived from both, so the moment the AppImage is
 * updated in place under a new name — or the player renames the entry in Steam
 * — an appid match would miss and the library would grow a second shmupX every
 * time. Matching on either field is what makes pressing the button twice
 * idempotent.
 *
 * An entry that is already there keeps its appid, so whatever artwork the
 * player put on it survives.
 *
 * Every other shortcut in the file is preserved exactly as it was parsed; the
 * indices are renumbered because Steam expects them contiguous from "0".
 */
export function addShortcut(root: VdfMap, input: ShortcutInput): AddResult {
  const existing = shortcutsOf(root);
  const wantedExe = unquotePath(quotePath(input.exe));
  const entries: VdfMap[] = [];
  let mine: VdfMap | null = null;
  for (const value of Object.values(existing)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as VdfMap;
    const sameExe = unquotePath(entry.Exe) === wantedExe;
    const sameName = String(entry.AppName ?? "") === input.appName;
    if (!mine && (sameExe || sameName)) mine = entry;
    else entries.push(entry);
  }

  const fresh = makeShortcut(input);
  let action: AddResult["action"] = "added";
  let entry = fresh;
  if (mine) {
    // Keep the id the artwork is filed under, and anything a newer client wrote
    // that this code has never heard of.
    const keptAppId = typeof mine.appid === "number"
      ? mine.appid
      : fresh.appid as number;
    entry = { ...mine, ...fresh, appid: keptAppId };
    action = sameShortcut(mine, entry) ? "unchanged" : "updated";
  }

  const index = entries.length;
  entries.push(entry);
  const shortcuts: VdfMap = {};
  entries.forEach((value, i) => {
    shortcuts[String(i)] = value;
  });
  return {
    root: { ...root, shortcuts },
    action,
    index,
    appId: (entry.appid as number) >>> 0,
  };
}

/** Whether rewriting would change anything a client can see. */
function sameShortcut(before: VdfMap, after: VdfMap): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (typeof a === "object" || typeof b === "object") {
      if (JSON.stringify(a ?? {}) !== JSON.stringify(b ?? {})) return false;
    } else if (a !== b) return false;
  }
  return true;
}

/** Take the launcher's entry out again. */
export function removeShortcut(
  root: VdfMap,
  match: { exe?: string; appName?: string },
): { root: VdfMap; removed: number } {
  const wantedExe = match.exe ? unquotePath(quotePath(match.exe)) : null;
  const entries: VdfMap[] = [];
  let removed = 0;
  for (const value of Object.values(shortcutsOf(root))) {
    if (!value || typeof value !== "object") continue;
    const entry = value as VdfMap;
    const sameExe = wantedExe !== null && unquotePath(entry.Exe) === wantedExe;
    const sameName = !!match.appName &&
      String(entry.AppName ?? "") === match.appName;
    if (sameExe || sameName) {
      removed++;
      continue;
    }
    entries.push(entry);
  }
  const shortcuts: VdfMap = {};
  entries.forEach((value, i) => {
    shortcuts[String(i)] = value;
  });
  return { root: { ...root, shortcuts }, removed };
}
