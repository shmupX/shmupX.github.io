import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { exportWorker } from "@shmupx/shmup-harbor/export-worker";

// /api/export-worker — the build server that picks up exports queued from a
// phone, the hosted site or the PWA (lib/export-worker.ts).
//
//   GET   its status: the BUILD CODE to type into the other device, which
//         targets this machine can build, what it is doing. Starts the worker
//         on the way if the user has not switched it off — the dashboard GETs
//         this on boot when it is served locally, which is what turns a desktop
//         into a build server just by opening the launcher. ?autostart=0 only
//         looks.
//   POST  { action: "start" | "stop" | "regenerate" | "rename", name? }
//
// LOCAL-ONLY: the worker builds on this machine's disk, so the hosted origin
// answers 403 — which is also how the dashboard learns it is not local.

function offline(): Response {
  return Response.json(
    { ok: false, error: "The build server only runs on a local install." },
    { status: 403 },
  );
}

export const handler = define.handlers({
  async GET(ctx) {
    // A GET has a side effect here (it may start the worker), so it gets the
    // same Fetch Metadata gate as the mutating routes.
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();
    const worker = exportWorker();
    if (new URL(ctx.req.url).searchParams.get("autostart") !== "0") {
      try {
        await worker.autoStart();
      } catch (e) {
        // Reported in the status body rather than as an HTTP failure: a
        // worker that cannot reach the database is still a worker with a code.
        worker.lastError = (e as Error).message;
      }
    }
    return Response.json({ ok: true, ...worker.status() });
  },

  async POST(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();
    let body: { action?: string; name?: string };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }
    const worker = exportWorker();
    try {
      switch (body.action) {
        case "start":
          await worker.setEnabled(true);
          await worker.start();
          break;
        case "stop":
          await worker.setEnabled(false);
          await worker.stop();
          break;
        case "regenerate":
          await worker.regenerateCode();
          break;
        case "rename":
          await worker.rename(body.name ?? "");
          break;
        default:
          return Response.json(
            { ok: false, error: `Unknown action '${body.action}'.` },
            { status: 400 },
          );
      }
    } catch (e) {
      return Response.json(
        { ok: false, error: (e as Error).message, ...worker.status() },
        { status: 500 },
      );
    }
    return Response.json({ ok: true, ...worker.status() });
  },
});
