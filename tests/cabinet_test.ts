// The cabinet: the page around a game — a backdrop behind it, a frame around
// the screen, the HOW TO PLAY card the title's button opens and the loading
// screen — as the editor's CABINET saves it with a level (`cabinet`) and the
// runtime puts it up. The 2019 game's page had all four (img/bg.jpg and
// img/frame.jpg around its canvas, howto_en.jpg in its modal, loading0..2.gif
// over loading_bg.png), and the cloud game 2019 carries them now; the
// originals are static/games/2019/cabinet/.
//
// Three files must agree: the editor (its save and load), the level loader,
// and game.bundle.js — its inlined copy of the loader, plus the BootScene that
// shows the spinner and the TitleScene that offers the button (README: a
// vendored artifact, patched by hand). This pins each half, and the helpers
// both copies share.

import { assert, assertEquals } from "@std/assert";
import {
  cabinetScreenRect,
  normalizeCabinet,
  normalizeLoadingArt,
} from "../static/phaser-plugins/level-loader.js";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

const PNG = "data:image/png;base64,AAAA";
const JPG = "data:image/jpeg;base64,/9j/";

Deno.test("normalizeCabinet keeps the four parts and nothing else", () => {
  assertEquals(normalizeCabinet(null), null);
  assertEquals(normalizeCabinet({}), null);
  assertEquals(normalizeCabinet({ backdrop: "javascript:alert(1)" }), null);
  // A screen rect with no picture is nothing.
  assertEquals(
    normalizeCabinet({ frame: { screen: { x: 1, y: 2, w: 3, h: 4 } } }),
    null,
  );
  assertEquals(
    normalizeCabinet({
      backdrop: JPG,
      frame: { image: PNG, screen: { x: "10", y: 0, w: "100", h: 200 }, z: 1 },
      howto: JPG,
      loading: { frames: [PNG, 7, JPG], bg: PNG },
      other: true,
    }) as unknown,
    {
      backdrop: JPG,
      frame: { image: PNG, screen: { x: 10, y: 0, w: 100, h: 200 } },
      howto: JPG,
      loading: { frames: [PNG, JPG], bg: PNG },
    },
  );
  // A rect that is not one is dropped, not the frame it came with.
  assertEquals(
    normalizeCabinet({
      frame: { image: PNG, screen: { x: 0, y: 0, w: 0, h: 5 } },
    }) as unknown,
    { frame: { image: PNG } },
  );
});

Deno.test("normalizeLoadingArt takes the database's object-of-indices for the frames", () => {
  assertEquals(normalizeLoadingArt({ frames: { "1": JPG, "0": PNG } }), {
    frames: [PNG, JPG],
  });
  assertEquals(normalizeLoadingArt({ bg: PNG }), { frames: [], bg: PNG });
  assertEquals(normalizeLoadingArt({ frames: [] }), null);
  assertEquals(normalizeLoadingArt("x"), null);
});

Deno.test("cabinetScreenRect: the 2019 layout unless the frame says where the game draws", () => {
  // img/frame.jpg is 766 x 1024. The game is 256 x 480, so at 1024 tall it
  // is 546.13 wide, and it sits in the middle of the picture.
  const r = cabinetScreenRect({ image: PNG }, 766, 1024);
  assertEquals(r.y, 0);
  assertEquals(r.h, 1024);
  assertEquals(Math.round(r.w * 100) / 100, 546.13);
  assertEquals(Math.round(r.x + r.w / 2), 383);
  assertEquals(
    cabinetScreenRect(
      { image: PNG, screen: { x: 5, y: 6, w: 70, h: 80 } },
      766,
      1024,
    ),
    { x: 5, y: 6, w: 70, h: 80 },
  );
  assertEquals(
    cabinetScreenRect({ image: PNG, screen: { w: 0, h: 80 } }, 100, 200).h,
    200,
  );
});

Deno.test("the editor carries the cabinet through the cloud save and load", async () => {
  const editor = await read("static/editor/index.html");
  assert(
    editor.includes("normalizeCabinet,") &&
      editor.includes("cabinetScreenRect,"),
    "the editor does not import the loader's cabinet helpers",
  );
  assert(
    editor.includes("payload.cabinet = normalizeCabinet(getCabinet());"),
    "the cloud save drops the cabinet",
  );
  assert(
    editor.includes("setCabinet(d.cabinet);"),
    "a cloud load keeps the previous level's cabinet",
  );
  assert(
    editor.includes('onclick="closeMenu();openCabinetManager()"'),
    "no CABINET row under ADVANCED EDITORS",
  );
  for (const part of ["backdrop", "frame", "howto", "loading"]) {
    assert(
      editor.includes(`part: '${part}'`),
      `the CABINET has no ${part} slot`,
    );
  }
});

Deno.test("the level loader — the plugin and the bundle's inlined copy — puts the cabinet up on both roads in", async () => {
  for (
    const path of [
      "static/phaser-plugins/level-loader.js",
      "static/games/2028-ai/game.bundle.js",
    ]
  ) {
    const js = await read(path);
    assert(
      js.includes("applyCabinet(levelData) {"),
      path + ": no applyCabinet",
    );
    assert(js.includes("loadingArt(options) {"), path + ": no loadingArt");
    assert(
      js.includes(
        "return this.applyCabinet(recipe).then(() => this.applyUiAtlases(recipe)",
      ),
      path + ": the editor hand-off skips the cabinet",
    );
    assert(
      js.includes(
        "return this.applyCabinet(data).then(() => this.applyUiAtlases(data)",
      ),
      path + ": the cloud road skips the cabinet",
    );
    assert(
      js.includes("delete recipe.cabinet;"),
      path + ": the PLAY recipe keeps the pictures",
    );
    assert(
      js.includes("globalThis.howtoModalOpen = open;"),
      path + ": the HOW TO PLAY card does not define howtoModalOpen",
    );
    assert(
      js.includes('"/cabinet/loading").once("value")'),
      path + ": loadingArt does not read the level's own node",
    );
  }
});

Deno.test("the bundle's BootScene shows the level's spinner and its TitleScene offers the button only with a card", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  assert(
    bundle.includes('this.levelLoader.loadingArt({ defaultLevel: "foo" })'),
    "BootScene does not read the loading screen ahead of the level",
  );
  assert(
    bundle.includes("applyLoadingArt(art) {"),
    "BootScene cannot take the level's loading screen",
  );
  assert(
    bundle.includes(
      "self.loadingFrameIndex = (self.loadingFrameIndex + 1) % self.loadingKeys.length;",
    ),
    "the spinner still counts three stock frames",
  );
  assert(
    bundle.includes(
      "self.loadingG.setTexture(self.loadingKeys[self.loadingFrameIndex]);",
    ),
    "the spinner still reads the stock keys",
  );
  assert(
    bundle.includes('typeof window.howtoModalOpen !== "function") {'),
    "the title shows HOW TO PLAY with no card to open",
  );
});

Deno.test("the 2019 game's own cabinet art is kept beside its level", async () => {
  for (
    const file of [
      "frame.jpg",
      "bg.jpg",
      "howto_en.jpg",
      "loading0.gif",
      "loading1.gif",
      "loading2.gif",
    ]
  ) {
    const stat = await Deno.stat(
      new URL(`../static/games/2019/cabinet/${file}`, import.meta.url),
    );
    assert(stat.size > 0, file + " is empty");
  }
});
