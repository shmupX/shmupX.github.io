import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import {
  DEZAEMON_SFC_ROM_NAME,
  DEZAEMON_SFC_TITLE,
  findDezaemonSfcRom,
  findDezaemonSfcSram,
  readDezaemonSfcRom,
  repoRoot,
} from "../../lib/dezaemon-sfc.ts";

// GET /api/dezaemon-sfc        — is there a Dezaemon (Super Famicom) ROM here?
// GET /api/dezaemon-sfc?rom=1  — that ROM, for the SNES player to boot.
// GET /api/dezaemon-sfc?sram=1 — the save $DEZAEMON_SFC_SRAM names, for the
//                                cartridge row to boot under the ROM.
//
// The SNES half of /api/dezaemon-disc, and the same shape for the same reason.
// A shelf record is a SAVE — 128 KB of SRAM — and the player needs the cart it
// belongs to before any of it means anything. So the launcher asks the first
// question when it renders its SUPER FAMICOM section: a yes is what makes the
// shelf's rows launchable, and a no is what the section says instead of
// offering a Play that could only fail.
//
// The ROM is served with its copier header already stripped (lib/dezaemon-sfc.ts
// explains why that matters to EmulatorJS), so what the player receives is the
// bare image whatever the dump on disk carried.
//
// A SAVE UNDER THE CART. The cartridge row boots bare — the ROM alone, its
// factory sample — unless $DEZAEMON_SFC_SRAM names a 128 KB Dezaemon save,
// in which case the answer carries `sram` and the launcher hands the player
// both files: the way to put a build in front of another machine's launcher
// (a Surface on the LAN, say) with one press of LAUNCH and no shelf import.
//
// LOCAL-ONLY: it describes and serves a file from the user's disk. On the
// hosted deploy (which has no dev-fixtures/ anyway) it answers "not available"
// rather than looking; elsewhere the Fetch Metadata gate keeps a cross-site
// page from reading which files the user has.

const NOT_HERE = "no Dezaemon (Super Famicom) ROM in dev-fixtures/ (a .sfc, " +
  ".smc, .fig or .swc whose internal header names DEZAEMON with 128 KB of " +
  "SRAM; one subdirectory deep is looked at too, and $DEZAEMON_SFC_ROM)";

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const wantRom = url.searchParams.get("rom") === "1";
    const wantSram = url.searchParams.get("sram") === "1";
    if (isDeploy()) {
      return Response.json(
        { available: false, reason: "local only" },
        { status: wantRom || wantSram ? 404 : 200 },
      );
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;

    const extra = [Deno.env.get("DEZAEMON_SFC_ROM") ?? ""].filter(Boolean);
    const rom = await findDezaemonSfcRom(await repoRoot(), { extra });
    const sram = await findDezaemonSfcSram(
      [Deno.env.get("DEZAEMON_SFC_SRAM") ?? ""].filter(Boolean),
    );

    if (wantSram) {
      if (!sram) {
        return Response.json({
          ok: false,
          error: "no save under the cart: $DEZAEMON_SFC_SRAM is unset, or " +
            "does not name a 131,072-byte Dezaemon SRAM image",
        }, { status: 404 });
      }
      const bytes = await Deno.readFile(sram.path);
      const etag = `"${sram.size}-${sram.mtime}"`;
      if (ctx.req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "content-disposition": `attachment; filename="${sram.name}"`,
          etag,
        },
      });
    }

    if (wantRom) {
      if (!rom) {
        return Response.json({ ok: false, error: NOT_HERE }, { status: 404 });
      }
      const bytes = await readDezaemonSfcRom(rom);
      // A ROM only changes when the file does, and the launcher asks for it on
      // every SNES launch: an ETag lets the browser skip the half-megabyte when
      // it already holds the same bytes.
      const etag = `"${rom.size}-${rom.mtime}-${rom.header.copierHeader}"`;
      if (ctx.req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "content-disposition":
            `attachment; filename="${DEZAEMON_SFC_ROM_NAME}"`,
          etag,
        },
      });
    }

    if (!rom) return Response.json({ available: false, reason: NOT_HERE });
    return Response.json({
      available: true,
      title: DEZAEMON_SFC_TITLE,
      name: rom.name,
      // The size the player will actually receive, not the size on disk: a
      // headered dump is 512 bytes larger than what leaves here.
      size: rom.size - rom.header.copierHeader,
      copierHeader: rom.header.copierHeader,
      header: rom.header,
      rom: "/api/dezaemon-sfc?rom=1",
      romName: DEZAEMON_SFC_ROM_NAME,
      // The save under the cart, when the operator put one there.
      ...(sram
        ? {
          sram: "/api/dezaemon-sfc?sram=1",
          sramName: sram.name,
          sramTitle: sram.title,
          sramSize: sram.size,
        }
        : {}),
    });
  },
});
