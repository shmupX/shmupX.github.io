// The offline half of `deno task testdrive:ps2:compare`: the two URLs it
// plays, the page it seats them in, and the resampling that makes a GIF with
// a steady clock out of a screencast with an uneven one. The browser half
// cannot run here; this pins what it is handed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compareUrls,
  concatList,
  gifArgs,
  harnessHtml,
  harnessSize,
  resample,
} from "../scripts/lib/testdrive-compare.ts";

Deno.test("the two panes differ in version and nothing else", () => {
  const u = compareUrls("http://127.0.0.1:5199", "2019-PS2");
  const og = new URL(u.og), mod = new URL(u.mod);
  assertEquals(og.pathname, "/games/2028-ai");
  assertEquals(mod.pathname, "/games/2028-ai");
  assertEquals(og.searchParams.get("version"), "og");
  assertEquals(mod.searchParams.get("version"), "mod");
  for (const k of ["level", "stage", "god"]) {
    assertEquals(og.searchParams.get(k), mod.searchParams.get(k), k);
  }
  assertEquals(og.searchParams.get("level"), "2019-PS2");
  // Straight into the stage, and invincible: the capture is of play.
  assertEquals(og.searchParams.get("stage"), "0");
  assertEquals(og.searchParams.get("god"), "1");
});

Deno.test("god mode and the stage can be turned", () => {
  const u = compareUrls("http://x", "L", { god: false, stage: 2 });
  assertEquals(new URL(u.mod).searchParams.get("god"), null);
  assertEquals(new URL(u.mod).searchParams.get("stage"), "2");
});

Deno.test("the harness seats both panes at game size under their labels", () => {
  const urls = compareUrls("http://x", "A & B");
  const html = harnessHtml(urls, "A & B");
  assertStringIncludes(html, `id="og"`);
  assertStringIncludes(html, `id="mod"`);
  assertStringIncludes(html, `width="256" height="480"`);
  assertStringIncludes(html, "<figcaption>OG</figcaption>");
  assertStringIncludes(html, "<figcaption>MOD</figcaption>");
  // The level name and the URLs are escaped, not interpolated raw.
  assertStringIncludes(html, "A &amp; B");
  assert(!html.includes("A & B —"), "the title carries the name unescaped");
  const size = harnessSize();
  assertEquals(size.width, 256 * 2 + 8 * 3);
  assertEquals(size.height, 480 + 22 + 8 * 2);
});

Deno.test("resampling keeps the capture's clock", () => {
  // Frames at 0, 100, 250, 900 ms; 10 fps over one second.
  const frames = [
    { file: "d", t: 900 },
    { file: "a", t: 0 },
    { file: "b", t: 100 },
    { file: "c", t: 250 },
  ];
  const picked = resample(frames, 10, 1);
  assertEquals(picked.length, 10);
  // 0→a, 100→b, 200→b, 300..800→c, 900→d: a gap repeats, never skips ahead.
  assertEquals(picked, ["a", "b", "b", "c", "c", "c", "c", "c", "c", "d"]);
  // A start before the first frame shows the first frame until it lands.
  assertEquals(resample(frames, 10, 0.3, -200), ["a", "a", "a"]);
  assertEquals(resample([], 10, 1), []);
});

Deno.test("the concat list times every frame and holds the last", () => {
  const list = concatList(["/f/0.png", "/f/it's.png"], 4);
  const lines = list.trimEnd().split("\n");
  assertEquals(lines[0], "file '/f/0.png'");
  assertEquals(lines[1], "duration 0.25");
  assertEquals(lines[2], "file '/f/it'\\''s.png'");
  // The last picture is named once more so its duration is honoured.
  assertEquals(lines.at(-1), "file '/f/it'\\''s.png'");
  const args = gifArgs("/f/list.txt", 12, "/f/out.gif");
  assertEquals(args.at(-1), "/f/out.gif");
  assertStringIncludes(args.join(" "), "palettegen");
  assertStringIncludes(args.join(" "), "fps=12");
});
