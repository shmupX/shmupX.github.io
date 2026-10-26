import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import { sanitizeLevelName } from "@shmupx/shmup-harbor/export";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { join } from "@std/path";
import {
  type CaptureJob,
  CaptureRegistry,
  containedShot,
  readManifest,
  runCapture,
} from "../../lib/store-shots.ts";

// /api/store-shots — CAPTURE SCREENSHOTS on the PUBLISH panel.
//
//   POST { level }          → { ok, capture }      start (or the one going)
//   GET  ?capture=<id>      → { ok, capture }      how far it is
//   GET  ?level=<name>      → { ok, level, shots, capturedAt, clip } what an
//                             earlier capture left (shots: [] when none)
//   GET  ?shot=<slug>/shots/<store>/<key>.png     the still itself
//
// lib/store-shots.ts runs the testdrive and ffmpeg; this is its HTTP face.
// LOCAL-ONLY: it spawns a browser and writes to disk, so the hosted origin
// refuses, and the Fetch Metadata gate keeps a cross-site page from starting
// a recording on this machine.

let registry: CaptureRegistry | null = null;
function publishRoot(): string {
  return join(repoRoot(), "build", "publish");
}
function jobs(): CaptureRegistry {
  if (!registry) {
    registry = new CaptureRegistry({ root: publishRoot(), run: runCapture });
  }
  return registry;
}

/** The job as the panel reads it: no process handles, URLs for the stills. */
function view(job: CaptureJob) {
  return {
    id: job.id,
    level: job.level,
    status: job.status,
    note: job.note,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    log: job.log.slice(-8),
    shots: job.shots.map((s) => ({ ...s, url: shotUrl(s.path) })),
  };
}

function shotUrl(path: string): string {
  return `/api/store-shots?shot=${encodeURIComponent(path)}`;
}

function offline(): Response {
  return Response.json(
    { ok: false, error: "Screenshots are captured on a local install." },
    { status: 403 },
  );
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();
    const url = new URL(ctx.req.url);
    const shot = url.searchParams.get("shot");
    if (shot) {
      const file = containedShot(publishRoot(), shot);
      if (!file) {
        return Response.json({ ok: false, error: "Not a still." }, {
          status: 400,
        });
      }
      try {
        const bytes = await Deno.readFile(file);
        return new Response(bytes, {
          headers: {
            "content-type": "image/png",
            "cache-control": "no-store",
          },
        });
      } catch {
        return Response.json({ ok: false, error: "No such still." }, {
          status: 404,
        });
      }
    }
    const id = url.searchParams.get("capture");
    if (id) {
      const job = jobs().get(id);
      if (!job) {
        return Response.json({ ok: false, error: "No such capture." }, {
          status: 404,
        });
      }
      return Response.json({ ok: true, capture: view(job) });
    }
    const level = sanitizeLevelName(url.searchParams.get("level") ?? "");
    if (!level) {
      return Response.json({ ok: false, error: "Name a level." }, {
        status: 400,
      });
    }
    const going = jobs().running(level);
    const m = await readManifest(publishRoot(), level);
    return Response.json({
      ok: true,
      level,
      capturedAt: m?.capturedAt ?? null,
      clip: m?.clip ?? null,
      shots: (m?.shots ?? []).map((s) => ({ ...s, url: shotUrl(s.path) })),
      ...(going ? { capture: view(going) } : {}),
    });
  },

  async POST(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    if (isDeploy()) return offline();
    let body: { level?: string };
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body." }, {
        status: 400,
      });
    }
    const level = sanitizeLevelName(String(body.level ?? ""));
    if (!level) {
      return Response.json({ ok: false, error: "Missing 'level'." }, {
        status: 400,
      });
    }
    const job = jobs().start(level);
    return Response.json({ ok: true, capture: view(job) });
  },
});
