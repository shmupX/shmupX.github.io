// The build half of member packs: which files of a checkout go in which pack,
// what the Steam binary therefore leaves out, the packs themselves, and the
// way back into a checkout.
//
// lib/member-content.ts is the policy; lib/member-packs.ts serves the packs in
// the packaged app. Everything here works on URL paths ("/snes/Dezaemon.sfc"),
// decoded, against a tree laid out the way static/ is — which is also how
// _fresh/client, the copy the binary embeds, is laid out.

import { buildZip, type ZipEntry } from "@shmupx/shmup-harbor/zip";
import { dirname, join } from "@std/path";
import { unzip } from "../static/zip-read.js";
import {
  MEMBER_DEFAULTS,
  MEMBER_FORMAT,
  type MemberManifest,
  type MemberPack,
  packFileName,
  packFor,
} from "./member-content.ts";
import { describeMemberUi, readMemberUi } from "./member-ui.ts";

/** Every file under `root` as a URL path, sorted. AppleDouble and Finder litter are not files. */
export async function treeUrls(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string[]) => {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith("._") || e.name === ".DS_Store") continue;
      const next = [...rel, e.name];
      if (e.isDirectory) await walk(join(dir, e.name), next);
      else if (e.isFile) out.push("/" + next.join("/"));
    }
  };
  await walk(root, []);
  return out.sort();
}

/** The member files among `urls`, by pack id, in table order. */
export function assignPacks(
  urls: readonly string[],
  packs: readonly MemberPack[],
): Map<string, string[]> {
  const out = new Map<string, string[]>(packs.map((p) => [p.id, []]));
  for (const url of urls) {
    const pack = packFor(url, packs);
    if (pack) out.get(pack.id)!.push(url);
  }
  return out;
}

/**
 * The fewest paths that leave exactly the `member` files out of a tree whose
 * files are `all`: a folder whenever everything under it is member content,
 * the file itself otherwise. Paths come back as URL paths ("/games/arcade-x",
 * "/editor/dezaemon/mesh-library.json").
 *
 * The count matters on Windows, where `deno compile`'s whole command line has
 * to fit in 32,767 characters: 262 community saves named one by one would not
 * leave much room, and their folder is one --exclude.
 */
export function minimalExcludes(
  all: readonly string[],
  member: ReadonlySet<string>,
): string[] {
  // For every folder, whether all of its files are member files.
  const pure = new Map<string, boolean>();
  for (const url of all) {
    const isMember = member.has(url);
    let dir = url.slice(0, url.lastIndexOf("/"));
    while (dir) {
      pure.set(dir, (pure.get(dir) ?? true) && isMember);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  const out = new Set<string>();
  for (const url of all) {
    if (!member.has(url)) continue;
    // The outermost folder that holds nothing but member files.
    let pick = url;
    let dir = url.slice(0, url.lastIndexOf("/"));
    while (dir && pure.get(dir)) {
      pick = dir;
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
    out.add(pick);
  }
  return [...out].sort();
}

export interface WrittenPack {
  id: string;
  title: string;
  file: string;
  files: number;
  bytes: number;
}

/**
 * Write one zip per pack that has anything in `root` — its files at their URL
 * paths, and a member.json naming them — into `outDir`. A pack whose only
 * file is one the Steam build answers for itself (MEMBER_DEFAULTS: an empty
 * saves manifest) is not written: there is nothing in it to restore. Packs
 * left over from an earlier build that this one did not write are removed,
 * so the folder only ever holds what the binary beside it left out.
 */
export async function writeMemberPacks(opts: {
  root: string;
  outDir: string;
  packs: readonly MemberPack[];
  built: Date;
  log?: (line: string) => void;
}): Promise<WrittenPack[]> {
  const log = opts.log ?? (() => {});
  const assigned = assignPacks(await treeUrls(opts.root), opts.packs);
  await Deno.mkdir(opts.outDir, { recursive: true });
  const written: WrittenPack[] = [];
  const keep = new Set<string>();
  for (const pack of opts.packs) {
    const files = assigned.get(pack.id) ?? [];
    if (!files.some((f) => !(f in MEMBER_DEFAULTS))) continue;
    // The rule's UI, read the way the launcher will read it, against the
    // files this pack actually holds: a section whose player is not here
    // is not written, rather than written and then dropped on import.
    const carried = new Set(files);
    const ui = pack.ui ? readMemberUi(pack.ui, (p) => carried.has(p)) : null;
    const manifest: MemberManifest = {
      format: MEMBER_FORMAT,
      version: 1,
      id: pack.id,
      title: pack.title,
      why: pack.why,
      built: opts.built.toISOString(),
      files,
      ...(ui ? { ui } : {}),
    };
    const entries: ZipEntry[] = [{
      path: "member.json",
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
    }];
    let bytes = 0;
    for (const url of files) {
      const data = await Deno.readFile(
        join(opts.root, ...url.slice(1).split("/")),
      );
      bytes += data.length;
      entries.push({ path: url.slice(1), data });
    }
    const file = join(opts.outDir, packFileName(pack.id));
    const zip = await buildZip(entries, opts.built);
    await Deno.writeFile(file, zip);
    keep.add(packFileName(pack.id));
    written.push({
      id: pack.id,
      title: pack.title,
      file,
      files: files.length,
      bytes,
    });
    log(
      `  ${packFileName(pack.id)}  ${files.length} file(s), ` +
        `${(zip.length / 1048576).toFixed(1)} MB — ${pack.title}` +
        (ui ? `; adds ${describeMemberUi(ui)}` : ""),
    );
  }
  for await (const e of Deno.readDir(opts.outDir)) {
    if (
      e.isFile && /^shmupx-member-.+\.zip$/.test(e.name) && !keep.has(e.name)
    ) {
      await Deno.remove(join(opts.outDir, e.name));
    }
  }
  return written;
}

export interface Restored {
  zip: string;
  written: string[];
  /** Entries no member rule names, which a restore never writes. */
  skipped: string[];
}

/**
 * Unpack member packs back into a checkout's `staticDir`, so a source build
 * has what a Steam build left out. Only paths a member rule names are
 * written: a pack restores member content, never the launcher's own files.
 */
export async function restoreMemberPacks(
  zips: readonly string[],
  staticDir: string,
  packs: readonly MemberPack[],
): Promise<Restored[]> {
  const out: Restored[] = [];
  for (const zip of zips) {
    const entries = await unzip(await Deno.readFile(zip)) as Array<
      { path: string; dir: boolean; data: Uint8Array }
    >;
    const done: Restored = { zip, written: [], skipped: [] };
    for (const e of entries) {
      if (e.dir || e.path === "member.json") continue;
      const url = "/" + e.path;
      if (!packFor(url, packs)) {
        done.skipped.push(url);
        continue;
      }
      const dest = join(staticDir, ...e.path.split("/"));
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.writeFile(dest, e.data);
      done.written.push(url);
    }
    out.push(done);
  }
  return out;
}
