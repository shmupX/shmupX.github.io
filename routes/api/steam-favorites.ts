import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { readKept } from "../../lib/kept-storage.ts";
import {
  favoritesFrom,
  localRunOptions,
  readFavoritesState,
  runFavoritesSync,
  writeFavoritesState,
} from "../../lib/steam-favorites.ts";

// /api/steam-favorites — favorites as games in Steam (lib/steam-favorites.ts).
//
//   GET   { enabled, favorites, last }: whether the sync is on, what it would
//         list, and what the last sync did.
//   POST  { action: "sync" } — sync now.
//         { action: "enable", enabled } — switch the sync on or off. Off takes
//         every favorite's entry out of Steam again.
//
// The sync also runs on its own whenever a favorite changes (main.ts), and at
// the launcher's start and exit (desktop.ts); this is the switch and the
// status line for Settings.
//
// LOCAL-ONLY: it writes into this machine's Steam config.

async function status(origin: string) {
  const opts = await localRunOptions(origin);
  const state = await readFavoritesState(opts.dataDir);
  const kept = await readKept(opts.keptFile);
  return {
    enabled: state.enabled,
    available: !!opts.exe,
    favorites: favoritesFrom(kept.values, state.titles).map((f) => ({
      key: f.key,
      title: f.title,
    })),
    last: state.last ?? null,
  };
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) {
      return Response.json(
        { ok: false, error: "Steam favorites only work on a local install." },
        { status: 403 },
      );
    }
    return Response.json(
      { ok: true, ...await status(new URL(ctx.req.url).origin) },
      { headers: { "cache-control": "no-store" } },
    );
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    let body: { action?: string; enabled?: unknown };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }
    const origin = new URL(ctx.req.url).origin;
    const opts = await localRunOptions(origin);
    if (body.action === "enable") {
      const state = await readFavoritesState(opts.dataDir);
      state.enabled = body.enabled !== false;
      await writeFavoritesState(opts.dataDir, state);
    } else if (body.action !== "sync") {
      return Response.json(
        { ok: false, error: `Unknown action '${body.action}'.` },
        { status: 400 },
      );
    }
    const report = await runFavoritesSync(
      opts,
      (await readKept(opts.keptFile)).values,
    );
    return Response.json({ ok: true, report, ...await status(origin) });
  },
});
