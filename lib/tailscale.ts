// lib/tailscale.ts — the dev server's public URL, through Tailscale.
//
// `deno task dev` (scripts/dev.ts) used to open an ngrok tunnel so a phone or
// a handheld could reach the Vite server over HTTPS — the Gamepad API wants a
// secure context. Tailscale does the same job without a third party in the
// path: `tailscale funnel <port>` publishes https://<machine>.<tailnet>.ts.net
// to the internet, `tailscale serve <port>` to the tailnet alone, and either
// one, run in the foreground, is ephemeral — it goes away with the process.
//
// Everything here is the pure half: where the CLI lives, what its status JSON
// says, which command to run and what URL it yields, and what a failure means
// in words. scripts/dev.ts does the spawning.

export type TunnelMode = "funnel" | "serve";

/** The mode `deno task dev` runs in, from SHMUPX_TUNNEL: funnel | serve | off. */
export function tunnelModeFromEnv(
  value: string | undefined,
): TunnelMode | "off" {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "none") return "off";
  if (v === "serve" || v === "tailnet") return "serve";
  return "funnel";
}

/**
 * Where the `tailscale` CLI may be, in the order to try it. The macOS app
 * ships the CLI inside its bundle rather than on PATH, and the Windows
 * installer puts it under Program Files; both are tried after the bare name.
 */
export function tailscaleCandidates(
  os: string,
  env: Record<string, string | undefined> = {},
): string[] {
  const out = ["tailscale"];
  if (os === "darwin") {
    out.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
    out.push("/usr/local/bin/tailscale");
  } else if (os === "windows") {
    const pf = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
    out.push(`${pf}\\Tailscale\\tailscale.exe`);
  } else {
    out.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
  }
  return out;
}

export interface TailscaleStatus {
  /** "Running", "Stopped", "NeedsLogin", "NoState", … */
  backendState: string;
  /** This machine's MagicDNS name without the trailing dot, or "". */
  dnsName: string;
  hostName: string;
  /** The tailnet's MagicDNS suffix ("tailXXXX.ts.net"), or "". */
  magicDnsSuffix: string;
  /** HTTPS certificates are enabled for the tailnet: Funnel and Serve can
   * mint https://<dnsName>. */
  certDomains: string[];
  tailscaleIPs: string[];
}

interface RawStatus {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; HostName?: unknown; TailscaleIPs?: unknown };
  CurrentTailnet?: { MagicDNSSuffix?: unknown };
  CertDomains?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** `tailscale status --json`, the parts the dev server cares about. */
export function parseStatus(json: string): TailscaleStatus {
  let raw: RawStatus = {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") raw = parsed as RawStatus;
  } catch {
    raw = {};
  }
  return {
    backendState: str(raw.BackendState),
    dnsName: str(raw.Self?.DNSName).replace(/\.$/, ""),
    hostName: str(raw.Self?.HostName),
    magicDnsSuffix: str(raw.CurrentTailnet?.MagicDNSSuffix).replace(/\.$/, ""),
    certDomains: strs(raw.CertDomains),
    tailscaleIPs: strs(raw.Self?.TailscaleIPs),
  };
}

/** The URL a Funnel or Serve on `port` answers at, given the machine's name. */
export function tunnelUrl(dnsName: string, httpsPort = 443): string {
  if (!dnsName) return "";
  return httpsPort === 443
    ? `https://${dnsName}/`
    : `https://${dnsName}:${httpsPort}/`;
}

/**
 * The foreground command: `tailscale funnel <port>` / `tailscale serve
 * <port>` proxies https://<machine>.<tailnet>.ts.net (port 443) to
 * http://127.0.0.1:<port> for as long as the process runs.
 */
export function tunnelArgs(mode: TunnelMode, port: number): string[] {
  return [mode, String(port)];
}

/** The command that clears what a foreground run may have left behind
 * (Windows cannot deliver the Ctrl+C the CLI cleans up on). */
export function tunnelOffArgs(mode: TunnelMode): string[] {
  return [mode, "--https=443", "off"];
}

/** The first https://….ts.net URL in a line of the CLI's output, or "". */
export function urlInLine(line: string): string {
  const m = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d+)?\/?/i.exec(
    line,
  );
  return m ? m[0] : "";
}

export interface TunnelHint {
  /** Try the tailnet-only Serve instead of Funnel. */
  fallbackToServe: boolean;
  lines: string[];
}

/**
 * What the CLI's complaint means, and what to do about it. The messages are
 * matched loosely: the CLI has reworded them across versions.
 */
export function explainTunnelError(
  mode: TunnelMode,
  output: string,
): TunnelHint {
  const text = output || "";
  const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0] ?? "";
  if (
    /funnel (is )?not (enabled|available)|funnel.*(disabled|not allowed)/i.test(
      text,
    )
  ) {
    return {
      fallbackToServe: mode === "funnel",
      lines: [
        "Tailscale Funnel is not enabled for this machine.",
        link
          ? `Enable it here: ${link}`
          : "Enable it in the admin console's Access Controls (the `funnel` node attribute), then run `tailscale funnel` once to accept.",
        "Falling back to `tailscale serve`, which only devices on your tailnet can reach.",
      ],
    };
  }
  if (/https.*(cert|not enabled)|enable https|certif/i.test(text)) {
    return {
      fallbackToServe: false,
      lines: [
        "HTTPS certificates are not enabled for your tailnet.",
        link
          ? `Enable them here: ${link}`
          : "Enable them in the admin console: DNS → HTTPS Certificates.",
      ],
    };
  }
  if (
    /not logged in|logged out|needs ?login|is stopped|not running|failed to connect/i
      .test(text)
  ) {
    return {
      fallbackToServe: false,
      lines: [
        "Tailscale is not running or not logged in on this machine.",
        "Run `tailscale up` (and log in), then start the dev server again.",
      ],
    };
  }
  return { fallbackToServe: false, lines: [] };
}
