#!/usr/bin/env -S deno run -A
/**
 * `deno task ps2:page "<level>"` — a game's PlayStation 2 download / PLAY
 * page, after Sh'M↑ Party's (github.com/easierbycode/shmup-party-ps2).
 *
 * It builds the level for the PS2 the way `deno task build:ps2 --iso` does —
 * the folder a USB stick takes and the bootable disc of the same tree — and
 * writes into static/games/<slug>/, which the site serves at /games/<slug>/:
 *
 *   index.html      the download page: the preview GIF, ⬇ ISO, ⬇ USB folder,
 *                   ▶ PLAY IN BROWSER, how to play, the secrets
 *   README.md       the same, for a repository's front page
 *   <slug>.iso      the disc
 *   <slug>-usb.zip  the folder, zipped under its own name
 *   play/           the web build of the same tree (lib/ps2/web-build.ts):
 *                   the disc's own main.js on the web build of AthenaEnv
 *   preview.gif     the seven-target capture (`deno task testdrive:parity`),
 *                   copied in when there is one — or --gif <file>
 *
 * All of it is committed, the ISO, the zip and play/ included. Deno Deploy
 * builds the site from this repository and `deno task build` does not run
 * this (it needs the cloud level and the AthenaEnv release), so anything here
 * git does not carry is a dead link on the live page.
 *
 * The slug and the title are the game's public name: the one alias the level
 * answers to as a subdomain (`deno task level:alias`), when it has exactly
 * one — gs is squad.codemonkey.games, so its page is /games/squad/, titled
 * SQUAD — else `<level>-ps2` and the level's own name. --slug and --title
 * say otherwise.
 *
 *   deno task ps2:page gs
 *   deno task ps2:page gs -- --slug gs-ps2 --title "GS" --gif build/testdrive/parity/gs/parity.gif
 *   deno task ps2:page gs -- --no-music     # a smaller disc: the effects but not the streamed music
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, join, resolve } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import { repoRoot } from "@shmupx/shmup-harbor/repo-root";
import { buildPs2 } from "../packages/shmup-harbor/lib/ps2/build.ts";
import { writeWebBuild } from "../packages/shmup-harbor/lib/ps2/web-build.ts";
import { buildZip, treeEntries } from "../packages/shmup-harbor/lib/ps2/zip.ts";
import { cloudLevelAliases } from "../lib/level-subdomain.ts";
import { ps2PageHtml, ps2Readme } from "./lib/ps2-page.ts";

const ROOT = repoRoot();
const flags = parseArgs(Deno.args.filter((a) => a !== "--"), {
  string: ["slug", "title", "gif", "caption"],
  boolean: ["no-music", "help"],
});
if (flags.help || !flags._[0]) {
  console.log(
    'deno task ps2:page "<level>" [-- --slug <name> --title <text> --gif <file> --caption <text> --no-music]',
  );
  Deno.exit(flags.help ? 0 : 2);
}
const level = String(flags._[0]);
const levelSlug = level.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

/** The one alias the level answers to, when it has exactly one; else null. */
async function publicName(): Promise<string | null> {
  const aliases = await cloudLevelAliases() ?? {};
  const names = Object.keys(aliases).filter((name) => aliases[name] === level);
  return names.length === 1 ? names[0] : null;
}
const alias = flags.slug && flags.title ? null : await publicName();
const slug = flags.slug ?? alias ?? `${levelSlug}-ps2`;
const title = flags.title ?? (alias ? alias.toUpperCase() : level);
const out = join(ROOT, "static", "games", slug);
await ensureDir(out);

console.log(`building ${level} for the PS2 (folder + disc)…`);
const built = await buildPs2({
  root: ROOT,
  levelName: level,
  iso: true,
  skipMusic: flags["no-music"],
});
if (!built.appDir || !built.isoPath) {
  throw new Error("the PS2 build wrote no folder or no disc");
}

const iso = `${slug}.iso`;
await Deno.copyFile(built.isoPath, join(out, iso));
const zip = `${slug}-usb.zip`;
// A fixed stamp, so the same build zips to the same bytes.
const zipped = await buildZip(
  await treeEntries(built.appDir),
  new Date("2026-10-18T00:00:00Z"),
);
await Deno.writeFile(join(out, zip), zipped);

console.log("writing the web build…");
await writeWebBuild(built.appDir, join(out, "play"), { title });

// testdrive:parity writes under the level's own name, whatever the slug.
const gifFrom = flags.gif
  ? resolve(flags.gif)
  : join(ROOT, "build", "testdrive", "parity", basename(level), "parity.gif");
let gif: string | null = null;
if (await exists(gifFrom)) {
  await Deno.copyFile(gifFrom, join(out, "preview.gif"));
  gif = "preview.gif";
} else if (await exists(join(out, "preview.gif"))) {
  gif = "preview.gif";
  console.log(`no GIF at ${gifFrom}; keeping the one already beside the page`);
} else {
  console.log(`no GIF at ${gifFrom}; the page goes out without one`);
}

const input = {
  title,
  level,
  slug,
  iso,
  zip,
  gif,
  isoBytes: (await Deno.stat(join(out, iso))).size,
  zipBytes: zipped.length,
  gifCaption: flags.caption ??
    `${title}'s stage-2 boss on every target shmupX exports to, a tool-assisted pilot fighting it: web, PS2, Super Famicom, Saturn, PS1 Kids!, PS1 Dezaemon+ and 64DD`,
};
await Deno.writeTextFile(join(out, "index.html"), ps2PageHtml(input));
await Deno.writeTextFile(join(out, "README.md"), ps2Readme(input));
console.log(`\n/games/${slug}/ — ${out}`);
console.log(`  ${iso} ${(input.isoBytes / 1048576).toFixed(1)} MB`);
console.log(`  ${zip} ${(input.zipBytes / 1048576).toFixed(1)} MB`);
console.log(`  play/  the web build`);
console.log(`  ${gif ?? "(no preview GIF)"}`);
