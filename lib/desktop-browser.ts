// lib/desktop-browser.ts — how the packaged launcher (desktop.ts) puts its
// window on screen.
//
// The launcher is a loopback web server; its window is a browser. Handing the
// URL to xdg-open / `start` / `open` gets whatever the default browser feels
// like opening: a tab with an address bar reading 127.0.0.1, in a process the
// launcher never hears from again. Added to Steam as a non-Steam game (a Legion
// Go or Steam Deck on Bazzite, say) that reads as a web page rather than a
// game, and the server outlives the tab — Steam keeps showing STOP, and the
// next PLAY starts a second server on the next free port, whose origin holds
// none of the player's saves.
//
// So this picks a browser the launcher can *own*: a Chromium-family browser in
// --app/--kiosk mode, else Firefox in --kiosk mode — each on a dedicated
// profile under the launcher's own data directory. The dedicated profile is
// what makes the browser process live exactly as long as the window (a shared
// profile hands the URL to the already-running instance and exits at once),
// and it keeps the player's saves out of whichever profile they browse the web
// with. Flatpak installs count, since that is how Bazzite ships Firefox. Only
// when none of those exist does it fall back to the system opener.
//
// Anything spawned gets an environment scrubbed of Steam's: LD_PRELOAD
// (gameoverlayrenderer.so) and the steam-runtime LD_LIBRARY_PATH crash or
// starve a native browser, and the Vulkan overlay layer does the same to
// Chromium's GPU process. tools/build-level's Electron scaffold does the same
// for the per-level exports, for the same reason.

export type DesktopOs = "linux" | "windows" | "darwin";

export type Engine = "chromium" | "firefox" | "unknown";

/** One way of opening the window, in the order the launcher should try them. */
export interface BrowserLaunch {
  /** For the console: "Firefox (Flatpak)", "Google Chrome", … */
  label: string;
  cmd: string;
  args: string[];
  /**
   * True when the process lives as long as the window, so its exit means the
   * player closed the launcher. The system openers hand the URL off and exit
   * at once, which says nothing.
   */
  managed: boolean;
  /** Dedicated profile, created before launch. */
  profileDir?: string;
  /** Written into profileDir before every launch (Firefox reads user.js). */
  profileFiles?: Record<string, string>;
}

export interface PlanOptions {
  os: DesktopOs;
  /** The launcher's own environment — SHMUPX_BROWSER, HOME, PATH, … */
  env: Record<string, string>;
  /** Where profiles live: launcherDataDir(). */
  dataDir: string;
  /** A normal window instead of a fullscreen kiosk. */
  windowed: boolean;
  /** Is this command on PATH? */
  onPath: (cmd: string) => boolean;
  /** Does this path exist? (Fixed install paths, Flatpak exports.) */
  exists: (path: string) => boolean;
}

// Chromium-family browsers by the name they are on PATH under. Chrome first:
// it is the one a player most likely installed on purpose.
const LINUX_CHROMIUM = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "brave",
  "microsoft-edge",
  "microsoft-edge-stable",
  "vivaldi",
  "vivaldi-stable",
];
const LINUX_FIREFOX = ["firefox", "firefox-esr"];

const FLATPAK_CHROMIUM = [
  "com.google.Chrome",
  "org.chromium.Chromium",
  "com.brave.Browser",
  "com.microsoft.Edge",
  "com.vivaldi.Vivaldi",
];
const FLATPAK_FIREFOX = ["org.mozilla.firefox"];

// Values of SHMUPX_BROWSER that mean "the system default, the old way".
const SYSTEM_OPENER_NAMES = new Set([
  "default",
  "system",
  "xdg-open",
  "xdg",
  "start",
  "open",
]);

// Firefox applies user.js over prefs.js at every startup, so a fresh kiosk
// profile skips the first-run tabs and prompts a player would otherwise meet
// with no toolbar to dismiss them from, and never goes into the offline mode
// that used to refuse loopback URLs when Wi-Fi is off.
export const FIREFOX_USER_JS =
  `// Written by shmupX before every launch — edits here do not survive one.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.tabs.warnOnCloseOtherTabs", false);
user_pref("full-screen-api.warning.timeout", 0);
user_pref("network.manage-offline-status", false);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
`;

/** How long a managed browser has to stay up before its exit counts as "the
 * player closed the window" rather than "it never started". A Chromium handed
 * a URL for a profile already in use, or a browser missing a library, is gone
 * well inside this. */
export const EARLY_EXIT_MS = 3000;

/**
 * The launcher's per-user data directory: where browser profiles live.
 *
 *   Linux    $XDG_DATA_HOME/shmupX  (~/.local/share/shmupX)
 *   Windows  %LOCALAPPDATA%\shmupX
 *   macOS    ~/Library/Application Support/shmupX
 */
export function launcherDataDir(
  os: DesktopOs,
  env: Record<string, string>,
): string {
  if (os === "windows") {
    const local = env.LOCALAPPDATA ||
      `${env.USERPROFILE ?? "C:\\Users\\Default"}\\AppData\\Local`;
    return `${local}\\shmupX`;
  }
  const home = env.HOME || "/tmp";
  if (os === "darwin") return `${home}/Library/Application Support/shmupX`;
  const data = env.XDG_DATA_HOME || `${home}/.local/share`;
  return `${data}/shmupX`;
}

/**
 * The environment a browser is spawned with: the launcher's, minus everything
 * Steam put there for the game's benefit. Steam keeps the pre-Steam PATH and
 * LD_LIBRARY_PATH in SYSTEM_PATH / SYSTEM_LD_LIBRARY_PATH, so those are put
 * back rather than guessed.
 */
export function cleanBrowserEnv(
  env: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("STEAM_") ||
      key.startsWith("Steam") ||
      key.startsWith("PRESSURE_VESSEL_") ||
      key.startsWith("ENABLE_VK_LAYER_VALVE_") ||
      key === "LD_PRELOAD"
    ) continue;
    out[key] = value;
  }
  if ("SYSTEM_LD_LIBRARY_PATH" in env) {
    if (env.SYSTEM_LD_LIBRARY_PATH) {
      out.LD_LIBRARY_PATH = env.SYSTEM_LD_LIBRARY_PATH;
    } else delete out.LD_LIBRARY_PATH;
  }
  if (env.SYSTEM_PATH) out.PATH = env.SYSTEM_PATH;
  return out;
}

/** Which family a browser command belongs to, from its file name. */
export function engineOf(cmd: string): Engine {
  const base = cmd.replace(/\\/g, "/").split("/").pop()!.toLowerCase()
    .replace(/\.exe$/, "");
  if (/firefox|librewolf|waterfox/.test(base)) return "firefox";
  if (/chrome|chromium|brave|edge|vivaldi|opera/.test(base)) return "chromium";
  return "unknown";
}

function slugOf(cmd: string): string {
  const base = cmd.replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/i, "");
  return base.replace(/[^A-Za-z0-9._-]+/g, "-") || "browser";
}

function profileDirFor(slug: string, o: PlanOptions): string {
  const sep = o.os === "windows" ? "\\" : "/";
  return `${o.dataDir}${sep}browser${sep}${slug}`;
}

function chromiumArgs(
  url: string,
  profileDir: string,
  o: PlanOptions,
): string[] {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
  ];
  // A fresh Chrome profile on a Linux desktop otherwise asks to unlock the
  // login keyring before it shows anything.
  if (o.os === "linux") args.push("--password-store=basic");
  if (!o.windowed) args.push("--kiosk");
  args.push(`--app=${url}`);
  return args;
}

function firefoxArgs(
  url: string,
  profileDir: string,
  o: PlanOptions,
): string[] {
  // --no-remote: this instance is ours alone — no other `firefox <url>` lands
  // in the kiosk window, and it never hands *our* URL to a running Firefox.
  return [
    "--profile",
    profileDir,
    "--no-remote",
    o.windowed ? "--new-window" : "--kiosk",
    url,
  ];
}

function engineLaunch(
  label: string,
  cmd: string,
  engine: Engine,
  url: string,
  o: PlanOptions,
  wrap?: (args: string[], profileDir: string | undefined) => {
    cmd: string;
    args: string[];
  },
): BrowserLaunch {
  const profileDir = engine === "unknown"
    ? undefined
    : profileDirFor(slugOf(cmd), o);
  const args = engine === "chromium"
    ? chromiumArgs(url, profileDir!, o)
    : engine === "firefox"
    ? firefoxArgs(url, profileDir!, o)
    : [url];
  const run = wrap ? wrap(args, profileDir) : { cmd, args };
  return {
    label,
    cmd: run.cmd,
    args: run.args,
    managed: true,
    ...(profileDir ? { profileDir } : {}),
    ...(engine === "firefox"
      ? { profileFiles: { "user.js": FIREFOX_USER_JS } }
      : {}),
  };
}

// `flatpak run --filesystem=<dir> <id> …` lets the sandboxed browser see a
// profile directory outside its own ~/.var/app tree. The dir has to exist
// first, or bubblewrap has nothing to bind — the launcher creates it.
function flatpakLaunch(
  id: string,
  engine: Engine,
  url: string,
  o: PlanOptions,
): BrowserLaunch {
  return engineLaunch(
    `${flatpakName(id)} (Flatpak)`,
    id,
    engine,
    url,
    o,
    (args, profileDir) => ({
      cmd: "flatpak",
      args: [
        "run",
        ...(profileDir ? [`--filesystem=${profileDir}`] : []),
        id,
        ...args,
      ],
    }),
  );
}

function flatpakName(id: string): string {
  const names: Record<string, string> = {
    "org.mozilla.firefox": "Firefox",
    "com.google.Chrome": "Google Chrome",
    "org.chromium.Chromium": "Chromium",
    "com.brave.Browser": "Brave",
    "com.microsoft.Edge": "Microsoft Edge",
    "com.vivaldi.Vivaldi": "Vivaldi",
  };
  return names[id] ?? id;
}

function looksLikeFlatpakId(value: string): boolean {
  return !/[\\/]/.test(value) &&
    /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$/.test(value);
}

/** The directories Flatpak exports launchers into, system then user. */
export function flatpakExportBins(env: Record<string, string>): string[] {
  const home = env.HOME || "/tmp";
  const data = env.XDG_DATA_HOME || `${home}/.local/share`;
  return ["/var/lib/flatpak/exports/bin", `${data}/flatpak/exports/bin`];
}

function hasFlatpak(id: string, o: PlanOptions): boolean {
  return o.onPath("flatpak") &&
    flatpakExportBins(o.env).some((dir) => o.exists(`${dir}/${id}`));
}

export function systemOpener(url: string, os: DesktopOs): BrowserLaunch {
  if (os === "windows") {
    return {
      label: "the default browser (start)",
      cmd: "cmd",
      args: ["/c", "start", "", url],
      managed: false,
    };
  }
  if (os === "darwin") {
    return {
      label: "the default browser (open)",
      cmd: "open",
      args: [url],
      managed: false,
    };
  }
  return {
    label: "the default browser (xdg-open)",
    cmd: "xdg-open",
    args: [url],
    managed: false,
  };
}

// SHMUPX_BROWSER names the browser outright: a command on PATH, a path to one,
// or a Flatpak id. "default" (or any of SYSTEM_OPENER_NAMES) asks for the
// system opener, i.e. the pre-kiosk behaviour.
function overrideLaunch(
  value: string,
  url: string,
  o: PlanOptions,
): BrowserLaunch {
  if (SYSTEM_OPENER_NAMES.has(value.toLowerCase())) {
    return systemOpener(url, o.os);
  }
  const engine = engineOf(value);
  if (looksLikeFlatpakId(value)) return flatpakLaunch(value, engine, url, o);
  return engineLaunch(slugOf(value), value, engine, url, o);
}

function windowsInstalls(env: Record<string, string>): {
  label: string;
  path: string;
}[] {
  const pf = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || env["PROGRAMFILES(X86)"] ||
    "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA || "";
  const out = [
    {
      label: "Google Chrome",
      path: `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    },
    {
      label: "Google Chrome",
      path: `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    },
  ];
  if (local) {
    out.push({
      label: "Google Chrome",
      path: `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    });
  }
  out.push(
    {
      label: "Microsoft Edge",
      path: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    },
    {
      label: "Microsoft Edge",
      path: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    },
  );
  return out;
}

/**
 * Every way of opening the launcher window on this machine, best first, ending
 * with the system opener. The launcher tries them in order until one stays up.
 */
export function planBrowserLaunches(
  url: string,
  o: PlanOptions,
): BrowserLaunch[] {
  const override = (o.env.SHMUPX_BROWSER ?? "").trim();
  if (override) {
    const chosen = overrideLaunch(override, url, o);
    return chosen.managed ? [chosen, systemOpener(url, o.os)] : [chosen];
  }
  const out: BrowserLaunch[] = [];
  if (o.os === "linux") {
    for (const name of LINUX_CHROMIUM) {
      if (o.onPath(name)) {
        out.push(engineLaunch(name, name, "chromium", url, o));
      }
    }
    for (const id of FLATPAK_CHROMIUM) {
      if (hasFlatpak(id, o)) out.push(flatpakLaunch(id, "chromium", url, o));
    }
    for (const name of LINUX_FIREFOX) {
      if (o.onPath(name)) out.push(engineLaunch(name, name, "firefox", url, o));
    }
    for (const id of FLATPAK_FIREFOX) {
      if (hasFlatpak(id, o)) out.push(flatpakLaunch(id, "firefox", url, o));
    }
  } else if (o.os === "windows") {
    for (const { label, path } of windowsInstalls(o.env)) {
      if (o.exists(path)) {
        out.push(engineLaunch(label, path, "chromium", url, o));
      }
    }
  }
  // macOS: `open` only, unless SHMUPX_BROWSER points at a browser binary.
  out.push(systemOpener(url, o.os));
  return out;
}

// ------------------------------------------------------------------ runtime

export type WindowOutcome =
  /** A managed browser ran and the player closed it. */
  | "closed"
  /** Handed to the system opener; the tab's fate is unknown. */
  | "detached"
  /** Nothing could be started. */
  | "none";

export interface OpenOptions {
  os: DesktopOs;
  env: Record<string, string>;
  dataDir: string;
  windowed: boolean;
  log: (line: string) => void;
}

function commandOnPath(env: Record<string, string>, os: DesktopOs) {
  const dirs = (env.PATH ?? "").split(os === "windows" ? ";" : ":").filter(
    Boolean,
  );
  const exts = os === "windows"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  const sep = os === "windows" ? "\\" : "/";
  return (cmd: string): boolean => {
    for (const dir of dirs) {
      for (const ext of exts) {
        try {
          if (Deno.statSync(`${dir}${sep}${cmd}${ext}`).isFile) return true;
        } catch { /* not here */ }
      }
    }
    return false;
  };
}

function pathExists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the launcher window and, for a browser this process owns, wait for the
 * player to close it. Falls through the plan while candidates die young.
 */
export async function openLauncherWindow(
  url: string,
  o: OpenOptions,
): Promise<WindowOutcome> {
  const plan = planBrowserLaunches(url, {
    os: o.os,
    env: o.env,
    dataDir: o.dataDir,
    windowed: o.windowed,
    onPath: commandOnPath(o.env, o.os),
    exists: pathExists,
  });
  const env = cleanBrowserEnv(o.env);
  for (const launch of plan) {
    if (launch.profileDir) {
      try {
        await Deno.mkdir(launch.profileDir, { recursive: true });
        for (const [name, text] of Object.entries(launch.profileFiles ?? {})) {
          await Deno.writeTextFile(
            `${launch.profileDir}${o.os === "windows" ? "\\" : "/"}${name}`,
            text,
          );
        }
      } catch (err) {
        o.log(
          `  ${launch.label}: could not prepare ${launch.profileDir} (${
            (err as Error).message
          })`,
        );
        continue;
      }
    }
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(launch.cmd, {
        args: launch.args,
        env,
        clearEnv: true,
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
    } catch (err) {
      o.log(`  ${launch.label}: ${(err as Error).message}`);
      continue;
    }
    if (!launch.managed) {
      o.log(`  Opened in ${launch.label}.`);
      // Don't let a browser that stays attached to its launcher keep us alive.
      child.unref();
      return "detached";
    }
    o.log(
      `  Window: ${launch.label}, ${o.windowed ? "windowed" : "kiosk"} mode.`,
    );
    const started = Date.now();
    const status = await child.status;
    if (Date.now() - started < EARLY_EXIT_MS) {
      o.log(
        `  ${launch.label} exited with code ${status.code} right away — trying the next browser.`,
      );
      continue;
    }
    return "closed";
  }
  o.log(`  Could not open a browser. Open ${url} yourself.`);
  return "none";
}
