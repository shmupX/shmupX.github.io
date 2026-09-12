import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import {
  buildDezaemonDiscZip,
  DEZAEMON_CONTENT_NAME,
  DEZAEMON_CUE_NAME,
  DEZAEMON_TITLE,
  DEZAEMON_ZIP_NAME,
  discZipEtag,
  findDezaemonDisc,
  repoRoot,
} from "../../lib/dezaemon-disc.ts";
import { resolveMednafen } from "@shmupx/shmup-harbor/mednafen";

// GET /api/dezaemon-disc — is there a Dezaemon 2 disc on this machine, and
// GET /api/dezaemon-disc?zip=1 — that disc, as the zip the Saturn player boots.
//
// The launcher asks the first question after it has read the emulator
// catalogue: a yes adds the Sega Saturn section with a "Dezaemon 2" row and
// installs the Saturn core for it (Dashboard.svelte, the Saturn auto-add).
// Launching that row opens cmg's /saturn/play.html in bring-your-own-disc
// mode, and when the player says it is ready the launcher fetches the second
// URL and posts the zip into the frame as a File — which is how a disc that
// is only on this disk reaches a player that otherwise loads discs from the
// cmg origin. lib/dezaemon-disc.ts finds the disc and builds the zip.
//
// The answer also says whether Mednafen — the Saturn with a backup cartridge,
// see lib/mednafen.ts — is reachable, so the launcher can offer that row too.
//
// LOCAL-ONLY: it describes and serves files from the user's disk. On the
// hosted deploy (which has no dev-fixtures/ anyway) it answers "not
// available" rather than looking; elsewhere the Fetch Metadata gate keeps a
// cross-site page from reading which files the user has.

const NOT_HERE = "no Dezaemon 2 disc image in dev-fixtures/ (a .cue, .bin, " +
  ".iso or .img whose ISO 9660 root holds GAME.CMP and DEZA2.PAL; " +
  "$DEZAEMON_DISC is looked at too)";

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const wantZip = url.searchParams.get("zip") === "1";
    if (isDeploy()) {
      return Response.json(
        { available: false, reason: "local only", mednafen: null },
        { status: wantZip ? 404 : 200 },
      );
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;

    const extra = [Deno.env.get("DEZAEMON_DISC") ?? ""].filter(Boolean);
    const disc = await findDezaemonDisc(await repoRoot(), { extra });

    if (wantZip) {
      if (!disc) {
        return Response.json({ ok: false, error: NOT_HERE }, { status: 404 });
      }
      // The zip only changes when the fixture files do, and the launcher asks
      // for it on every Saturn launch: an ETag lets the browser skip the 7.6 MB
      // when it already holds the same bytes.
      const etag = await discZipEtag(disc);
      if (ctx.req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      const zip = await buildDezaemonDiscZip(disc);
      return new Response(zip as BodyInit, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(zip.length),
          "content-disposition": `attachment; filename="${DEZAEMON_ZIP_NAME}"`,
          etag,
        },
      });
    }

    const mednafen = await resolveMednafen();
    const mednafenInfo = {
      available: mednafen.available,
      bin: mednafen.bin,
      disc: mednafen.disc,
      savDir: mednafen.savDir,
      reason: mednafen.reason,
    };
    if (!disc) {
      return Response.json({
        available: false,
        reason: NOT_HERE,
        mednafen: mednafenInfo,
      });
    }
    return Response.json({
      available: true,
      title: DEZAEMON_TITLE,
      content: DEZAEMON_CONTENT_NAME,
      cue: DEZAEMON_CUE_NAME,
      cueFrom: disc.cueFrom,
      files: disc.files.map((f) => ({ name: f.name, size: f.size })),
      zip: "/api/dezaemon-disc?zip=1",
      mednafen: mednafenInfo,
    });
  },
});
