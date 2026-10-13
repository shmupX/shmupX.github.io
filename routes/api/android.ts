import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { isOwnMachine } from "./host.ts";
import { detectExportCapabilities } from "@shmupx/shmup-harbor/export";
import {
  adbConnect,
  adbPair,
  adoptApk,
  AndroidError,
  buildAndroid,
  buildCandidates,
  cancelAndroidJob,
  defaultTarget,
  detectAndroidRuntimes,
  detectRemoteDesktop,
  forgetBuild,
  getAndroidJob,
  installBuild,
  launchBuild,
  listAndroidJobs,
  listBuilds,
  parseTarget,
  shelfPath,
  startAndroidJob,
} from "../../lib/android-host.ts";

// GET  /api/android            — the Mobile shelf: runtimes, builds, jobs
// GET  /api/android?shelf=1    — what the BUILD picker can build
// GET  /api/android?job=ID     — one job's status and log
// POST /api/android { action: "build",   name, sav?, title? }  → a job
// POST /api/android { action: "install", id, target }           → a job
// POST /api/android { action: "launch",  id, target }           → a job
// POST /api/android { action: "adopt",   path, name? }          → the build
// POST /api/android { action: "forget",  id }
// POST /api/android { action: "connect", address }              → adb connect
// POST /api/android { action: "pair",    address, code }        → adb pair
// POST /api/android { action: "cancel",  job }
//
// The launcher's Mobile section (svelte-src/Dashboard.svelte) is drawn from
// the GET and drives the moves with the POSTs; lib/android-host.ts does the
// work. Every APK here is a file on THIS machine, and every runtime it can
// go to is on this machine or reachable from it, so this is local-only the
// way routes/api/host.ts is: the hosted deploy refuses, a cross-site page is
// refused, and a client that is not the serving machine itself (a phone on
// the tunnel, a second PC on the LAN) is told "remote client". A remote
// DESKTOP session passes that gate — it is this machine's own browser, driven
// from afar — which is exactly the case the install-elsewhere targets exist
// for (remoteDesktop in the GET body says when).

function ownMachine(ctx: { req: Request }): boolean {
  const info = (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info;
  return isOwnMachine(info?.remoteAddr, ctx.req.headers);
}

function fail(e: unknown): Response {
  if (e instanceof AndroidError) {
    return Response.json({ ok: false, error: e.message }, { status: e.status });
  }
  return Response.json({ ok: false, error: (e as Error).message }, {
    status: 500,
  });
}

/** The sav the launcher sends: base64 of a Dezaemon cart. */
function savBytes(raw: unknown): Uint8Array | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const handler = define.handlers({
  async GET(ctx) {
    if (isDeploy()) {
      return Response.json({ available: false, reason: "local only" });
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (!ownMachine(ctx)) {
      return Response.json({ available: false, reason: "remote client" });
    }
    const url = new URL(ctx.req.url);
    const noStore = { headers: { "cache-control": "no-store" } };
    const jobId = url.searchParams.get("job");
    if (jobId) {
      const job = getAndroidJob(jobId);
      return job
        ? Response.json({ ok: true, job }, noStore)
        : Response.json({ ok: false, error: "no such job" }, { status: 404 });
    }
    if (url.searchParams.get("shelf")) {
      return Response.json(
        { ok: true, candidates: await buildCandidates() },
        noStore,
      );
    }
    const [runtimes, remoteDesktop, builds, caps] = await Promise.all([
      detectAndroidRuntimes(),
      detectRemoteDesktop(),
      listBuilds(),
      detectExportCapabilities(),
    ]);
    return Response.json({
      available: true,
      os: Deno.build.os,
      runtimes,
      remoteDesktop,
      builds,
      jobs: listAndroidJobs(),
      canBuild: !!caps.platforms.android,
      buildNotes: caps.notes,
      defaultTarget: defaultTarget(runtimes, remoteDesktop),
      shelfPath: shelfPath(),
    }, noStore);
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    if (!ownMachine(ctx)) {
      return Response.json(
        {
          ok: false,
          error:
            "the Mobile shelf belongs to the machine serving this page; from elsewhere, queue the build to a paired desktop with ?builder=CODE",
        },
        { status: 403 },
      );
    }
    let body: Record<string, unknown>;
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "expected a JSON body" }, {
        status: 400,
      });
    }
    const action = typeof body.action === "string" ? body.action : "";
    const str = (
      k: string,
    ) => (typeof body[k] === "string" ? body[k] as string : "");
    try {
      if (action === "build") {
        const name = str("name").trim();
        const sav = savBytes(body.sav);
        if (!name && !sav) {
          return Response.json({ ok: false, error: "name the game to build" }, {
            status: 400,
          });
        }
        const caps = await detectExportCapabilities();
        if (!caps.platforms.android) {
          return Response.json(
            {
              ok: false,
              error: "this machine cannot build an APK: " +
                caps.notes.join("; "),
            },
            { status: 409 },
          );
        }
        const title = str("title").trim() || null;
        const job = startAndroidJob(
          "build",
          { name: title || name },
          (log, signal) => buildAndroid({ name, sav, title, log, signal }),
        );
        return Response.json({ ok: true, job });
      }
      if (action === "install" || action === "launch") {
        const id = str("id");
        const target = parseTarget(body.target);
        if (!id || !target) {
          return Response.json({
            ok: false,
            error: "id and target are required",
          }, {
            status: 400,
          });
        }
        const build = (await listBuilds()).find((b) => b.id === id);
        if (!build) {
          return Response.json({ ok: false, error: "no such build" }, {
            status: 404,
          });
        }
        const job = startAndroidJob(action, {
          name: build.name,
          buildId: id,
          target,
        }, async (log) => {
          if (action === "install") {
            return await installBuild(build, target, log);
          }
          const r = await launchBuild(build, target, log);
          log(r.note);
          return r.build;
        });
        return Response.json({ ok: true, job });
      }
      if (action === "adopt") {
        const path = str("path");
        if (!path) {
          return Response.json({ ok: false, error: "path is required" }, {
            status: 400,
          });
        }
        const build = await adoptApk(path, str("name") || null);
        return Response.json({ ok: true, build });
      }
      if (action === "forget") {
        const id = str("id");
        return Response.json({ ok: !!id && await forgetBuild(id) });
      }
      if (action === "connect") {
        return Response.json(await adbConnect(str("address")));
      }
      if (action === "pair") {
        return Response.json(await adbPair(str("address"), str("code")));
      }
      if (action === "cancel") {
        return Response.json({ ok: cancelAndroidJob(str("job")) });
      }
      return Response.json({ ok: false, error: "unknown action" }, {
        status: 400,
      });
    } catch (e) {
      return fail(e);
    }
  },
});
