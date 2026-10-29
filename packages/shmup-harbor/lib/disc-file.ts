// Finding a file that lives on the Dezaemon 2 disc.
//
// The shared scan behind lib/sndpac.ts (SNDPAC.BIN, the sample bank) and
// scripts/build-mesh-library.ts (MDLDT_01-56.CMP, the ポリ吉 part library).
// A named file is looked for as an extracted copy first — dev-fixtures/.cache/
// then a bare dev-fixtures/<name> — and then inside every disc image in the
// gitignored dev-fixtures/, through the engine's ISO 9660 reader. Finding
// nothing is the normal case on a fresh checkout and is never an error.

import { basename, join } from "@std/path";
import { openDisc, readFile } from "@shmupx/shmup-engine/iso9660-read";

/** Extensions worth opening as a disc image when scanning dev-fixtures/. */
export const DISC_EXTENSIONS = [".bin", ".iso", ".img"];

export interface DiscFileSource {
  bytes: Uint8Array;
  /** Human-readable provenance for the build log. */
  from: string;
}

export interface DiscImage {
  name: string;
  // deno-lint-ignore no-explicit-any
  disc: any;
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

export function fixturesDir(root: string): string {
  return join(root, "dev-fixtures");
}

/**
 * Every disc image directly inside `dir`, opened, in name order. Files that
 * carry no ISO 9660 volume (a CD audio track, a memory card) are skipped.
 */
export async function openDiscImagesIn(dir: string): Promise<DiscImage[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return [];
  }
  const images: DiscImage[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile) continue;
    const lower = entry.name.toLowerCase();
    if (!DISC_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    const image = await readIfPresent(join(dir, entry.name));
    if (!image) continue;
    const disc = openDisc(image);
    if (disc) images.push({ name: basename(entry.name), disc });
  }
  return images;
}

/** Every disc image in dev-fixtures/, opened, in name order. */
export function openDiscImages(root: string): Promise<DiscImage[]> {
  return openDiscImagesIn(fixturesDir(root));
}

/**
 * The disc image(s) at a path the caller named: an image file, or a folder
 * scanned like dev-fixtures/ (a Redump set's folder holds the data track
 * beside its audio tracks and .cue, and only the data track opens). Throws
 * when the path cannot be read or holds no ISO 9660 volume — the caller asked
 * for it by name, so finding nothing there is an error, not the normal case.
 */
export async function openDiscPath(path: string): Promise<DiscImage[]> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    throw new Error(`cannot read ${path}`);
  }
  const images = info.isDirectory ? await openDiscImagesIn(path) : [];
  if (info.isFile) {
    const disc = openDisc(await Deno.readFile(path));
    if (disc) images.push({ name: basename(path), disc });
  }
  if (!images.length) throw new Error(`no disc image at ${path}`);
  return images;
}

/**
 * Locate one disc file. In order: an explicit path (which must be readable —
 * the caller asked for it by name), the extraction cache, a bare copy in
 * dev-fixtures/, then every disc image there. Null when nothing is found.
 */
export async function findDiscFile(
  root: string,
  name: string,
  { explicit = null, flag = "--file" }: {
    explicit?: string | null;
    flag?: string;
  } = {},
): Promise<DiscFileSource | null> {
  if (explicit) {
    const bytes = await readIfPresent(explicit);
    if (!bytes) throw new Error(`${flag}: cannot read ${explicit}`);
    return { bytes, from: explicit };
  }
  const fixtures = fixturesDir(root);
  for (const path of [join(fixtures, ".cache", name), join(fixtures, name)]) {
    const bytes = await readIfPresent(path);
    if (bytes) return { bytes, from: path };
  }
  for (const { name: image, disc } of await openDiscImages(root)) {
    const found = readFile(disc, name);
    if (found) return { bytes: found, from: `${image} (ISO 9660)` };
  }
  return null;
}

/**
 * Locate several disc files at once, opening each disc image only once.
 * `files[i]` is null for a name nothing supplies; the result is null when
 * none of them were found anywhere.
 */
export async function findDiscFiles(
  root: string,
  names: string[],
): Promise<{ files: (Uint8Array | null)[]; from: string } | null> {
  const fixtures = fixturesDir(root);
  const files: (Uint8Array | null)[] = new Array(names.length).fill(null);
  const sources = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    for (
      const path of [
        join(fixtures, ".cache", names[i]),
        join(fixtures, names[i]),
      ]
    ) {
      const bytes = await readIfPresent(path);
      if (bytes) {
        files[i] = bytes;
        sources.add(path);
        break;
      }
    }
  }
  if (files.some((f) => !f)) {
    for (const { name: image, disc } of await openDiscImages(root)) {
      for (let i = 0; i < names.length; i++) {
        if (files[i]) continue;
        const found = readFile(disc, names[i]);
        if (found) {
          files[i] = found;
          sources.add(`${image} (ISO 9660)`);
        }
      }
      if (files.every(Boolean)) break;
    }
  }
  if (!files.some(Boolean)) return null;
  return { files, from: [...sources].join(", ") };
}
