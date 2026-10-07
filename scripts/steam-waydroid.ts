#!/usr/bin/env -S deno run -A
// scripts/steam-waydroid.ts — put an Android build on Steam, through Waydroid
// and Lutris.
//
//   deno task steam:waydroid 2019                 # build if needed, install, list
//   deno task steam:waydroid 2019 --rebuild       # fresh APK first
//   deno task steam:waydroid "G-Fencer 755"       # any shelf name build:android takes
//   deno task steam:waydroid 2019 --restart-steam # and make Steam reread its list
//   deno task steam:waydroid 2019 --no-steam      # stop at the Lutris entry
//
// Steam cannot run an APK and Lutris has no Android runner, so the chain is
// the one a person would click through by hand:
//
//   1. the APK, from build/<slug>/dist — built with `deno task build:android`
//      when it is not there (or --rebuild), the way that task would build it;
//   2. installed into Waydroid, which needs a running session to take an
//      install, so one is started for the install and stopped again after;
//   3. a one-line launch script, kept outside build/ so a rebuild does not
//      move it, that runs `waydroid app launch <package id>`;
//   4. a Lutris game on the Linux runner whose exe is that script — written
//      through Lutris's own modules (its database, config and artwork paths),
//      not by hand, so the entry is one Lutris itself would have made;
//   5. Lutris's "Create Steam shortcut", by calling the function behind the
//      menu item, which puts `lutris lutris:rungameid/<id>` in Steam's
//      shortcuts.vdf and copies the artwork into Steam's grid folder.
//
// WHY A COMMITTED LEVEL RECORD WINS THE SHELF. The shelf refuses to build an
// eShop entry of kind "web" ("2019" is one: a playable web build already), and
// the escape hatch build-desktop offers is --level-file. A game whose record is
// committed at static/games/<slug>/level.json — the file `deno task 2019:zip`
// packs — is built from that file here without being asked, so the name on
// the eShop is enough.
//
// THE PACKAGE ID is read, not derived: from build/<slug>/cordova/config.xml
// when the build tree is there, else from the APK with aapt. The derivation
// lives in tools/build-level/lib/slug.js (an all-digit slug gets an "a" in
// front: 2019 → com.easierbycode.a2019) and a second copy here would be the
// one that drifts.
//
// STEAM READS shortcuts.vdf ONCE, at start. Writing to it while Steam runs is
// what Lutris's menu item does too, and Steam shows the entry after its next
// restart — but a Steam that is quit cleanly may write its own idea of the
// list back over the file first. --restart-steam closes that gap: it asks
// Steam to shut down (`steam -shutdown`, the clean way), waits for it, writes
// the shortcut, and starts Steam again through the user unit that autostarted
// it, so it comes back exactly as it was launched. Without the flag the
// shortcut is written as Lutris would write it and the restart is left to you.
//
// WHAT THE LAUNCH SCRIPT DOES ABOUT EXITING. `waydroid app launch` starts the
// session itself when none is running and then blocks for as long as the
// session lives — which is what keeps Steam showing the game as running. When
// a session is already up it returns at once, so the script then waits for the
// session to stop instead. Either way Steam marks the game finished when
// Waydroid's session ends, not when the app's window closes: there is no
// unprivileged way to ask Waydroid which app is in front. In Game Mode there
// is no desktop compositor for Waydroid to draw on, so the script hands the
// launch to Bazzite's waydroid-launcher, which opens one (cage) around it.

import { basename, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { parseArgs } from "@std/cli/parse-args";
import { slugFor } from "@shmupx/shmup-harbor/export";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";

const ROOT = repoRoot();
const HOME = Deno.env.get("HOME") ?? "";
/** Where the launch scripts live: outside build/, so a rebuild keeps them. */
const SCRIPT_DIR = join(HOME, ".local", "share", "shmupX", "waydroid");
/** Steam's user unit on Bazzite — what autostarted the Steam that is running. */
const STEAM_UNIT = "app-steam@autostart.service";

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = parseArgs(Deno.args, {
  string: ["apk", "package-id", "level-file", "name"],
  boolean: ["rebuild", "no-steam", "restart-steam", "help"],
});

if (args.help || !args._.length) {
  console.log(
    `usage: deno task steam:waydroid <game> [--apk PATH] [--package-id ID]
         [--level-file PATH] [--name TITLE] [--rebuild] [--no-steam]
         [--restart-steam]

  <game>           a name \`deno task build:android\` accepts (shelf:list)
  --apk            use this APK instead of build/<slug>/dist
  --package-id     the APK's application id, when it cannot be read
  --level-file     build from this level record (default: a committed
                   static/games/<slug>/level.json, when there is one)
  --name           the title Lutris and Steam show (default: <game>)
  --rebuild        build the APK even if one is already there
  --no-steam       make the Lutris entry and stop
  --restart-steam  quit Steam before writing the shortcut and start it after`,
  );
  Deno.exit(args.help ? 0 : 2);
}

const game = String(args._[0]);
const slug = slugFor(game);
const title = args.name ?? game;
const lutrisSlug = `shmupx-${slug}`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(1);
}

/** Run a command, inheriting stdio, and fail on a non-zero exit. */
async function run(cmd: string[], opts: { cwd?: string } = {}): Promise<void> {
  console.log(`$ ${cmd.join(" ")}`);
  const status = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) fail(`${cmd[0]} exited ${status.code}`);
}

/** Run a command and return its stdout, or "" if it fails. */
async function read(cmd: string[]): Promise<string> {
  try {
    const out = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
  } catch (_e) {
    return "";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (_e) {
    return false;
  }
}

async function which(name: string): Promise<boolean> {
  return (await read(["which", name])).trim().length > 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── 1. The APK ──────────────────────────────────────────────────────────────

async function newestApk(dir: string): Promise<string | null> {
  const apks: { path: string; mtime: number }[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.toLowerCase().endsWith(".apk")) continue;
      const path = join(dir, entry.name);
      apks.push({ path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 });
    }
  } catch (_e) { /* no dist yet */ }
  apks.sort((a, b) => b.mtime - a.mtime);
  return apks[0]?.path ?? null;
}

async function ensureApk(): Promise<string> {
  if (args.apk) {
    if (!(await exists(args.apk))) fail(`--apk ${args.apk}: no such file`);
    return args.apk;
  }
  const dist = join(ROOT, "build", slug, "dist");
  if (!args.rebuild) {
    const have = await newestApk(dist);
    if (have) {
      console.log(
        `APK      : ${have} (already built; --rebuild for a fresh one)`,
      );
      return have;
    }
  }
  const build = ["deno", "task", "build:android", game];
  const committed = join(ROOT, "static", "games", slug, "level.json");
  const levelFile = args["level-file"] ??
    ((await exists(committed)) ? committed : null);
  if (levelFile) {
    console.log(`Level    : ${levelFile}`);
    build.push("--level-file", levelFile);
  }
  console.log(`\nBuilding "${game}" for Android…`);
  await run(build, { cwd: ROOT });
  const built = await newestApk(dist);
  if (!built) fail(`the build finished but left no .apk in ${dist}`);
  return built;
}

// ─── 2. The package id ───────────────────────────────────────────────────────

async function findAapt(): Promise<string | null> {
  const roots = [
    Deno.env.get("ANDROID_SDK_ROOT"),
    Deno.env.get("ANDROID_HOME"),
    join(HOME, "Android", "Sdk"),
  ].filter((r): r is string => !!r);
  for (const root of roots) {
    const tools = join(root, "build-tools");
    const versions: string[] = [];
    try {
      for await (const e of Deno.readDir(tools)) {
        if (e.isDirectory) versions.push(e.name);
      }
    } catch (_e) {
      continue;
    }
    // Newest build-tools first; any aapt reads a manifest.
    versions.sort().reverse();
    for (const v of versions) {
      const aapt = join(tools, v, "aapt");
      if (await exists(aapt)) return aapt;
    }
  }
  return null;
}

async function packageIdOf(apk: string): Promise<string> {
  if (args["package-id"]) return args["package-id"];
  // The build tree's config.xml, when the APK is the one it built.
  const configXml = join(ROOT, "build", slug, "cordova", "config.xml");
  if (!args.apk && (await exists(configXml))) {
    const m = (await Deno.readTextFile(configXml)).match(
      /<widget[^>]*\sid="([^"]+)"/,
    );
    if (m) return m[1];
  }
  const aapt = await findAapt();
  if (aapt) {
    const m = (await read([aapt, "dump", "badging", apk])).match(
      /package: name='([^']+)'/,
    );
    if (m) return m[1];
  }
  return fail(
    `cannot read the package id of ${apk} (no build tree, no aapt) — pass --package-id`,
  );
}

// ─── 3. Waydroid ─────────────────────────────────────────────────────────────

async function waydroidSessionRunning(): Promise<boolean> {
  return /Session:\s*RUNNING/.test(await read(["waydroid", "status"]));
}

async function installIntoWaydroid(
  apk: string,
  packageId: string,
): Promise<void> {
  if (!(await which("waydroid"))) fail("waydroid is not installed");
  const status = await read(["waydroid", "status"]);
  if (/not initialized/i.test(status)) {
    fail(
      "Waydroid is not initialized — run `ujust setup-waydroid` (or `waydroid init`) first",
    );
  }
  if (
    (await read(["systemctl", "is-active", "waydroid-container"])).trim() !==
      "active"
  ) {
    fail(
      "waydroid-container.service is not running — `sudo systemctl start waydroid-container`",
    );
  }

  // An install goes through the running session's platform service, so a
  // stopped session is started for it — detached, since `waydroid session
  // start` runs for as long as the session does — and stopped again after.
  let startedSession = false;
  let session: Deno.ChildProcess | null = null;
  if (!(await waydroidSessionRunning())) {
    console.log("\nStarting a Waydroid session for the install…");
    session = new Deno.Command("waydroid", {
      args: ["session", "start"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    session.unref();
    startedSession = true;
    const deadline = Date.now() + 120_000;
    while (!(await waydroidSessionRunning())) {
      if (Date.now() > deadline) {
        fail("the Waydroid session did not come up within two minutes");
      }
      await sleep(2000);
    }
    // The session reports RUNNING a moment before Android is ready to take
    // an install; the package manager is up once the app list answers.
    const ready = Date.now() + 60_000;
    while (!/packageName/.test(await read(["waydroid", "app", "list"]))) {
      if (Date.now() > ready) break;
      await sleep(2000);
    }
  }

  console.log(`\nInstalling ${basename(apk)} into Waydroid…`);
  await run(["waydroid", "app", "install", apk]);
  // `waydroid app install` exits 0 whether or not Android took the package,
  // so look for it.
  let listed = false;
  for (let i = 0; i < 10 && !listed; i++) {
    listed = (await read(["waydroid", "app", "list"])).includes(
      `packageName: ${packageId}`,
    );
    if (!listed) await sleep(1500);
  }
  if (!listed) {
    fail(`${packageId} is not in \`waydroid app list\` after the install`);
  }
  console.log(`Installed: ${packageId}`);

  if (startedSession) {
    console.log("Stopping the session this started…");
    await read(["waydroid", "session", "stop"]);
    try {
      session?.kill();
    } catch (_e) { /* already gone */ }
  }
}

// ─── 4. The launch script ────────────────────────────────────────────────────

async function writeLaunchScript(packageId: string): Promise<string> {
  await ensureDir(SCRIPT_DIR);
  const path = join(SCRIPT_DIR, `${slug}.sh`);
  const script = `#!/usr/bin/env bash
# ${title} — launched in Waydroid. Written by \`deno task steam:waydroid ${
    JSON.stringify(game)
  }\`;
# rerun that to refresh it (and the APK it installs).
set -eu
PKG=${shellQuote(packageId)}

# Game Mode has no desktop compositor for Waydroid to draw on; Bazzite's
# waydroid-launcher opens one (cage) and runs the app inside it.
if [ "\${XDG_CURRENT_DESKTOP:-}" = "gamescope" ] || [ -n "\${GAMESCOPE_WAYLAND_DISPLAY:-}" ]; then
  if command -v waydroid-launcher >/dev/null 2>&1; then
    exec waydroid-launcher app launch "$PKG"
  fi
fi

# On the desktop, \`waydroid app launch\` starts the session itself when it is
# stopped and then blocks for as long as it lives — which is what keeps Steam
# showing the game as running. When a session is already up it returns at
# once, so wait for the session to end instead.
if waydroid status 2>/dev/null | grep -q 'Session:.*RUNNING'; then
  waydroid app launch "$PKG"
  sleep 3
  while waydroid status 2>/dev/null | grep -q 'Session:.*RUNNING'; do sleep 2; done
else
  exec waydroid app launch "$PKG"
fi
`;
  await Deno.writeTextFile(path, script);
  await Deno.chmod(path, 0o755);
  console.log(`\nLaunch script: ${path}`);
  return path;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─── 5 & 6. Lutris, and its Steam shortcut ───────────────────────────────────

/**
 * Everything Lutris-side runs inside Lutris's own Python modules: the game
 * row goes through lutris.database.games, the config through
 * lutris.config.write_game_config, the artwork to the paths
 * lutris.util.resources names, and the shortcut through
 * lutris.util.steam.shortcut.create_shortcut — the function behind the
 * "Create Steam shortcut" menu item. The icon is also laid out as a banner
 * and a cover so Steam's grid gets something other than a grey tile.
 */
const LUTRIS_PY = `
import json, os, shutil, sys, types
spec = json.loads(sys.argv[1])
from lutris import settings
from lutris.database import games as games_db
from lutris.config import write_game_config
from lutris.util import resources
from lutris.util.steam import shortcut

name, slug, exe, icon_src = spec["name"], spec["slug"], spec["exe"], spec.get("icon")
out = {}

# --- artwork: icon (png), banner + cover (jpg) from the game's icon ---------
has_icon = has_banner = has_cover = 0
if icon_src and os.path.exists(icon_src):
    try:
        from PIL import Image
        icon = Image.open(icon_src).convert("RGBA")
        os.makedirs(settings.ICON_PATH, exist_ok=True)
        icon.resize((128, 128), Image.LANCZOS).save(resources.get_icon_path(slug))
        has_icon = 1
        def card(size, scale):
            bg = Image.new("RGB", size, (16, 16, 20))
            side = int(min(size) * scale)
            art = icon.resize((side, side), Image.LANCZOS)
            bg.paste(art, ((size[0] - side) // 2, (size[1] - side) // 2), art)
            return bg
        os.makedirs(settings.BANNER_PATH, exist_ok=True)
        card((460, 215), 0.8).save(resources.get_banner_path(slug), quality=92)
        has_banner = 1
        os.makedirs(settings.COVERART_PATH, exist_ok=True)
        card((600, 900), 0.7).save(resources.get_cover_path(slug), quality=92)
        has_cover = 1
    except Exception as ex:  # artwork is a nicety; the entry is not
        out["artwork_error"] = str(ex)

# --- the game: Linux runner, exe = the launch script ------------------------
configpath = write_game_config(slug, {
    "game": {"exe": exe, "working_dir": os.path.dirname(exe)},
    "system": {},
})
row = {
    "name": name, "slug": slug, "runner": "linux", "platform": "Linux",
    "directory": os.path.dirname(exe), "installed": 1, "configpath": configpath,
    "has_custom_icon": has_icon, "has_custom_banner": has_banner,
    "has_custom_coverart_big": has_cover,
}
existing = games_db.get_games_by_slug(slug)
if existing:
    game_id = existing[0]["id"]
    old = existing[0].get("configpath")
    games_db.add_or_update(id=game_id, **row)
    if old and old != configpath:
        try: os.remove(os.path.join(settings.GAME_CONFIG_DIR, old + ".yml"))
        except FileNotFoundError: pass
    out["lutris"] = "updated"
else:
    game_id = games_db.add_game(**row)
    out["lutris"] = "added"
out["game_id"] = game_id
out["config"] = os.path.join(settings.GAME_CONFIG_DIR, configpath + ".yml")

# --- "Create Steam shortcut" -------------------------------------------------
if spec.get("steam"):
    g = types.SimpleNamespace(id=str(game_id), name=name, slug=slug, runner_name="linux")
    vdf = shortcut.get_shortcuts_vdf_path()
    if not vdf:
        out["steam"] = "no Steam user data directory found"
    elif shortcut.shortcut_exists(g):
        shortcut.set_artwork(g)
        out["steam"] = "already there"
    else:
        shortcut.create_shortcut(g)
        out["steam"] = "created"
    out["vdf"] = vdf
    out["steam_appid"] = shortcut.generate_appid(g)
print(json.dumps(out))
`;

async function lutrisAndSteam(
  exe: string,
  steam: boolean,
): Promise<Record<string, unknown>> {
  if (!(await which("lutris"))) {
    fail("lutris is not installed (or not on PATH)");
  }
  const iconCandidates = [
    join(ROOT, "static", "icons", `${slug}-icon.png`),
    join(ROOT, "build", slug, "cordova", "icons", "icon-512.png"),
    join(ROOT, "build", slug, "cordova", "icons", "icon-192.png"),
  ];
  let icon: string | null = null;
  for (const c of iconCandidates) {
    if (await exists(c)) {
      icon = c;
      break;
    }
  }

  const spec = JSON.stringify({
    name: title,
    slug: lutrisSlug,
    exe,
    icon,
    steam,
  });
  // -I: nothing from the current directory or the environment on the path —
  // the only modules wanted are Lutris's, under /usr/lib.
  const out = await new Deno.Command("python3", {
    args: ["-I", "-c", LUTRIS_PY, spec],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  if (!out.success) fail(`Lutris step failed:\n${stderr}`);
  const last = stdout.split("\n").pop() ?? "{}";
  try {
    return JSON.parse(last);
  } catch (_e) {
    return fail(`Lutris step gave no result:\n${stdout}\n${stderr}`);
  }
}

// ─── Steam restart ───────────────────────────────────────────────────────────

async function steamRunning(): Promise<boolean> {
  return (await read(["pgrep", "-x", "steam"])).trim().length > 0;
}

/** True when a game is running under Steam — then it must not be restarted. */
async function steamGameRunning(): Promise<boolean> {
  const procs = await read(["pgrep", "-fa", "SteamLaunch"]);
  return procs.split("\n").some((l) => l.includes("reaper"));
}

async function stopSteam(): Promise<void> {
  if (await steamGameRunning()) {
    fail(
      "a game is running under Steam — not restarting it; rerun without --restart-steam or close the game",
    );
  }
  console.log("\nAsking Steam to shut down…");
  await read(["steam", "-shutdown"]);
  const deadline = Date.now() + 90_000;
  while (await steamRunning()) {
    if (Date.now() > deadline) fail("Steam did not exit within 90 s");
    await sleep(2000);
  }
  // Let the unit notice; a `start` while it is still "deactivating" is a no-op.
  await sleep(2000);
}

async function startSteam(): Promise<void> {
  console.log("Starting Steam again…");
  const unit = await read([
    "systemctl",
    "--user",
    "show",
    "-p",
    "LoadState",
    STEAM_UNIT,
  ]);
  if (/LoadState=loaded/.test(unit)) {
    await read(["systemctl", "--user", "start", STEAM_UNIT]);
  } else {
    // Not Bazzite's autostart: launch it plainly, detached, as the user would.
    const p = new Deno.Command("steam", {
      args: ["-silent"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    p.unref();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log(`Game     : ${game}`);
console.log(`Slug     : ${slug}`);
console.log(`Title    : ${title}`);

const apk = await ensureApk();
const packageId = await packageIdOf(apk);
console.log(`Package  : ${packageId}`);

await installIntoWaydroid(apk, packageId);
const launcher = await writeLaunchScript(packageId);

const steam = !args["no-steam"];
const wasRunning = steam && args["restart-steam"] && (await steamRunning());
if (wasRunning) await stopSteam();

const result = await lutrisAndSteam(launcher, steam);

if (wasRunning) await startSteam();

console.log(
  `\nLutris   : ${result.lutris} "${title}" (id ${result.game_id}, runner linux)`,
);
console.log(`           ${result.config}`);
if (result.artwork_error) {
  console.log(`           artwork skipped: ${result.artwork_error}`);
}
if (steam) {
  console.log(
    `Steam    : shortcut ${result.steam} (appid ${result.steam_appid})`,
  );
  console.log(`           ${result.vdf}`);
  if (result.steam === "created" && !wasRunning && (await steamRunning())) {
    console.log(
      `\nSteam is running and reads that file only at start: restart Steam to see ` +
        `"${title}" in its library. If it is still missing after the restart, rerun ` +
        `with --restart-steam, which writes the shortcut while Steam is closed.`,
    );
  }
}
console.log(`\nLaunch   : ${launcher}`);
