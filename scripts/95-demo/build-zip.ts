// Pack EVIL INVADERS '95 into the archive the eShop installs.
//
//   deno task 95-demo:zip           # static/games/95-demo-web.zip
//   deno task 95-demo:zip --icon    # also redraw static/icons/95-demo-icon.png
//
// The archive is the 2019 web build's shape (scripts/2019/build-zip.ts): the
// 2028.Ai game page rendered standalone, this checkout's runtime with its one
// level line pointed at the foo.json beside it, and the level record. A plain
// visit to that page bakes foo.json in as the offline level, which the level
// loader merges over the stock recipe exactly as it merges the cloud record
// on ?level=95-demo, so the install plays what 95.codemonkey.games plays —
// the Galaga flights, the fire gates, endsOnClear, the RedDevil — on the same
// leaderboard (the record's gameId). Phaser, the plugins and the assets are
// fetched off this origin, as for 2019.
//
// The record is not a committed copy: it is buildLevel()'s, the very record
// `build-level.ts --apply` writes to shmupX/levels/95-demo, rebuilt from
// scripts/95-demo/ with neither the network nor the source checkout. So
// `deno task build` needs no network, the same commit always builds the same
// archive, and the archive cannot drift from the conversion. A Dezaemon 2
// cart (`deno task eshop:publish`) is no substitute: the cart drops every
// enemy's flight script, the dart and endsOnClear, and gives every stage a
// boss.
//
// The shop row's icon is drawn from the game's own art — the title's
// starfield, logo and tag line over a rank of its invaders and the fighter —
// and committed; --icon redraws it.

import { buildZip, type ZipEntry } from "@shmupx/shmup-harbor/zip";
import { encodePng, type Raster } from "@shmupx/shmup-harbor/png";
import { fromFileUrl } from "@std/path";
import { injectLauncherMarker } from "../../lib/launcher-inject.ts";
import { standaloneGamePageHtml } from "../../lib/game-page.ts";
import { patchBundle } from "../2019/build-zip.ts";
import { buildArt, buildLevel } from "./build-level.ts";
import {
  composite,
  logoArt,
  resample,
  subTitleArt,
  titleBackdropArt,
} from "./art.ts";

/** The game's name, as the page's <title> and the shop row say it. */
export const TITLE = "EVIL INVADERS '95";

const BUNDLE = fromFileUrl(
  new URL("../../static/games/2028-ai/game.bundle.js", import.meta.url),
);
const OUT = new URL("../../static/games/95-demo-web.zip", import.meta.url);
export const ICON = new URL(
  "../../static/icons/95-demo-icon.png",
  import.meta.url,
);

// Fixed, so zipping the same inputs twice gives the same bytes.
const STAMP = new Date("2026-10-28T00:00:00Z");

/** The archive's entries, sorted. */
export async function gameEntries(): Promise<ZipEntry[]> {
  const encoder = new TextEncoder();
  const { record } = await buildLevel();
  const html = injectLauncherMarker(
    standaloneGamePageHtml({ title: TITLE, bundleSrc: "game.bundle.js" }),
  );
  const entries: ZipEntry[] = [
    { path: "foo.json", data: encoder.encode(JSON.stringify(record)) },
    {
      path: "game.bundle.js",
      data: encoder.encode(patchBundle(await Deno.readTextFile(BUNDLE))),
    },
    { path: "index.html", data: encoder.encode(html) },
  ];
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** A sprite blown up by a whole factor, its pixels kept square. */
const grow = (r: Raster, k: number) =>
  resample(r, r.width * k, r.height * k, true);

/**
 * The shop's box art, 256x384 (the 2:3 of 2019's): the title's starfield,
 * its logo and tag line, a rank of the three invaders and the fighter below.
 */
export async function iconArt(): Promise<Raster> {
  const W = 256, H = 384;
  const parts = [
    { art: titleBackdropArt(W, H), x: 0, y: 0 },
    { art: await logoArt(), x: 0, y: 40 },
    { art: await subTitleArt(), x: 0, y: 132 },
  ];

  const { frames } = await buildArt();
  const art = (name: string) => frames.find((f) => f.name === name)!.raster;
  const rank = ["ei95GoldGirl0", "ei95EyeDude0", "ei95PinkBunny0"].map(
    (n) => grow(art(n), 2),
  );
  const gap = 12;
  const rankW = rank.reduce((w, r) => w + r.width, 0) + gap * 2;
  const rankH = Math.max(...rank.map((r) => r.height));
  let x = Math.floor((W - rankW) / 2);
  for (const r of rank) {
    parts.push({ art: r, x, y: 196 + Math.floor((rankH - r.height) / 2) });
    x += r.width + gap;
  }
  const ship = grow(art("ei95Fighter"), 2);
  parts.push({
    art: ship,
    x: Math.floor((W - ship.width) / 2),
    y: H - 28 - ship.height,
  });
  // alpha-over: the plates and sprites are drawn on transparency
  return composite(W, H, parts);
}

if (import.meta.main) {
  if (Deno.args.includes("--icon")) {
    await Deno.writeFile(ICON, await encodePng(await iconArt()));
    console.log(`wrote ${fromFileUrl(ICON)}`);
  }
  const entries = await gameEntries();
  const zip = await buildZip(entries, STAMP);
  await Deno.writeFile(OUT, zip);
  console.log(
    `wrote ${fromFileUrl(OUT)} (${(zip.length / 1048576).toFixed(1)} MB, ${
      entries.map((e) => e.path).join(", ")
    })`,
  );
}
