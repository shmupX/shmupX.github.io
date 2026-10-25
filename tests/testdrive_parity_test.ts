// The pure halves of `deno task testdrive:parity` (scripts/lib/parity.ts,
// scripts/lib/parity-emu.ts, scripts/lib/parity-n64dd.ts) and `deno task
// ps2:page` (scripts/lib/ps2-page.ts).
// Nothing here starts a browser, an emulator or ffmpeg.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  clipFrames,
  clipStart,
  concatList,
  decodeInputs,
  encodeInputs,
  gifLadder,
  gridArgs,
  gridCells,
  kindOf,
  parseTargets,
  projectileKinds,
} from "../scripts/lib/parity.ts";
import {
  keptFrames,
  locateExpr,
  runClockAt,
} from "../scripts/lib/parity-emu.ts";
import { listRow, rdramNeedle } from "../scripts/lib/parity-n64dd.ts";
import { KIDS, PSX_RAM } from "../scripts/lib/parity-psx.ts";
import {
  parityCaption,
  ps2PageHtml,
  ps2Readme,
} from "../scripts/lib/ps2-page.ts";

/** gs's Daltonius as the record has it (the parts the kinds read). */
const DALTONIUS = {
  name: "Daltonius",
  bulletDataA: { texture: ["RAM_0"] },
  bulletDataB: { texture: ["laptop0", "laptop1"] },
  stage2: {
    hpBelow: 0.5,
    bulletDataA: { texture: ["deza1_52_0.gif", "deza1_52_1.gif"] },
    bulletDataB: { texture: ["deza1_52_0.gif", "deza1_52_1.gif"] },
  },
};

Deno.test("a boss's projectile kinds are its distinct texture sets, the second stage's apart", () => {
  const kinds = projectileKinds(DALTONIUS);
  assertEquals(kinds, {
    A: ["RAM_0"],
    B: ["laptop0", "laptop1"],
    "stage2:A": ["deza1_52_0.gif", "deza1_52_1.gif"],
  });
  assertEquals(kindOf(kinds, "laptop1"), "B");
  // The editor's one-dot leader reads as the dot it stands for.
  assertEquals(kindOf(kinds, "deza1_52_0\u2024gif"), "stage2:A");
  assertEquals(kindOf(kinds, "normalProjectile0.gif"), null);
});

Deno.test("targets parse in grid order and refuse unknown names", () => {
  assertEquals(parseTargets("sfc,web"), ["web", "sfc"]);
  assertEquals(parseTargets(undefined).length, 7);
  // Nothing captured: --reuse rewrites only the grid and the GIF.
  assertEquals(parseTargets("none"), []);
  assertThrows(() => parseTargets("web,gba"), Error, "gba");
});

Deno.test("a clip opens early enough for the last pre-morph volley of each kind", () => {
  const pre = { A: { wall: 1000 }, B: { wall: 5000 } };
  assertEquals(clipStart(4000, pre, ["A", "B"]), { at: 600, pulledBy: ["A"] });
  // A kind seen after the window opened pulls nothing.
  assertEquals(clipStart(800, pre, ["A", "B"]), { at: 600, pulledBy: ["A"] });
  assertEquals(clipStart(400, pre, ["A", "B"]).pulledBy, []);
});

Deno.test("clip frames are resampled onto a steady clock from the frame then showing", () => {
  const frames = [
    { file: "a", t: 0 },
    { file: "b", t: 100 },
    { file: "c", t: 250 },
  ];
  // 10 fps over 300 ms: ticks at 0, 100, 200 → a, b, b.
  assertEquals(clipFrames(frames, 0, 300, 10), ["a", "b", "b"]);
  assertEquals(clipFrames(frames, 300, 300, 10), []);
  assert(concatList(["x\\y.png"], 10).includes("file 'x/y.png'"));
});

Deno.test("an input log keeps only the steps the mask changes on, and round-trips", () => {
  const masks = [0, 0, 4, 4, 4, 8, 0];
  const log = encodeInputs(masks);
  assertEquals(log, [[0, 0], [2, 4], [5, 8], [6, 0]]);
  assertEquals(decodeInputs(log, masks.length), masks);
});

Deno.test("the grid is four across with the rest centred under them", () => {
  const ids = ["web", "ps2", "sfc", "saturn", "kids", "plus", "n64dd"];
  const { cells, width, height } = gridCells(ids, 300, 320);
  assertEquals([width, height], [1200, 640]);
  assertEquals(cells[3], { id: "saturn", x: 900, y: 0 });
  // Three under four: half a cell in.
  assertEquals(cells[4], { id: "kids", x: 150, y: 320 });
  assertEquals(cells[6].x, 750);
});

Deno.test("the grid's ffmpeg line pads every clip to the longest and draws blocked panes black", () => {
  const args = gridArgs([
    { id: "web", clip: "web.mp4", caption: "WEB", seconds: 8 },
    { id: "ps2", clip: null, caption: "PS2 - PENDING", seconds: 0 },
  ], {
    cellW: 300,
    cellH: 320,
    captionH: 22,
    fps: 30,
    font: "C:\\Windows\\Fonts\\consola.ttf",
    out: "grid.mp4",
  });
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert(filter.includes("tpad=stop_mode=clone:stop_duration=1.00"), filter);
  assert(filter.includes("xstack=inputs=2:layout=0_0|300_0"), filter);
  assert(filter.includes("fontfile='C\\:/Windows/Fonts/consola.ttf'"), filter);
  assert(args.includes("color=c=black:s=300x320:r=30:d=8.00"));
  // No font: no captions, and still a valid chain.
  const bare = gridArgs([{
    id: "web",
    clip: "w.mp4",
    caption: "WEB",
    seconds: 1,
  }], {
    cellW: 300,
    cellH: 320,
    captionH: 22,
    fps: 30,
    font: null,
    out: "g.mp4",
  });
  assert(!bare.join(" ").includes("drawtext"));
});

Deno.test("the GIF budget ladder lowers the rate, then the scale", () => {
  const ladder = gifLadder(15);
  assertEquals(ladder[0], { fps: 15, scale: 1 });
  assertEquals(ladder[5], { fps: 15, scale: 0.75 });
  assertEquals(ladder.at(-1), { fps: 6, scale: 0.5 });
});

Deno.test("a rewound console run is cut along its kept spans", () => {
  const frames = Array.from(
    { length: 50 },
    (_, i) => ({ file: `f${i}`, t: i * 100 }),
  );
  // Played 0-2000, died, rewound to the checkpoint at 1500 at wall 3000, played on.
  const kept: [number, number][] = [[0, 1500], [3000, 4000]];
  const out = keptFrames(frames, kept, 10);
  assertEquals(out.length, 25);
  assertEquals(out[14], "f14");
  assertEquals(out[15], "f30"); // the cut: the rewind's first frame follows 1.4 s
  assertEquals(runClockAt(kept, 3500), 2000);
  assertEquals(runClockAt(kept, 2000), null); // thrown away
  // A window inside the kept run: skip the first second, keep one.
  assertEquals(keptFrames(frames, kept, 10, 1000, 1000).length, 10);
});

Deno.test("the RAM locator narrows a candidate list by every pair", () => {
  const js = locateExpr([[0x0d, 1], [0x3d6, 5]], true);
  assert(js.includes("[[13,1],[982,5]]"), js);
  assert(js.includes("window.__ram = out"));
});

Deno.test("the PS1 RAM finder keeps only the EXE copy whose base holds the BIOS vector", () => {
  // A heap with KIDS.EXE's bytes twice: in "RAM", whose 0x80 has the vector
  // every BIOS copies there, and in a stray buffer, which does not.
  const heap = new Uint8Array(0x300000);
  const ram = 0x10000, stray = 0x250000;
  const needle = new TextEncoder().encode(KIDS.needle);
  heap.set(needle, ram + KIDS.needleAt);
  heap.set(needle, stray);
  const ejs = { Module: { HEAPU8: heap } };
  const win: Record<string, unknown> = {};
  new Function("window", "EJS_emulator", PSX_RAM)(win, ejs);
  const psx = win.__psx as {
    find: (s: string, at: number) => number;
    b: (a: number) => number;
  };
  assert(!(psx.find(KIDS.needle, KIDS.needleAt) > 0));
  heap.set(
    [0, 0, 0x1a, 0x3c, 0x80, 0x0c, 0x5a, 0x27, 8, 0, 0x40, 3],
    ram + 0x80,
  );
  assertEquals(psx.find(KIDS.needle, KIDS.needleAt), ram);
  heap[ram + KIDS.layer] = 3;
  assertEquals(psx.b(KIDS.layer), 3);
});

Deno.test("the 64DD's RDRAM is looked for by the boot code, as host-order words where the IPL puts it", () => {
  const rom = new Uint8Array(0x1040);
  rom.set([0x80, 0x02, 0x5c, 0x00], 8); // the header's entry point, 0x80025C00
  rom.set([0x3c, 0x08, 0x80, 0x0a, 0x25, 0x08, 0x4c, 0x80], 0x1000);
  const { bytes, at } = rdramNeedle(rom);
  assertEquals(at, 0x25c00);
  assertEquals(bytes.length, 64);
  assertEquals(bytes.slice(0, 8), [
    0x0a,
    0x80,
    0x08,
    0x3c,
    0x80,
    0x4c,
    0x08,
    0x25,
  ]);
  // GAME SELECT: DST is row 0, its item 10; the pointer's hot spot per row.
  assertEquals(listRow(0), { x: 105, y: 115, item: 10 });
  assertEquals(listRow(3), { x: 105, y: 177, item: 13 });
});

Deno.test("the PS2 page offers the disc, the folder and the browser build, with the GIF on top", () => {
  const input = {
    title: "SQUAD",
    level: "gs",
    slug: "squad",
    iso: "squad.iso",
    zip: "squad-usb.zip",
    gif: "preview.gif",
    isoBytes: 12 * 1048576,
    zipBytes: 3 * 1048576,
    gifCaption: "SQUAD's boss <everywhere>",
  };
  const html = ps2PageHtml({ ...input, folder: "SQUAD" });
  assert(html.includes('href="./squad.iso" download'));
  assert(html.includes('href="./squad-usb.zip" download'));
  // One split button: the disc up front, the USB folder behind its arrow.
  const split = html.slice(
    html.indexOf('<div class="split">'),
    html.indexOf('href="./play/"'),
  );
  assert(split.indexOf("squad.iso") < split.indexOf('class="split-more"'));
  const menu = split.slice(split.indexOf('<details class="split-more">'));
  assert(menu.includes('aria-label="More downloads"'));
  assert(menu.includes('href="./squad-usb.zip" download'));
  assert(html.includes("<b>SQUAD/athena.elf</b>"));
  assert(html.includes('href="./play/"'));
  assert(html.includes('src="./preview.gif"'));
  assert(html.includes("12.0 MB"));
  assert(html.includes("&lt;everywhere&gt;"), "the caption is escaped");
  assert(html.includes("Hold L1+R1"));
  assert(
    ps2Readme({ ...input, folder: "SQUAD" }).includes("as a folder, `SQUAD/`"),
  );
  const md = ps2Readme(input);
  assert(
    md.startsWith(
      "# SQUAD — PlayStation 2\n\n![SQUAD's boss <everywhere>](preview.gif)",
    ),
  );
  // The commands name the level, not the page's public name.
  assert(md.includes("deno task ps2:page gs "));
  assert(md.includes("deno task testdrive:parity gs "));
  // No GIF yet: no image, and nothing broken.
  assert(!ps2PageHtml({ ...input, gif: null }).includes("<img"));
});

Deno.test("the page's GIF caption names only the targets the parity run captured", () => {
  const pane = (id: string, status = "captured") => ({ id, status });
  const report = {
    stage: 1,
    boss: "Daltonius",
    panes: [
      pane("web"),
      pane("ps2"),
      pane("sfc"),
      pane("saturn"),
      pane("kids", "blocked"),
      pane("plus", "blocked"),
      pane("n64dd", "failed"),
    ],
  };
  assertEquals(
    parityCaption("SQUAD", report),
    "SQUAD's stage-2 boss, Daltonius, on four of the seven targets shmupX exports to, a tool-assisted pilot fighting it: web, PS2, Super Famicom and Saturn",
  );
  const all = report.panes.map((p) => pane(p.id));
  assertEquals(
    parityCaption("SQUAD", { stage: 1, panes: all }),
    "SQUAD's stage-2 boss on every target shmupX exports to, a tool-assisted pilot fighting it: web, PS2, Super Famicom, Saturn, PS1 Kids!, PS1 Dezaemon+ and 64DD",
  );
  assertEquals(
    parityCaption("SQUAD", { panes: [pane("saturn")] }),
    "SQUAD's boss on one of the seven targets shmupX exports to, a tool-assisted pilot fighting it: Saturn",
  );
  assertEquals(
    parityCaption("SQUAD", { panes: [pane("web", "failed")] }),
    null,
  );
});
