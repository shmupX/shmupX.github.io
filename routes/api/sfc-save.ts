import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { decodeBase64 } from "@std/encoding/base64";
import {
  installSfcSram,
  launchSfcMednafen,
  MednafenError,
  resolveSfcMednafen,
  SFC_SRAM_SIZE,
} from "../../lib/sfc-mednafen.ts";
import { isSfcSav } from "../../packages/shmup-engine/src/sfc/sram.js";

// GET  /api/sfc-save — can a Super Famicom Dezaemon save be played in
//                      Mednafen from here?
// POST /api/sfc-save { sram, name, launch } — install it as Mednafen's SRAM
//                      for the Dezaemon cart and, optionally, start Mednafen.
//
// The Super Famicom counterpart of /api/psx-save. The editor's DEZAEMON (SFC)
// row builds the 128 KB SRAM image in the page (exportLevelToSfcSram) and
// sends it here as base64; lib/sfc-mednafen.ts writes it as <rom base>.srm in
// Mednafen's save directory — backing up the file that was there first,
// because an SRAM image is the whole cart — and Mednafen starts on the ROM
// with the game loadable from its title menu.
//
// The image is checked before anything touches the disk: it has to decode to
// exactly 131,072 bytes carrying "T.TABATA" at 0x7FF8, or it is not a
// Dezaemon save and the install refuses before it has read the user's save
// directory.
//
// LOCAL-ONLY: it spawns a process and writes into the user's Mednafen
// directory, so the hosted deploy refuses it, and the POST is behind the
// Fetch Metadata gate like every other mutating local endpoint. The GET names
// paths on the user's disk, so it is gated the same way.

interface SaveBody {
  sram?: string;
  name?: string;
  launch?: boolean;
}

/** The base64 field as the 131,072-byte SRAM image, or a message saying why not. */
export function decodeSramField(
  sram: unknown,
): { bytes: Uint8Array } | { error: string } {
  if (typeof sram !== "string" || !sram) {
    return { error: "sram must be base64" };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(sram);
  } catch {
    return { error: "sram is not valid base64" };
  }
  if (bytes.length !== SFC_SRAM_SIZE) {
    return {
      error:
        `sram decodes to ${bytes.length} bytes; a Dezaemon SRAM image is ${SFC_SRAM_SIZE}`,
    };
  }
  if (!isSfcSav(bytes)) {
    return {
      error:
        'sram does not carry "T.TABATA" at 0x7FF8; it is not a Dezaemon save',
    };
  }
  return { bytes };
}

export const handler = define.handlers({
  async GET(ctx) {
    if (isDeploy()) {
      return Response.json({
        available: false,
        mednafen: null,
        reason: "local only",
      });
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const extra = [Deno.env.get("DEZAEMON_SFC_ROM") ?? ""].filter(Boolean);
    const r = await resolveSfcMednafen({ extra });
    return Response.json({
      available: r.available,
      mednafen: r.available
        ? {
          bin: r.bin,
          rom: r.rom,
          savDir: r.savDir,
          name: r.name,
          sram: r.sramPath,
        }
        : null,
      reason: r.reason,
    });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;

    let body: SaveBody;
    try {
      body = await ctx.req.json();
    } catch {
      return Response.json({ ok: false, error: "expected a JSON body" }, {
        status: 400,
      });
    }
    const launch = body.launch === true;
    if (body.sram === undefined && !launch) {
      return Response.json(
        { ok: false, error: "nothing to do: send sram, launch: true, or both" },
        { status: 400 },
      );
    }

    // Validate first — a bad image must not get as far as the save directory.
    let sram: Uint8Array | null = null;
    if (body.sram !== undefined) {
      const decoded = decodeSramField(body.sram);
      if ("error" in decoded) {
        return Response.json({ ok: false, error: decoded.error }, {
          status: 400,
        });
      }
      sram = decoded.bytes;
    }

    const extra = [Deno.env.get("DEZAEMON_SFC_ROM") ?? ""].filter(Boolean);
    const r = await resolveSfcMednafen({ extra });
    if (!r.rom || !r.savDir || (launch && !r.available)) {
      return Response.json(
        { ok: false, error: r.reason ?? "Mednafen is not set up here" },
        { status: 409 },
      );
    }

    const out: Record<string, unknown> = {
      ok: true,
      name: typeof body.name === "string" ? body.name : null,
      rom: r.rom,
      sram: null,
      backup: null,
      replaced: false,
      launched: false,
    };
    try {
      if (sram) {
        const installed = await installSfcSram(sram, {
          savDir: r.savDir,
          name: r.name,
        });
        out.sram = installed.sramPath;
        out.backup = installed.backupPath;
        out.replaced = installed.replaced;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ ok: false, error: message }, {
        status: e instanceof MednafenError ? 400 : 500,
      });
    }

    if (launch) {
      try {
        const { pid } = await launchSfcMednafen(r);
        out.launched = true;
        out.pid = pid;
      } catch (e) {
        // The save is installed either way; say why the emulator did not
        // start rather than failing the whole request.
        out.launched = false;
        out.error = e instanceof Error ? e.message : String(e);
      }
    }
    return Response.json(out);
  },
});
