import { define } from "../../utils.ts";
import {
  crossSiteGuard,
  isDeploy,
  localWriteGuard,
} from "../../lib/local-guards.ts";
import { join } from "@std/path";
import { repoRoot } from "../../lib/dezaemon-n64.ts";
import {
  convertDisk,
  DDD_IMAGE_BYTES,
  imageFormat,
  NDD_IMAGE_BYTES,
} from "../../packages/shmup-engine/src/n64/index.js";

// POST /api/n64dd-disk?name=<file>.ndd   — keep a disk the editor built, on this machine
// GET  /api/n64dd-disk?file=<file>.ndd   — that disk, for the Nintendo 64DD player
// GET  /api/n64dd-disk                   — the disks kept so far
//
// The editor builds a 64DD disk in the page (exportLevelToDdd) and the player
// is another window — opened by the launcher's own window manager on the
// desktop, by window.open elsewhere — that cannot be posted 64 MB across. So
// the disk is parked here first, under build/n64dd/ in the checkout (the same
// tree `deno task build:ddd` writes to), and the player is given its URL: the
// "?rom=<path>" contract every player in the catalogue already takes, only
// with a disk and an IPL beside the cartridge. A parked disk is also a file
// the operator keeps — an .ndd ares or a flashcart can mount — which the
// download row gives them anyway.
//
// A .ddd posted here is turned into the .ndd the player wants (the system
// area built for a type-0 disk, lib/dezaemon-n64.ts's sibling in the engine
// does it); anything that is not a 64DD image is refused before the disk is
// touched. The name is cut to a safe spelling and always ends in .ndd.
//
// LOCAL-ONLY, the same way /api/psx-save is: it writes into the user's
// checkout and serves files from it, so the hosted deploy refuses it and the
// POST sits behind the Fetch Metadata gate.

/** Where the disks go: $SHMUPX_N64DD_DIR, else build/n64dd/ in the checkout. */
export async function diskDir(): Promise<string> {
  const env = Deno.env.get("SHMUPX_N64DD_DIR");
  if (env) return env;
  return join(await repoRoot(), "build", "n64dd");
}

/**
 * A file name this route will write or serve: letters and digits in any
 * script (a Japanese title keeps its name instead of collapsing to "-"), a
 * few marks, ending in .ndd. Every separator and control character becomes
 * "-", so nothing here names a directory.
 */
export function safeDiskName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  let clean = name.trim().replace(/[^\p{L}\p{N} ._()\-]+/gu, "-").replace(
    /^\.+/,
    "",
  ).slice(0, 80).trim();
  if (!clean) return null;
  if (!/\.ndd$/i.test(clean)) clean = clean.replace(/\.(ddd)$/i, "") + ".ndd";
  if (clean === ".ndd") return null;
  return clean;
}

async function listDisks(dir: string) {
  const out: { file: string; bytes: number; mtime: number; url: string }[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !/\.ndd$/i.test(entry.name)) continue;
      const info = await Deno.stat(join(dir, entry.name));
      out.push({
        file: entry.name,
        bytes: info.size,
        mtime: info.mtime?.getTime() ?? 0,
        url: `/api/n64dd-disk?file=${encodeURIComponent(entry.name)}`,
      });
    }
  } catch { /* no directory yet: no disks */ }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const wanted = url.searchParams.get("file");
    if (isDeploy()) {
      return Response.json({ available: false, reason: "local only" }, {
        status: wanted ? 404 : 200,
      });
    }
    const denied = crossSiteGuard(ctx.req);
    if (denied) return denied;
    const dir = await diskDir();
    if (!wanted) {
      return Response.json({
        available: true,
        dir,
        disks: await listDisks(dir),
      });
    }
    const file = safeDiskName(wanted);
    if (!file || file !== wanted) {
      return Response.json({
        ok: false,
        error: "file must name a disk this route wrote",
      }, { status: 400 });
    }
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(join(dir, file));
    } catch {
      return Response.json({ ok: false, error: `no ${file} under ${dir}` }, {
        status: 404,
      });
    }
    return new Response(bytes as BodyInit, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "content-disposition": `attachment; filename="${file}"`,
        "cache-control": "no-store",
      },
    });
  },

  async POST(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;
    const url = new URL(ctx.req.url);
    const file = safeDiskName(url.searchParams.get("name") ?? "");
    if (!file) {
      return Response.json({
        ok: false,
        error: "name must be a file name for the disk",
      }, { status: 400 });
    }
    const body = new Uint8Array(await ctx.req.arrayBuffer());
    const format = imageFormat(body);
    if (!format) {
      return Response.json(
        {
          ok: false,
          error:
            `the body is ${body.length} bytes; a 64DD image is ${DDD_IMAGE_BYTES} (.ddd) or ${NDD_IMAGE_BYTES} (.ndd)`,
        },
        { status: 400 },
      );
    }
    const ndd = format === "ndd" ? body : convertDisk(body, "ndd");
    const dir = await diskDir();
    await Deno.mkdir(dir, { recursive: true });
    const path = join(dir, file);
    await Deno.writeFile(path, ndd);
    return Response.json({
      ok: true,
      file,
      path,
      bytes: ndd.length,
      converted: format === "ddd",
      url: `/api/n64dd-disk?file=${encodeURIComponent(file)}`,
    });
  },
});
