import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { currentLauncherBinary } from "../../lib/launcher-binary.ts";
import {
  installShortcut,
  steamIsRunning,
  type SteamOs,
  steamRoots,
} from "../../lib/steam-library.ts";

// /api/steam — put this launcher in Steam's library as a non-Steam game.
//
//   GET   what the button should say: whether Steam is here, whether this is a
//         packaged launcher with a path worth adding, and whether the client is
//         running (which decides whether the player has to restart it).
//   POST  { action: "add" } — write the shortcut into every signed-in account.
//
// The whole point is that the player never does this by hand. On a handheld in
// Game Mode, "add a non-Steam game" means leaving Game Mode, finding a desktop
// file picker that hides AppImages by default, and knowing where the download
// went — for a launcher whose own README has always just told them to do that
// (README.md's "Games → Add a Non-Steam Game"). lib/steam-shortcut.ts writes
// the entry, lib/steam-library.ts finds the files.
//
// LOCAL-ONLY: it writes into this machine's Steam config, so the hosted origin
// refuses it — which is also how the dashboard learns not to show the row.

function launcherOs(): SteamOs {
  return Deno.build.os === "windows"
    ? "windows"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
}

function env(): Record<string, string> {
  try {
    return Deno.env.toObject();
  } catch {
    return {};
  }
}

/** The shortcut this launcher would write, or why it cannot write one. */
async function survey() {
  const os = launcherOs();
  const environment = env();
  const binary = currentLauncherBinary();
  const roots = await steamRoots(os, environment);
  return {
    os,
    binary,
    steamFound: roots.length > 0,
    steamRunning: await steamIsRunning(os, environment),
    // A source checkout has no launcher binary to add — `deno` itself is not a
    // game. Saying which build task produces one is more use than "unavailable".
    reason: binary
      ? roots.length ? null : "Steam is not installed on this machine"
      : "this is a source checkout — run `deno task build:desktop` and add the " +
        "app it produces",
  };
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) {
      return Response.json(
        { ok: false, error: "Adding to Steam only works on a local install." },
        { status: 403 },
      );
    }
    return Response.json({ ok: true, ...await survey() }, {
      headers: { "cache-control": "no-store" },
    });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    let body: { action?: string; name?: string };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }
    if (body.action !== "add") {
      return Response.json(
        { ok: false, error: `Unknown action '${body.action}'.` },
        { status: 400 },
      );
    }
    const state = await survey();
    if (!state.binary || !state.steamFound) {
      return Response.json({ ok: false, error: state.reason, ...state }, {
        status: 409,
      });
    }
    try {
      const report = await installShortcut({
        appName: body.name?.trim() || "shmupX",
        exe: state.binary.path,
        // Closing the window quits the launcher, which is what Steam needs to
        // see the game end (desktop.ts). Nothing else to pass.
        launchOptions: "",
        tags: ["shmupX"],
      }, { os: state.os, env: env() });
      // `report.ok` is the last word on whether anything was written, so it
      // comes after the spread rather than before it.
      return Response.json({ ...state, ...report, ok: report.ok }, {
        status: report.ok ? 200 : 500,
      });
    } catch (e) {
      return Response.json(
        { ok: false, error: (e as Error).message, ...state },
        { status: 500 },
      );
    }
  },
});
