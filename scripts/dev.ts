// Dev launcher: starts vite, then opportunistically publishes it through
// Tailscale so a phone or a handheld can reach the dev server over HTTPS —
// the Gamepad API wants a secure context on most browsers, and a launcher on
// another machine wants a URL it can open. `tailscale funnel <port>` gives a
// public https://<machine>.<tailnet>.ts.net (SHMUPX_TUNNEL=funnel, the
// default); `tailscale serve <port>` the same URL for devices on your tailnet
// only (SHMUPX_TUNNEL=serve); SHMUPX_TUNNEL=off skips it. Either command runs
// in the foreground and is ephemeral, so the tunnel lives exactly as long as
// this process. If Tailscale is unavailable (not installed, logged out,
// Funnel not enabled) we still get a usable localhost dev server — the
// tunnel attempt is best-effort, and the console says what to fix.
//
// TAILSCALE_INVITE_URL, when set in the environment, is printed beside the
// tailnet-only URL so the other device can be invited onto the tailnet. It is
// a credential: keep it in the environment, never in the repo.

import {
  explainTunnelError,
  parseStatus,
  tailscaleCandidates,
  tunnelArgs,
  type TunnelMode,
  tunnelModeFromEnv,
  tunnelOffArgs,
  tunnelUrl,
  urlInLine,
} from "../lib/tailscale.ts";

const PORT = Number(Deno.env.get("PORT") ?? "5173");
const TUNNEL = tunnelModeFromEnv(Deno.env.get("SHMUPX_TUNNEL"));
const INVITE_URL = (Deno.env.get("TAILSCALE_INVITE_URL") ?? "").trim();

function pipe(
  child: Deno.ChildProcess,
  prefix: string,
  onLine?: (line: string) => void,
) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const forward = async (
    stream: ReadableStream<Uint8Array>,
    out: WritableStream<Uint8Array>,
  ) => {
    const writer = out.getWriter();
    for await (const chunk of stream) {
      const text = dec.decode(chunk);
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const eol = i < lines.length - 1 ? "\n" : "";
        if (line || eol) {
          await writer.write(enc.encode(`${prefix}${line}${eol}`));
          if (line && onLine) onLine(line);
        }
      }
    }
    writer.releaseLock();
  };
  forward(child.stdout, Deno.stdout.writable).catch(() => {});
  forward(child.stderr, Deno.stderr.writable).catch(() => {});
}

function startVite(): Deno.ChildProcess {
  // Go through `deno task` so Vite picks up Deno's npm/jsr package resolution
  // (the project depends on @fresh/plugin-vite via JSR).
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["task", "dev:vite", "--port", String(PORT)],
    stdout: "piped",
    stderr: "piped",
    env: { FORCE_COLOR: "1" },
  });
  const child = cmd.spawn();
  pipe(child, "");
  return child;
}

async function waitForVite(timeoutMs = 20_000): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, {
        signal: AbortSignal.timeout(1000),
      });
      await r.body?.cancel();
      return true;
    } catch (_e) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

// ── Tailscale ──────────────────────────────────────────────────────────────

/** The first `tailscale` that answers `version`, or null. */
async function findTailscale(): Promise<string | null> {
  for (const bin of tailscaleCandidates(Deno.build.os, Deno.env.toObject())) {
    try {
      const out = await new Deno.Command(bin, {
        args: ["version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (out.success) return bin;
    } catch (_e) {
      // not here — try the next place
    }
  }
  return null;
}

async function tailscaleStatus(bin: string) {
  try {
    const out = await new Deno.Command(bin, {
      args: ["status", "--json"],
      stdout: "piped",
      stderr: "null",
    }).output();
    return parseStatus(new TextDecoder().decode(out.stdout));
  } catch (_e) {
    return parseStatus("");
  }
}

interface Tunnel {
  child: Deno.ChildProcess;
  mode: TunnelMode;
  bin: string;
  /** Resolves with the URL once the CLI prints it (or the child dies: ""). */
  url: Promise<string>;
  /** Everything the CLI said, for the error hints. */
  output: () => string;
}

function startTunnel(bin: string, mode: TunnelMode): Tunnel | null {
  try {
    const child = new Deno.Command(bin, {
      args: tunnelArgs(mode, PORT),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let said = "";
    let resolveUrl: (url: string) => void = () => {};
    const url = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    pipe(child, "[tailscale] ", (line) => {
      said += line + "\n";
      const found = urlInLine(line);
      if (found) resolveUrl(found);
    });
    child.status.then(() => resolveUrl(""));
    return { child, mode, bin, url, output: () => said };
  } catch (e) {
    console.log(`[dev] failed to start tailscale: ${(e as Error).message}`);
    return null;
  }
}

/** Kill the foreground run and clear its config (a Windows kill is not the
 * Ctrl+C the CLI tidies up on). */
async function stopTunnel(t: Tunnel | null) {
  if (!t) return;
  try {
    t.child.kill("SIGTERM");
  } catch (_e) { /* already gone */ }
  try {
    await new Deno.Command(t.bin, {
      args: tunnelOffArgs(t.mode),
      stdout: "null",
      stderr: "null",
    }).output();
  } catch (_e) { /* best effort */ }
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);

/**
 * Publish the dev server. Funnel first (public); when Funnel is not enabled
 * for this machine, Serve (tailnet only) with the CLI's own enable-link in
 * the console. Returns the running tunnel, or null with the reason printed.
 */
async function openTunnel(): Promise<Tunnel | null> {
  if (TUNNEL === "off") {
    console.log("[dev] SHMUPX_TUNNEL=off — staying on localhost");
    return null;
  }
  const bin = await findTailscale();
  if (!bin) {
    console.log(
      "[dev] tailscale not found — staying on localhost (install it from https://tailscale.com/download, then `tailscale up`)",
    );
    return null;
  }
  const status = await tailscaleStatus(bin);
  if (status.backendState !== "Running" || !status.dnsName) {
    console.log(
      `[dev] tailscale is ${
        status.backendState || "not answering"
      } — staying on localhost (run \`tailscale up\` and log in)`,
    );
    return null;
  }
  if (!status.certDomains.length) {
    console.log(
      "[dev] your tailnet has no HTTPS certificates yet — enable them in the admin console (DNS → HTTPS Certificates); trying anyway",
    );
  }

  let mode: TunnelMode = TUNNEL;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = startTunnel(bin, mode);
    if (!t) return null;
    // The CLI prints the URL within a moment; the machine's MagicDNS name
    // says what it will be either way.
    const url = await withTimeout(t.url, 8000, tunnelUrl(status.dnsName));
    if (url) {
      // Still running? A refused Funnel exits at once with its reason.
      const dead = await withTimeout(
        t.child.status.then(() => true),
        500,
        false,
      );
      if (!dead) return t;
    }
    const hint = explainTunnelError(mode, t.output());
    await stopTunnel(t);
    for (const line of hint.lines) console.log(`[dev] ${line}`);
    if (!hint.lines.length) {
      console.log(
        `[dev] tailscale ${mode} did not come up — staying on localhost`,
      );
    }
    if (!hint.fallbackToServe) return null;
    mode = "serve";
  }
  return null;
}

const banner = (lines: string[]) => {
  const width = Math.max(20, ...lines.map((l) => l.length + 4));
  const bar = "─".repeat(width);
  const body = lines.map((l) => `│  ${l.padEnd(width - 4)}  │`).join("\n");
  console.log(`\n┌${bar}┐\n${body}\n└${bar}┘\n`);
};

const vite = startVite();
let tunnel: Tunnel | null = null;

const cleanup = () => {
  const t = tunnel;
  tunnel = null;
  stopTunnel(t).catch(() => {});
  try {
    vite.kill("SIGTERM");
  } catch (_e) { /* ignore */ }
};
Deno.addSignalListener("SIGINT", () => {
  cleanup();
  Deno.exit(130);
});
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", () => {
    cleanup();
    Deno.exit(143);
  });
}

const ready = await waitForVite();
if (!ready) {
  console.log(
    "[dev] vite did not become ready — falling back to localhost only",
  );
} else {
  tunnel = await openTunnel();
  if (tunnel) {
    const url = await tunnel.url;
    const reach = tunnel.mode === "funnel"
      ? "public, via Tailscale Funnel"
      : "your tailnet only, via Tailscale Serve";
    const lines = [
      `Tunnel:   ${url}    (${reach})`,
      `Local:    http://localhost:${PORT}`,
    ];
    if (tunnel.mode === "serve" && INVITE_URL) {
      lines.push(
        `Invite:   ${INVITE_URL}    (join the tailnet from the other device)`,
      );
    }
    banner(lines);
  }
}

const status = await vite.status;
cleanup();
Deno.exit(status.code);
