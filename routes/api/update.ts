import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { currentLauncherBinary } from "../../lib/launcher-binary.ts";
import { updatePlan, updateState } from "../../lib/self-update.ts";

// GET /api/update — is this copy keeping itself current, and if not, why not?
//
// The updater is the one feature here with no visible surface at all: it polls
// on `Deno.autoUpdate`'s own timer, patches a dylib the player will never see,
// and takes effect on a launch that has not happened yet. Every one of its
// refusals (lib/self-update.ts) is therefore invisible too — a launcher that
// will never update again looks exactly like one that is current — and a
// silent refusal is the same failure the refusals themselves were written to
// stop. This is where the reason comes out.
//
// There is no POST. `Deno.autoUpdate` exposes no "check now": calling it a
// second time arms a second poller rather than forcing a check, so a CHECK NOW
// button would be a lie with a progress spinner on it. The dashboard's row
// re-reads this instead.
//
// What it CANNOT say is in `armedAt`'s doc comment: the runtime reports nothing
// per poll, so an armed channel that 404s every hour is indistinguishable from
// an armed one that is up to date. The row says when it was armed, not when it
// last looked, because only one of those is known.
//
// LOCAL-ONLY, like /api/steam: the hosted origin has no launcher to update, and
// answering there would put a row about a binary in a browser tab on
// codemonkey.games.

export const handler = define.handlers({
  GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) {
      return Response.json(
        { ok: false, error: "There is nothing to update on the website." },
        { status: 403 },
      );
    }
    // `startAutoUpdate` runs once at boot (desktop.ts) and leaves its verdict
    // in the module. Null means this process never called it — `deno task dev`,
    // or the server imported by a test — and the honest answer is the plan this
    // build WOULD have, computed the same way, rather than "unknown".
    const state = updateState();
    const version = (Deno as { desktopVersion?: string | null }).desktopVersion;
    const plan = state?.plan ?? updatePlan({
      env: Deno.env.toObject(),
      target: Deno.build.target,
      version: version ?? null,
      // Deno.BrowserWindow exists only under `deno desktop`, the same tell
      // desktop.ts uses to decide whether it has a window of its own.
      underDesktop: "BrowserWindow" in Deno,
      binaryKind: currentLauncherBinary()?.kind ?? null,
    });
    return Response.json({
      ok: true,
      // Armed means the poller is running; it does not mean a release exists.
      armed: state?.armedAt != null,
      enabled: plan.enabled,
      reason: plan.reason,
      url: plan.url,
      channel: plan.channel,
      version: plan.version,
      intervalMs: plan.intervalMs,
      /** The version staged for the next launch, once one has been. */
      staged: state?.staged ?? null,
      /** Why the previous launch was rolled back, if it was. */
      rolledBack: state?.rolledBack ?? null,
      armedAt: state?.armedAt ?? null,
      lastError: state?.lastError ?? null,
      /** Whether this process ever armed it — false under `deno task dev`. */
      started: state !== null,
    }, { headers: { "cache-control": "no-store" } });
  },
});
