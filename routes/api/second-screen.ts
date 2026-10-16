import { define } from "../../utils.ts";
import { crossSiteGuard, localWriteGuard } from "../../lib/local-guards.ts";
import {
  closeSecondScreen,
  openSecondScreen,
  secondScreenStatus,
} from "../../lib/second-screen.ts";
import { isOwnMachine } from "./host.ts";

// /api/second-screen — the machine's own touchscreen as the controller while
// the game plays on a monitor (lib/second-screen.ts, lib/display-layout.ts).
//
//   GET                                  → { available, reason?, external, internalEnabled, open }
//   POST { action: "open", layout, title? } → { ok, reason? }
//   POST { action: "close" }                → { ok, reason? }
//
// The launcher asks when a game starts with no pad in hand and the Touch
// Controller setting on (svelte-src/Dashboard.svelte), and closes it again when
// the game ends, a pad turns up, or the controller page's PLAY HERE is pressed.
//
// LOCAL-ONLY, like /api/host: it rearranges THIS machine's displays, so it
// answers only the browser on this machine — never the dev tunnel, another PC
// on the LAN, or the hosted deploy.

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\])$/i;

/**
 * The origin the controller page is opened on. It must be the launcher page's
 * own — a BroadcastChannel only reaches the same origin — and the page knows
 * that exactly (`location.origin`), where the request URL may say 127.0.0.1
 * for a page loaded as localhost. So the page's word is taken, but only for a
 * loopback address on this same port; anything else falls back to the
 * request's own origin.
 */
export function controllerOrigin(claimed: unknown, requestUrl: string): string {
  const here = new URL(requestUrl);
  if (typeof claimed === "string") {
    try {
      const u = new URL(claimed);
      if (
        (u.protocol === "http:" || u.protocol === "https:") &&
        LOOPBACK.test(u.hostname) && u.port === here.port
      ) {
        return u.origin;
      }
    } catch (_e) { /* not a URL */ }
  }
  return here.origin;
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const info = (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info;
    if (!isOwnMachine(info?.remoteAddr, ctx.req.headers)) {
      return Response.json({ available: false, reason: "remote client" });
    }
    return Response.json(await secondScreenStatus(), {
      headers: { "cache-control": "no-store" },
    });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    const info = (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info;
    if (!isOwnMachine(info?.remoteAddr, ctx.req.headers)) {
      return Response.json({ ok: false, reason: "remote client" }, {
        status: 403,
      });
    }
    let body: Record<string, unknown>;
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, reason: "Expected a JSON body." }, {
        status: 400,
      });
    }
    if (body.action === "close") {
      return Response.json(await closeSecondScreen());
    }
    if (body.action === "open") {
      const result = await openSecondScreen({
        origin: controllerOrigin(body.origin, ctx.req.url),
        layout: body.layout === "twin" ? "twin" : "classic",
        title: typeof body.title === "string" ? body.title : undefined,
      });
      return Response.json(result);
    }
    return Response.json({ ok: false, reason: "unknown action" }, {
      status: 400,
    });
  },
});
