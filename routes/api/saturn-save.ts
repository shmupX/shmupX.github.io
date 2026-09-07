import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { decodeBase64 } from "@std/encoding/base64";
import {
  installCartSave,
  launchMednafen,
  MednafenError,
  resolveMednafen,
} from "../../lib/mednafen.ts";
import {
  interleave,
  MISTER_SAV_SIZE,
} from "../../packages/shmup-engine/mod.js";

// GET  /api/saturn-save — can a level be played in Mednafen from here?
// POST /api/saturn-save { sav, name, launch } — install it as Mednafen's
// cartridge save and, optionally, start Mednafen on the disc.
//
// The browser's Saturn core has only the console's 32 KB internal memory, and
// a level exported from the editor is a ~110 KB save, so the editor's
// DEZAEMON 2 (SATURN) menu offers "→ MEDNAFEN CART": the .sav it just built
// comes here as base64, lib/mednafen.ts converts it to the <disc>.bcr/.bkr
// pair and drops it in Mednafen's save directory (backing up the cart that
// was there), and Mednafen starts with the level loadable from the cartridge
// in the game's own LOAD menu. The launcher's "Dezaemon 2 · Mednafen" row
// POSTs { launch: true } alone to start the emulator on whatever is installed.
// The same code path as `deno task sav:run` (scripts/run-mednafen.ts).
//
// The save is checked before anything touches the disk: it has to decode to
// exactly the 1,114,112-byte MiSTer image (32 KB internal + 512 KB cart,
// 0xFF-interleaved) — or its 557,056 logical bytes, which are interleaved
// here — because a wrong-sized image would be written as a cart Mednafen then
// silently reformats.
//
// LOCAL-ONLY: it spawns a process and writes into the user's Mednafen
// directory, so the hosted deploy refuses it, and the POST is behind the
// Fetch Metadata gate like every other mutating local endpoint. The GET names
// paths on the user's disk, so it is gated the same way.

/** The logical size of a MiSTer .sav: what interleave() doubles. */
const LOGICAL_SAV_SIZE = MISTER_SAV_SIZE / 2;

interface SaveBody {
  sav?: string;
  name?: string;
  launch?: boolean;
}

/** The base64 field as the 1,114,112-byte image, or a message saying why not. */
export function decodeSavField(
  sav: unknown,
): { bytes: Uint8Array } | { error: string } {
  if (typeof sav !== "string" || !sav) return { error: "sav must be base64" };
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(sav);
  } catch {
    return { error: "sav is not valid base64" };
  }
  if (bytes.length === MISTER_SAV_SIZE) return { bytes };
  if (bytes.length === LOGICAL_SAV_SIZE) return { bytes: interleave(bytes) };
  return {
    error: `sav decodes to ${bytes.length} bytes; expected the ` +
      `${MISTER_SAV_SIZE}-byte MiSTer image (or its ${LOGICAL_SAV_SIZE} ` +
      `logical bytes)`,
  };
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
    const r = await resolveMednafen();
    return Response.json({
      available: r.available,
      mednafen: r.available
        ? { bin: r.bin, disc: r.disc, savDir: r.savDir, name: r.name }
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
    if (body.sav === undefined && !launch) {
      return Response.json(
        { ok: false, error: "nothing to do: send sav, launch: true, or both" },
        { status: 400 },
      );
    }

    // Validate first — a bad save must not get as far as the save directory.
    let sav: Uint8Array | null = null;
    if (body.sav !== undefined) {
      const decoded = decodeSavField(body.sav);
      if ("error" in decoded) {
        return Response.json({ ok: false, error: decoded.error }, {
          status: 400,
        });
      }
      sav = decoded.bytes;
    }

    const r = await resolveMednafen();
    // Installing needs the disc's name (the save pair is called after it)
    // and a save directory; launching needs the executable as well.
    if (!r.disc || !r.savDir || (launch && !r.available)) {
      return Response.json(
        { ok: false, error: r.reason ?? "Mednafen is not set up here" },
        { status: 409 },
      );
    }

    const out: Record<string, unknown> = {
      ok: true,
      name: typeof body.name === "string" ? body.name : null,
      disc: r.disc,
      bcr: null,
      bkr: null,
      backup: null,
      launched: false,
    };
    try {
      if (sav) {
        const installed = await installCartSave(sav, {
          savDir: r.savDir,
          name: r.name,
        });
        out.bcr = installed.bcrPath;
        out.bkr = installed.bkrPath;
        out.backup = installed.backupPath;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json({ ok: false, error: message }, {
        status: e instanceof MednafenError ? 400 : 500,
      });
    }

    if (launch) {
      try {
        const { pid } = await launchMednafen({ bin: r.bin, disc: r.disc }, {
          wait: false,
        });
        out.launched = true;
        out.pid = pid;
      } catch (e) {
        // The save is installed either way; say why the emulator did not start
        // rather than failing the whole request.
        out.launched = false;
        out.error = e instanceof Error ? e.message : String(e);
      }
    }
    return Response.json(out);
  },
});
