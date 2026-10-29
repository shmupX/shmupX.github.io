// scripts/build-tone-bank.ts — cut the Dezaemon 2 tone bank out of SNDPAC.BIN.
//
//   deno task deza:tonebank                  → find the bank, cache it, report
//   deno task deza:tonebank --out build/tonebank
//   deno task deza:tonebank --sndpac path/to/SNDPAC.BIN
//
// SNDPAC.BIN is disc content and is never committed. The bank is found in
// dev-fixtures/ (gitignored): a bare SNDPAC.BIN, or any disc image the ISO
// 9660 reader can pull one out of. Finding nothing is not an error — the task
// says so and exits 0, and every consumer falls back to its synthesised
// voices.
//
// With --out it also writes the PS2 pack (audsrv .adp per sample, plus
// tonebank.json and .wav twins). `deno task build:ps2` does this itself; the
// flag is for inspecting the render without building a disc.
//
// With --web it writes the PUBLISHED web bank: buildWebToneBank's index as
// tone-bank.json (plus a format/version header and the SHA-256 of the PCM and
// of the SNDPAC.BIN it came from) and its Int16 PCM as tone-bank.pcm, by
// default into static/games/2028-ai/assets/tone-bank/ — committed, served with
// the game, and what the runtime and the editor's MUSIC play (decision
// 2026-10-28; on Steam it ships only in the members' Dezaemon 2 disc pack,
// lib/member-content.ts). The output is deterministic; with no bank to cut
// from, the committed files stay as they are.
//
// Flags:
//   --sndpac <path>  use this bank instead of searching dev-fixtures/
//   --out <dir>      also render the PS2 pack here
//   --web [dir]      also write the published web bank (default: the game's assets)
//   --no-cache       skip writing dev-fixtures/.cache/SNDPAC.BIN

import { dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  buildToneBankPack,
  cacheSndpac,
  findSndpac,
} from "../lib/ps2/tone-bank-pack.ts";
import { WEB_TONE_BANK_DIR, webToneBankFiles } from "../lib/sndpac.ts";
import { repoRoot } from "../lib/repo-root.ts";

const ROOT = repoRoot();
const VALUE_FLAGS = new Set(["--sndpac", "--out"]);

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(2);
}

const flags: Record<string, string | true> = {};
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (VALUE_FLAGS.has(arg)) {
    const value = Deno.args[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    flags[arg] = value;
  } else if (arg === "--no-cache") {
    flags[arg] = true;
  } else if (arg === "--web") {
    const next = Deno.args[i + 1];
    flags[arg] = next && !next.startsWith("--") ? Deno.args[++i] : WEB_TONE_BANK_DIR;
  } else {
    fail(`unknown argument ${arg}`);
  }
}

const source = await findSndpac(
  ROOT,
  typeof flags["--sndpac"] === "string" ? flags["--sndpac"] : null,
);

if (!source) {
  console.log(
    "[tonebank] no SNDPAC.BIN found — drop a Dezaemon 2 disc image (or the " +
      "bank itself) into dev-fixtures/ to render the real Saturn timbres. " +
      (typeof flags["--web"] === "string"
        ? `Keeping ${flags["--web"]} as committed.`
        : "Nothing to do."),
  );
  Deno.exit(0);
}

console.log(
  `[tonebank] bank: ${
    relative(ROOT, source.from) || source.from
  } (${source.bytes.length} bytes)`,
);
if (flags["--no-cache"] !== true) await cacheSndpac(ROOT, source.bytes);

const webFlag = flags["--web"];
if (typeof webFlag === "string") {
  const webDir = resolve(ROOT, webFlag);
  const files = await webToneBankFiles(source.bytes);
  await ensureDir(webDir);
  await Deno.writeTextFile(join(webDir, "tone-bank.json"), files.json);
  await Deno.writeFile(join(webDir, "tone-bank.pcm"), files.pcm);
  console.log(
    `[tonebank] web bank: ${files.index.slices.length} slices, ${files.pcm.length.toLocaleString()} B of PCM → ${
      relative(ROOT, webDir) || webDir
    }/`,
  );
}

const outFlag = flags["--out"];
if (typeof outFlag !== "string") {
  if (typeof webFlag !== "string") {
    console.log("[tonebank] cached. Pass --out <dir> to render the PS2 pack, --web to publish the web bank.");
  }
  Deno.exit(0);
}

const pack = buildToneBankPack(source.bytes);
const outDir = resolve(ROOT, outFlag);
for (const file of [...pack.files, ...pack.wavFiles]) {
  const target = join(outDir, file.path);
  await ensureDir(dirname(target));
  await Deno.writeFile(target, file.data);
}
for (const note of pack.notes) console.log(`[tonebank] ${note}`);
console.log(
  `[tonebank] wrote ${pack.files.length + pack.wavFiles.length} files to ${
    relative(ROOT, outDir) || outDir
  }/`,
);
