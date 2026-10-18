// lib/android-host.ts — the launcher's Mobile shelf: the APKs this machine
// has built, what it can run them on, and the moves between the two.
//
// An APK is a host artifact twice over. It sits on this machine's disk
// (build/<slug>/dist, or the packaged app's staging root), and the only
// things that can run it are on this machine too — Waydroid on a Linux
// desktop, the Windows Subsystem for Android, a phone or emulator on adb —
// or reachable from it, over adb's wireless debugging or Tailscale. So unlike
// the PS2 and Dezaemon shelves, which live in one browser's IndexedDB, the
// Mobile shelf is a file under the launcher's config directory
// (android-shelf.json, beside the build code) that every browser on this
// machine reads through routes/api/android.ts. Builds nobody registered —
// `deno task build:android <game>` from a terminal — are discovered from the
// build trees' artifacts.json and listed all the same.
//
// Everything that parses text or decides a verdict is a pure function up
// top, so tests/android_host_test.ts can hold it to a truth table without a
// Waydroid, an adb or a tailnet. The host probes and the moves below spawn
// processes, and they are all best-effort: a tool that is not installed is
// "not found", never an exception, because the launcher's section has to
// render on a machine with none of this.

import { basename, dirname, join } from "@std/path";
import {
  guessAndroidSdk,
  isCompiledBinary,
  runExport,
  slugFor,
} from "@shmupx/shmup-harbor/export";
import { configDir } from "@shmupx/shmup-harbor/export-worker";
import {
  listShelf,
  resolveShelfName,
  SHELF_DB,
  ShelfError,
} from "@shmupx/shmup-harbor/shelf";
import {
  packagedBuildRoot,
  stagedRuntimeRoot,
} from "@shmupx/shmup-harbor/build-workspace";
import { rtdbPath } from "./rtdb-root.ts";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { tailscaleCandidates } from "./tailscale.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** One APK on this machine's Mobile shelf. */
export interface AndroidBuild {
  /** The build slug — one per game, so a rebuild replaces its row. */
  id: string;
  /** What the game is called: the window title, the package's label. */
  name: string;
  slug: string;
  /** The .apk, as an absolute path on this machine. */
  apk: string;
  packageId: string;
  size: number;
  /** When the APK was written, ms since the epoch. */
  builtAt: number;
  /** What the build was made from — a shelf name, or "found on disk". */
  source: string;
  /** The app's own icon (cordova's icon-192.png), when the build tree has it. */
  icon: string | null;
  /** Target id → when the APK last went onto it, ms since the epoch. */
  installed: Record<string, number>;
}

/**
 * The registry file: the builds, plus the APKs the user took off the shelf —
 * each with when, so a rebuild that lands on the same path (newer than the
 * forgetting) comes back by itself.
 */
export interface AndroidShelfFile {
  version: 1;
  builds: AndroidBuild[];
  forgotten: Array<{ apk: string; at: number }>;
}

export interface AdbDevice {
  serial: string;
  /** "device", "offline", "unauthorized", "no permissions", … */
  state: string;
  model: string;
  /** Wireless debugging and emulators show up as host:port serials. */
  transport: "usb" | "tcp";
}

export interface TailscalePeer {
  /** The machine's own name — "Pixel 9" — for the row. */
  name: string;
  /**
   * The name Taildrop addresses it by: the first label of its MagicDNS name
   * ("pixel-9"), which is also what `tailscale file cp <file> <id>:` wants.
   */
  id: string;
  dns: string;
  ip: string;
  os: string;
  online: boolean;
}

export interface WaydroidState {
  found: boolean;
  initialized: boolean;
  containerActive: boolean;
  sessionRunning: boolean;
  /** Inside gamescope (Bazzite's Game Mode), where waydroid-launcher is the way in. */
  gameMode: boolean;
  /** `waydroid status` verbatim, for the panel. */
  status: string;
}

export interface WsaState {
  found: boolean;
  /** WsaClient.exe, when it is where the Store puts it. */
  path: string | null;
  /** Its adb endpoint answers. */
  running: boolean;
}

export interface AndroidRuntimes {
  waydroid: WaydroidState;
  wsa: WsaState;
  adb: { found: boolean; path: string | null; devices: AdbDevice[] };
  tailscale: { found: boolean; self: string; peers: TailscalePeer[] };
}

export interface RemoteDesktop {
  /** This session looks like it is being driven from somewhere else. */
  detected: boolean;
  /** What said so: "rdp", "xrdp", "vnc", "ssh", "sunshine", "rustdesk", … */
  via: string[];
}

/** A place an APK can go. */
export type AndroidTarget =
  | "waydroid"
  | "wsa"
  | `adb:${string}`
  | `taildrop:${string}`;

export interface AndroidJob {
  id: string;
  kind: "build" | "install" | "launch";
  /** The shelf name being built, or the build being moved. */
  name: string;
  buildId: string | null;
  target: AndroidTarget | null;
  status: "running" | "done" | "failed";
  log: string[];
  startedAt: number;
  endedAt: number | null;
  /** The build, once a build or install job has one. */
  build: AndroidBuild | null;
  error: string | null;
}

/** A move that failed for a reason the launcher should relay as-is. */
export class AndroidError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "AndroidError";
  }
}

/** The Windows Subsystem for Android's fixed adb endpoint. */
export const WSA_ADB = "127.0.0.1:58526";

// ── Pure: parsers and verdicts ───────────────────────────────────────────────

/**
 * `adb devices -l`, as a list. The header, the daemon's own chatter ("* daemon
 * started successfully") and blank lines are skipped; everything else is a
 * serial, a state and optional key:value fields, of which `model` is the one
 * worth a label (adb spells spaces as underscores in it).
 */
export function parseAdbDevices(text: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("*") || /^List of devices/i.test(line)) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state] = parts;
    let model = "";
    for (const field of parts.slice(2)) {
      const m = /^model:(.+)$/.exec(field);
      if (m) model = m[1].replace(/_/g, " ");
    }
    // "no permissions" is two words; the state is everything up to the first
    // key:value field.
    const stateEnd = parts.findIndex((p, i) => i >= 2 && p.includes(":"));
    const stateText = parts.slice(1, stateEnd < 0 ? undefined : stateEnd)
      .join(" ");
    out.push({
      serial,
      state: stateText || state,
      model,
      transport: serial.includes(":") ? "tcp" : "usb",
    });
  }
  return out;
}

/** `tailscale status --json`: this machine's name and every peer. */
export function parseTailscalePeers(
  json: string,
): { self: string; peers: TailscalePeer[] } {
  let raw: {
    Self?: { HostName?: unknown };
    Peer?: Record<string, Record<string, unknown>>;
  } = {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    raw = {};
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const peers: TailscalePeer[] = [];
  for (const p of Object.values(raw.Peer || {})) {
    if (!p || typeof p !== "object") continue;
    const ips = Array.isArray(p.TailscaleIPs)
      ? p.TailscaleIPs.filter((x): x is string => typeof x === "string")
      : [];
    const dns = str(p.DNSName).replace(/\.$/, "");
    peers.push({
      name: str(p.HostName),
      id: dns.split(".")[0] ||
        str(p.HostName).toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      dns,
      ip: ips.find((ip) => !ip.includes(":")) || ips[0] || "",
      os: str(p.OS).toLowerCase(),
      online: p.Online === true,
    });
  }
  peers.sort((a, b) =>
    Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)
  );
  return { self: str(raw.Self?.HostName), peers };
}

/** `waydroid status`: whether it has been initialised, and the session line. */
export function parseWaydroidStatus(
  text: string,
): { initialized: boolean; sessionRunning: boolean } {
  const t = String(text || "");
  return {
    initialized: !/not initialized/i.test(t),
    sessionRunning: /Session:\s*RUNNING/i.test(t),
  };
}

/**
 * Is this desktop being driven from somewhere else?
 *
 * Two kinds of evidence. The session's own environment says so outright on an
 * RDP, xrdp, VNC or ssh -X session. A streaming or remote-control host that
 * is RUNNING — Sunshine, RustDesk, AnyDesk, Parsec, TeamViewer, xrdp, a VNC
 * server, GNOME Remote Desktop — says the machine is set up to be used that
 * way, which is all the launcher needs: on such a machine the APK it just
 * built is for a device in the user's hand, not for this screen, so the
 * install-elsewhere targets lead.
 */
export function remoteDesktopSignals(
  env: Record<string, string | undefined>,
  processes: string[],
): RemoteDesktop {
  const via: string[] = [];
  const session = String(env.SESSIONNAME || "");
  if (/^RDP-/i.test(session)) via.push("rdp");
  if (env.XRDP_SESSION) via.push("xrdp");
  if (env.VNCDESKTOP) via.push("vnc");
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) via.push("ssh");
  const names = new Set(
    processes.map((p) => basename(String(p || "")).toLowerCase()),
  );
  const daemons: Array<[string, string[]]> = [
    ["sunshine", ["sunshine", "sunshine.exe"]],
    ["xrdp", ["xrdp", "xrdp-sesman"]],
    ["vnc", [
      "wayvnc",
      "x11vnc",
      "xvnc",
      "tigervncserver",
      "vncserver",
      "krfb",
    ]],
    ["gnome-remote-desktop", [
      "gnome-remote-desktop-daemon",
      "gnome-remote-de",
    ]],
    ["rustdesk", ["rustdesk", "rustdesk.exe"]],
    ["anydesk", ["anydesk", "anydesk.exe"]],
    ["parsec", ["parsecd", "parsecd.exe", "parsec.exe"]],
    ["teamviewer", ["teamviewerd", "teamviewer", "teamviewer.exe"]],
  ];
  for (const [label, procs] of daemons) {
    if (procs.some((p) => names.has(p)) && !via.includes(label)) {
      via.push(label);
    }
  }
  return { detected: via.length > 0, via };
}

/**
 * The package id tools/build-level gives a slug — `safePackageSegment` in its
 * lib/slug.js, mirrored here so a build found on disk without its config.xml
 * is still addressed by the id Android knows it by.
 */
export function packageIdForSlug(slug: string): string {
  const reserved = new Set([
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "goto",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "try",
    "void",
    "volatile",
    "while",
    "true",
    "false",
    "null",
  ]);
  let s = String(slug || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!s) s = "app";
  if (!/^[a-z_]/.test(s)) s = "a" + s;
  if (reserved.has(s)) s = s + "_";
  return "com.easierbycode." + s;
}

/** The `id` and `<name>` out of a cordova config.xml, when it has them. */
export function parseCordovaConfig(
  xml: string,
): { packageId: string | null; name: string | null } {
  const id = /<widget[^>]*\sid="([^"]+)"/.exec(xml)?.[1] || null;
  const name = /<name>([^<]*)<\/name>/.exec(xml)?.[1]?.trim() || null;
  return { packageId: id, name };
}

/** What a target is called on the shelf. */
export function targetLabel(
  target: string,
  runtimes?: AndroidRuntimes | null,
): string {
  if (target === "waydroid") return "Waydroid";
  if (target === "wsa") return "Windows Subsystem for Android";
  if (target.startsWith("adb:")) {
    const serial = target.slice(4);
    const dev = runtimes?.adb.devices.find((d) => d.serial === serial);
    return (dev?.model || serial) + " (adb)";
  }
  if (target.startsWith("taildrop:")) {
    const id = target.slice(9);
    const peer = runtimes?.tailscale.peers.find((p) => p.id === id);
    return (peer?.name || id) + " (Tailscale)";
  }
  return target;
}

/** A target string the launcher sent, or null when it is not one. */
export function parseTarget(raw: unknown): AndroidTarget | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (t === "waydroid" || t === "wsa") return t;
  if (/^adb:[^\s]+$/.test(t)) return t as AndroidTarget;
  if (/^taildrop:[^\s:]+$/.test(t)) return t as AndroidTarget;
  return null;
}

/**
 * The registry's builds and the ones discovered on disk as one list: the
 * registry's row wins where both have the same APK (it carries the install
 * history), a forgotten APK stays forgotten, and the order is newest first.
 */
export function mergeBuilds(
  registered: AndroidBuild[],
  discovered: AndroidBuild[],
  forgotten: Array<{ apk: string; at: number }> = [],
): AndroidBuild[] {
  const gone = new Map(forgotten.map((f) => [f.apk, f.at]));
  const kept = (b: AndroidBuild) => {
    const at = gone.get(b.apk);
    return at === undefined || b.builtAt > at;
  };
  const byApk = new Map<string, AndroidBuild>();
  for (const b of discovered) if (kept(b)) byApk.set(b.apk, b);
  for (const b of registered) if (kept(b)) byApk.set(b.apk, b);
  // One row per id as well: a rebuild writes the same dist path, but a build
  // adopted from elsewhere may share the slug — the newer one is the shelf's.
  const byId = new Map<string, AndroidBuild>();
  for (const b of byApk.values()) {
    const prev = byId.get(b.id);
    if (!prev || b.builtAt > prev.builtAt) byId.set(b.id, b);
  }
  return [...byId.values()].sort((a, b) => b.builtAt - a.builtAt);
}

/**
 * The install marks that still describe THIS APK. A mark older than the file
 * was made by an earlier build on the same path, so after a rebuild the row
 * stops saying "ON WAYDROID" and A installs again before launching. The
 * registry keeps the old marks; this is only the shelf's view of them.
 */
export function currentInstalls(
  installed: Record<string, number> | undefined,
  builtAt: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [target, at] of Object.entries(installed || {})) {
    if (typeof at === "number" && at >= builtAt) out[target] = at;
  }
  return out;
}

/**
 * Which target A on a row should use when the user has not said: something
 * that runs on this screen first, unless this screen is a remote one — then
 * the device in their hand. Null when there is nowhere to put it.
 */
export function defaultTarget(
  runtimes: AndroidRuntimes,
  remote: RemoteDesktop,
): AndroidTarget | null {
  const local: AndroidTarget[] = [];
  if (runtimes.waydroid.found && runtimes.waydroid.initialized) {
    local.push("waydroid");
  }
  if (runtimes.wsa.found) local.push("wsa");
  const devices = runtimes.adb.devices.filter((d) => d.state === "device");
  const remoteTargets: AndroidTarget[] = [
    ...devices.map((d) => `adb:${d.serial}` as AndroidTarget),
    ...runtimes.tailscale.peers
      .filter((p) => p.online && p.os === "android")
      .map((p) => `taildrop:${p.id}` as AndroidTarget),
  ];
  const order = remote.detected
    ? [...remoteTargets, ...local]
    : [...local, ...remoteTargets];
  return order[0] || null;
}

// ── Host probes ───────────────────────────────────────────────────────────────

interface Ran {
  ok: boolean;
  text: string;
}

/** Run a command and read what it printed; a missing tool is `ok: false`. */
async function runRead(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<Ran> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: opts.env,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    return { ok: out.success, text };
  } catch (e) {
    return { ok: false, text: (e as Error).message || "" };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The adb to use: the SDK's own, else one on PATH, else none. */
export async function adbPath(
  env: Record<string, string> = Deno.env.toObject(),
): Promise<string | null> {
  const sdk = await guessAndroidSdk(env);
  if (sdk) {
    const exe = join(
      sdk,
      "platform-tools",
      Deno.build.os === "windows" ? "adb.exe" : "adb",
    );
    if (await pathExists(exe)) return exe;
  }
  const onPath = await runRead("adb", ["version"], { timeoutMs: 8000 });
  return onPath.ok ? "adb" : null;
}

/** The names of every running process, as far as the OS will say. */
export async function listProcesses(): Promise<string[]> {
  if (Deno.build.os === "windows") {
    const r = await runRead("tasklist", ["/fo", "csv", "/nh"], {
      timeoutMs: 8000,
    });
    if (!r.ok) return [];
    return r.text.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, ""))
      .filter(Boolean);
  }
  const r = await runRead("ps", ["-eo", "comm="], { timeoutMs: 8000 });
  if (!r.ok) return [];
  return r.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function detectRemoteDesktop(
  env: Record<string, string> = Deno.env.toObject(),
): Promise<RemoteDesktop> {
  return remoteDesktopSignals(env, await listProcesses());
}

async function tailscaleBin(
  env: Record<string, string>,
): Promise<string | null> {
  for (const cand of tailscaleCandidates(Deno.build.os, env)) {
    const r = await runRead(cand, ["version"], { timeoutMs: 8000 });
    if (r.ok) return cand;
  }
  return null;
}

/** WsaClient.exe, where the Microsoft Store puts it. */
function wsaClientPath(env: Record<string, string>): string | null {
  if (Deno.build.os !== "windows") return null;
  const local = env.LOCALAPPDATA ||
    (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : "");
  if (!local) return null;
  return join(local, "Microsoft", "WindowsApps", "WsaClient.exe");
}

/** Everything on this machine an APK could run on, probed in parallel. */
export async function detectAndroidRuntimes(
  env: Record<string, string> = Deno.env.toObject(),
): Promise<AndroidRuntimes> {
  const [waydroid, adb, tailscale] = await Promise.all([
    probeWaydroid(env),
    probeAdb(env),
    probeTailscale(env),
  ]);
  const wsaPath = wsaClientPath(env);
  const wsa: WsaState = {
    found: wsaPath !== null && await pathExists(wsaPath),
    path: wsaPath,
    running: adb.devices.some((d) =>
      d.serial === WSA_ADB && d.state === "device"
    ),
  };
  return { waydroid, wsa, adb, tailscale };
}

async function probeWaydroid(
  env: Record<string, string>,
): Promise<WaydroidState> {
  const none: WaydroidState = {
    found: false,
    initialized: false,
    containerActive: false,
    sessionRunning: false,
    gameMode: false,
    status: "",
  };
  if (Deno.build.os !== "linux") return none;
  const status = await runRead("waydroid", ["status"], { timeoutMs: 10000 });
  if (!status.ok && !/Session:|not initialized/i.test(status.text)) return none;
  const parsed = parseWaydroidStatus(status.text);
  const unit = await runRead("systemctl", ["is-active", "waydroid-container"], {
    timeoutMs: 8000,
  });
  return {
    found: true,
    initialized: parsed.initialized,
    containerActive: unit.text.trim() === "active",
    sessionRunning: parsed.sessionRunning,
    gameMode: env.XDG_CURRENT_DESKTOP === "gamescope" ||
      !!env.GAMESCOPE_WAYLAND_DISPLAY,
    status: status.text.trim(),
  };
}

async function probeAdb(
  env: Record<string, string>,
): Promise<AndroidRuntimes["adb"]> {
  const path = await adbPath(env);
  if (!path) return { found: false, path: null, devices: [] };
  const r = await runRead(path, ["devices", "-l"], { timeoutMs: 20000 });
  return { found: true, path, devices: r.ok ? parseAdbDevices(r.text) : [] };
}

async function probeTailscale(
  env: Record<string, string>,
): Promise<AndroidRuntimes["tailscale"]> {
  const bin = await tailscaleBin(env);
  if (!bin) return { found: false, self: "", peers: [] };
  const r = await runRead(bin, ["status", "--json"], { timeoutMs: 10000 });
  if (!r.ok) return { found: true, self: "", peers: [] };
  const parsed = parseTailscalePeers(r.text);
  return { found: true, ...parsed };
}

// ── The registry ──────────────────────────────────────────────────────────────

export function shelfPath(): string {
  return join(configDir(), "android-shelf.json");
}

export async function readShelfFile(
  path = shelfPath(),
): Promise<AndroidShelfFile> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(path));
    if (raw && typeof raw === "object" && Array.isArray(raw.builds)) {
      return {
        version: 1,
        builds: raw.builds.filter(isBuild),
        forgotten: Array.isArray(raw.forgotten)
          ? raw.forgotten.filter((x: unknown) =>
            !!x && typeof x === "object" &&
            typeof (x as { apk?: unknown }).apk === "string"
          ).map((x: { apk: string; at?: unknown }) => ({
            apk: x.apk,
            at: typeof x.at === "number" ? x.at : 0,
          }))
          : [],
      };
    }
  } catch { /* first run, or unreadable — start empty */ }
  return { version: 1, builds: [], forgotten: [] };
}

function isBuild(x: unknown): x is AndroidBuild {
  const b = x as AndroidBuild;
  return !!b && typeof b === "object" && typeof b.id === "string" &&
    typeof b.apk === "string" && typeof b.packageId === "string";
}

export async function writeShelfFile(
  file: AndroidShelfFile,
  path = shelfPath(),
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(file, null, 2) + "\n");
}

/** The build trees an APK can be found in, on this machine. */
export function buildRoots(): string[] {
  const roots = [join(stagedRuntimeRoot(), "build")];
  try {
    roots.unshift(join(repoRoot(), "build"));
  } catch { /* no checkout */ }
  return roots;
}

/**
 * A build described from its tree: build/<slug>/ holds artifacts.json (the
 * APK's path), cordova/config.xml (the package id and the app's name) and
 * cordova/icons/icon-192.png.
 */
export async function buildFromTree(
  dir: string,
  source = "found on disk",
): Promise<AndroidBuild | null> {
  let apks: string[] = [];
  try {
    const arts = JSON.parse(
      await Deno.readTextFile(join(dir, "artifacts.json")),
    );
    apks = Array.isArray(arts?.android)
      ? arts.android.filter((p: unknown) =>
        typeof p === "string" && /\.apk$/i.test(p)
      )
      : [];
  } catch { /* no manifest */ }
  if (!apks.length) {
    // A tree the Node tool built without recording its artifacts (an older
    // run): the newest .apk in dist/ is still a build.
    try {
      let newest: { path: string; mtime: number } | null = null;
      for await (const e of Deno.readDir(join(dir, "dist"))) {
        if (!e.isFile || !/\.apk$/i.test(e.name)) continue;
        const p = join(dir, "dist", e.name);
        const mtime = (await Deno.stat(p)).mtime?.getTime() || 0;
        if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
      }
      if (newest) apks = [newest.path];
    } catch { /* no dist */ }
  }
  if (!apks.length) return null;
  const apk = apks[0];
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(apk);
  } catch {
    return null;
  }
  const slug = basename(dir);
  let packageId = packageIdForSlug(slug);
  let name = slug;
  try {
    const cfg = parseCordovaConfig(
      await Deno.readTextFile(join(dir, "cordova", "config.xml")),
    );
    if (cfg.packageId) packageId = cfg.packageId;
    if (cfg.name) name = cfg.name;
  } catch { /* no cordova tree */ }
  const icon = join(dir, "cordova", "icons", "icon-192.png");
  return {
    id: slug,
    name,
    slug,
    apk,
    packageId,
    size: stat.size,
    builtAt: stat.mtime?.getTime() || Date.now(),
    source,
    icon: (await pathExists(icon)) ? icon : null,
    installed: {},
  };
}

/** Every build tree under the roots that holds an APK. */
export async function discoverBuilds(
  roots = buildRoots(),
): Promise<AndroidBuild[]> {
  const out: AndroidBuild[] = [];
  for (const root of roots) {
    try {
      for await (const e of Deno.readDir(root)) {
        if (!e.isDirectory) continue;
        const b = await buildFromTree(join(root, e.name));
        if (b) out.push(b);
      }
    } catch { /* no such root */ }
  }
  return out;
}

/** The shelf as the launcher sees it: registered and discovered, existing. */
export async function listBuilds(): Promise<AndroidBuild[]> {
  const file = await readShelfFile();
  const live: AndroidBuild[] = [];
  for (const b of file.builds) {
    try {
      const stat = await Deno.stat(b.apk);
      const builtAt = Math.max(b.builtAt || 0, stat.mtime?.getTime() || 0);
      live.push({
        ...b,
        size: stat.size,
        builtAt,
        installed: currentInstalls(b.installed, builtAt),
      });
    } catch { /* the APK is gone — the row goes with it */ }
  }
  return mergeBuilds(live, await discoverBuilds(), file.forgotten);
}

export async function registerBuild(build: AndroidBuild): Promise<void> {
  const file = await readShelfFile();
  file.forgotten = file.forgotten.filter((f) => f.apk !== build.apk);
  const prev = file.builds.find((b) => b.apk === build.apk);
  file.builds = [
    { ...build, installed: { ...(prev?.installed || {}), ...build.installed } },
    ...file.builds.filter((b) => b.apk !== build.apk && b.id !== build.id),
  ];
  await writeShelfFile(file);
}

export async function markInstalled(
  build: AndroidBuild,
  target: AndroidTarget,
): Promise<AndroidBuild> {
  const file = await readShelfFile();
  const row = file.builds.find((b) => b.apk === build.apk) ||
    { ...build, installed: {} };
  row.installed = { ...(row.installed || {}), [target]: Date.now() };
  file.builds = [row, ...file.builds.filter((b) => b.apk !== build.apk)];
  await writeShelfFile(file);
  return row;
}

/** Take a build off the shelf. The APK stays where it is. */
export async function forgetBuild(id: string): Promise<boolean> {
  const builds = await listBuilds();
  const b = builds.find((x) => x.id === id);
  if (!b) return false;
  const file = await readShelfFile();
  file.builds = file.builds.filter((x) => x.apk !== b.apk);
  file.forgotten = [
    ...file.forgotten.filter((f) => f.apk !== b.apk),
    { apk: b.apk, at: Date.now() },
  ];
  await writeShelfFile(file);
  return true;
}

// ── What can be built ─────────────────────────────────────────────────────────

export interface BuildCandidate {
  /** The shelf name to build: "game:2028-ai", "level:rando", "eshop:<id>". */
  name: string;
  title: string;
  section: string;
}

/**
 * The names the launcher's BUILD picker offers: this repo's own games, the
 * cloud levels, and the eShop's carts — the shelves `deno task build:android`
 * resolves, minus the 262-save community library, which is too long for a
 * pad-driven list (it is still one `deno task build:android <slug>` away).
 */
export async function buildCandidates(): Promise<BuildCandidate[]> {
  const out: BuildCandidate[] = [];
  let sections: Awaited<ReturnType<typeof listShelf>> = [];
  try {
    sections = await listShelf({ offline: true, root: shelfRoot() });
  } catch { /* nothing on disk */ }
  for (const s of sections) {
    if (s.section === "THIS REPO") {
      for (const r of s.rows) {
        out.push({
          name: "game:" + r.slug,
          title: r.slug,
          section: "THIS REPO",
        });
      }
    } else if (s.section === "ESHOP") {
      for (const r of s.rows) {
        if (!/\(deza\)$/.test(r.title)) continue;
        out.push({
          name: "eshop:" + r.slug,
          title: r.title.replace(/\s*\(deza\)$/, ""),
          section: "ESHOP",
        });
      }
    }
  }
  // shmupX's own games only: SHELF_DB is the database's base (it also serves
  // the root-level shelves), and the levels are under the shmupX subtree —
  // the root-level levels/* is cmg's catalog (lib/rtdb-root.ts).
  try {
    const res = await fetch(
      `${SHELF_DB}/${rtdbPath("levels")}.json?shallow=true`,
      {
        signal: AbortSignal.timeout(15000),
      },
    );
    const names = res.ok ? await res.json() : null;
    if (names && typeof names === "object") {
      for (const name of Object.keys(names).sort()) {
        if (name.startsWith("__")) continue;
        out.push({ name: "level:" + name, title: name, section: "CLOUD" });
      }
    }
  } catch { /* offline — the cloud shelf is simply absent */ }
  return out;
}

/** Where the shelf resolver works from: the checkout, or the staged copy. */
function shelfRoot(): string | undefined {
  return isCompiledBinary() ? stagedRuntimeRoot() : undefined;
}

// ── The moves ─────────────────────────────────────────────────────────────────

export type Log = (line: string) => void;

export interface BuildRequest {
  /** A shelf name — see buildCandidates — or anything resolveShelfName takes. */
  name: string;
  /** A Dezaemon cart from a browser's shelf, built by way of a file on disk. */
  sav?: Uint8Array;
  /** What to call the app when the cart's own title should not name it. */
  title?: string | null;
  log?: Log;
  signal?: AbortSignal;
}

/** Build one shelf name into an APK and put it on the Mobile shelf. */
export async function buildAndroid(req: BuildRequest): Promise<AndroidBuild> {
  const log = req.log ?? (() => {});
  let name = String(req.name || "").trim();
  if (req.sav) {
    const dir = join(packagedBuildRoot(), "carts");
    await Deno.mkdir(dir, { recursive: true });
    const file = join(dir, `${slugFor(req.title || name || "cart")}.sav`);
    await Deno.writeFile(file, req.sav);
    log(`Cart written to ${file} (${req.sav.length.toLocaleString()} bytes).`);
    name = "sav:" + file;
  }
  if (!name) throw new AndroidError("Name the game to build.", 400);
  let hit;
  try {
    hit = await resolveShelfName(name, {
      root: shelfRoot(),
      name: req.title || null,
      log,
    });
  } catch (e) {
    if (e instanceof ShelfError) throw new AndroidError(e.message, 404);
    throw e;
  }
  log(hit.note);
  const levelRecord = hit.levelFile
    ? JSON.parse(await Deno.readTextFile(hit.levelFile))
    : undefined;
  const out = await runExport({
    level: hit.levelName,
    platform: "android",
    ...(levelRecord === undefined ? {} : { levelRecord }),
    log,
    signal: req.signal,
  });
  const apk = out.artifacts.find((p) => /\.apk$/i.test(p));
  if (!apk) throw new AndroidError("The build produced no .apk.", 500);
  const tree = dirname(dirname(apk));
  const found = await buildFromTree(tree, hit.note);
  const stat = await Deno.stat(apk);
  const build: AndroidBuild = {
    id: out.slug,
    name: hit.levelName,
    slug: out.slug,
    apk,
    packageId: found?.packageId || packageIdForSlug(out.slug),
    size: stat.size,
    builtAt: Date.now(),
    source: name,
    icon: found?.icon || null,
    installed: {},
  };
  await registerBuild(build);
  log(`On the Mobile shelf: ${build.name} (${build.packageId}).`);
  return build;
}

/** Put an APK that already exists — a queued export's, say — on the shelf. */
export async function adoptApk(
  path: string,
  name?: string | null,
): Promise<AndroidBuild> {
  const real = await Deno.realPath(path).catch(() => null);
  if (!real || !/\.apk$/i.test(real)) {
    throw new AndroidError("That is not an .apk on this machine.", 404);
  }
  let inside = false;
  for (const root of [...buildRoots(), packagedBuildRoot()]) {
    const r = await Deno.realPath(root).catch(() => root);
    if (
      real === r || real.startsWith(r.endsWith("/") ? r : r + "/") ||
      real.startsWith(r + "\\")
    ) {
      inside = true;
    }
  }
  if (!inside) {
    throw new AndroidError(
      "Only a build this machine made can be shelved.",
      403,
    );
  }
  const tree = dirname(dirname(real));
  const found = await buildFromTree(tree, "adopted");
  const stat = await Deno.stat(real);
  const slug = found?.slug || slugFor(name || basename(real, ".apk"));
  const build: AndroidBuild = {
    id: slug,
    name: name || found?.name || slug,
    slug,
    apk: real,
    packageId: found?.packageId || packageIdForSlug(slug),
    size: stat.size,
    builtAt: stat.mtime?.getTime() || Date.now(),
    source: "adopted",
    icon: found?.icon || null,
    installed: {},
  };
  await registerBuild(build);
  return build;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn and forget: the process outlives this request. */
function spawnDetached(cmd: string, args: string[]): Deno.ChildProcess {
  const child = new Deno.Command(cmd, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  child.unref();
  return child;
}

/** A Waydroid session up and its package manager answering. */
async function ensureWaydroidSession(log: Log): Promise<void> {
  const status = await runRead("waydroid", ["status"], { timeoutMs: 10000 });
  const parsed = parseWaydroidStatus(status.text);
  if (!status.ok && !/Session:/i.test(status.text)) {
    throw new AndroidError("waydroid is not installed on this machine.", 409);
  }
  if (!parsed.initialized) {
    throw new AndroidError(
      "Waydroid is not initialised — run `waydroid init` (on Bazzite, `ujust setup-waydroid`) first.",
      409,
    );
  }
  if (parsed.sessionRunning) return;
  const unit = await runRead("systemctl", ["is-active", "waydroid-container"], {
    timeoutMs: 8000,
  });
  if (unit.text.trim() !== "active") {
    throw new AndroidError(
      "waydroid-container.service is not running — `sudo systemctl start waydroid-container`.",
      409,
    );
  }
  log("Starting a Waydroid session…");
  spawnDetached("waydroid", ["session", "start"]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const s = await runRead("waydroid", ["status"], { timeoutMs: 10000 });
    if (parseWaydroidStatus(s.text).sessionRunning) break;
    if (Date.now() > deadline) {
      throw new AndroidError(
        "The Waydroid session did not come up within two minutes.",
        504,
      );
    }
    await sleep(2000);
  }
  // RUNNING comes a moment before Android can take an install; the package
  // manager is up once the app list answers.
  const ready = Date.now() + 60_000;
  while (
    !/packageName/.test(
      (await runRead("waydroid", ["app", "list"], { timeoutMs: 15000 })).text,
    )
  ) {
    if (Date.now() > ready) break;
    await sleep(2000);
  }
  log("Waydroid session is up.");
}

async function waydroidHas(packageId: string): Promise<boolean> {
  const list = await runRead("waydroid", ["app", "list"], { timeoutMs: 15000 });
  return list.text.includes(`packageName: ${packageId}`);
}

async function installWaydroid(build: AndroidBuild, log: Log): Promise<void> {
  await ensureWaydroidSession(log);
  log(`Installing ${basename(build.apk)} into Waydroid…`);
  const r = await runRead("waydroid", ["app", "install", build.apk], {
    timeoutMs: 180_000,
  });
  if (r.text.trim()) log(r.text.trim());
  // `waydroid app install` exits 0 whether or not Android took the package.
  let listed = false;
  for (let i = 0; i < 10 && !listed; i++) {
    listed = await waydroidHas(build.packageId);
    if (!listed) await sleep(1500);
  }
  if (!listed) {
    throw new AndroidError(
      `${build.packageId} is not in \`waydroid app list\` after the install.`,
      500,
    );
  }
  log(`Installed ${build.packageId}.`);
}

async function launchWaydroid(
  build: AndroidBuild,
  env: Record<string, string>,
  log: Log,
  onTarget = false,
): Promise<string> {
  const status = await runRead("waydroid", ["status"], { timeoutMs: 10000 });
  const running = parseWaydroidStatus(status.text).sessionRunning;
  if (!running || !onTarget || !(await waydroidHas(build.packageId))) {
    await installWaydroid(build, log);
  }
  const gameMode = env.XDG_CURRENT_DESKTOP === "gamescope" ||
    !!env.GAMESCOPE_WAYLAND_DISPLAY;
  if (gameMode) {
    const probe = await runRead("waydroid-launcher", ["--help"], {
      timeoutMs: 5000,
    });
    if (probe.ok || /usage/i.test(probe.text)) {
      // Game Mode has no desktop compositor for Waydroid to draw on; Bazzite's
      // waydroid-launcher opens one (cage) and runs the app inside it.
      spawnDetached("waydroid-launcher", ["app", "launch", build.packageId]);
      log(`Launched ${build.packageId} through waydroid-launcher.`);
      return "Launched in Waydroid (Game Mode).";
    }
  }
  // A running session answers `app launch` at once; a stopped one is started
  // by the same command, which then blocks for the session's life — so it is
  // spawned detached either way.
  spawnDetached("waydroid", ["app", "launch", build.packageId]);
  log(`Launched ${build.packageId} in Waydroid.`);
  return "Launched in Waydroid.";
}

async function adbRun(
  adb: string,
  args: string[],
  timeoutMs: number,
): Promise<Ran> {
  return await runRead(adb, args, { timeoutMs });
}

async function requireAdb(env: Record<string, string>): Promise<string> {
  const adb = await adbPath(env);
  if (!adb) {
    throw new AndroidError(
      "adb was not found — install the Android SDK platform-tools.",
      409,
    );
  }
  return adb;
}

/** WSA's adb endpoint answering, starting the subsystem when it is not. */
async function ensureWsa(
  adb: string,
  env: Record<string, string>,
  log: Log,
): Promise<string> {
  const connected = async () => {
    const r = await adbRun(adb, ["connect", WSA_ADB], 15000);
    return /connected to|already connected/i.test(r.text);
  };
  if (await connected()) return WSA_ADB;
  const client = wsaClientPath(env);
  if (!client || !(await pathExists(client))) {
    throw new AndroidError(
      "The Windows Subsystem for Android is not installed on this machine.",
      409,
    );
  }
  // Starting any package boots the subsystem; Settings is the one every WSA
  // has. Developer mode (Settings → Developer) must be on for adb to answer.
  log("Starting the Windows Subsystem for Android…");
  spawnDetached(client, ["/launch", "wsa://com.android.settings"]);
  const deadline = Date.now() + 90_000;
  while (!(await connected())) {
    if (Date.now() > deadline) {
      throw new AndroidError(
        `WSA did not answer on ${WSA_ADB} — turn on Developer mode in its settings.`,
        504,
      );
    }
    await sleep(3000);
  }
  return WSA_ADB;
}

async function adbHas(
  adb: string,
  serial: string,
  packageId: string,
): Promise<boolean> {
  const r = await adbRun(
    adb,
    ["-s", serial, "shell", "pm", "path", packageId],
    20000,
  );
  return r.ok && /package:/.test(r.text);
}

async function installAdb(
  adb: string,
  serial: string,
  build: AndroidBuild,
  log: Log,
): Promise<void> {
  log(`Installing ${basename(build.apk)} on ${serial}…`);
  const r = await adbRun(
    adb,
    ["-s", serial, "install", "-r", build.apk],
    300_000,
  );
  if (r.text.trim()) log(r.text.trim());
  if (!r.ok || !/Success/i.test(r.text)) {
    throw new AndroidError(
      `adb install failed on ${serial}: ${
        r.text.trim().split("\n").pop() || "no output"
      }`,
      500,
    );
  }
  log(`Installed ${build.packageId} on ${serial}.`);
}

async function launchAdb(
  adb: string,
  serial: string,
  build: AndroidBuild,
  log: Log,
  onTarget = false,
): Promise<string> {
  if (!onTarget || !(await adbHas(adb, serial, build.packageId))) {
    await installAdb(adb, serial, build, log);
  }
  const r = await adbRun(adb, [
    "-s",
    serial,
    "shell",
    "monkey",
    "-p",
    build.packageId,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ], 30000);
  if (!r.ok) {
    throw new AndroidError(
      `Could not start ${build.packageId} on ${serial}: ${r.text.trim()}`,
      500,
    );
  }
  log(`Started ${build.packageId} on ${serial}.`);
  return `Started on ${serial}.`;
}

async function taildrop(
  peer: string,
  build: AndroidBuild,
  env: Record<string, string>,
  log: Log,
): Promise<void> {
  const bin = await tailscaleBin(env);
  if (!bin) {
    throw new AndroidError("tailscale was not found on this machine.", 409);
  }
  log(`Sending ${basename(build.apk)} to ${peer} over Tailscale…`);
  const r = await runRead(bin, ["file", "cp", build.apk, `${peer}:`], {
    timeoutMs: 600_000,
  });
  if (!r.ok) {
    throw new AndroidError(
      `Taildrop to ${peer} failed: ${r.text.trim() || "no output"}`,
      500,
    );
  }
  log(`Sent. Open it from the Tailscale app on ${peer} to install.`);
}

/** Put a build onto a target. */
export async function installBuild(
  build: AndroidBuild,
  target: AndroidTarget,
  log: Log = () => {},
  env: Record<string, string> = Deno.env.toObject(),
): Promise<AndroidBuild> {
  if (target === "waydroid") await installWaydroid(build, log);
  else if (target === "wsa") {
    const adb = await requireAdb(env);
    await installAdb(adb, await ensureWsa(adb, env, log), build, log);
  } else if (target.startsWith("adb:")) {
    await installAdb(await requireAdb(env), target.slice(4), build, log);
  } else if (target.startsWith("taildrop:")) {
    await taildrop(target.slice(9), build, env, log);
  }
  return await markInstalled(build, target);
}

/** Start a build on a target, installing it there first when it is not. */
export async function launchBuild(
  build: AndroidBuild,
  target: AndroidTarget,
  log: Log = () => {},
  env: Record<string, string> = Deno.env.toObject(),
): Promise<{ build: AndroidBuild; note: string }> {
  // A mark on the row means THIS APK is on the target (listBuilds drops the
  // marks an earlier build on the same path left). Without one the launch
  // installs first — even over an older build of the same package.
  const onTarget = (build.installed || {})[target] !== undefined;
  let note: string;
  if (target === "waydroid") {
    note = await launchWaydroid(build, env, log, onTarget);
  } else if (target === "wsa") {
    const adb = await requireAdb(env);
    const serial = await ensureWsa(adb, env, log);
    if (!onTarget || !(await adbHas(adb, serial, build.packageId))) {
      await installAdb(adb, serial, build, log);
    }
    const client = wsaClientPath(env);
    if (client && await pathExists(client)) {
      spawnDetached(client, ["/launch", `wsa://${build.packageId}`]);
      log(`Launched ${build.packageId} through WsaClient.`);
      note = "Launched in the Windows Subsystem for Android.";
    } else note = await launchAdb(adb, serial, build, log);
  } else if (target.startsWith("adb:")) {
    note = await launchAdb(
      await requireAdb(env),
      target.slice(4),
      build,
      log,
      onTarget,
    );
  } else {
    // Taildrop has no launch: the phone's owner installs what arrived.
    await taildrop(target.slice(9), build, env, log);
    note = `Sent to ${target.slice(9)} — install it from the Tailscale app.`;
  }
  return { build: await markInstalled(build, target), note };
}

/** `adb connect host:port` — a phone's wireless debugging, over any network. */
export async function adbConnect(
  address: string,
  env: Record<string, string> = Deno.env.toObject(),
): Promise<{ ok: boolean; text: string }> {
  const adb = await requireAdb(env);
  const addr = address.trim();
  if (!/^[\w.\-\[\]:]+:\d+$/.test(addr)) {
    throw new AndroidError("Give the address as host:port.", 400);
  }
  const r = await adbRun(adb, ["connect", addr], 20000);
  return {
    ok: /connected to|already connected/i.test(r.text),
    text: r.text.trim(),
  };
}

/** `adb pair host:port code` — the one-time pairing wireless debugging wants. */
export async function adbPair(
  address: string,
  code: string,
  env: Record<string, string> = Deno.env.toObject(),
): Promise<{ ok: boolean; text: string }> {
  const adb = await requireAdb(env);
  const addr = address.trim();
  if (!/^[\w.\-\[\]:]+:\d+$/.test(addr)) {
    throw new AndroidError("Give the pairing address as host:port.", 400);
  }
  if (!/^\d{6}$/.test(code.trim())) {
    throw new AndroidError("The pairing code is six digits.", 400);
  }
  const r = await adbRun(adb, ["pair", addr, code.trim()], 30000);
  return { ok: /Successfully paired/i.test(r.text), text: r.text.trim() };
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
//
// A build takes minutes and an install a while; the route answers with a job
// id and the launcher polls. In-process, like lib/engine-compare.ts's: the
// launcher and this server are the one machine, and a job that outlives the
// process has nothing to report to anyway.

interface JobRecord extends AndroidJob {
  abort: AbortController;
}

const jobs = new Map<string, JobRecord>();
const LOG_LINES = 400;
const KEEP_JOBS = 24;

export function startAndroidJob(
  kind: AndroidJob["kind"],
  meta: {
    name: string;
    buildId?: string | null;
    target?: AndroidTarget | null;
  },
  work: (log: Log, signal: AbortSignal) => Promise<AndroidBuild | null>,
): AndroidJob {
  const id = kind + "-" + Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 7);
  const abort = new AbortController();
  const job: JobRecord = {
    id,
    kind,
    name: meta.name,
    buildId: meta.buildId ?? null,
    target: meta.target ?? null,
    status: "running",
    log: [],
    startedAt: Date.now(),
    endedAt: null,
    build: null,
    error: null,
    abort,
  };
  jobs.set(id, job);
  const log: Log = (line) => {
    job.log.push(String(line));
    if (job.log.length > LOG_LINES) {
      job.log.splice(0, job.log.length - LOG_LINES);
    }
  };
  work(log, abort.signal).then((build) => {
    job.build = build;
    job.status = "done";
  }, (e) => {
    job.status = "failed";
    job.error = (e as Error)?.message || String(e);
    log("✗ " + job.error);
  }).finally(() => {
    job.endedAt = Date.now();
    pruneJobs();
  });
  return publicAndroidJob(job);
}

function pruneJobs(): void {
  const finished = [...jobs.values()].filter((j) => j.status !== "running")
    .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  while (finished.length > KEEP_JOBS) jobs.delete(finished.shift()!.id);
}

export function getAndroidJob(id: string): AndroidJob | null {
  const j = jobs.get(id);
  return j ? publicAndroidJob(j) : null;
}

export function listAndroidJobs(): AndroidJob[] {
  return [...jobs.values()].map(publicAndroidJob).sort((a, b) =>
    b.startedAt - a.startedAt
  );
}

export function cancelAndroidJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== "running") return false;
  j.abort.abort();
  return true;
}

function publicAndroidJob(j: JobRecord | AndroidJob): AndroidJob {
  return {
    id: j.id,
    kind: j.kind,
    name: j.name,
    buildId: j.buildId,
    target: j.target,
    status: j.status,
    log: j.log.slice(-LOG_LINES),
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    build: j.build,
    error: j.error,
  };
}

/** For tests: forget every job. */
export function resetAndroidJobs(): void {
  jobs.clear();
}
