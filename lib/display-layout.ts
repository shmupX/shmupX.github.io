// lib/display-layout.ts — the screens a Linux desktop launcher is shown on,
// and turning the built-in one back on as a controller.
//
// The case this exists for: a Lenovo Legion Go docked to a monitor, set (as
// KDE lets you) to use ONLY the external display while one is connected. The
// game belongs on the monitor; the Legion's own touchscreen, dark, is the one
// thing in the room that could be a controller when no pad is in hand. So the
// launcher asks for the built-in panel back — enabled, extended beside the
// monitor, the monitor still primary — shows the touch controller on it
// (static/virtual-pad/index.html, in a second window), and puts the layout
// back exactly as it found it when the game ends.
//
// No permissions beyond the session's own: on KDE Plasma (Bazzite's desktop
// mode, SteamOS's) `kscreen-doctor` is the same per-user configuration the
// Display Configuration page writes, and on an X11 session `xrandr` is too. A
// GNOME Wayland session offers no such command — the answer there is a reason
// to show, not a change — and gamescope (Bazzite's and SteamOS's Game Mode)
// drives one display at a time, so there is nothing to extend onto.
//
// The parsing and planning are pure (tests/display_layout_test.ts holds them
// to fixtures); only detectOutputs and applyCommands touch the machine.

export type DisplayBackend = "kscreen" | "xrandr";

export interface DisplayOutput {
  /** Connector name: "eDP-1", "HDMI-A-1", "DP-2". */
  name: string;
  connected: boolean;
  enabled: boolean;
  /** The device's own panel (eDP / LVDS / DSI) rather than a plugged-in one. */
  internal: boolean;
  primary: boolean;
  /** Logical position and size, as windows are placed (after scale and rotation). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayPlan {
  backend: DisplayBackend;
  internal: DisplayOutput;
  external: DisplayOutput;
  /** Commands that bring the built-in panel up beside the monitor ([] when it already is). */
  apply: string[][];
  /** Commands that put the layout back the way it was ([] when nothing changed). */
  restore: string[][];
}

/** Connector names a laptop or handheld gives its own panel. */
export function isInternalName(name: string): boolean {
  return /^(edp|lvds|dsi)/i.test(name.trim());
}

// ── KDE: kscreen-doctor -j ──────────────────────────────────────────────────

interface KscreenSize {
  width?: number;
  height?: number;
}
interface KscreenMode {
  id?: string | number;
  size?: KscreenSize;
}
interface KscreenOutput {
  name?: string;
  connected?: boolean;
  enabled?: boolean;
  primary?: boolean;
  priority?: number;
  pos?: { x?: number; y?: number };
  size?: KscreenSize;
  scale?: number;
  rotation?: number;
  currentModeId?: string | number;
  preferredModes?: Array<string | number>;
  modes?: KscreenMode[];
  type?: number | string;
}

// kscreen's Output::Rotation: None 1, Left 2, Inverted 4, Right 8. A quarter
// turn swaps width and height — and the Legion Go's panel is natively portrait
// (1600×2560), turned a quarter by default, so this is the common case there.
function quarterTurn(rotation: number | undefined): boolean {
  return rotation === 2 || rotation === 8;
}

/** `kscreen-doctor -j` (KDE Plasma 5.x / 6.x) as outputs. */
export function parseKscreenJson(text: string): DisplayOutput[] {
  let doc: { outputs?: KscreenOutput[] };
  try {
    doc = JSON.parse(text);
  } catch (_e) {
    return [];
  }
  const out: DisplayOutput[] = [];
  for (const o of doc.outputs ?? []) {
    if (!o || typeof o.name !== "string") continue;
    const modes = Array.isArray(o.modes) ? o.modes : [];
    const byId = (id: unknown) =>
      modes.find((m) =>
        id !== undefined && id !== "" && String(m.id) === String(id)
      );
    // A disabled output has no current mode; its preferred one is what it
    // comes back on.
    const mode = byId(o.currentModeId) ??
      byId(o.preferredModes?.[0]) ??
      modes[0];
    const px = mode?.size ?? o.size ?? {};
    let w = Number(px.width) || 0;
    let h = Number(px.height) || 0;
    if (quarterTurn(o.rotation)) [w, h] = [h, w];
    const scale = Number(o.scale) > 0 ? Number(o.scale) : 1;
    out.push({
      name: o.name,
      connected: o.connected !== false,
      enabled: !!o.enabled,
      internal: isInternalName(o.name) || o.type === 7 || o.type === "Panel",
      // Plasma 6 replaced "primary" with a priority order (1 = primary).
      primary: o.primary === true || o.priority === 1,
      x: Number(o.pos?.x) || 0,
      y: Number(o.pos?.y) || 0,
      width: Math.round(w / scale),
      height: Math.round(h / scale),
    });
  }
  return out;
}

// ── X11: xrandr --query ─────────────────────────────────────────────────────

/** `xrandr --query` as outputs. Disabled outputs report no geometry. */
export function parseXrandr(text: string): DisplayOutput[] {
  const out: DisplayOutput[] = [];
  const head =
    /^(\S+)\s+(connected|disconnected)(\s+primary)?(?:\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+))?(?:\s+(normal|left|inverted|right))?/;
  let current: DisplayOutput | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = head.exec(line);
    if (m) {
      current = {
        name: m[1],
        connected: m[2] === "connected",
        enabled: m[4] !== undefined,
        internal: isInternalName(m[1]),
        primary: !!m[3],
        x: Number(m[6] ?? 0),
        y: Number(m[7] ?? 0),
        // xrandr already reports the rotated, scaled framebuffer region.
        width: Number(m[4] ?? 0),
        height: Number(m[5] ?? 0),
      };
      out.push(current);
      continue;
    }
    // A disabled output's size comes from its preferred mode ("+" marks it).
    if (current && !current.enabled && current.width === 0) {
      const mode = /^\s+(\d+)x(\d+)\S*\s.*\+/.exec(line);
      if (mode) {
        current.width = Number(mode[1]);
        current.height = Number(mode[2]);
      }
    }
  }
  return out;
}

// ── the plan ────────────────────────────────────────────────────────────────

/** The monitor the game goes to: the primary external one, else the first lit. */
export function pickExternal(outputs: DisplayOutput[]): DisplayOutput | null {
  const lit = outputs.filter((o) => o.connected && !o.internal && o.enabled);
  return lit.find((o) => o.primary) ?? lit[0] ?? null;
}

export function pickInternal(outputs: DisplayOutput[]): DisplayOutput | null {
  return outputs.find((o) => o.connected && o.internal) ?? null;
}

/**
 * How to get the built-in panel up beside the monitor, and back.
 *
 * The panel goes to the RIGHT of the monitor, top-aligned, so the monitor's
 * origin — where the launcher's window is — does not move. The monitor stays
 * primary. Only what was changed is undone: a panel that was already on stays
 * on when the game ends.
 */
export function planExtend(
  outputs: DisplayOutput[],
  backend: DisplayBackend,
): DisplayPlan | { error: string } {
  const external = pickExternal(outputs);
  if (!external) return { error: "no external display is connected" };
  const internal = pickInternal(outputs);
  if (!internal) return { error: "this machine has no built-in screen to use" };
  if (internal.enabled) {
    return { backend, internal, external, apply: [], restore: [] };
  }
  const x = external.x + external.width;
  const y = external.y;
  const placed = { ...internal, enabled: true, x, y };
  if (backend === "kscreen") {
    return {
      backend,
      internal: placed,
      external,
      apply: [[
        "kscreen-doctor",
        `output.${internal.name}.enable`,
        `output.${internal.name}.position.${x},${y}`,
        `output.${external.name}.primary`,
      ]],
      restore: [["kscreen-doctor", `output.${internal.name}.disable`]],
    };
  }
  return {
    backend,
    internal: placed,
    external,
    apply: [[
      "xrandr",
      "--output",
      internal.name,
      "--auto",
      "--right-of",
      external.name,
      "--output",
      external.name,
      "--primary",
    ]],
    restore: [["xrandr", "--output", internal.name, "--off"]],
  };
}

// ── the machine ─────────────────────────────────────────────────────────────

/**
 * Why this session cannot rearrange its displays, or null when it can try.
 * `env` is the process environment.
 */
export function unsupportedReason(
  os: string,
  env: Record<string, string | undefined>,
): string | null {
  if (os !== "linux") return "the controller screen is Linux-only for now";
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${
    env.DESKTOP_SESSION ?? ""
  }`;
  if (env.GAMESCOPE_WAYLAND_DISPLAY || /gamescope/i.test(desktop)) {
    return "Game Mode (gamescope) shows one display at a time — switch to " +
      "Desktop Mode to use the built-in screen as a controller";
  }
  return null;
}

async function output(cmd: string[]): Promise<string | null> {
  try {
    const r = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "null",
    }).output();
    return r.success ? new TextDecoder().decode(r.stdout) : null;
  } catch (_e) {
    return null; // not installed
  }
}

/** The outputs as this session's display server sees them, and through what. */
export async function detectOutputs(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<{ backend: DisplayBackend; outputs: DisplayOutput[] } | null> {
  const kde = /kde|plasma/i.test(env.XDG_CURRENT_DESKTOP ?? "") ||
    !!env.KDE_FULL_SESSION;
  const order: DisplayBackend[] = kde || env.WAYLAND_DISPLAY
    ? ["kscreen", "xrandr"]
    : ["xrandr", "kscreen"];
  for (const backend of order) {
    if (backend === "kscreen") {
      const text = await output(["kscreen-doctor", "-j"]);
      const outputs = text ? parseKscreenJson(text) : [];
      if (outputs.length) return { backend, outputs };
    } else if (env.DISPLAY && !env.WAYLAND_DISPLAY) {
      // xrandr under Wayland only sees XWayland's fake outputs and cannot
      // change anything real, so it is an X11-session-only answer.
      const text = await output(["xrandr", "--query"]);
      const outputs = text ? parseXrandr(text) : [];
      if (outputs.length) return { backend, outputs };
    }
  }
  return null;
}

/** Run a plan's commands in order; the first failure stops and is returned. */
export async function applyCommands(cmds: string[][]): Promise<string | null> {
  for (const cmd of cmds) {
    try {
      const r = await new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!r.success) {
        const err = new TextDecoder().decode(r.stderr).trim();
        return `${cmd[0]} failed${err ? `: ${err.split("\n")[0]}` : ""}`;
      }
    } catch (e) {
      return `${cmd[0]}: ${(e as Error).message}`;
    }
  }
  return null;
}
