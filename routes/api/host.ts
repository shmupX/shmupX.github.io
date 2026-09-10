import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { detectHostDevice } from "../../lib/host-device.ts";

// GET /api/host — what machine is the launcher running on?
//
// Answers { available, os, legionGo, detachable, model, dmi } from the DMI
// product strings (lib/host-device.ts). The launcher asks once at boot: on a
// Lenovo Legion Go whose controller comes apart, Split Controller mode —
// each half of the pad as its own player — defaults ON for the games it
// launches, and a pad that vanishes while the keyboard starts talking reads
// as the Legion's FPS mode (svelte-src/Dashboard.svelte). The Gamepad API
// cannot say any of this on Windows, where the built-in pad is XInput's
// anonymous "Xbox 360 Controller".
//
// LOCAL-ONLY: it describes the machine SERVING the launcher, which is only
// the machine holding the pad when the browser is on the same box — so it
// answers that box alone: a client on loopback, or one whose address is the
// very address it asked for (the desktop binary bound to a LAN address with
// SHMUPX_HOST, opened in its own window), and never a request that came
// through a proxy (the dev tunnel — Tailscale Funnel or Serve, scripts/dev.ts
// — connects from the local daemon but stamps X-Forwarded-For). A phone on the tunnel, or a second PC on the LAN
// address, is told "not available" rather than the Legion's verdict. The
// hosted deploy answers "not available" without looking, and the Fetch
// Metadata gate keeps a cross-site page from reading which hardware the user
// has.

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** The IP a Host header names, without port or brackets. */
function hostIp(host: string | null): string {
  if (!host) return "";
  const h = host.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1];
  const i = h.lastIndexOf(":");
  return i > 0 && !h.slice(i + 1).includes(":") ? h.slice(0, i) : h;
}

/**
 * Is this request from the serving machine itself? Loopback, the address the
 * request was addressed to (a machine reaching its own LAN interface), or no
 * address at all (desktop.ts's in-process server.fetch) — and not forwarded.
 */
export function isOwnMachine(
  addr: Deno.Addr | undefined,
  headers: Headers,
): boolean {
  if (headers.has("x-forwarded-for") || headers.has("x-forwarded-host")) {
    return false;
  }
  if (!addr) return true;
  if (addr.transport !== "tcp" && addr.transport !== "udp") return true;
  const h = addr.hostname.toLowerCase();
  if (LOOPBACK.has(h) || h.startsWith("127.")) return true;
  const asked = hostIp(headers.get("host"));
  return asked !== "" && asked === h;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (isDeploy()) {
      return Response.json({ available: false, reason: "local only" });
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const info = (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info;
    if (!isOwnMachine(info?.remoteAddr, ctx.req.headers)) {
      return Response.json({ available: false, reason: "remote client" });
    }
    return Response.json(await detectHostDevice(), {
      headers: { "cache-control": "no-store" },
    });
  },
});
