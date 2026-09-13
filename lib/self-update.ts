// Keeping shmupX current without the player ever building anything.
//
// The launcher is an .AppImage / .exe / .app somebody downloaded once. Every
// canary feature since then lives in this repo and is deployed on push to main,
// and none of it reaches that file — so the player either rebuilds from a
// checkout or plays a frozen copy. "Add to Steam once and never think about it
// again" (lib/steam-shortcut.ts) only holds if the thing Steam points at keeps
// up on its own.
//
// `deno desktop` does the hard part. `Deno.autoUpdate()` polls a release
// manifest, fetches a bsdiff patch of the runtime rather than a whole ~350MB
// download, verifies it, stages it for the next launch and rolls back by itself
// if that launch fails. What is left is the policy this module holds: which
// manifest THIS build should be watching, how often, and what to tell the
// player. Signing is not optional here — a launcher that will replace its own
// executable from a URL must not do it on a plain HTTPS fetch alone — so the
// Ed25519 public key travels with the build and an unsigned manifest is simply
// not honoured.
//
// scripts/release-desktop.ts publishes what this reads. desktop.ts calls
// `startAutoUpdate()` once, at boot, and routes/api/update.ts reports state.

/** Where the manifests live. Overridable for a staging channel, never by data. */
const DEFAULT_BASE_URL = "https://codemonkey.games/desktop";

/**
 * The Ed25519 public key the manifest must be signed with, base64.
 *
 * Empty means "unsigned manifests are acceptable", which this deliberately does
 * NOT default to: an empty key here disables updates rather than weakening
 * them (see `updatePlan`). Set SHMUPX_UPDATE_KEY at build time, or paste the
 * key the release script prints.
 */
const DEFAULT_PUBLIC_KEY = "";

/** Once an hour. A launcher left open for a week should not still be stale. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdateContext {
  env: Record<string, string>;
  /** `Deno.build.target`, e.g. "x86_64-unknown-linux-gnu". */
  target: string;
  /** `Deno.desktopVersion` — null in a source checkout. */
  version: string | null;
  /** Whether this process is a `deno desktop` app at all. */
  underDesktop: boolean;
}

export interface UpdatePlan {
  /** Whether to arm the updater. */
  enabled: boolean;
  /** The manifest URL for this build, when there is one. */
  url: string | null;
  publicKey: string;
  intervalMs: number;
  version: string | null;
  /** The `<os>-<arch>` segment this build watches. */
  channel: string | null;
  /** Why updates are off, when they are. */
  reason: string | null;
}

/**
 * `x86_64-unknown-linux-gnu` -> `linux-x86_64`.
 *
 * The manifest is per-architecture — a patch is a binary diff of one build
 * against another, so there is nothing shared between an x86_64 AppImage and
 * an aarch64 one — and this is the directory name the release script writes.
 */
export function updateChannel(target: string): string | null {
  const arch = target.startsWith("x86_64")
    ? "x86_64"
    : target.startsWith("aarch64")
    ? "aarch64"
    : null;
  if (!arch) return null;
  const os = target.includes("linux")
    ? "linux"
    : target.includes("darwin")
    ? "macos"
    : target.includes("windows")
    ? "windows"
    : null;
  return os && arch ? `${os}-${arch}` : null;
}

/**
 * What this build should do about updates.
 *
 * Off, with a reason, in every case where doing it would be wrong rather than
 * merely unavailable: a source checkout has no version to diff from, an
 * unrecognised target has no manifest, and a build with no public key has no
 * way to tell a real release from whatever answers that URL.
 */
export function updatePlan(ctx: UpdateContext): UpdatePlan {
  const base = (ctx.env.SHMUPX_UPDATE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const publicKey = (ctx.env.SHMUPX_UPDATE_KEY || DEFAULT_PUBLIC_KEY).trim();
  const channel = updateChannel(ctx.target);
  const off = (reason: string): UpdatePlan => ({
    enabled: false,
    url: null,
    publicKey,
    intervalMs: DEFAULT_INTERVAL_MS,
    version: ctx.version,
    channel,
    reason,
  });

  if (!ctx.underDesktop) {
    return off("this build has no updater — only the Linux and macOS apps do");
  }
  if (!ctx.version) {
    return off(
      "this build carries no version, so there is nothing to update from",
    );
  }
  if (!channel) return off(`no release channel for ${ctx.target}`);
  if (!publicKey) {
    return off(
      "this build carries no update signing key, so it will not replace " +
        "itself from the network",
    );
  }
  if (ctx.env.SHMUPX_NO_UPDATE) {
    return off("updates are switched off for this run");
  }
  return {
    enabled: true,
    url: `${base}/${channel}`,
    publicKey,
    intervalMs: Number(ctx.env.SHMUPX_UPDATE_INTERVAL_MS) > 0
      ? Number(ctx.env.SHMUPX_UPDATE_INTERVAL_MS)
      : DEFAULT_INTERVAL_MS,
    version: ctx.version,
    channel,
    reason: null,
  };
}

/** What the running process last heard from the updater. */
export interface UpdateState {
  plan: UpdatePlan;
  /** The version staged for the next launch, once one has been. */
  staged: string | null;
  /** Why the previous launch was rolled back, if it was. */
  rolledBack: string | null;
}

let state: UpdateState | null = null;

/** The updater's state, for /api/update. Null until `startAutoUpdate` runs. */
export function updateState(): UpdateState | null {
  return state;
}

/**
 * Arm the updater, once.
 *
 * Never throws: a launcher that will not start because its update check failed
 * is strictly worse than a stale one. Everything it learns goes into
 * `updateState()` and to `log`, which desktop.ts points at the console.
 */
export function startAutoUpdate(
  ctx: UpdateContext,
  log: (line: string) => void = console.log,
): UpdateState {
  const plan = updatePlan(ctx);
  state = { plan, staged: null, rolledBack: null };
  if (!plan.enabled || !plan.url) {
    if (plan.reason) log(`  Updates: off — ${plan.reason}`);
    return state;
  }
  const autoUpdate = (Deno as {
    autoUpdate?: (options: {
      url: string;
      interval?: number;
      publicKey?: string;
      onUpdateReady?: (version: string) => void;
      onRollback?: (reason: string) => void;
    }) => void;
  }).autoUpdate;
  if (typeof autoUpdate !== "function") {
    state.plan = {
      ...plan,
      enabled: false,
      reason: "this runtime has no updater",
    };
    return state;
  }
  try {
    autoUpdate({
      url: plan.url,
      interval: plan.intervalMs,
      publicKey: plan.publicKey,
      onUpdateReady(version) {
        if (state) state.staged = version;
        log(
          `\n  shmupX ${version} is ready — it starts next time you open it.\n`,
        );
      },
      onRollback(reason) {
        if (state) state.rolledBack = reason;
        log(
          `\n  The last update did not start, so it was rolled back: ${reason}\n`,
        );
      },
    });
    log(`  Updates: watching ${plan.url} (now on ${plan.version}).`);
  } catch (e) {
    state.plan = {
      ...plan,
      enabled: false,
      reason: `the updater would not start: ${(e as Error).message}`,
    };
    log(`  Updates: off — ${state.plan.reason}`);
  }
  return state;
}
