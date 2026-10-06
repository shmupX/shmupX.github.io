#!/usr/bin/env -S deno run -A
/**
 * `deno task testdrive:ps2:web "<level>"` — drive the packaged Mac app through
 * a PS2 export end to end, and photograph what comes out.
 *
 * What a person does by hand, and what this does for them: open the level
 * editor in the desktop app, load a cloud level (or import a web game's folder),
 * TARGET → PS2, EXPORT, → PS2 LIBRARY, back to the launcher, PLAYSTATION 2,
 * and press A on the WEB row under the new disc. Then, because the disc itself
 * is what the export is for and Play! cannot show it (README: AthenaEnv stalls
 * under its HLE kernel), boot the same .iso in PCSX2 and capture its title
 * screen. Every step is asserted, every screen is saved — each only once it
 * has drawn something, since a frame photographed on a timer is a black
 * frame — and the run ends in one report.
 *
 * It drives the REAL app — build/desktop/shmupX-mac-<arch>.app, launched with
 * a DevTools port — not a dev server, so what it proves is what a user gets:
 * the compiled launcher, its service worker, its build route, its library.
 * The CEF backend forwards --remote-debugging-port to Chromium, which is the
 * whole trick; everything after that is Runtime.evaluate against the editor's
 * and dashboard's own functions, the same calls their buttons make.
 *
 *   deno task testdrive:ps2:web "Master Arena Mod"        # a cloud level, by name
 *   deno task testdrive:ps2:web dev-fixtures/2019-web      # a web game folder, imported
 *   deno task testdrive:ps2:web "Master Arena Mod" -- --rebuild   # build:mac first
 *   deno task testdrive:ps2:web -- --help
 *
 * Output: build/testdrive/ps2-web/<slug>/ holding section.png (the shelf with
 * the disc and its WEB row), web.png (the web build running in the launcher
 * frame), title.png (the disc's title screen in PCSX2) and report.json.
 *
 * WHY THE APP IS LEFT RUNNING. The point of a test drive is to look at the
 * result, and the launcher is sitting on the game when this returns; --quit
 * closes it instead. The DevTools port stays open either way until it quits.
 *
 * IT WRITES TO THE CLOUD. The editor's export saves the open game to the
 * shared level database under its name before it builds (that is how the web
 * build gets a level to play), so a cloud level is re-saved and a directory
 * import is saved as a new level named after the folder (or --name). That is
 * exactly what a person pressing EXPORT does, and the level stays afterwards.
 *
 * Needs macOS (the packaged app is a .app), and for the title capture PCSX2
 * under /Applications plus the Xcode command line tools (a 20-line Swift
 * program lists windows; screencapture needs a window id). Without PCSX2 the
 * run still proves the browser half and says what it skipped.
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { Cdp } from "../packages/shmup-harbor/tools/sav-profiler/lib/web.ts";

const ROOT = repoRoot();
const DEFAULT_PORT = 9333;

const HELP = `deno task testdrive:ps2:web "<level name | web game folder>" [-- flags]

Drives the packaged Mac app through: load the game in the editor → TARGET PS2 →
EXPORT → → PS2 LIBRARY → launcher PLAYSTATION 2 → the WEB row under the disc,
then boots the .iso in PCSX2. Screenshots and report.json land in
build/testdrive/ps2-web/<slug>/.

  <level>            a cloud level's name, or a directory holding game.json
                     (imported as LOAD DIRECTORY would). Either is SAVED to the
                     shared level database under that name before the build.
  --name <n>         the level name to save and export a directory under (default: its basename)
  --rebuild          run \`deno task build:mac\` first (also done when no .app exists)
  --app <path>       the .app to drive (default: build/desktop/shmupX-mac-<arch>.app)
  --port <n>         DevTools port for the app (default: ${DEFAULT_PORT})
  --out <dir>        output directory (default: build/testdrive/ps2-web/<slug>)
  --settle <s>       seconds to wait after the web build first draws before web.png (default: 1)
  --picture-wait <s> how long the web build may stay black before failing (default: 90)
  --pcsx2-wait <s>   how long PCSX2 may stay black before failing (default: 120)
  --no-pcsx2         skip the PCSX2 boot and title capture
  --quit             quit the app when done (default: leave it on the game)
  --build-timeout <s>  how long the PS2 export may take (default: 600)
  --help`;

type Flags = {
  _: (string | number)[];
  name?: string;
  rebuild: boolean;
  app?: string;
  port: number;
  out?: string;
  settle: number;
  "picture-wait": number;
  "pcsx2-wait": number;
  pcsx2: boolean;
  quit: boolean;
  "build-timeout": number;
  help: boolean;
};

// `deno task … -- --flag` hands the script the bare `--` as well, and parseArgs
// stops at it; the sibling scripts strip it the same way.
const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  boolean: ["rebuild", "pcsx2", "quit", "help"],
  string: ["name", "app", "out"],
  default: {
    rebuild: false,
    pcsx2: true,
    quit: false,
    help: false,
    port: DEFAULT_PORT,
    settle: 1,
    "picture-wait": 90,
    "pcsx2-wait": 120,
    "build-timeout": 600,
  },
  negatable: ["pcsx2"],
}) as unknown as Flags;

const log = (line: string) => console.log(`[testdrive] ${line}`);
// PIDs this run started that must not outlive it (PCSX2's). Filled in below.
const spawned = new Set<number>();
function putDown(): void {
  for (const pid of spawned) { try { Deno.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  spawned.clear();
}
function fail(msg: string): never {
  console.error(`[testdrive] ${msg}`);
  putDown();
  Deno.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A probe that has SEEN the answer is "no" throws this, and until() stops at
// once instead of polling out its deadline and reporting a timeout.
class Abort extends Error {}
async function until<T>(
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

if (flags.help || flags._.length === 0) {
  console.log(HELP);
  Deno.exit(flags.help ? 0 : 2);
}
if (Deno.build.os !== "darwin") {
  fail("the packaged app this drives is a macOS .app; run this on the Mac");
}
const subject = String(flags._[0]);

// ── What is being driven ─────────────────────────────────────────────────────
// A directory with game.json is a web game to import; anything else is the
// name of a level in the cloud.
let importDir: string | null = null;
try {
  const p = resolve(ROOT, subject);
  const st = await Deno.stat(p);
  if (st.isDirectory) {
    await Deno.stat(join(p, "game.json"));
    importDir = p;
  }
} catch { /* not a folder with a game in it: a level name */ }
const levelName = importDir ? (flags.name ?? basename(importDir)) : subject;
const slug = levelName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "level";
const outDir = resolve(ROOT, flags.out ?? join("build", "testdrive", "ps2-web", slug));
await ensureDir(outDir);
// A run that stops early must not leave the previous run's pictures behind as
// if they were its own.
for (const stale of ["section.png", "web.png", "title.png", "report.json", "probe.png", "probe.bmp"]) {
  await Deno.remove(join(outDir, stale)).catch(() => {});
}

const report: Record<string, unknown> = {
  subject,
  importDir,
  levelName,
  startedAt: new Date().toISOString(),
  steps: {} as Record<string, unknown>,
};
const steps = report.steps as Record<string, unknown>;

// ── The app ──────────────────────────────────────────────────────────────────
const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
const appPath = resolve(ROOT, flags.app ?? join("build", "desktop", `shmupX-mac-${arch}.app`));
const appBinary = join(appPath, "Contents", "MacOS", "laufey");

async function run(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  const c = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd ?? ROOT,
    stdout: opts.quiet ? "piped" : "inherit",
    stderr: opts.quiet ? "piped" : "inherit",
  });
  const out = await c.output();
  if (!out.success) {
    throw new Error(`${cmd.join(" ")} exited ${out.code}${opts.quiet ? ": " + new TextDecoder().decode(out.stderr) : ""}`);
  }
  return opts.quiet ? new TextDecoder().decode(out.stdout) : "";
}

async function pidsMatching(needle: string): Promise<number[]> {
  const out = await run(["ps", "-axo", "pid=,command="], { quiet: true });
  return out.split("\n")
    .filter((l) => l.includes(needle) && !l.includes(" grep "))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n));
}

async function mainAppPids(): Promise<number[]> {
  // The main process is the one whose command IS the binary; the helpers carry
  // --type= and die with it.
  const out = await run(["ps", "-axo", "pid=,command="], { quiet: true });
  return out.split("\n")
    .filter((l) => l.includes(appBinary) && !l.includes("--type="))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n));
}
async function quitApp(): Promise<void> {
  const mains = await mainAppPids();
  for (const pid of mains) {
    try { Deno.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  if (!mains.length) return;
  // Gone means gone: the next launch binds the same DevTools port.
  await until("the previous app to exit", 10_000, async () => (await mainAppPids()).length === 0 ? true : null, 250)
    .catch(() => { for (const pid of mains) { try { Deno.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
}
async function devtoolsHolder(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    const v = await res.json() as { Browser?: string };
    return v.Browser ?? "something";
  } catch {
    return null;
  }
}

let needBuild = flags.rebuild;
try { await Deno.stat(appBinary); } catch { needBuild = true; }
if (needBuild) {
  log(`building the Mac app (deno task build:mac)…`);
  await run(["deno", "task", "build:mac"]);
  steps.rebuilt = true;
}

log(`quitting any running copy of ${basename(appPath)}…`);
await quitApp();
// Chromium cannot bind a DevTools port something else holds, and then runs
// without one in silence; this would wait a minute and blame the app.
{
  const holder = await until<string>("the DevTools port to be free", 10_000, async () =>
    (await devtoolsHolder(flags.port)) === null ? "free" : null, 500).catch(() => null);
  if (!holder) {
    fail(`DevTools port ${flags.port} is held by ${await devtoolsHolder(flags.port)}; quit it or pass --port <n>`);
  }
}
log(`launching ${basename(appPath)} with DevTools on :${flags.port}…`);
await run(["open", "-g", "-n", "-a", appPath, "--args", `--remote-debugging-port=${flags.port}`, "--no-open"]);

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };
const target = await until<Target>("the launcher page on the DevTools port", 60_000, async () => {
  const res = await fetch(`http://127.0.0.1:${flags.port}/json/list`);
  const list = await res.json() as Target[];
  return list.find((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1") && t.webSocketDebuggerUrl) ?? null;
});
const origin = new URL(target.url).origin;
log(`app is serving at ${origin}`);
report.origin = origin;
report.app = appPath;

const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("DOM.enable");

// "Has it drawn yet" is read off the pixels, not off a clock: a Dezaemon mod
// sits in its boot scene longer than a 2019 level does, and PCSX2 reaches the
// title of a 39 MB disc later than that of a 7 MB one, so every fixed delay
// this replaced photographed black at least once. A capture is converted to
// BMP by sips (the one decoder every Mac has) and two things are counted: the
// share of pixels that are not black, and how many distinct colours there are.
// Both have to clear a bar. Black fails the first; a window that has just been
// created and painted one flat colour before its first frame (PCSX2 does
// this) is fully lit and fails the second. A title screen has dozens of
// colours whatever its background. File sizes were tried first and lied: a
// black window's JPEG is mostly its title bar.
const LIT = 24; // a channel above this is "not black"
const MIN_LIT = 0.01; // share of pixels that must be lit
const MIN_COLOURS = 16; // distinct 4-bit-per-channel colours a drawn frame has
type Picture = { lit: number; colours: number };
function isDrawn(p: Picture): boolean {
  return p.lit >= MIN_LIT && p.colours >= MIN_COLOURS;
}
async function readPicture(png: string, skipTopShare = 0): Promise<Picture> {
  const bmp = png.replace(/\.png$/, ".bmp");
  await run(["sips", "-s", "format", "bmp", png, "--out", bmp], { quiet: true });
  const b = await Deno.readFile(bmp);
  await Deno.remove(bmp).catch(() => {});
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const off = dv.getUint32(10, true);
  const w = dv.getInt32(18, true);
  const hRaw = dv.getInt32(22, true);
  const bytes = dv.getUint16(28, true) / 8;
  const h = Math.abs(hRaw);
  const topDown = hRaw < 0;
  const stride = Math.ceil((w * bytes) / 4) * 4;
  const skip = Math.round(h * skipTopShare);
  const colours = new Set<number>();
  let lit = 0, total = 0;
  for (let row = 0; row < h; row++) {
    const y = topDown ? row : h - 1 - row;
    if (y < skip) continue;
    const base = off + row * stride;
    for (let x = 0; x < w; x += 2) {
      const i = base + x * bytes;
      if (Math.max(b[i], b[i + 1], b[i + 2]) > LIT) lit++;
      colours.add(((b[i] >> 4) << 8) | ((b[i + 1] >> 4) << 4) | (b[i + 2] >> 4));
      total++;
    }
  }
  return { lit: total ? lit / total : 0, colours: colours.size };
}
async function waitForPicture(
  what: string,
  timeoutMs: number,
  capture: () => Promise<string | null>, // writes a PNG, returns its path (null: nothing captured yet)
  skipTopShare = 0,
): Promise<Picture & { waitedMs: number }> {
  const t0 = Date.now();
  const r = await until<Picture>(`${what} to draw something`, timeoutMs, async () => {
    const png = await capture();
    if (!png) return null;
    const p = await readPicture(png, skipTopShare);
    return isDrawn(p) ? p : null;
  }, 1000);
  return { ...r, waitedMs: Date.now() - t0 };
}

async function navigate(url: string): Promise<void> {
  await cdp.send("Page.navigate", { url });
}
async function shot(name: string, quiet = false): Promise<string> {
  const r = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const path = join(outDir, name);
  await Deno.writeFile(path, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  if (!quiet) log(`wrote ${path}`);
  return path;
}

// ── The editor: load, export, file ───────────────────────────────────────────
await navigate(`${origin}/editor/?game=2028-ai`);
await until("the level editor", 90_000, () =>
  cdp.eval<boolean>(
    `typeof exportGameToApk === 'function' && typeof addPs2ExportToLibrary === 'function' && typeof loadFromFirebase === 'function' && typeof loadGameFilesFromFileList === 'function'`,
  ));
// The editor talks in dialogs. Answer them: alerts are collected for the
// report, confirms say yes, and the name prompt names the level.
await cdp.eval(`(() => {
  window.__td = { alerts: [] };
  window.alert = (m) => window.__td.alerts.push(String(m));
  window.confirm = () => true;
  window.prompt = () => ${JSON.stringify(levelName)};
  return true;
})()`);

if (importDir) {
  log(`importing ${importDir} as LOAD DIRECTORY would…`);
  // A directory path on a webkitdirectory input is what gives the editor the
  // same FileList the picker does (relative paths included); handing it the
  // files one by one leaves the list empty.
  await cdp.eval(`(() => {
    const inp = document.createElement('input');
    inp.id = 'td-dir-input'; inp.type = 'file'; inp.webkitdirectory = true; inp.multiple = true;
    inp.style.display = 'none'; document.body.appendChild(inp); return true;
  })()`);
  const doc = await cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
  const q = await cdp.send<{ nodeId: number }>("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#td-dir-input" });
  await cdp.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files: [importDir] });
  const imported = await cdp.eval<{ files: number; status: string; alerts: string[] }>(`(async () => {
    const files = Array.from(document.getElementById('td-dir-input').files);
    await loadGameFilesFromFileList(files);
    return { files: files.length, status: document.getElementById('status').textContent, alerts: window.__td.alerts };
  })()`);
  if (!imported.files || imported.alerts.length) {
    fail(`import failed: ${imported.alerts.join("; ") || "no files arrived"}`);
  }
  log(`imported ${imported.files} files (${imported.status})`);
  steps.import = imported;
} else {
  log(`loading cloud level "${levelName}"…`);
  const ok = await cdp.eval<boolean>(`loadFromFirebase(${JSON.stringify(levelName)})`);
  const alerts = await cdp.eval<string[]>(`window.__td.alerts`);
  if (!ok) fail(`could not load "${levelName}": ${alerts.join("; ") || "loadFromFirebase returned false"}`);
  steps.load = { ok, alerts };
}
await cdp.eval(`(() => { document.getElementById('firebase-level-name').value = ${JSON.stringify(levelName)}; window.__td.alerts = []; return true; })()`);

log(`exporting to PS2…`);
await cdp.eval(`(() => { setExportPlatform('ps2'); exportGameToApk(); return exportPlatform; })()`);
const built = await until<{ status: string; ps2Export: Record<string, unknown> | null }>(
  "the PS2 build",
  flags["build-timeout"] * 1000,
  async () => {
    const s = await cdp.eval<{ status: string; ps2Export: Record<string, unknown> | null }>(`({
      status: document.getElementById('export-apk-status').textContent,
      ps2Export: (typeof ps2Export !== 'undefined' && ps2Export && ps2Export.isoPath)
        ? { name: ps2Export.name, isoPath: ps2Export.isoPath, appDir: ps2Export.appDir, web: ps2Export.web, webUrl: ps2Export.webUrl }
        : null,
    })`);
    // The editor's own failure wordings, anchored: the status also quotes
    // the level's name, and a level may be called "Error Zone".
    if (/^(Export failed|Export needs|Export not queued|Could not|That is not a BUILD CODE|This game has no name)/i.test(s.status)) {
      throw new Abort(s.status);
    }
    // showPs2ExportActions settles webUrl a moment after ps2Export appears
    // (it imports the library module first), so wait for that too.
    return s.ps2Export && (s.ps2Export.webUrl || !s.ps2Export.web) ? s : null;
  },
  2000,
).catch((e) => fail(`PS2 export did not finish: ${e.message}`));
log(`disc built: ${built.ps2Export!.isoPath}`);
const webBtn = await cdp.eval<{ hidden: boolean; webUrl: string | null }>(
  `({ hidden: document.getElementById('export-ps2-web').classList.contains('hidden'), webUrl: ps2Export.webUrl })`,
);
steps.export = { ...built, playWebBuild: !webBtn.hidden };
if (!built.ps2Export!.web) fail("the export settled no web identity (ps2Export.web is empty)");
if (webBtn.hidden) fail("PLAY WEB BUILD stayed hidden after the build");
log(`panel offers PLAY WEB BUILD → ${webBtn.webUrl}`);

log(`filing the disc in the PS2 library…`);
await cdp.eval(`(() => { addPs2ExportToLibrary(); return true; })()`);
const filed = await until<{ id: string; note: string }>("the disc to be filed", 300_000, async () => {
  const s = await cdp.eval<{ id: string | null; note: string }>(
    `({ id: (ps2Export && ps2Export.id) || null, note: document.getElementById('export-ps2-note').textContent })`,
  );
  if (/^Could not/i.test(s.note)) throw new Abort(s.note);
  return s.id ? { id: s.id, note: s.note } : null;
}, 1500).catch((e) => fail(`filing failed: ${e.message}`));
const record = await cdp.eval<Record<string, unknown>>(`(async () => {
  const lib = await import('/ps2-library.js');
  const r = await lib.getPs2Game(${JSON.stringify(filed.id)});
  return r ? { id: r.id, name: r.name, size: r.size, source: r.source, web: r.web, webUrl: lib.ps2WebUrl(r.web) } : null;
})()`);
if (!record || !record.web) fail(`the filed record carries no web identity: ${JSON.stringify(record)}`);
log(`filed as ${record.id} (${((record.size as number) / 1048576).toFixed(1)} MB) with web ${JSON.stringify(record.web)}`);
steps.library = { ...filed, record };

// ── The launcher: the shelf, then the WEB row ────────────────────────────────
log(`opening the launcher's PLAYSTATION 2 section…`);
await navigate(`${origin}/`);
await until("the launcher's PlayStation 2 section tile", 60_000, () =>
  cdp.eval<boolean>(`[...document.querySelectorAll('.cmg-strip .strip-tile')].some(x => /playstation 2/i.test(x.textContent || ''))`));
const shelf = await cdp.eval<{ rows: { text: string; chips: string[] }[] }>(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // Into the Games screen (the menu row's leaf text is "Games"), then the PS2 tile.
  const leaf = [...document.querySelectorAll('body *')].find(e => e.childElementCount === 0 && (e.textContent || '').trim() === 'Games');
  const menu = leaf && (leaf.closest('button,[role=button],[onclick],li,a') || leaf.parentElement);
  if (menu) menu.click();
  await wait(900);
  const tile = [...document.querySelectorAll('.cmg-strip .strip-tile')].find(x => /playstation 2/i.test(x.textContent || ''));
  tile.click();
  await wait(900);
  const name = ${JSON.stringify(String(record.name))}.toUpperCase();
  const rows = [...document.querySelectorAll('.games-list .game-row')]
    .map(r => ({ text: (r.innerText || '').replace(/\\s+/g, ' ').trim(), chips: [...r.querySelectorAll('.eshop-kind')].map(c => c.textContent) }))
    .filter(r => r.text.includes(name));
  return { rows };
})()`);
const discRow = shelf.rows.find((r) => !r.chips.includes("WEB"));
const webRow = shelf.rows.find((r) => r.chips.includes("WEB"));
if (!discRow) fail(`the PLAYSTATION 2 section shows no disc row for ${record.name}: ${JSON.stringify(shelf.rows)}`);
if (!webRow) fail(`the PLAYSTATION 2 section shows no WEB row under ${record.name}: ${JSON.stringify(shelf.rows)}`);
log(`shelf: "${discRow.text}" + "${webRow.text}"`);
steps.shelf = shelf;
const sectionPng = await shot("section.png");

log(`launching the WEB row…`);
const launched = await cdp.eval<{ iframeSrc: string | null; body: string }>(`(async () => {
  const name = ${JSON.stringify(String(record.name))}.toUpperCase();
  const row = [...document.querySelectorAll('.games-list .game-row')].find(r => r.querySelector('.eshop-kind') && (r.innerText || '').toUpperCase().includes(name));
  row.click();
  await new Promise(r => setTimeout(r, 1200));
  const f = document.querySelector('iframe');
  return { iframeSrc: f ? f.getAttribute('src') : null, body: document.body.className };
})()`);
// launchGame may append its own flags (online=1 in a netplay session, the
// launcher's debug= and builder=), so the path and the identity parameter are
// what must match.
function sameRoute(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ua = new URL(a, origin), ub = new URL(b, origin);
  if (ua.pathname !== ub.pathname) return false;
  return ["level", "playExport", "play"].every((k) => ua.searchParams.get(k) === ub.searchParams.get(k));
}
if (!sameRoute(launched.iframeSrc, String(record.webUrl))) {
  fail(`the WEB row opened ${launched.iframeSrc}, expected ${record.webUrl}`);
}
const frame = await until<{ href: string; offline: string; scenes: string[] }>("the web build to start in the frame", 90_000, () =>
  cdp.eval<{ href: string; offline: string; scenes: string[] } | null>(`(() => {
    const f = document.querySelector('iframe'); const w = f && f.contentWindow;
    if (!w || !w.__PHASER_GAME__) return null;
    const scenes = w.__PHASER_GAME__.scene.getScenes(true).map(s => s.sys.settings.key);
    return scenes.length ? { href: w.location.href, offline: typeof w.__OFFLINE_LEVEL__, scenes } : null;
  })()`));
if (frame.offline !== "undefined") {
  fail(`the frame baked the default level over ${record.name} (__OFFLINE_LEVEL__ is ${frame.offline}); it would be playing 2028.Ai`);
}
log(`web build running: ${frame.href} (scenes ${frame.scenes.join(", ")}, no baked level)`);
const drawn = await waitForPicture("the web build", flags["picture-wait"] * 1000, () => shot("probe.png", true))
  .catch((e) => fail(`the web build never drew: ${e.message}`));
await Deno.remove(join(outDir, "probe.png")).catch(() => {});
const scenesNow = await cdp.eval<string[]>(
  `document.querySelector('iframe').contentWindow.__PHASER_GAME__.scene.getScenes(true).map(s => s.sys.settings.key)`,
);
log(`web build drew after ${(drawn.waitedMs / 1000).toFixed(1)}s (${(drawn.lit * 100).toFixed(0)}% lit, ${drawn.colours} colours; scenes ${scenesNow.join(", ")})`);
await sleep(flags.settle * 1000);
const webPng = await shot("web.png");
steps.web = { ...launched, ...frame, scenesAtCapture: scenesNow, drewAfterMs: drawn.waitedMs, screenshot: webPng, sectionScreenshot: sectionPng };

// ── PCSX2: the disc itself ───────────────────────────────────────────────────
const WINLIST_SWIFT = `import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list {
  if let p = w[kCGWindowOwnerPID as String] as? Int32, p == pid {
    let id = w[kCGWindowNumber as String] as? Int ?? 0
    let name = w[kCGWindowName as String] as? String ?? ""
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    print("\\(id)\\t\\(name)\\t\\(b["Width"] ?? 0)x\\(b["Height"] ?? 0)")
  }
}
`;

async function findPcsx2(): Promise<string | null> {
  const apps: string[] = [];
  for await (const e of Deno.readDir("/Applications")) {
    if (e.name.startsWith("PCSX2") && e.name.endsWith(".app")) apps.push(join("/Applications", e.name));
  }
  // Numeric, so v2.10 sorts after v2.9.
  apps.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return apps.at(-1) ?? null;
}

async function winlistBinary(): Promise<string | null> {
  const cache = join(ROOT, "build", "testdrive", ".cache");
  await ensureDir(cache);
  const bin = join(cache, "winlist");
  try { await Deno.stat(bin); return bin; } catch { /* compile */ }
  try {
    const src = join(cache, "winlist.swift");
    await Deno.writeTextFile(src, WINLIST_SWIFT);
    await run(["swiftc", "-O", src, "-o", bin], { quiet: true });
    return bin;
  } catch (e) {
    log(`no window lister (swiftc): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

if (flags.pcsx2) {
  const pcsx2 = await findPcsx2();
  const winlist = pcsx2 ? await winlistBinary() : null;
  if (!pcsx2) {
    log("PCSX2 is not under /Applications — skipping the disc boot");
    steps.pcsx2 = { skipped: "no PCSX2 installed" };
  } else if (!winlist) {
    steps.pcsx2 = { skipped: "no swiftc to list windows with" };
  } else {
    const iso = String(built.ps2Export!.isoPath);
    log(`booting the disc in ${basename(pcsx2)} (${pcsx2})…`);
    const before = new Set(await pidsMatching("PCSX2"));
    await run(["open", "-g", "-n", "-a", pcsx2, "--args", "-batch", "-nogui", "-nofullscreen", "-fastboot", iso]);
    const ours = async () => {
      // Matched by the app's name, not the .iso: PCSX2's helper processes do
      // not carry the disc path on their command line, and they outlive the
      // main process when only that one is killed.
      const list = (await pidsMatching("PCSX2")).filter((p) => !before.has(p));
      for (const p of list) spawned.add(p);
      return list;
    };
    // `open` can leave two processes naming the .iso; only one owns the game
    // window, so every candidate is asked for its windows.
    const found = await until<{ pid: number; wid: string; name: string }>("the PCSX2 game window", 60_000, async () => {
      for (const pid of await ours()) {
        let out = "";
        try { out = await run([winlist, String(pid)], { quiet: true }); } catch { continue; }
        for (const line of out.split("\n")) {
          const [wid, name] = line.split("\t");
          if (wid && name && !/^PCSX2/.test(name)) return { pid, wid, name };
        }
      }
      return null;
    }, 1000).catch((e) => fail(
      `PCSX2 never showed a game window: ${e.message}. If PCSX2 is open with an untitled window, ` +
      `the terminal lacks Screen Recording permission (macOS hides other apps' window titles without it).`,
    ));
    log(`PCSX2 window "${found.name}" (pid ${found.pid})`);
    // The window exists long before the game draws into it: AthenaEnv has to
    // read its script and sheets off the disc first. Capture it to probe.png
    // until a frame clears the lit-pixel and colour checks (the window's title
    // bar, the top 8%, is skipped), and keep that frame. Not a dotfile:
    // screencapture refuses to write one ("cannot write file to intended
    // destination"). A capture that produced no file is simply not there yet.
    const probe = join(outDir, "probe.png");
    const pcsx2Drawn = await waitForPicture("PCSX2", flags["pcsx2-wait"] * 1000, async () => {
      await Deno.remove(probe).catch(() => {});
      await run(["screencapture", "-x", "-o", `-l${found.wid}`, probe], { quiet: true }).catch(() => {});
      return (await Deno.stat(probe).catch(() => null)) ? probe : null;
    }, 0.08).catch((e) => fail(`PCSX2 showed nothing: ${e.message}`));
    log(`PCSX2 drew after ${(pcsx2Drawn.waitedMs / 1000).toFixed(1)}s (${(pcsx2Drawn.lit * 100).toFixed(0)}% lit, ${pcsx2Drawn.colours} colours)`);
    // The frame that passed is the frame that is kept.
    const titlePng = join(outDir, "title.png");
    await Deno.rename(probe, titlePng);
    log(`wrote ${titlePng}`);
    let elfLine = "";
    try {
      const emulog = await Deno.readTextFile(join(Deno.env.get("HOME") ?? "", "Library/Application Support/PCSX2/logs/emulog.txt"));
      elfLine = emulog.split("\n").find((l) => l.includes("ELF Loading")) ?? "";
    } catch { /* no log */ }
    // Every PCSX2 process this run started goes, politely and then not: `open`
    // leaves more than one, and one of them has ignored SIGTERM before.
    const started = await ours();
    for (const pid of started) { try { Deno.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    await sleep(2000);
    for (const pid of await ours()) { try { Deno.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    spawned.clear();
    if (elfLine && !/cdrom0:/.test(elfLine)) {
      fail(`PCSX2 did not fast-boot the disc (${elfLine.trim()}); check Boot Full vs fast boot`);
    }
    steps.pcsx2 = { app: pcsx2, iso, window: found.name, elfLine: elfLine.trim(), drewAfterMs: pcsx2Drawn.waitedMs, screenshot: titlePng };
    log(`PCSX2: ${elfLine.trim() || "booted"}`);
  }
}

// ── Done ─────────────────────────────────────────────────────────────────────
report.finishedAt = new Date().toISOString();
report.ok = true;
await Deno.writeTextFile(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
cdp.close();
if (flags.quit) {
  await quitApp();
  log("app closed");
} else {
  log(`app left running on the game (DevTools :${flags.port}); pass --quit to close it`);
}
console.log(`
testdrive ok — "${levelName}"
  disc      ${built.ps2Export!.isoPath}
  library   ${record.id}  web ${JSON.stringify(record.web)}
  shelf     ${discRow.text}
            ${webRow.text}
  web       ${frame.href}
  pcsx2     ${(steps.pcsx2 as Record<string, unknown> | undefined)?.screenshot ?? (steps.pcsx2 as Record<string, unknown> | undefined)?.skipped ?? "skipped (--no-pcsx2)"}
  report    ${join(outDir, "report.json")}
`);
