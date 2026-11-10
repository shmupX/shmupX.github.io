// The Dezaemon field mode (?field=saturn), pinned against the vendored
// game.bundle.js the way tests/deza_channel_triggers_test.ts pins the
// trigger lines.
//
// A Dezaemon 2 cart is authored for the Saturn's 320x224 screen and the
// runtime's own is 256x480, so every rule that counts screen pixels plays out
// on the wrong distance (README-Parity.md, P1). Under ?field=saturn a
// vertical import plays on the Saturn's screen with the engine's numbers:
//
//   the grid walker's gate    a row is spawned 48 px above a 224-px top, at
//                             scroll row*16 - 272 (+0x152E8, 0xE800)
//   the spawn                 the cell's left edge plus half the band's
//                             width; the row's line shifted by the per-band
//                             byte, subtracted for air, added for ground
//                             (+0x1679A)
//   the change-channel lines  62 / 112 / 164 px, unscaled
//   the steering distances    64 and 96 px of flight, unscaled
//   the fire window           lateral 48..272, scroll 0..224 (+0x1983E)
//   the ship's clamps         x 60..259, y 20..212 (+0xAB0E)
//   the despawn box           x 16..304, y -16..256 (+0x173A4)
//
// Without the flag every one of them is what it was.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { WEB_FIELD, WEB_GATE_LEAD } from "../scripts/lib/parity-report.ts";
import { FIT_PORTRAIT, GAME_PAGE_CSS } from "../lib/game-page.ts";

const BUNDLE = "static/games/2028-ai/game.bundle.js";

const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** The bundle between two of its own lines, the first included. */
function section(js: string, from: string, to: string): string {
  const a = js.indexOf(from);
  assert(a >= 0, `no ${JSON.stringify(from)} in ${BUNDLE}`);
  const b = js.indexOf(to, a);
  assert(b > a, `no ${JSON.stringify(to)} after it`);
  return js.slice(a, b);
}

interface Point {
  x: number;
  y: number;
}

interface Field {
  DEZA_FIELD: boolean;
  GAME_DIMENSIONS: {
    WIDTH: number;
    HEIGHT: number;
    CENTER_X: number;
    CENTER_Y: number;
  };
  DEZA_TITLE_BAND_Y: number;
  DEZA_ROLL_BAND_Y: number;
  DEZA_STEER_DIST: number;
  DEZA_STEER_DIST_AIMED: number;
  published: { width: number; height: number; saturn: boolean };
  dezaWaveLead(): number;
  dezaFieldSpawn(
    scene: unknown,
    dezaemon: unknown,
    col: number,
    row: number,
  ): Point;
  dezaFieldOutside(o: Point): boolean;
  dezaFieldFits(recipe: unknown): boolean;
  dezaFieldLeaveUrl(href: string): string;
  channelTrigger(
    ch: unknown,
    ground: boolean,
    horizontal: boolean,
    band: number,
  ): number | null;
  bossEngineX(scene: unknown, lateral: number): number;
  bossEngineY(parkY: number, scroll: number): number;
  dezaFireWindow(scene: unknown, enemy: Point): boolean;
  clampPlayerX(p: unknown, x: number): number;
  clampPlayerY(p: unknown, y: number): number;
  dezaZakoLeft(enemy: Point, bottomMargin: number): boolean;
  dezaSatX(sx: number): number;
  storyOff(recipe: unknown): boolean;
}

/** The field's constants and rules, lifted out of the bundle for one URL. */
async function field(search: string): Promise<Field> {
  const js = await read(BUNDLE);
  const head = section(
    js,
    "  function readDezaFieldFlag() {",
    "  var STAGE_DIMENSIONS = {",
  );
  const vars = [
    /^ {2}var DEZA_SCREEN_[WH] = .*;$/gm,
    /^ {2}var DEZA_(TITLE|ROLL)_BAND_Y = .*;$/gm,
    /^ {2}var CHANNEL_TRIGGER_\w+ = .*;$/gm,
    /^ {2}var DEZA_STEER_(PX|DIST|DIST_AIMED) = .*;(?: *\/\/.*)?$/gm,
    /^ {2}var BOSS_ENGINE_\w+ = .*;$/gm,
    /^ {2}var DEZA_FIELD_(ENTRY|SHIP) = .*;$/gm,
    /^ {2}var DEZA_BAND_WIDTH = .*;$/gm,
  ].flatMap((re) => js.match(re) ?? []);
  const fns = [
    "dezaSatX",
    "dezaHorizontal",
    "channelTrigger",
    "dezaBand",
    "bossEngineX",
    "bossEngineY",
    "dezaFireWindow",
    "dezaWaveLead",
    "dezaFieldSpawn",
    "clampPlayerX",
    "clampPlayerY",
    "dezaZakoLeft",
    "storyOff",
  ].map((n) => functionSource(js, n)).join("\n");
  const names = [
    "DEZA_FIELD",
    "GAME_DIMENSIONS",
    "DEZA_TITLE_BAND_Y",
    "DEZA_ROLL_BAND_Y",
    "DEZA_STEER_DIST",
    "DEZA_STEER_DIST_AIMED",
    "dezaWaveLead",
    "dezaFieldSpawn",
    "dezaFieldOutside",
    "dezaFieldFits",
    "dezaFieldLeaveUrl",
    "channelTrigger",
    "bossEngineX",
    "bossEngineY",
    "dezaFireWindow",
    "clampPlayerX",
    "clampPlayerY",
    "dezaZakoLeft",
    "dezaSatX",
    "storyOff",
  ];
  const window = { location: { search } } as Record<string, unknown>;
  const out = new Function(
    "window",
    // What the lifted functions close over elsewhere in the bundle.
    "var clamp = function(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); };\n" +
      "var readSearchParam = function() { return null; };\n" +
      "var readBooleanSearchParam = function(_n, d) { return d; };\n" +
      "var componentOn = function() { return true; };\n" +
      "var isImportedLevel = function() { return true; };\n" +
      head + "\n" +
      "var GW = GAME_DIMENSIONS.WIDTH, GH = GAME_DIMENSIONS.HEIGHT;\n" +
      "var GW13 = GW, GH11 = GH;\n" +
      vars.join("\n") + "\n" + fns +
      `\nreturn { ${names.join(", ")} };`,
  )(window) as Field;
  out.published = window.__GAME_FIELD__ as Field["published"];
  return out;
}

/** A vertical game's scene, with its scroll where the test wants it. */
const scene = (scroll: number, w: number, h: number) => ({
  scale: { width: w, height: h },
  dezaBg: { _scroll: scroll },
  recipe: { meta: { dezaemonSettings: { horizontal: false } } },
});

/** A zako's `dezaemon` block: its placement cell and its ground bit. */
const zako = (band: number, index: number, ground = false) => ({
  placementId: 0x80 | band << 4 | index,
  behavior: { ground },
});

Deno.test("without the flag the screen and every distance are what they were", async () => {
  const f = await field("?stage=0&god=1");
  assertStrictEquals(f.DEZA_FIELD, false);
  assertEquals(f.GAME_DIMENSIONS, {
    WIDTH: 256,
    HEIGHT: 480,
    CENTER_X: 128,
    CENTER_Y: 240,
  });
  assertEquals(f.published, { width: 256, height: 480, saturn: false });
  assertStrictEquals(f.dezaWaveLead(), 512);
  assertStrictEquals(f.dezaWaveLead() - 272, WEB_GATE_LEAD);
  assertStrictEquals(f.DEZA_TITLE_BAND_Y, 48);
  assertStrictEquals(f.DEZA_ROLL_BAND_Y, 128);
  assertStrictEquals(f.DEZA_STEER_DIST, 128);
  assertStrictEquals(f.DEZA_STEER_DIST_AIMED, 192);
  assertStrictEquals(
    f.channelTrigger({ trigger: 1 }, false, false, 7),
    62 * 480 / 224,
  );
  assertStrictEquals(f.bossEngineY(100, 56 + 10), 120);
  assertStrictEquals(f.dezaSatX(48), 16);
  // The ship keeps its art-wide clamp and the 50..GH-20 band.
  assertStrictEquals(f.clampPlayerX({ halfW: 9 }, -40), 9);
  assertStrictEquals(f.clampPlayerX({ halfW: 9 }, 400), 247);
  assertStrictEquals(f.clampPlayerY({}, 0), 50);
  assertStrictEquals(f.clampPlayerY({}, 999), 460);
  // An enemy leaves 20 px (or its entry margin) under the screen, 40 px out
  // at the sides.
  assertStrictEquals(f.dezaZakoLeft({ x: 128, y: 500 }, 20), false);
  assertStrictEquals(f.dezaZakoLeft({ x: 128, y: 501 }, 20), true);
  assertStrictEquals(f.dezaZakoLeft({ x: -40, y: 100 }, 20), false);
  assertStrictEquals(f.dezaZakoLeft({ x: -41, y: 100 }, 20), true);
  const s = scene(0, 256, 480);
  assertStrictEquals(f.dezaFireWindow(s, { x: 16, y: 480 }), true);
  assertStrictEquals(f.dezaFireWindow(s, { x: 15, y: 100 }), false);
});

Deno.test("?field=saturn is the Saturn's 320x224 screen", async () => {
  const f = await field("?stage=0&field=saturn");
  assertStrictEquals(f.DEZA_FIELD, true);
  assertEquals(f.GAME_DIMENSIONS, {
    WIDTH: 320,
    HEIGHT: 224,
    CENTER_X: 160,
    CENTER_Y: 112,
  });
  assertEquals(f.published, { width: 320, height: 224, saturn: true });
  // The title, the staff roll and the HUD are drawn in Saturn coordinates;
  // on the field they need no window and no band.
  assertStrictEquals(f.dezaSatX(48), 48);
  assertStrictEquals(f.DEZA_TITLE_BAND_Y, 0);
  assertStrictEquals(f.DEZA_ROLL_BAND_Y, 0);
  // Any other value of the parameter is not the flag.
  assertStrictEquals((await field("?field=1")).DEZA_FIELD, false);
  assertStrictEquals((await field("?field=saturnine")).DEZA_FIELD, false);
});

Deno.test("a row is spawned 48 px above the Saturn's top edge", async () => {
  const f = await field("?field=saturn");
  // 224 lines and the 48 px the walker starts an object above them.
  assertStrictEquals(f.dezaWaveLead(), 272);
  assertStrictEquals(WEB_FIELD.lead, 0);
  // Ramsie's C stands on row 38: due at scroll 336 (the survey saw it at
  // 340), where the web's own screen spawns it at 96.
  const row = 38;
  const due = row * 16 - f.dezaWaveLead();
  assertStrictEquals(due, 336);
  // At that scroll a 32x32 air zako (band 3, shift -8) stands 40 px above
  // the top, a 16x16 one (band 0, -16) 32 px above, a 64x64 one (band 6,
  // +8) 56 px above: every foot on the same line, 24 px above the screen.
  const s = scene(due, 320, 224);
  const feet = [[3, 32], [0, 16], [6, 64]].map(([band, h]) => {
    const at = f.dezaFieldSpawn(s, zako(band, 0), 4, row);
    return at.y + h / 2;
  });
  assertEquals(feet, [-24, -24, -24]);
  assertStrictEquals(f.dezaFieldSpawn(s, zako(3, 0), 4, row).y, -40);
  // A ground record takes the same byte the other way.
  assertStrictEquals(f.dezaFieldSpawn(s, zako(3, 0, true), 4, row).y, -56);
  assertStrictEquals(f.dezaFieldSpawn(s, zako(5, 0, true), 4, row).y, -40);
  // A row inside the opening screen stands on its own line of the map.
  assertStrictEquals(
    f.dezaFieldSpawn(scene(0, 320, 224), zako(7, 0), 0, 4).y,
    224 - 64,
  );
});

Deno.test("a grid spawn is drawn from its cell's left edge", async () => {
  const f = await field("?field=saturn");
  const s = scene(0, 320, 224);
  // 16, 32 and 64 px wide: the centre is col*16 + w/2, where the web's own
  // screen puts every one of them at col*16 + 16.
  const xs = [0, 1, 2, 3, 4, 5, 6].map((band) =>
    f.dezaFieldSpawn(s, zako(band, 0), 10, 20).x
  );
  assertEquals(xs, [168, 176, 168, 176, 192, 176, 192]);
  // The grid is whole: column 0 and column 19 are on the screen.
  assertStrictEquals(f.dezaFieldSpawn(s, zako(0, 0), 0, 20).x, 8);
  assertStrictEquals(f.dezaFieldSpawn(s, zako(0, 0), 19, 20).x, 312);
});

Deno.test("the engine's distances are unscaled on the field", async () => {
  const f = await field("?field=saturn");
  // The resolver's 62 / 112 / 164 px, shifted by the band byte.
  assertEquals(
    [1, 2, 3].map((m) => f.channelTrigger({ trigger: m }, false, false, 7)),
    [62, 112, 164],
  );
  assertStrictEquals(f.channelTrigger({ trigger: 1 }, false, false, 0), 78);
  assertStrictEquals(f.channelTrigger({ trigger: 1 }, true, false, 0), 46);
  // A steered bullet kinks or splits after 64 px of flight, 96 when aimed.
  assertStrictEquals(f.DEZA_STEER_DIST, 64);
  assertStrictEquals(f.DEZA_STEER_DIST_AIMED, 96);
  // The boss's space is the screen's: lateral 160 is the centre line and a
  // scroll offset from the park is its own pixels.
  const s = scene(0, 320, 224);
  assertStrictEquals(f.bossEngineX(s, 160), 160);
  assertStrictEquals(f.bossEngineX(s, 336), 336);
  assertStrictEquals(f.bossEngineY(56, 280), 280);
  assertStrictEquals(f.bossEngineY(56, -56), -56);
});

Deno.test("the fire window is lateral 48..272 on the 224 lines", async () => {
  const f = await field("?field=saturn");
  const s = scene(0, 320, 224);
  assertStrictEquals(f.dezaFireWindow(s, { x: 48, y: 0 }), true);
  assertStrictEquals(f.dezaFireWindow(s, { x: 272, y: 224 }), true);
  assertStrictEquals(f.dezaFireWindow(s, { x: 47, y: 100 }), false);
  assertStrictEquals(f.dezaFireWindow(s, { x: 273, y: 100 }), false);
  assertStrictEquals(f.dezaFireWindow(s, { x: 160, y: -1 }), false);
  assertStrictEquals(f.dezaFireWindow(s, { x: 160, y: 225 }), false);
});

Deno.test("the ship is held to the Saturn's clamps, whatever its art", async () => {
  const f = await field("?field=saturn");
  for (const halfW of [5, 16, 40]) {
    assertStrictEquals(f.clampPlayerX({ halfW }, 0), 60);
    assertStrictEquals(f.clampPlayerX({ halfW }, 320), 259);
    assertStrictEquals(f.clampPlayerX({ halfW }, 160), 160);
  }
  assertStrictEquals(f.clampPlayerY({}, 0), 20);
  assertStrictEquals(f.clampPlayerY({}, 224), 212);
  assertStrictEquals(f.clampPlayerY({}, 144), 144);
  // The survey pilot's box is inside them.
  const b = WEB_FIELD.pilotBox;
  assert(b.x0 >= 60 && b.x1 <= 259 && b.y0 >= 20 && b.y1 <= 212);
});

Deno.test("a shot leaves by the despawn box, an enemy by the bottom line", async () => {
  const f = await field("?field=saturn");
  // +0x173A4: x 16..304, y -16..256.
  for (const p of [[16, -16], [304, 256], [160, 112]]) {
    assertStrictEquals(f.dezaFieldOutside({ x: p[0], y: p[1] }), false);
  }
  for (const p of [[15, 100], [305, 100], [160, -17], [160, 257]]) {
    assertStrictEquals(f.dezaFieldOutside({ x: p[0], y: p[1] }), true);
  }
  // An enemy: the box's bottom line, whatever margin the caller keeps for
  // the tall screen; the sides 16 px outside the picture; never the top,
  // where a grid spawn comes in from.
  assertStrictEquals(f.dezaZakoLeft({ x: 160, y: 256 }, 20), false);
  assertStrictEquals(f.dezaZakoLeft({ x: 160, y: 257 }, 116), true);
  assertStrictEquals(f.dezaZakoLeft({ x: 8, y: 100 }, 20), false);
  assertStrictEquals(f.dezaZakoLeft({ x: -17, y: 100 }, 20), true);
  assertStrictEquals(f.dezaZakoLeft({ x: 337, y: 100 }, 20), true);
  assertStrictEquals(f.dezaZakoLeft({ x: 160, y: -56 }, 20), false);
});

Deno.test("the field fits a vertical Dezaemon import and nothing else", async () => {
  const f = await field("?field=saturn");
  const cart = (horizontal: boolean) => ({
    meta: { dezaemonSettings: { horizontal } },
  });
  assertStrictEquals(f.dezaFieldFits(cart(false)), true);
  assertStrictEquals(f.dezaFieldFits(cart(true)), false);
  assertStrictEquals(f.dezaFieldFits({ meta: {} }), false);
  assertStrictEquals(f.dezaFieldFits(null), false);
  // Anything else is opened again without the flag, and with the rest of
  // its URL.
  assertStrictEquals(
    f.dezaFieldLeaveUrl(
      "https://x.test/games/2028-ai?level=gs&field=saturn&god=1",
    ),
    "https://x.test/games/2028-ai?level=gs&god=1",
  );
  // The story panel is laid out on 480 lines: no story on the field, even
  // where MOD would play one.
  assertStrictEquals(f.storyOff({ noStory: false }), true);
  assertStrictEquals((await field("")).storyOff({ noStory: false }), false);
});

Deno.test("the bundle routes its field rules through the flag", async () => {
  const js = await read(BUNDLE);
  // The gate, the spawn, the culls, the boot check and the game-over panel.
  for (
    const line of [
      "if (self0.waveDueByScroll) return Math.max(0, row * 16 - dezaWaveLead());",
      "if (DEZA_FIELD && scene.waveDueByScroll && enemyData.dezaemon) {",
      "var at = dezaFieldSpawn(scene, enemyData.dezaemon, i, dezaRow);",
      "p.sprite.y = clampPlayerY(p, p.sprite.y + moveY);",
      "if (DEZA_FIELD ? dezaFieldOutside(bullet)",
      "if (DEZA_FIELD ? dezaFieldOutside(eBullet)",
      "if (DEZA_FIELD && !dezaFieldFits(gameState._phaserRecipe)) {",
      "window.location.replace(dezaFieldLeaveUrl(window.location.href));",
    ]
  ) {
    assert(js.includes(line), `the bundle has: ${line}`);
  }
  // The size is read once, ahead of the Phaser config and of every GW/GH
  // copy, all of which still take it from GAME_DIMENSIONS.
  const flag = js.indexOf("var DEZA_FIELD = readDezaFieldFlag();");
  const copies = [...js.matchAll(/^ {2}var G[WH]\d* = (.*);$/gm)];
  assert(copies.length >= 20, "the module-level size copies");
  for (const m of copies) {
    assert(m.index! > flag, "a size copy is read after the flag");
    assert(/^GAME_DIMENSIONS\.(WIDTH|HEIGHT)$/.test(m[1]), m[0]);
  }
  assert(
    js.includes(
      'width: GAME_DIMENSIONS.WIDTH,\n      height: GAME_DIMENSIONS.HEIGHT,\n      parent: "phaser-canvas"',
    ),
  );
});

Deno.test("the page fits the field unturned, in both shells", async () => {
  const shell = await read(
    "packages/shmup-harbor/tools/build-level/lib/shell-template.js",
  );
  for (
    const [name, fit, css] of [
      ["lib/game-page.ts", FIT_PORTRAIT, GAME_PAGE_CSS],
      ["shell-template.js", shell, shell],
    ]
  ) {
    assert(
      fit.includes('.get("field") === "saturn"'),
      `${name} reads the flag`,
    );
    assert(
      fit.includes(
        "var GW = FIELD_SATURN ? 320 : 256, GH = FIELD_SATURN ? 224 : 480;",
      ),
      `${name} fits the field's size`,
    );
    assert(
      fit.includes('document.documentElement.classList.add("field-saturn")'),
      `${name} marks the page`,
    );
    // The landscape rotation is for the portrait screen only.
    const rotated = css.slice(css.indexOf("(orientation: landscape)"));
    assert(rotated.includes("html:not(.field-saturn) {"), `${name} CSS`);
    assert(!/\n\s*html \{\s*transform: rotate/.test(rotated), `${name} CSS`);
  }
  // A cabinet is drawn around the tall screen: none on the field, in the
  // plugin and in the bundle's copy of it.
  const guard = "window.__GAME_FIELD__ && window.__GAME_FIELD__.saturn";
  assert((await read("static/phaser-plugins/level-loader.js")).includes(guard));
  assert((await read(BUNDLE)).includes(guard));
});
