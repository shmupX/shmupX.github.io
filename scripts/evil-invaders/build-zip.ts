// Pack Evil Invaders into the archive the eShop installs.
//
//   deno task evil-invaders:zip           # static/games/evil-invaders-web.zip
//   deno task evil-invaders:zip --icon    # also redraw static/icons/evil-invaders-icon.png
//
// The archive is the 2019 web build's shape (scripts/2019/build-zip.ts), as
// 95-demo's is: the 2028.Ai game page rendered standalone, this checkout's
// runtime with its one level line pointed at the foo.json beside it, and the
// level record. A plain visit to that page bakes foo.json in as the offline
// level, which the level loader merges over the stock recipe exactly as it
// merges the cloud record on ?level=evil-invaders, so the install plays what
// the cloud game plays — the bouncing Bowsers, the fire gates, the RedDevil
// boss, the starfield — on the same leaderboard (the record's gameId).
// Phaser, the plugins and the assets are fetched off this origin, as for 2019.
//
// The record is not a committed copy: it is buildLevel()'s, the very record
// `build-level.ts --apply` writes to shmupX/levels/evil-invaders, rebuilt
// from scripts/evil-invaders/ with neither the network nor the source
// checkout. So `deno task build` needs no network, the same commit always
// builds the same archive, and the archive cannot drift from the conversion.
//
// The shop row's icon is drawn from the game's own art — the starfield, the
// logo and tag line over a rank of its enemies and Peach's ship — and
// committed; --icon redraws it.

import { buildZip, type ZipEntry } from "@shmupx/shmup-harbor/zip";
import { encodePng, type Raster } from "@shmupx/shmup-harbor/png";
import { fromFileUrl } from "@std/path";
import { injectLauncherMarker } from "../../lib/launcher-inject.ts";
import { standaloneGamePageHtml } from "../../lib/game-page.ts";
import { patchBundle } from "../2019/build-zip.ts";
import { buildArt, buildLevel, TITLE } from "./build-level.ts";
import {
  composite,
  logoArt,
  resample,
  subTitleArt,
  titleBackdropArt,
} from "./art.ts";

export { TITLE };

const BUNDLE = fromFileUrl(
  new URL("../../static/games/2028-ai/game.bundle.js", import.meta.url),
);
const OUT = new URL(
  "../../static/games/evil-invaders-web.zip",
  import.meta.url,
);
export const ICON = new URL(
  "../../static/icons/evil-invaders-icon.png",
  import.meta.url,
);

// Fixed, so zipping the same inputs twice gives the same bytes.
const STAMP = new Date("2026-10-29T00:00:00Z");

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
 * The shop's box art, 256x384 (the 2:3 of 2019's): the starfield, the logo
 * and tag line, a rank of the small Bowser, a flirty girl and the small
 * CoolInvader, and Peach's ship below.
 */
export async function iconArt(): Promise<Raster> {
  const W = 256, H = 384;
  const parts = [
    { art: titleBackdropArt(W, H), x: 0, y: 0 },
    { art: await logoArt(), x: 0, y: 40 },
    { art: await subTitleArt(), x: 0, y: 132 },
  ];

  const { frames } = await buildArt();
  const art = (name: string) => {
    const f = frames.find((x) => x.name === name);
    if (!f) throw new Error(`no frame ${name}`);
    return f.raster;
  };
  const rank = [
    grow(art("eiBowser17_0"), 2),
    grow(art("eiFlirtyGirl150_0"), 2),
    grow(art("eiCoolInvader17_0"), 2),
  ];
  const gap = 12;
  const rankW = rank.reduce((w, r) => w + r.width, 0) + gap * 2;
  const rankH = Math.max(...rank.map((r) => r.height));
  let x = Math.floor((W - rankW) / 2);
  for (const r of rank) {
    parts.push({ art: r, x, y: 196 + Math.floor((rankH - r.height) / 2) });
    x += r.width + gap;
  }
  const ship = grow(art("eiPeach0"), 2);
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
