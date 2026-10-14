import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { decodeBase64 } from "@std/encoding/base64";
import {
  installPsxCard,
  launchPsxMednafen,
  MednafenError,
  PSX_CARD_SIZE,
  resolvePsxMednafen,
} from "../../lib/psx-mednafen.ts";

// GET  /api/psx-save — can a Dezaemon Kids! card be played in Mednafen from here?
// POST /api/psx-save { card, name, launch } — install it as Mednafen's slot-1
// memory card for the Kids! disc and, optionally, start Mednafen on the disc.
//
// The PlayStation counterpart of /api/saturn-save. The editor's DEZAEMON
// KIDS! (PS) row builds the 128 KB card in the page (exportLevelToKidsCard)
// and sends it here as base64; lib/psx-mednafen.ts writes it as
// <disc base>.0.mcr in Mednafen's save directory — backing up the card that
// was there first, because a Kids! save takes the whole card and there is no
// slot to merge into — and Mednafen starts with the game loadable from
// PELON's ロード on the main menu. The launcher has no row for this: the
// disc's own section boots the browser player, which cannot mount a card.
//
// The card is checked before anything touches the disk: it has to decode to
// exactly 131,072 bytes that open with "MC", or it is not a card and the
// install refuses before it has read the user's save directory.
//
// The GET reports the BIOS beside the rest — Mednafen will not boot a Japanese
// disc without scph5500.bin in its firmware folder, and this route cannot
// supply one — so the editor can say why a launch would stop at the BIOS
// screen before anybody presses the button; an install still works without it.
//
// LOCAL-ONLY: it spawns a process and writes into the user's Mednafen
// directory, so the hosted deploy refuses it, and the POST is behind the
// Fetch Metadata gate like every other mutating local endpoint. The GET names
// paths on the user's disk, so it is gated the same way.

interface SaveBody {
  card?: string;
  name?: string;
  launch?: boolean;
}

/** The base64 field as the 131,072-byte card, or a message saying why not. */
export function decodeCardField(
  card: unknown,
): { bytes: Uint8Array } | { error: string } {
  if (typeof card !== "string" || !card) {
    return { error: "card must be base64" };
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(card);
  } catch {
    return { error: "card is not valid base64" };
  }
  if (bytes.length !== PSX_CARD_SIZE) {
    return {
      error:
        `card decodes to ${bytes.length} bytes; a PlayStation memory card is ${PSX_CARD_SIZE}`,
    };
  }
  if (bytes[0] !== 0x4d || bytes[1] !== 0x43) {
    return {
      error: 'card does not start with "MC"; it is not a memory card image',
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
        bios: null,
        reason: "local only",
      });
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const extra = [Deno.env.get("DEZAEMON_PSX_DISC") ?? ""].filter(Boolean);
    const r = await resolvePsxMednafen({ extra });
    return Response.json({
      available: r.available,
      mednafen: r.available
        ? {
          bin: r.bin,
          disc: r.disc,
          savDir: r.savDir,
          name: r.name,
          card: r.cardPath,
        }
        : null,
      bios: r.bios,
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
    if (body.card === undefined && !launch) {
      return Response.json(
        { ok: false, error: "nothing to do: send card, launch: true, or both" },
        { status: 400 },
      );
    }

    // Validate first — a bad card must not get as far as the save directory.
    let card: Uint8Array | null = null;
    if (body.card !== undefined) {
      const decoded = decodeCardField(body.card);
      if ("error" in decoded) {
        return Response.json({ ok: false, error: decoded.error }, {
          status: 400,
        });
      }
      card = decoded.bytes;
    }

    const extra = [Deno.env.get("DEZAEMON_PSX_DISC") ?? ""].filter(Boolean);
    const r = await resolvePsxMednafen({ extra });
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
      card: null,
      backup: null,
      replaced: false,
      note: r.bios.present
        ? null
        : `no ${r.bios.file} in ${r.bios.dir}: Mednafen will stop at the BIOS check until a Japanese BIOS is there`,
      launched: false,
    };
    try {
      if (card) {
        const installed = await installPsxCard(card, {
          savDir: r.savDir,
          name: r.name,
        });
        out.card = installed.cardPath;
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
        const { pid } = await launchPsxMednafen(r);
        out.launched = true;
        out.pid = pid;
      } catch (e) {
        // The card is installed either way; say why the emulator did not
        // start rather than failing the whole request.
        out.launched = false;
        out.error = e instanceof Error ? e.message : String(e);
      }
    }
    return Response.json(out);
  },
});
