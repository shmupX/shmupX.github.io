import { define } from "../../utils.ts";
import { crossSiteGuard } from "../../lib/local-guards.ts";
import { ExportError, runExport } from "@shmupx/shmup-harbor/export";

// POST /api/build-apk — export a custom Firebase "Game" to an installable app.
//
// The build pipeline lives IN this repo at tools/build-level and compiles cmg's
// own 2028-ai game (static/games/2028-ai); PS2 is built in-process by lib/ps2.
// All of that is lib/export-build.ts — this route is the HTTP face of it for
// the level editor (static/editor/index.html), which POSTs here when it is
// served from a local host. The same builder is what lib/export-worker.ts runs
// for a job queued from a phone or the hosted site.
//
// LOCAL-ONLY: it spawns a subprocess and writes to disk, so it is refused on the
// read-only Deno Deploy origin. The editor treats that refusal as its cue to
// queue the build on a paired desktop instead (static/export-queue.js).

export const handler = define.handlers({
  async POST(ctx) {
    // Requiring a JSON body is not a CSRF defense: a cross-site page can post
    // text/plain without tripping a CORS preflight, and ctx.req.json() parses it
    // all the same. Since a hit here spawns the build tool and writes to disk,
    // gate on Fetch Metadata the way every other mutating local route does.
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (Deno.env.get("DENO_DEPLOYMENT_ID")) {
      return Response.json(
        {
          ok: false,
          error: "APK export is only available on a local install.",
        },
        { status: 403 },
      );
    }

    let body: { level?: string; platform?: string; levelRecord?: unknown };
    try {
      body = await ctx.req.json();
    } catch (_e) {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }

    try {
      const built = await runExport({
        level: body.level || "",
        platform: body.platform || "android",
        // A Dezaemon cart open in the editor has no cloud record to fetch, so
        // the editor sends the record itself. Absent for a normal cloud level,
        // which is fetched exactly as before.
        ...(body.levelRecord === undefined
          ? {}
          : { levelRecord: body.levelRecord }),
      });
      // `ps2` rides along only for a PS2 build — named rather than positional,
      // so the editor can offer the disc and the USB folder as separate
      // downloads (see /api/build-artifact).
      return Response.json({ ok: true, ...built });
    } catch (e) {
      if (e instanceof ExportError) {
        return Response.json(
          { ok: false, error: e.message, ...(e.log ? { log: e.log } : {}) },
          { status: e.status },
        );
      }
      return Response.json(
        { ok: false, error: (e as Error).message },
        { status: 500 },
      );
    }
  },
});
