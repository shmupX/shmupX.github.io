import { define } from "../../utils.ts";
import { localWriteGuard } from "../../lib/local-guards.ts";
import { buildZip, type ZipEntry } from "../../lib/ps2/zip.ts";
import { packagedBuildRoot } from "../../lib/build-workspace.ts";
import {
  basename,
  dirname,
  fromFileUrl,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "jsr:@std/path@^1.1.2";

// GET /api/build-artifact?path=<path> — hand a finished export back to the
// browser that asked for it.
//
// /api/build-apk builds into build/ and answers with paths on the build host's
// disk, which is all the editor needed while "export" meant "look in build/".
// The PS2 target changed that: its artifacts are things a browser can actually
// use — a disc image the in-browser player boots, a folder that belongs on a
// USB stick — so there has to be a way to fetch one. This is it.
//
// A DIRECTORY is served as a .zip of itself (lib/ps2/zip.ts), which is the only
// shape a download can take and, for the athena.elf build, exactly the shape it
// wants: unpack it and the folder is back.
//
// LOCAL-ONLY, and confined to build/. The query names a path on disk, so the
// containment check below is the whole security boundary — everything else
// (the Deploy refusal, the Fetch Metadata gate) is the same posture the build
// route already takes.

const MIME: Record<string, string> = {
  ".iso": "application/x-iso9660-image",
  ".zip": "application/zip",
  ".elf": "application/octet-stream",
  ".apk": "application/vnd.android.package-archive",
};

/**
 * Every directory an artifact may be served from, real paths, most specific
 * first.
 *
 * A checkout builds into <root>/build. Depth is not fixed — this module is
 * routes/api/ in a source checkout and _fresh/server/assets/<chunk>.mjs once
 * Vite has bundled the server — so walk up looking for the marker instead of
 * counting levels, exactly as routes/api/build-apk.ts does for the same reason.
 *
 * The packaged app cannot write into its own tree at all (a read-only
 * deno-compile VFS), so it builds into lib/build-workspace.ts's directory
 * instead; that is the second root, and it is offered unconditionally because
 * nothing else is served from it either way.
 */
async function allowedRoots(): Promise<string[]> {
  const roots: string[] = [];
  let dir = dirname(fromFileUrl(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const stat = await Deno.stat(join(dir, "build"));
      if (stat.isDirectory) {
        roots.push(join(dir, "build"));
        break;
      }
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  roots.push(packagedBuildRoot());
  const real: string[] = [];
  for (const root of roots) {
    real.push(await Deno.realPath(root).catch(() => root));
  }
  return real;
}

/** Every file under `dir`, as archive entries prefixed with the folder's name. */
async function treeEntries(dir: string): Promise<ZipEntry[]> {
  const name = basename(dir);
  const out: ZipEntry[] = [];
  const walk = async (at: string) => {
    for await (const entry of Deno.readDir(at)) {
      const path = join(at, entry.name);
      if (entry.isDirectory) {
        await walk(path);
      } else if (entry.isFile) {
        out.push({
          path: `${name}/${relative(dir, path).replaceAll(SEPARATOR, "/")}`,
          data: await Deno.readFile(path),
        });
      }
    }
  };
  await walk(dir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export const handler = define.handlers({
  async GET(ctx) {
    const denied = localWriteGuard(ctx.req);
    if (denied) return denied;

    const wanted = new URL(ctx.req.url).searchParams.get("path");
    if (!wanted) {
      return Response.json({ ok: false, error: "Missing 'path'." }, {
        status: 400,
      });
    }
    // Containment, on the REAL path: a symlink inside build/ pointing out of it
    // would otherwise pass a string comparison and serve anything on the disk.
    let path: string;
    try {
      path = await Deno.realPath(resolve(wanted));
    } catch {
      return Response.json({ ok: false, error: "No such artifact." }, {
        status: 404,
      });
    }
    const roots = await allowedRoots();
    const contained = roots.some((root) =>
      path === root || path.startsWith(root + SEPARATOR)
    );
    if (!contained) {
      return Response.json(
        { ok: false, error: "Artifacts are only served from build/." },
        { status: 403 },
      );
    }

    const stat = await Deno.stat(path);
    if (stat.isDirectory) {
      // Fixed timestamp, like every other archive this repo writes, so the same
      // export downloaded twice is the same file.
      const zip = await buildZip(
        await treeEntries(path),
        new Date("2000-03-04T00:00:00Z"),
      );
      return new Response(zip as BodyInit, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(zip.length),
          "content-disposition": `attachment; filename="${basename(path)}.zip"`,
        },
      });
    }

    const name = basename(path);
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const file = await Deno.open(path, { read: true });
    return new Response(file.readable, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": String(stat.size),
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  },
});
