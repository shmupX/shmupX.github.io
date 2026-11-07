// Pack RonaGun (hellophaser) into the archive the eShop installs.
//
//   deno task hellophaser:zip           # static/games/hellophaser-web.zip
//   deno task hellophaser:zip --icon    # also redraw static/icons/hellophaser-icon.png
//
// Evil Invaders' shape (scripts/evil-invaders/build-zip.ts): the 2028.Ai game
// page rendered standalone, this checkout's runtime (attachTrail included)
// with its one level line pointed at the foo.json beside it, and the level
// record, which is buildLevel()'s, so the archive cannot drift from the
// conversion. Its music streams from the source's site, as on the cloud.

import { buildZip, type ZipEntry } from "@shmupx/shmup-harbor/zip";
import {
  decodePng,
  encodePng,
  newRaster,
  type Raster,
} from "@shmupx/shmup-harbor/png";
import { fromFileUrl } from "@std/path";
import { injectLauncherMarker } from "../../lib/launcher-inject.ts";
import { standaloneGamePageHtml } from "../../lib/game-page.ts";
import { patchBundle } from "../2019/build-zip.ts";
import { composite, resample } from "../95-demo/art.ts";
import {
  ART_DIR,
  buildArt,
  buildLevel,
  TITLE,
  titleArt,
} from "./build-level.ts";

export { TITLE };

const BUNDLE = fromFileUrl(
  new URL("../../static/games/2028-ai/game.bundle.js", import.meta.url),
);
const OUT = new URL("../../static/games/hellophaser-web.zip", import.meta.url);
export const ICON = new URL(
  "../../static/icons/hellophaser-icon.png",
  import.meta.url,
);

// Fixed, so zipping the same inputs twice gives the same bytes.
const STAMP = new Date("2026-11-07T00:00:00Z");

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

const grow = (r: Raster, k: number) =>
  resample(r, r.width * k, r.height * k, true);

/**
 * The shop's box art, 256x384: the menu's star backdrop, the RonaGun logo,
 * a rank of the lanes' first sprites, and Lincoln below.
 */
export async function iconArt(): Promise<Raster> {
  const W = 256, H = 384;
  const title = await titleArt();
  const bg = resample(title.backdrop, 512, 480, true);
  const black = newRaster(W, H);
  for (let i = 3; i < black.data.length; i += 4) black.data[i] = 255;
  const parts = [
    { art: black, x: 0, y: 0 },
    { art: bg, x: -128, y: -48 },
    { art: title.logo, x: 0, y: 40 },
    { art: title.subTitle, x: 0, y: 118 },
  ];
  const { frames } = await buildArt();
  const art = (name: string) => {
    const f = frames.find((x) => x.name === name);
    if (!f) throw new Error(`no frame ${name}`);
    return f.raster;
  };
  const rank = [
    art("hpUniblinky_0"),
    art("hpBlueAngel_0"),
    art("hpAsteroid_0"),
  ].map((r) => r.width > 48 ? r : grow(r, 2));
  const gap = 10;
  const rankW = rank.reduce((w, r) => w + r.width, 0) + gap * 2;
  const rankH = Math.max(...rank.map((r) => r.height));
  let x = Math.floor((W - rankW) / 2);
  for (const r of rank) {
    parts.push({ art: r, x, y: 158 + Math.floor((rankH - r.height) / 2) });
    x += r.width + gap;
  }
  // Lincoln on his blue thruster
  const glow = resample(
    await decodePng(await Deno.readFile(new URL("blue.png", ART_DIR))),
    40,
    40,
    false,
  );
  const ship = grow(art("hpLincoln_0"), 2);
  const sx = Math.floor((W - ship.width) / 2);
  const sy = H - 24 - ship.height;
  parts.push({
    art: glow,
    x: Math.floor((W - 40) / 2),
    y: sy + ship.height - 24,
  });
  parts.push({ art: ship, x: sx, y: sy });
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
