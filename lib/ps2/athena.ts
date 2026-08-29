// Getting hold of athena.elf — the AthenaEnv interpreter that runs the
// exported game on the console.
//
// AthenaEnv publishes one rolling `latest` release containing the whole
// environment; all this needs from it is the interpreter, so the tarball is
// fetched once, the ELF is extracted, and the copy is cached under
// build/ps2/.cache. Point ATHENA_ELF (or --athena-elf) at a local build to
// skip the download entirely — useful offline, and the only way to ship a
// custom AthenaEnv.

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ungzip } from "./deflate.ts";

const RELEASE_URL =
  "https://github.com/DanielSant0s/AthenaEnv/releases/download/latest/AthenaEnv.tar.gz";
const ELF_IN_TARBALL = "AthenaEnv/athena.elf";

export interface AthenaOptions {
  cacheDir: string;
  /** Explicit athena.elf; skips the cache and the download. */
  elfPath?: string | null;
  /** Re-download even when the cache already holds a copy. */
  refresh?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// Pull one member out of an uncompressed tar. Only the fields that matter here
// are read: name, size, and the type flag that separates regular files from
// the long-name and directory entries.
function readFromTar(tar: Uint8Array, wanted: string): Uint8Array | null {
  const decoder = new TextDecoder();
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) {
      at += 512;
      continue;
    }
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(
      /[\0 ]/g,
      "",
    );
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const body = at + 512;
    if (name === wanted && (type === "0" || type === "\0")) {
      return tar.slice(body, body + size);
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Resolve athena.elf, downloading and caching the release if necessary. */
export async function resolveAthenaElf(
  options: AthenaOptions,
): Promise<{ bytes: Uint8Array; source: string }> {
  const override = options.elfPath ?? Deno.env.get("ATHENA_ELF") ?? null;
  if (override) {
    if (!(await exists(override))) {
      throw new Error(`athena.elf not found at ${override}`);
    }
    return { bytes: await Deno.readFile(override), source: override };
  }

  const cached = join(options.cacheDir, "athena.elf");
  if (!options.refresh && (await exists(cached))) {
    return { bytes: await Deno.readFile(cached), source: cached };
  }

  console.log(`  downloading AthenaEnv from ${RELEASE_URL}`);
  const response = await fetch(RELEASE_URL);
  if (!response.ok) {
    throw new Error(
      `could not download AthenaEnv (HTTP ${response.status}). ` +
        `Pass --athena-elf <path> or set ATHENA_ELF to build offline.`,
    );
  }
  const tar = await ungzip(new Uint8Array(await response.arrayBuffer()));
  const elf = readFromTar(tar, ELF_IN_TARBALL);
  if (!elf) {
    throw new Error(
      `the AthenaEnv release no longer contains ${ELF_IN_TARBALL} — ` +
        `pass --athena-elf <path> to a local build instead`,
    );
  }
  await ensureDir(dirname(cached));
  await Deno.writeFile(cached, elf);
  return { bytes: elf, source: RELEASE_URL };
}
