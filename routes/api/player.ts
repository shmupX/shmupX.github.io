import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { authorFromEnvironment } from "../../packages/shmup-engine/src/write/attribution.js";
import { isOwnMachine } from "./host.ts";

// GET /api/player — who is at this machine?
//
// Answers { available, user }: the account name, else the name of the home
// directory (authorFromEnvironment — the same rule `deno task build:sav`
// applies to its own environment). The editor asks when it exports a Dezaemon
// cart: a web game that names nobody goes out PRESENTED BY its player on the
// staff roll, and a browser has no other way to learn who that is.
//
// A route of its own rather than a field of /api/host, which waits on the
// machine's DMI strings — a PowerShell spawn on Windows — and an export should
// not.
//
// LOCAL-ONLY, by /api/host's rule and for a stronger reason: the name belongs
// to whoever is sitting at the serving machine, so only a browser on that
// machine is told it. A phone on the tunnel or a second PC on the LAN gets
// "not available" and exports uncredited until a name is typed; the hosted
// deploy has no player at all; and the Fetch Metadata gate keeps a cross-site
// page from reading an account name.

/** The player, read through `get` so a test can stand in for the environment. */
export function hostUser(
  get: (key: string) => string | undefined = (key) => Deno.env.get(key),
): string | null {
  const env: Record<string, string | undefined> = {};
  for (const key of ["USER", "LOGNAME", "USERNAME", "HOME", "USERPROFILE"]) {
    try {
      env[key] = get(key);
    } catch {
      // not permitted to read this one: the next may still answer
    }
  }
  return authorFromEnvironment(env);
}

export const handler = define.handlers({
  GET(ctx) {
    if (isDeploy()) {
      return Response.json({ available: false, reason: "local only" });
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const info = (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info;
    if (!isOwnMachine(info?.remoteAddr, ctx.req.headers)) {
      return Response.json({ available: false, reason: "remote client" });
    }
    return Response.json({ available: true, user: hostUser() }, {
      headers: { "cache-control": "no-store" },
    });
  },
});
