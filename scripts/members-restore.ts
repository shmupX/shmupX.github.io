// deno task members:restore <zip|folder>... — put member packs back into this
// checkout's static/, so a source build has what `deno task build:steam` left
// out of the Steam binary (lib/member-content.ts says what that is).
//
// A folder argument restores every shmupx-member-*.zip in it, so
//   deno task members:restore build/steam/members
// undoes a Steam build's split in one go. Only paths a member rule names are
// written: a pack can restore member content, never the launcher's own files.

import { join, resolve } from "@std/path";
import { memberPacks } from "../lib/member-content.ts";
import { restoreMemberPacks } from "../lib/member-build.ts";
import { keptRomsets } from "../lib/streamed-payloads.ts";

const ROOT = resolve(import.meta.dirname!, "..");

async function zipsIn(arg: string): Promise<string[]> {
  const path = resolve(arg);
  const info = await Deno.stat(path);
  if (!info.isDirectory) return [path];
  const found: string[] = [];
  for await (const e of Deno.readDir(path)) {
    if (e.isFile && /^shmupx-member-.+\.zip$/i.test(e.name)) {
      found.push(join(path, e.name));
    }
  }
  return found.sort();
}

if (!Deno.args.length) {
  console.error(
    "usage: deno task members:restore <shmupx-member-*.zip | folder>...",
  );
  Deno.exit(2);
}

const zips: string[] = [];
for (const arg of Deno.args) {
  try {
    zips.push(...await zipsIn(arg));
  } catch (err) {
    console.error(`error: ${arg}: ${(err as Error).message}`);
    Deno.exit(1);
  }
}
const eshop = JSON.parse(
  await Deno.readTextFile(join(ROOT, "data", "eshop.json")),
);
const packs = memberPacks(keptRomsets(eshop));
const restored = await restoreMemberPacks(zips, join(ROOT, "static"), packs);
for (const r of restored) {
  console.log(`${r.zip}: ${r.written.length} file(s) into static/`);
  for (const url of r.skipped) {
    console.log(`  skipped ${url}: no member pack carries it`);
  }
}
