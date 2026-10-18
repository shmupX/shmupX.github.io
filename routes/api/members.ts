import { define } from "../../utils.ts";
import { crossSiteGuard, localWriteGuard } from "../../lib/local-guards.ts";
import { steamMemberLibrary } from "../../lib/member-packs.ts";
import { packFileName } from "../../lib/member-content.ts";

// /api/members — the Steam build's member packs (lib/member-packs.ts).
//
//   GET   { available, packs, problems, missing, dirs, importDir }: what is
//         installed, what could not be read and why, and which packs none of
//         the installed ones provide.
//   POST  the zip itself as the body (x-file-name: its name) — filed into the
//         launcher's members folder, and served from the next request on.
//
// Only the Steam build has packs: every other build carries its member content
// or downloads it, and answers { available: false }.

const MAX_PACK = 2 ** 31 - 1;

export const handler = define.handlers({
  async GET(ctx) {
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const library = steamMemberLibrary();
    if (!library) {
      return Response.json({ ok: true, available: false }, {
        headers: { "cache-control": "no-store" },
      });
    }
    const { packs, problems } = await library.packs();
    const have = new Set(
      packs.flatMap((p) =>
        p.files.map((f) => library.ruleFor(f)?.id).filter(Boolean)
      ),
    );
    const missing = library.rules.filter((r) => !have.has(r.id)).map((r) => ({
      id: r.id,
      title: r.title,
      why: r.why,
      file: packFileName(r.id),
    }));
    return Response.json({
      ok: true,
      available: true,
      packs: packs.map((p) => ({ ...p, count: p.files.length })),
      problems,
      missing,
      dirs: library.dirs,
      importDir: library.importDir,
    }, { headers: { "cache-control": "no-store" } });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    const library = steamMemberLibrary();
    if (!library) {
      return Response.json(
        { ok: false, error: "Only the Steam build takes member packs." },
        { status: 409 },
      );
    }
    const length = Number(ctx.req.headers.get("content-length") ?? "0");
    if (length > MAX_PACK) {
      return Response.json({ ok: false, error: "That file is too big." }, {
        status: 413,
      });
    }
    const name = ctx.req.headers.get("x-file-name") ?? "pack.zip";
    const bytes = new Uint8Array(await ctx.req.arrayBuffer());
    try {
      const pack = await library.importPack(bytes, name);
      return Response.json({
        ok: true,
        pack: { ...pack, count: pack.files.length },
      });
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: `${name} is not a member pack: ${(err as Error).message}`,
        },
        { status: 400 },
      );
    }
  },
});
