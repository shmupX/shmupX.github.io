// Dev launcher: starts vite, then opportunistically opens an ngrok tunnel so
// the Gamepad API (which requires a secure context on most browsers) works
// when a remote controller is connected. If ngrok is unavailable (binary
// missing, no auth, no internet, etc.) we still get a usable localhost dev
// server — the tunnel attempt is best-effort.

const PORT = Number(Deno.env.get("PORT") ?? "5173");
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

function pipe(child: Deno.ChildProcess, prefix: string) {
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

async function startNgrok(): Promise<Deno.ChildProcess | null> {
  // Check binary first so a missing install doesn't throw at spawn time.
  try {
    const which = new Deno.Command("ngrok", {
      args: ["version"],
      stdout: "null",
      stderr: "null",
    });
    const out = await which.output();
    if (!out.success) return null;
  } catch (_e) {
    console.log("[dev] ngrok not found — staying on localhost");
    return null;
  }

  try {
    const cmd = new Deno.Command("ngrok", {
      args: ["http", String(PORT), "--log=stdout", "--log-format=logfmt"],
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    pipe(child, "[ngrok] ");
    return child;
  } catch (e) {
    console.log(`[dev] failed to start ngrok: ${(e as Error).message}`);
    return null;
  }
}

interface NgrokTunnel {
  public_url: string;
  proto: string;
  config?: { addr?: string };
}

async function getTunnelUrl(timeoutMs = 8000): Promise<string | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const r = await fetch(NGROK_API, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        const data = await r.json() as { tunnels: NgrokTunnel[] };
        const https = data.tunnels.find((t) => t.proto === "https");
        if (https) return https.public_url;
      } else {
        await r.body?.cancel();
      }
    } catch (_e) {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const banner = (msg: string) => {
  const bar = "─".repeat(Math.max(20, msg.length + 4));
  console.log(`\n┌${bar}┐\n│  ${msg}  │\n└${bar}┘\n`);
};

const vite = startVite();
let ngrok: Deno.ChildProcess | null = null;

const cleanup = () => {
  try {
    ngrok?.kill("SIGTERM");
  } catch (_e) { /* ignore */ }
  try {
    vite.kill("SIGTERM");
  } catch (_e) { /* ignore */ }
};
Deno.addSignalListener("SIGINT", () => {
  cleanup();
  Deno.exit(130);
});
Deno.addSignalListener("SIGTERM", () => {
  cleanup();
  Deno.exit(143);
});

const ready = await waitForVite();
if (!ready) {
  console.log(
    "[dev] vite did not become ready — falling back to localhost only",
  );
} else {
  ngrok = await startNgrok();
  if (ngrok) {
    const url = await getTunnelUrl();
    if (url) {
      banner(`Tunnel:   ${url}    (Local: http://localhost:${PORT})`);
    } else {
      console.log(
        "[dev] ngrok started but no tunnel URL after 8s — using localhost only",
      );
    }
  }
}

const status = await vite.status;
cleanup();
Deno.exit(status.code);
