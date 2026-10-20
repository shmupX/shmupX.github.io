// A custom game's title: which of 2028.Ai's plates it still wears.
//
// A cloud level named on the URL (or baked into an exported app) wears the
// stock logo, subtitle and G only where it brought no art of its own. The
// loader reads what it brought off the record (customTitleArt) and puts that,
// with the game's name, on recipe.customTitle; TitleScene in game.bundle.js
// draws the name in Orbitron for a missing logo, the genre plate
// (subTitle_custom) for a missing subtitle, the game's own ship for G, and
// rando's gold 2028 (title_bg_custom) for a missing scrolling backdrop.
// Three places must agree: the loader, the bundle's inlined copy of it
// (patched by hand, see ui_frames_in_level_atlas_test.ts) and the game page,
// which self-hosts Orbitron for the canvas text.

import { assert, assertEquals } from "@std/assert";
import {
  createLevelLoaderPlugin,
  customTitleArt,
  recordIsAGame,
  titleNameOf,
} from "../static/phaser-plugins/level-loader.js";

const read = (p: string) =>
  Deno.readTextFile(new URL(`../${p}`, import.meta.url));

type Rect = { x: number; y: number; w: number; h: number };
type FrameMap = Record<string, { frame: Rect }>;

const NONE = {
  logo: false,
  subTitle: false,
  titleG: false,
  titleBg: false,
  staffroll: false,
};

function uiSet(frame: string) {
  return {
    uiAtlases: {
      game_ui: {
        imageDataURL: "data:image/png;base64,AAAA",
        frames: { [frame]: { frame: { x: 0, y: 0, w: 8, h: 8 } } } as FrameMap,
      },
    },
  };
}

Deno.test("a bare record brought no title art", () => {
  assertEquals(customTitleArt({ enemylist: [["00"]] }), NONE);
  assertEquals(customTitleArt(null), NONE);
  assertEquals(customTitleArt("gs"), NONE);
});

Deno.test("a title plate uploaded as a data URL counts", () => {
  assertEquals(customTitleArt({ logoDataURL: "data:," }).logo, true);
  assertEquals(customTitleArt({ subTitleDataURL: "data:," }).subTitle, true);
  assertEquals(customTitleArt({ titleBgDataURL: "data:," }), {
    ...NONE,
    titleBg: true,
  });
});

Deno.test("a plate in the record's game_ui set counts, in either spelling", () => {
  // Firebase-encoded dot, as the editor's save writes frame names.
  assertEquals(customTitleArt(uiSet("logo․gif")).logo, true);
  assertEquals(customTitleArt(uiSet("subTitleEn.gif")).subTitle, true);
  assertEquals(customTitleArt(uiSet("subTitle.png")).subTitle, true);
  // A staff roll plate of its own, which the STAFF ROLL shows (ownStaffrollPlate).
  assertEquals(customTitleArt(uiSet("staffrollName․gif")), {
    ...NONE,
    staffroll: true,
  });
  assertEquals(customTitleArt(uiSet("titleG․gif")), { ...NONE, titleG: true });
  // Another atlas's frame of that name is not the title's.
  const other = {
    uiAtlases: { title_ui: uiSet("logo.gif").uiAtlases.game_ui },
  };
  assertEquals(customTitleArt(other), NONE);
});

Deno.test("a titleG an older save left in its level atlas counts once there is art to lift", () => {
  const frames = { "titleG․gif": { frame: { x: 0, y: 0, w: 8, h: 8 } } };
  assertEquals(
    customTitleArt({ atlasImageDataURL: "data:,", atlasFrames: frames }).titleG,
    true,
  );
  assertEquals(customTitleArt({ atlasFrames: frames }).titleG, false);
});

Deno.test("a title plate of its own makes a record a game", () => {
  assertEquals(recordIsAGame({ enemylist: [["00"]] }), false);
  assertEquals(
    recordIsAGame({ enemylist: [["00"]], ...uiSet("titleG․gif") }),
    true,
  );
  assertEquals(
    recordIsAGame({ enemylist: [["00"]], ...uiSet("subTitleEn․gif") }),
    true,
  );
});

Deno.test("the title calls a game by its record's title, else its name, else its key", () => {
  assertEquals(titleNameOf({ name: " gs " }, "GS"), "gs");
  assertEquals(titleNameOf({ name: "" }, "gs"), "gs");
  assertEquals(titleNameOf({}, "gs"), "gs");
  assertEquals(titleNameOf(null, null), null);
  // `name` stays the key the editor saves under; `title` is the one on screen.
  assertEquals(titleNameOf({ name: "gs", title: " SQUAD " }, "gs"), "SQUAD");
  assertEquals(titleNameOf({ name: "gs", title: "  " }, "gs"), "gs");
  assertEquals(titleNameOf({ title: 7 }, "gs"), "gs");
});

// ---- the loader puts it on the recipe ---------------------------------------

class FakeTexture {
  frames: Record<
    string,
    { cutX: number; cutY: number; cutWidth: number; cutHeight: number }
  > = {};
  source: { image: { width: number; height: number } }[];
  constructor(image: { width: number; height: number }, frames: FrameMap) {
    this.source = [{ image }];
    for (const [k, v] of Object.entries(frames)) {
      this.frames[k] = {
        cutX: v.frame.x,
        cutY: v.frame.y,
        cutWidth: v.frame.w,
        cutHeight: v.frame.h,
      };
    }
  }
  has(name: string) {
    return name in this.frames;
  }
}

class FakeTextures {
  map = new Map<string, FakeTexture>();
  exists(k: string) {
    return this.map.has(k);
  }
  get(k: string) {
    return this.map.get(k)!;
  }
  remove(k: string) {
    this.map.delete(k);
  }
  addImage() {}
  addAtlas(
    k: string,
    image: { width: number; height: number },
    data: { frames: FrameMap },
  ) {
    this.map.set(k, new FakeTexture(image, data.frames));
  }
}

// A data URL decodes as a 64x32 image; canvases are sized but draw nothing.
function withFakeDom(search: string | null, fn: () => Promise<void>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { Image: g.Image, document: g.document, location: g.location };
  g.Image = class {
    width = 64;
    height = 32;
    onload: ((this: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload && this.onload());
    }
  };
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
    }),
  };
  if (search === null) delete g.location;
  else g.location = { search };
  return fn().finally(() => {
    g.Image = saved.Image;
    g.document = saved.document;
    if (saved.location === undefined) delete g.location;
    else g.location = saved.location;
  });
}

const Plugin = createLevelLoaderPlugin({
  Plugins: {
    ScenePlugin: class {
      scene: unknown;
      constructor(scene: unknown) {
        this.scene = scene;
      }
    },
  },
});

function stockScene() {
  const textures = new FakeTextures();
  textures.addAtlas("game_asset", { width: 256, height: 256 }, {
    frames: { "duke_0": { frame: { x: 0, y: 0, w: 32, h: 32 } } },
  });
  textures.addAtlas("game_ui", { width: 512, height: 100 }, {
    frames: {
      "titleG.gif": { frame: { x: 0, y: 0, w: 200, h: 40 } },
      "logo.gif": { frame: { x: 0, y: 40, w: 256, h: 60 } },
    },
  });
  return { textures };
}

const BASE = {
  stage0: { enemylist: [["00"]] },
  playerData: { texture: ["duke_0"] },
  enemyData: {},
  bossData: {},
};

const GS = {
  name: "gs",
  enemylist: [["A0"]],
  enemyData: { enemyA: { hp: 1, texture: ["cyber-octopus0"] } },
  ...uiSet("titleG․gif"),
};

// deno-lint-ignore no-explicit-any
type Loaded = { recipe: any; showTitle: boolean };

Deno.test("a level named on the URL carries its name and title art on the recipe", () =>
  withFakeDom("?level=gs", async () => {
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () => Promise.resolve(GS);
    const out = await plugin.loadLevel({
      baseRecipe: BASE,
      audio: { enabled: false },
    }) as Loaded;
    assertEquals(out.recipe.customTitle, {
      name: "gs",
      logo: false,
      subTitle: false,
      titleG: true,
      titleBg: false,
      staffroll: false,
    });
    // ...and, with a title plate of its own, opens on its title.
    assertEquals(out.showTitle, true);
  }));

Deno.test("an exported app's baked record is a custom game too", () =>
  withFakeDom(null, async () => {
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    const baked = { ...GS, name: undefined };
    const out = await plugin.loadLevel({
      baseRecipe: BASE,
      offlineLevel: baked,
      audio: { enabled: false },
    }) as Loaded;
    // No name of its own: the key it was fetched by (the default level's).
    assertEquals(out.recipe.customTitle, {
      name: "foo",
      logo: false,
      subTitle: false,
      titleG: true,
      titleBg: false,
      staffroll: false,
    });
  }));

Deno.test("the default visit is 2028.Ai itself and carries no customTitle", () =>
  withFakeDom(null, async () => {
    const scene = stockScene();
    const plugin = new Plugin(scene, null, "levelLoader");
    plugin.fetchLevel = () =>
      Promise.resolve({ name: "foo", enemylist: [["00"]], enemyData: {} });
    const out = await plugin.loadLevel({
      baseRecipe: BASE,
      audio: { enabled: false },
    }) as Loaded;
    assertEquals(out.recipe.customTitle, undefined);
    assertEquals(out.showTitle, true);
  }));

Deno.test("the editor's PLAY of a saved game names it; an unsaved one wears the stock plates", () =>
  withFakeDom("?editorPlay=1", async () => {
    // The draft the editor leaves in localStorage, handed over as the plugin
    // reads it (Deno's own localStorage needs --location to exist).
    const play = (recipe: unknown) => {
      const plugin = new Plugin(stockScene(), null, "levelLoader");
      plugin.readEditorPlayRequest = () => ({ recipe, stageId: 0 });
      plugin.mergeEditorAtlas = () => Promise.resolve(false);
      return plugin.loadLevel({
        baseRecipe: BASE,
        audio: { enabled: false },
      }) as Promise<Loaded>;
    };
    const saved = await play({
      ...BASE,
      meta: { version: "1.0", editorLevelName: "gs" },
      logoDataURL: "data:,",
      titleBgDataURL: "data:,",
    });
    assertEquals(saved.recipe.customTitle, {
      name: "gs",
      logo: true,
      subTitle: false,
      titleG: false,
      titleBg: true,
      staffroll: false,
    });
    // PLAY itself opens in the stage; the title it names is the one the
    // ending returns to.
    assertEquals(saved.showTitle, false);

    const unsaved = await play({ ...BASE, meta: { version: "1.0" } });
    assertEquals(unsaved.recipe.customTitle, undefined);
  }));

// ---- three copies, one rule --------------------------------------------------

// A function as written, whitespace aside, from its signature to the next one.
function slice(js: string, from: string, to: string) {
  const start = js.indexOf(from);
  const end = js.indexOf(to, start);
  assert(start > 0 && end > start, `no ${from}`);
  // The plugin exports what the bundle's copy only declares.
  return js.slice(start, end).replace(/\bexport /g, "").replace(/\s+/g, " ")
    .trim();
}

Deno.test("the bundle's inlined loader reads a record's title art the way the plugin does", async () => {
  const plugin = await read("static/phaser-plugins/level-loader.js");
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const helpers = (js: string) =>
    slice(
      js,
      "function customTitleArt(data) {",
      "// Does a level record carry a whole game's framing",
    );
  assertEquals(helpers(bundle), helpers(plugin));
  const isAGame = (js: string) =>
    slice(js, "function recordIsAGame(data) {", "function openCustomAudioDB(");
  assertEquals(isAGame(bundle), isAGame(plugin));
  for (
    const line of [
      "recipe.customTitle = Object.assign({ name: titleNameOf(data, levelKey) }, customTitleArt(data));",
      "recipe.customTitle = Object.assign({ name: String(editorName) }, customTitleArt(recipe));",
    ]
  ) {
    assert(plugin.includes(line), "the plugin lacks: " + line);
    assert(bundle.includes(line), "the bundle lacks: " + line);
  }
});

Deno.test("the title scene draws the plates a custom game did not bring", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  for (
    const needle of [
      "function nameLogoTexture(scene, name) {",
      "function shipTitleGTexture(scene) {",
      'this.load.image("subTitle_custom", "assets/img/subTitleCustom.png");',
      "} else if (nameLogo) {",
      "} else if (plateSub) {",
      'this.load.image("title_bg_custom", "assets/img/titleBgCustom.jpg");',
      'var plateBg = !!custom && !custom.titleBg && this.textures.exists("title_bg_custom");',
      'plateBg ? "title_bg_custom" : "title_bg"',
      'this.titleG = ownG ? this.add.sprite(0, 0, ownG) : this.add.sprite(0, 0, "game_ui", "titleG.gif");',
    ]
  ) {
    assert(bundle.includes(needle), "the bundle lacks: " + needle);
  }
  // A cart's own title and the import's ship logo are settled first.
  assert(
    /var custom = !this\.dezaTitle && !shipFrames && recipe && recipe\.customTitle/
      .test(bundle),
    "a custom game's plates must defer to a cart's title",
  );
  // The genre plate and the backdrop ship with the game's assets, and an
  // app the forge stages carries both.
  for (const file of ["subTitleCustom.png", "titleBgCustom.jpg"]) {
    const plate = await Deno.stat(
      new URL(`../static/games/2028-ai/assets/img/${file}`, import.meta.url),
    );
    assert(plate.isFile, file);
    const keep = slice(bundle, "var KEEP_FILES = [", "];");
    assert(keep.includes(`"assets/img/${file}"`), `the forge drops ${file}`);
  }
});

Deno.test("the custom backdrop is rando's gold 2028, as wide as it tiles and as tall as the screen", async () => {
  const jpg = await Deno.readFile(
    new URL(
      "../static/games/2028-ai/assets/img/titleBgCustom.jpg",
      import.meta.url,
    ),
  );
  // The first baseline frame header (SOF0) holds height then width.
  let at = 2;
  while (at < jpg.length && jpg[at + 1] !== 0xc0) {
    at += 2 + ((jpg[at + 2] << 8) | jpg[at + 3]);
  }
  const height = (jpg[at + 5] << 8) | jpg[at + 6];
  const width = (jpg[at + 7] << 8) | jpg[at + 8];
  // 845 is where the lattice of 2028s, 121.22 px between rows tilted 25.5
  // degrees, comes round again three rows across
  // (scripts/2028-ai/draw_2028_backdrop.py), so the sideways scroll wraps
  // without a seam; rando's own 768 was not a period of it and showed one.
  // 480 is GAME_DIMENSIONS.HEIGHT, every row a 1:1 tileSprite shows.
  assertEquals([width, height], [845, 480]);
});

Deno.test("the game page self-hosts Orbitron and starts its load for the canvas", async () => {
  const page = await read("lib/game-page.ts");
  assert(
    page.includes("font-family: 'Orbitron'"),
    "no Orbitron @font-face on the game page",
  );
  assert(
    page.includes("url('/fonts/orbitron-latin.woff2')"),
    "Orbitron is not the self-hosted file",
  );
  assert(
    page.includes('document.fonts.load("900 40px Orbitron")'),
    "FONT_PRELOAD does not start Orbitron",
  );
});

Deno.test("both staff rolls show a game's own staffrollName plate in place of shmupX's", async () => {
  const bundle = await read("static/games/2028-ai/game.bundle.js");
  const rule = slice(
    bundle,
    "function ownStaffrollPlate() {",
    "var StaffRollPanel",
  );
  assert(
    rule.includes(
      "return !!(recipe && recipe.customTitle && recipe.customTitle.staffroll);",
    ),
    "ownStaffrollPlate no longer reads customTitle.staffroll",
  );
  const panel = slice(
    bundle,
    "var StaffRollPanel",
    "_addDezaCredits(credits, entries) {",
  );
  assert(
    panel.includes(
      '} else if (ownStaffrollPlate()) { this.namePanel = scene.add.sprite(15, 90, "game_ui", "staffrollName.gif");',
    ),
    "the title's STAFF ROLL does not draw the game's plate",
  );
  const ending = slice(bundle, "showStaffRoll() {", "playSound(key, volume) {");
  assert(
    ending.includes(
      'if (ownStaffrollPlate()) { var namePlate = this.add.sprite(15, 90, "game_ui", "staffrollName.gif");',
    ),
    "the ending's staff roll does not draw the game's plate",
  );
});
