import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { isOwnMachine } from "./host.ts";
import {
  compareCapabilities,
  CompareError,
  compareJobFile,
  getCompareJob,
  publicCompareJob,
  startCompare,
} from "../../lib/engine-compare.ts";

// GET  /api/engine-compare                 — can this machine run one?
// GET  /api/engine-compare?job=ID          — a job's status, log and files
// GET  /api/engine-compare?job=ID&file=F   — one of a finished job's files
// POST /api/engine-compare { source, from, for } — start one
//
// The engine comparison (tools/sav-profiler, wrapped by lib/engine-compare.ts)
// launches Mednafen and a Chrome on THIS machine, drives them with synthetic
// keys and records the screen — so this is local-only twice over: the hosted
// deploy refuses it, and only a client on the serving machine itself may
// start or read one (isOwnMachine, the /api/host gate). A page on the
// Tailscale tunnel gets a plain "remote client" and should queue the job to a
// paired desktop through the export queue instead (?builder=CODE).

const FILE_TYPES: Record<string, string> = {
  "compare.mp4": "video/mp4",
  "sheet.png": "image/png",
  "moment.png": "image/png",
  "report.md": "text/markdown; charset=utf-8",
  "report.json": "application/json",
};

function ownMachine(ctx: { req: Request }): boolean {
  const info = (ctx as unknown as { info?: Deno.ServeHandlerInfo }).info;
  return isOwnMachine(info?.remoteAddr, ctx.req.headers);
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
    const id = url.searchParams.get("job");
    if (!id) {
      const cap = await compareCapabilities();
      return Response.json({ ...cap, reason: cap.reasons.join("; ") || null }, {
        headers: { "cache-control": "no-store" },
      });
    }
    const job = getCompareJob(id);
    if (!job) {
      return Response.json({ ok: false, error: "no such job" }, {
        status: 404,
      });
    }
    const file = url.searchParams.get("file");
    if (!file) {
      return Response.json({ ok: true, job: publicCompareJob(job) }, {
        headers: { "cache-control": "no-store" },
      });
    }
    const type = FILE_TYPES[file];
    const path = type ? compareJobFile(job, file) : null;
    if (!type || !path) {
      return Response.json({ ok: false, error: "no such file" }, {
        status: 404,
      });
    }
    try {
      const f = await Deno.open(path, { read: true });
      return new Response(f.readable, {
        headers: { "content-type": type, "cache-control": "no-store" },
      });
    } catch {
      return Response.json({ ok: false, error: "the file is gone" }, {
        status: 404,
      });
    }
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    if (!ownMachine(ctx)) {
      return Response.json(
        {
          ok: false,
          error:
            "the comparison runs on the machine serving this page; from elsewhere, queue it to a paired desktop with ?builder=CODE",
        },
        { status: 403 },
      );
    }
    let body: { source?: unknown; from?: unknown; for?: unknown };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "expected a JSON body" }, {
        status: 400,
      });
    }
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) {
      return Response.json({ ok: false, error: "source names the level" }, {
        status: 400,
      });
    }
    const cap = await compareCapabilities();
    if (!cap.available) {
      return Response.json({ ok: false, error: cap.reasons.join("; ") }, {
        status: 409,
      });
    }
    try {
      const job = startCompare({
        source,
        from: body.from === undefined ? undefined : Number(body.from),
        len: body.for === undefined ? undefined : Number(body.for),
      });
      return Response.json({ ok: true, job: publicCompareJob(job) });
    } catch (e) {
      if (e instanceof CompareError) {
        return Response.json({ ok: false, error: e.message }, {
          status: e.status,
        });
      }
      throw e;
    }
  },
});
