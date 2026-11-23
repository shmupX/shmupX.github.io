// Daltonius's Computer Precinct (static/daltonius, codemonkey.games/daltonius).
//
// The page draws every frame out of its own art/ folder: Daltonius's poses
// and his death scene as scripts/gs/draw_daltonius.py writes them, and the
// tag, its beam and barrier, and his RAM and laptop bullets cut from gs's
// atlas. A frame named in frames.js but missing from art/ stops the page at
// load ("OUT OF ORDER"), so these check the folder against the list, and the
// Daltonius frames against the script's own copies, so a redraw of him in
// scripts/gs/art can't leave the page showing the old one.

import { assert, assertEquals } from "@std/assert";
import {
  DALTONIUS_FRAMES,
  FRAMES,
  GS_FRAMES,
} from "../static/daltonius/frames.js";

const PAGE = new URL("../static/daltonius/", import.meta.url);
const PAGE_ART = new URL("art/", PAGE);
const GS_ART = new URL("../scripts/gs/art/", import.meta.url);

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(bytes: Uint8Array): { w: number; h: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert(sig.every((b, i) => bytes[i] === b), "not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

Deno.test("the precinct's art folder holds exactly the frames it draws", async () => {
  const onDisk: string[] = [];
  for await (const entry of Deno.readDir(PAGE_ART)) {
    if (entry.isFile) onDisk.push(entry.name);
  }
  assertEquals(
    onDisk.sort(),
    FRAMES.map((name) => `${name}.png`).sort(),
    "static/daltonius/art/ has drifted from frames.js: a frame listed but " +
      "missing stops the page at load, and one on disk but unlisted is dead " +
      "weight on the deploy.",
  );
});

Deno.test("the precinct's Daltonius is the one draw_daltonius.py draws", async () => {
  for (const name of DALTONIUS_FRAMES) {
    const page = await Deno.readFile(new URL(`${name}.png`, PAGE_ART));
    const art = await Deno.readFile(new URL(`${name}.png`, GS_ART));
    assertEquals(
      page,
      art,
      `static/daltonius/art/${name}.png differs from scripts/gs/art/${name}.png` +
        " — copy the script's output across after a redraw",
    );
  }
});

Deno.test("his death frames stand on the same line as his poses", async () => {
  // Every pose and death frame is 128 tall with his feet at the bottom, so
  // the page can swap one for another in place; the death frames are all
  // 128 wide too, for the swelling and the gas cloud.
  for (const name of DALTONIUS_FRAMES) {
    if (name.startsWith("Daltonius_fired")) continue; // the balloon
    const { w, h } = pngSize(
      await Deno.readFile(new URL(`${name}.png`, PAGE_ART)),
    );
    assertEquals(h, 128, `${name} is ${h} tall`);
    if (name.startsWith("Daltonius_die_")) {
      assertEquals(w, 128, `${name} is ${w} wide`);
    }
  }
  const deaths = DALTONIUS_FRAMES.filter((n) => n.includes("_die_"));
  for (const beat of ["bulge", "froth", "toot", "flat"]) {
    assert(
      deaths.some((n) => n.startsWith(`Daltonius_die_${beat}`)),
      `the death scene has no ${beat} frame`,
    );
  }
});

Deno.test("the tag and the bullets keep gs's sizes", async () => {
  // Cut from gs's atlas at its own rects; the page sizes its hit boxes and
  // the beam's rotation around these.
  const sizes: Record<string, [number, number]> = {
    "bby-ship": [32, 50],
    beam0: [22, 6],
    beam1: [22, 6],
    barrier0: [64, 64],
    RAM_0: [32, 18],
    laptop0: [74, 58],
    laptop1: [74, 58],
  };
  assertEquals(Object.keys(sizes).sort(), [...GS_FRAMES].sort());
  for (const [name, [w, h]] of Object.entries(sizes)) {
    const got = pngSize(await Deno.readFile(new URL(`${name}.png`, PAGE_ART)));
    assertEquals([got.w, got.h], [w, h], name);
  }
});

Deno.test("the precinct page loads its own stylesheet and module", async () => {
  const html = await Deno.readTextFile(new URL("index.html", PAGE));
  assert(html.includes(`<link rel="stylesheet" href="precinct.css">`));
  assert(html.includes(`<script type="module" src="precinct.js"></script>`));
  for (const file of ["precinct.css", "precinct.js", "frames.js"]) {
    assert((await Deno.stat(new URL(file, PAGE))).isFile, file);
  }
  const js = await Deno.readTextFile(new URL("precinct.js", PAGE));
  assert(js.includes(`from "./frames.js"`), "precinct.js reads frames.js");
});
