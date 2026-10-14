import { define } from "../../utils.ts";
import { crossSiteGuard, isDeploy } from "../../lib/local-guards.ts";
import {
  DEZAEMON_N64_PATCH_URL,
  DEZAEMON_N64_ROM_NAME,
  DEZAEMON_N64_SHA1_ENGLISH,
  DEZAEMON_N64_SHA1_JAPAN,
  DEZAEMON_N64_TITLE,
  findDezaemonN64,
  N64DD_IPL_NAME,
  readDezaemonN64Rom,
  readN64ddIpl,
  repoRoot,
} from "../../lib/dezaemon-n64.ts";

// GET /api/dezaemon-n64        — does this machine have Dezaemon 3D and the 64DD IPL?
// GET /api/dezaemon-n64?rom=1  — the cartridge, translated to English, for the player
// GET /api/dezaemon-n64?ipl=1  — the 64DD IPL, for the player
//
// The Nintendo 64 half of /api/dezaemon-sfc, and the same shape for the same
// reason. A disk the editor builds is a DATA disk — a project of textures and
// records — and it means nothing until Dezaemon 3D's cartridge is in the
// console and the 64DD has its IPL. Neither is ours to ship, so the editor's
// → PLAY 64DD row asks this route first: a yes is what makes the row appear,
// and a no is what the row says instead of offering a Play that could only
// fail.
//
// The cartridge leaves here in English. lib/dezaemon-n64.ts applies the 2024
// translation (an xdelta3 delta the repo carries under static/n64dd/) to the
// Japanese dump in memory and holds the result to the SHA-1 its readme gives;
// a dump that is already the English ROM passes through, and any other dump
// is reported with its sum rather than patched into garbage. Sixteen megabytes
// is patched once per dump and kept, keyed on the file's identity, so a
// launch after the first is a cache hit.
//
// LOCAL-ONLY: it describes and serves files from the user's disk. On the
// hosted deploy it answers "not available" rather than looking, and the Fetch
// Metadata gate keeps a cross-site page from reading which files the user has.

const NOT_HERE = "no Dezaemon 3D ROM in dev-fixtures/ (a 16 MB .z64, .n64 or " +
  ".v64 whose header names DEZAEMON 3D; one subdirectory deep is looked at " +
  "too, and $DEZAEMON_N64_ROM)";
const NO_IPL = "no 64DD IPL in dev-fixtures/ (a 4 MB N64 image whose header " +
  "says IPL or 64DD, or whose name does; $N64DD_IPL names one anywhere)";

// The translated image, kept per dump: `key` is the file's path, size and
// mtime, so a replaced dump is patched afresh and an untouched one never
// twice. One entry — a machine has one Dezaemon 3D.
let romCache: { key: string; bytes: Uint8Array } | null = null;

export function romKey(
  rom: { path: string; size: number; mtime: number },
): string {
  return `${rom.path}:${rom.size}:${rom.mtime}`;
}

function envExtra(name: string): string[] {
  return [Deno.env.get(name) ?? ""].filter(Boolean);
}

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const wantRom = url.searchParams.get("rom") === "1";
    const wantIpl = url.searchParams.get("ipl") === "1";
    if (isDeploy()) {
      return Response.json(
        { available: false, reason: "local only" },
        { status: wantRom || wantIpl ? 404 : 200 },
      );
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;

    const root = await repoRoot();
    const found = await findDezaemonN64(root, {
      extra: [...envExtra("DEZAEMON_N64_ROM"), ...envExtra("N64DD_IPL")],
    });
    const rom = found.rom;
    const ipl = found.ipl;

    if (wantRom) {
      if (!rom) {
        return Response.json({ ok: false, error: NOT_HERE }, { status: 404 });
      }
      const key = romKey(rom);
      const etag = `"${rom.sha1}"`;
      if (ctx.req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      let bytes: Uint8Array;
      try {
        bytes = romCache && romCache.key === key
          ? romCache.bytes
          : await readDezaemonN64Rom(rom, { root });
      } catch (e) {
        return Response.json({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }, { status: 409 });
      }
      romCache = { key, bytes };
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "content-disposition":
            `attachment; filename="${DEZAEMON_N64_ROM_NAME}"`,
          etag,
        },
      });
    }

    if (wantIpl) {
      if (!ipl) {
        return Response.json({ ok: false, error: NO_IPL }, { status: 404 });
      }
      const etag = `"${ipl.sha1}"`;
      if (ctx.req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      const bytes = await readN64ddIpl(ipl);
      return new Response(bytes as BodyInit, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
          "content-disposition": `attachment; filename="${N64DD_IPL_NAME}"`,
          etag,
        },
      });
    }

    const reasons: string[] = [];
    if (!rom) reasons.push(NOT_HERE);
    else if (rom.edition === "unknown") {
      reasons.push(
        `${rom.name} is a Dezaemon 3D dump the translation does not know (SHA-1 ${rom.sha1}); ` +
          `the patch takes the original Japanese ROM, ${DEZAEMON_N64_SHA1_JAPAN}`,
      );
    }
    if (!ipl) reasons.push(NO_IPL);
    return Response.json({
      available: !!rom && rom.edition !== "unknown" && !!ipl,
      title: DEZAEMON_N64_TITLE,
      rom: rom
        ? {
          name: rom.name,
          size: rom.size,
          order: rom.header.order,
          internalName: rom.header.name,
          gameCode: rom.header.gameCode,
          sha1: rom.sha1,
          edition: rom.edition,
          // What leaves ?rom=1: the English ROM when the dump is the Japanese
          // or the English one, nothing otherwise.
          english: rom.edition !== "unknown",
          url: "/api/dezaemon-n64?rom=1",
          fileName: DEZAEMON_N64_ROM_NAME,
        }
        : null,
      ipl: ipl
        ? {
          name: ipl.name,
          size: ipl.size,
          internalName: ipl.header.name,
          sha1: ipl.sha1,
          url: "/api/dezaemon-n64?ipl=1",
          fileName: N64DD_IPL_NAME,
        }
        : null,
      patch: {
        url: DEZAEMON_N64_PATCH_URL,
        takes: DEZAEMON_N64_SHA1_JAPAN,
        makes: DEZAEMON_N64_SHA1_ENGLISH,
      },
      reason: reasons.length ? reasons.join("; ") : null,
    });
  },
});
