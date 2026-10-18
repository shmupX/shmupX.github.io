import { define } from "../../utils.ts";
import { crossSiteGuard, localWriteGuard } from "../../lib/local-guards.ts";

// /api/launch — the one game this launcher was started for, if any.
//
//   GET   { game, play, single }: what desktop.ts was started with. A Steam
//         entry made from a favorite (lib/steam-favorites.ts) starts the
//         launcher with --game <section>:<row> or --play <shelf slug>, and the
//         dashboard opens that game as soon as it can.
//   POST  { action: "quit" } — the player has left that game: end the
//         launcher, so Steam sees the game it started end with it.
//
// desktop.ts puts the target in SHMUPX_LAUNCH_GAME / SHMUPX_LAUNCH_PLAY and
// its quit on globalThis, because the built server is a module graph of its
// own and those are what both halves share.

interface QuitHook {
  __shmupxQuit?: () => void;
}

function target() {
  const game = Deno.env.get("SHMUPX_LAUNCH_GAME") || null;
  const play = Deno.env.get("SHMUPX_LAUNCH_PLAY") || null;
  return { game, play, single: !!(game || play) };
}

export const handler = define.handlers({
  GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    return Response.json({ ok: true, ...target() }, {
      headers: { "cache-control": "no-store" },
    });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    let body: { action?: string };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }
    if (body.action !== "quit") {
      return Response.json(
        { ok: false, error: `Unknown action '${body.action}'.` },
        { status: 400 },
      );
    }
    // Only a launcher started for one game ends with it: the full launcher's
    // own window is how that one is closed.
    const quit = (globalThis as QuitHook).__shmupxQuit;
    if (!target().single || typeof quit !== "function") {
      return Response.json({ ok: true, quitting: false });
    }
    // After this answer is on its way, not before it.
    setTimeout(quit, 150);
    return Response.json({ ok: true, quitting: true });
  },
});
