// The offline half of `deno task testdrive:ps2:textures`: the VRAM threshold
// a sheet budget is judged by, which budgets get put side by side, how a
// browser sheet is reduced to the disc's texel density, and how a paused
// request is matched to its pane. The browser half cannot run here.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  budgetOf,
  cloudLevelUrl,
  degrade,
  FRAMEBUFFER_BYTES,
  GS_VRAM_BYTES,
  mixSharpest,
  offlineInjector,
  paneLabel,
  paneOfRequest,
  paneUrl,
  pickPair,
  pngSize,
  sheetScales,
} from "../scripts/lib/testdrive-textures.ts";
import { newRaster } from "../packages/shmup-harbor/lib/ps2/png.ts";

Deno.test("the threshold is the GS's 4 MB less a double-buffered 640x448 frame", () => {
  assertEquals(GS_VRAM_BYTES, 4194304);
  assertEquals(FRAMEBUFFER_BYTES, 640 * 448 * 4 * 2);
  // Three 512 sheets as 8-bit texels fit; three 1024 sheets do not.
  const small = budgetOf(512, [
    { name: "game_asset", w: 512, h: 512 },
    { name: "game_ui", w: 512, h: 512 },
    { name: "level_atlas", w: 512, h: 512 },
  ], {});
  assert(small.fits);
  assertEquals(small.vramBytes, 3 * 512 * 512 + FRAMEBUFFER_BYTES);
  const big = budgetOf(1024, [
    { name: "game_asset", w: 1024, h: 1024 },
    { name: "game_ui", w: 1024, h: 1024 },
    { name: "level_atlas", w: 1024, h: 1024 },
  ], {});
  assert(!big.fits);
  // Two 1024 sheets and a small one do: the sum is what counts, not the cap.
  const mixed = budgetOf(1024, [
    { name: "game_asset", w: 1024, h: 1024 },
    { name: "game_ui", w: 1024, h: 512 },
    { name: "level_atlas", w: 64, h: 64 },
  ], {});
  assert(mixed.fits);
});

Deno.test("the scales are read off the export's own build notes", () => {
  // The wording assets.ts writes (repackBaseAtlas and the level_atlas note).
  const notes = [
    "custom atlas: 44 frames, 2048x2048",
    "game_asset: 611 frames -> 512x512 at 1/4; game_asset: 17201 colours -> 256, mean error 2.10/255",
    "game_ui: 90 frames -> 512x256 at 1/2; game_ui: 300 colours, exact as 8-bit indexed",
    "level_atlas: 12 frames -> 256x128 at 1/1",
    "player: duke_0, duke_1",
  ];
  assertEquals(sheetScales(notes), {
    game_asset: 4,
    game_ui: 2,
    level_atlas: 1,
  });
});

Deno.test("the pair is the baseline against the sharpest budget that fits", () => {
  const b512 = budgetOf(512, [{ name: "a", w: 512, h: 512 }], { a: 4 });
  const b1024 = budgetOf(1024, [{ name: "a", w: 1024, h: 1024 }], { a: 2 });
  const over = budgetOf(2048, [{ name: "a", w: 2048, h: 2048 }], { a: 1 });
  assertEquals(pickPair([b512, b1024, over]).sharp, b1024);
  // Nothing sharper fits, not even one sheet: the caller is told, not handed
  // two of the same.
  assertEquals(pickPair([b512, over]).sharp, null);
  assertEquals(pickPair([b512, b1024], 1024).sharp, null);
  assertThrows(() => pickPair([b1024], 512));
  // The threshold can be moved: at 8 MB the 2048 disc is the sharpest.
  const eight = 8 * 1048576;
  const wide = [
    budgetOf(512, [{ name: "a", w: 512, h: 512 }], { a: 4 }, eight),
    budgetOf(2048, [{ name: "a", w: 2048, h: 2048 }], { a: 1 }, eight),
  ];
  assertEquals(pickPair(wide, 512, eight).sharp?.label, "2048");
});

Deno.test("when no whole disc fits, the sharpest mix of sheets that does is the right pane", () => {
  // The 2019-PS2 numbers: at 512 everything packs at 1/4 (2.81 MB); at 1024
  // at 1/2, but 4.69 MB is over. game_asset and level_atlas can go up
  // (3.94 MB); game_ui would tip it over and stays.
  const b512 = budgetOf(512, [
    { name: "game_asset", w: 512, h: 512 },
    { name: "game_ui", w: 512, h: 512 },
    { name: "level_atlas", w: 256, h: 512 },
    { name: "cyber_liberty", w: 64, h: 32 },
  ], { game_asset: 4, game_ui: 4, level_atlas: 4 });
  const b1024 = budgetOf(1024, [
    { name: "game_asset", w: 1024, h: 1024 },
    { name: "game_ui", w: 1024, h: 1024 },
    { name: "level_atlas", w: 512, h: 1024 },
    { name: "cyber_liberty", w: 64, h: 32 },
  ], { game_asset: 2, game_ui: 2, level_atlas: 2 });
  assert(!b1024.fits);
  const mix = mixSharpest(b512, b1024)!;
  assert(mix, "no mix was found");
  assertEquals(mix.label, "mixed");
  assertEquals(mix.scales, { game_asset: 2, game_ui: 4, level_atlas: 2 });
  assertEquals(mix.sheets.find((s) => s.name === "game_ui"), {
    name: "game_ui",
    w: 512,
    h: 512,
  });
  assert(mix.fits && mix.vramBytes <= GS_VRAM_BYTES);
  assertEquals(pickPair([b512, b1024]).sharp, mix);
  // The order is the player's: game_asset is tried before the UI, so with
  // room for one sheet only it is the enemies that sharpen.
  const tight = FRAMEBUFFER_BYTES + 512 * 512 * 2 + 256 * 512 + 64 * 32 +
    1024 * 1024 - 512 * 512;
  const one = mixSharpest(
    budgetOf(512, b512.sheets, b512.scales, tight),
    budgetOf(1024, b1024.sheets, b1024.scales, tight),
    tight,
  )!;
  assertEquals(one.scales, { game_asset: 2, game_ui: 4, level_atlas: 4 });
  // A sheet the sharper build did not actually sharpen is not an upgrade.
  const flat = budgetOf(1024, b1024.sheets, {
    game_asset: 4,
    game_ui: 4,
    level_atlas: 4,
  });
  assertEquals(mixSharpest(b512, flat), null);
});

Deno.test("degrade keeps the sheet's size and takes its detail down by the scale", () => {
  // A 4x4 sheet, each texel a different grey; at scale 2 every 2x2 block
  // becomes its mean, drawn back at 4x4.
  const sheet = newRaster(4, 4);
  for (let i = 0; i < 16; i++) {
    sheet.data.set([i * 16, i * 16, i * 16, 255], i * 4);
  }
  const out = degrade(sheet, 2);
  assertEquals([out.width, out.height], [4, 4]);
  // Top-left block holds texels 0, 1, 4, 5 → mean 2.5*16 = 40.
  for (const i of [0, 1, 4, 5]) assertEquals(out.data[i * 4], 40);
  // Bottom-right block holds 10, 11, 14, 15 → mean 12.5*16 = 200.
  for (const i of [10, 11, 14, 15]) assertEquals(out.data[i * 4], 200);
  // Scale 1 is the sheet itself, and an odd size is padded rather than cut.
  assertEquals(degrade(sheet, 1), sheet);
  const odd = degrade(newRaster(5, 3), 4);
  assertEquals([odd.width, odd.height], [5, 3]);
});

Deno.test("a request is matched to its pane by the budget marker in its document's URL", () => {
  const url = paneUrl("http://127.0.0.1:5199", "/games/2028-ai", {
    level: "2019-PS2",
    version: "og",
    stage: 0,
    god: true,
    pane: "sharp",
  });
  const u = new URL(url);
  assertEquals(u.searchParams.get("tex"), "sharp");
  assertEquals(u.searchParams.get("version"), "og");
  assertEquals(u.searchParams.get("god"), "1");
  // Named so the boot skips the title; the record itself is planted.
  assertEquals(u.searchParams.get("level"), "2019-PS2");
  // The Referer carries it for a subresource; the frame tree for a document.
  assertEquals(paneOfRequest({ Referer: url }, undefined), "sharp");
  assertEquals(paneOfRequest({ referer: url }, undefined), "sharp");
  assertEquals(paneOfRequest({}, url.replace("sharp", "base")), "base");
  assertEquals(paneOfRequest({ Referer: "http://x/other" }, "http://x/"), null);
  assertEquals(paneOfRequest({ Referer: "not a url" }, undefined), null);
});

Deno.test("small helpers", () => {
  // A PNG's IHDR: width then height, big-endian, after the 8-byte signature
  // and the chunk's length and type.
  const png = new Uint8Array(24);
  const dv = new DataView(png.buffer);
  dv.setUint32(16, 2048);
  dv.setUint32(20, 2128);
  assertEquals(pngSize(png), { w: 2048, h: 2128 });
  assertThrows(() => pngSize(new Uint8Array(10)));
  assertEquals(
    cloudLevelUrl("2019-PS2"),
    "https://evil-invaders-default-rtdb.firebaseio.com/levels/2019-PS2.json",
  );
  // The runtime's own sanitising: characters Firebase keys cannot hold.
  assertEquals(
    cloudLevelUrl("a.b/c"),
    "https://evil-invaders-default-rtdb.firebaseio.com/levels/a_b_c.json",
  );
  const b = budgetOf(512, [{ name: "game_asset", w: 512, h: 512 }], {
    game_asset: 4,
    level_atlas: 2,
  });
  assertEquals(paneLabel(b), "game 1/4 lvl 1/2 ui 1/1 · 2.4MB");
});

Deno.test("the injector plants each pane's record where the loader looks first", () => {
  const src = offlineInjector({
    base: '{"name":"L","atlasFrames":{"a․png":1}}',
    sharp: '{"name":"L"}',
  });
  // Evaluated against a fake document: the sharp pane gets the sharp record,
  // marked; an unmarked document gets nothing.
  const run = (search: string) => {
    const g: Record<string, unknown> = {};
    new Function("location", "globalThis", src)({ search }, g);
    return g.__OFFLINE_LEVEL__ as Record<string, unknown> | undefined;
  };
  assertEquals(run("?tex=sharp"), { name: "L", __tex: "sharp" });
  assertEquals(run("?tex=base")?.__tex, "base");
  assertEquals(run("?tex=base")?.atlasFrames, { "a․png": 1 });
  assertEquals(run(""), undefined);
  assertEquals(run("?tex=other"), undefined);
});
