// The parity testdrive's two PlayStation panes: the player page — EmulatorJS's
// psx core (pcsx_rearmed) booting a Dezaemon Kids! or Dezaemon Plus Select 100
// disc on the Japanese BIOS — and the page code that drives each game from
// power-on into the rush's first stage by RAM signals alone, never by timings:
// a menu that has not finished drawing drops a press, and the card loads take
// anything from 15 to 60 seconds.
//
// Both games keep the rush on a memory card (deno task build:kids / build:plus).
// Kids! loads it from slot 1, which pcsx_rearmed exposes as the libretro save
// RAM — the same write-and-reset as the Super Famicom's SRAM. Select 100's GAME
// LOAD reads slot 2 only, a card pcsx_rearmed opens just once, when the game is
// loaded, and only with its memcard2 option on: so the page turns the option on
// and the card is written straight into the core's slot-2 buffer.
//
// Every address is PS1 main RAM (0x80000000 + offset), little-endian. pcsx
// keeps that RAM as one flat 2 MB block in the core's heap; find() locates it.
// Kids!'s are watched in this core: the menus' pointer, layer, button and
// dialog bytes, the user-game runtime's lives and ship. Select 100's likewise.

export const EJS_CDN = "https://cdn.emulatorjs.org/stable/data/";

/**
 * The BIOS's exception vector, which every PS1 BIOS copies to RAM 0x80
 * (lui k0,0; addiu k0,k0,0x0c80; jr k0) and no file on the disc carries: a
 * search hit for an EXE's bytes is RAM only if its base has this at +0x80.
 */
const BIOS_VECTOR = [0, 0, 0x1a, 0x3c, 0x80, 0x0c, 0x5a, 0x27, 8, 0, 0x40, 3];

/**
 * Dezaemon Kids! (SLPS-01503). The menus are a hand pointer flown with the
 * d-pad; each screen is told by what it has loaded (`gfx`), the menu layer
 * open over it, and whether a speech bubble is up. The game a card holds is
 * played from the PLAY screen's user-game island, by a runtime that loads over
 * the menus (`runtime` is its "STAGE %d CLEAR").
 */
export const KIDS = {
  /** KIDS.EXE's text at 0x800607F0 (t_addr 0x80060000): its help-file names. */
  needle: "HELP120.TIM\0HELP119.TIM\0HELP118.",
  needleAt: 0x607f0,
  /** u32: the menu pointer, in pixels × 60. */
  pointerX: 0xbc8a0,
  pointerY: 0xbc8a4,
  pointerScale: 60,
  /** u8: 1 a screen alone, 2 with PERON MENU open, 3 the LOAD screen. */
  layer: 0xbb8dd,
  /** u8: 0 while a speech bubble (a question, the load's progress) is up, else 255. */
  dialog: 0xbc66b,
  /** u32: the header of the screen art loaded last. */
  gfx: 0x1bb000,
  gfxMain: 0x18ce,
  gfxMake: 0x351d,
  gfxPlay: 0x1486,
  /**
   * u8 ×3: 1 while the main menu's three buttons (遊ぼう! 作り方 作ろう!)
   * take clicks. The title before it has loaded the same art (`gfxMain`) and
   * reads 0 here: only its はじまるよ, under the pointer's start, does.
   */
  mainButtons: [0xb102a, 0xb103c, 0xb104e],
  /** u32: "STAG" of the user-game runtime's "STAGE %d CLEAR". */
  runtime: 0x1131c8,
  runtimeWord: 0x47415453,
  /**
   * u8 ×2: the stock — 0 while the runtime loads and runs its title card and
   * attract screens, 2 from the run's first frame.
   */
  lives: [0x146c88, 0x16f602],
  /** s16 per object, px << 7; the ship's. */
  shipX: 0x174498,
  shipY: 0x174f70,
} as const;

/** Where Kids!'s walk clicks, in the pointer's pixels. */
export const KIDS_AT = {
  make: { x: 250, y: 95 }, // 作ろう! on the main menu
  peron: { x: 270, y: 195 }, // Peron, bottom right: PERON MENU (opens and closes)
  load: { x: 230, y: 188 }, // PERON MENU's last icon, ロード (the first is セーブ)
  slot1: { x: 70, y: 78 },
  yes: { x: 180, y: 142 }, // the question's はい
  back: { x: 30, y: 38 }, // the LOAD screen's back arrow
  exit: { x: 296, y: 20 }, // the exit sign, top right
  play: { x: 65, y: 95 }, // 遊ぼう!
  island: { x: 148, y: 140 }, // the ユーザーゲーム island
} as const;

/**
 * Dezaemon Plus Select 100 (SLPS-01504). Its menus are lists with one cursor
 * byte; the screen is told by the menu record after it. The game a card holds
 * runs in a runtime whose state byte says menu or stage.
 */
export const PLUS = {
  /** MAIN.EXE's text at 0x800107F0 (t_addr 0x80010000): a DMA debug format. */
  needle: "tat=%08x,chcr=%08x,madr=%08x\n",
  needleAt: 0x107f0,
  /** u8: the cursor of the menu up. */
  cursor: 0x857c,
  /**
   * u8 ×2: the menu up — 1/0 the title, 255/255 the main menu, 0/6 MEMORY
   * CARD, 240/16 GAME LOAD at work.
   */
  screenA: 0x8589,
  screenB: 0x858a,
  /** u8: 0 in Select 100's own menus, 32 the loaded game's menu and attract, 34 its stage. */
  state: 0x14c2b4,
  /** u8: REST, 2 at the start. */
  lives: 0x112a5a,
  /** u8: the ship, in the field's pixels (x 0..255, y 0..223; the screen follows it). */
  shipX: 0x112a06,
  shipY: 0x112a08,
} as const;

/** The player page, at the pane's size. */
export function psxPage(opts: {
  disc: string;
  bios: string;
  name: string;
  width: number;
  height: number;
}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${opts.name}</title>
<style>html,body{margin:0;background:#000;overflow:hidden}#display{width:${opts.width}px;height:${opts.height}px}</style>
</head><body><div id="display"></div>
<script>
window.EJS_player = "#display";
window.EJS_core = "psx";
window.EJS_gameUrl = ${JSON.stringify(opts.disc)};
window.EJS_gameName = ${JSON.stringify(opts.name)};
window.EJS_biosUrl = ${JSON.stringify(opts.bios)};
window.EJS_pathtodata = ${JSON.stringify(EJS_CDN)};
window.EJS_startOnLoaded = true;
window.EJS_disableDatabases = true;
// EmulatorJS hands the core its default options only when it keeps no
// settings of its own; with localStorage on and empty it hands it none.
window.EJS_disableLocalStorage = true;
window.EJS_defaultOptions = { pcsx_rearmed_memcard2: "enabled" };
</script>
<script src="${EJS_CDN}loader.js"></script>
</body></html>`;
}

/**
 * Page code: `window.__psx`. `find(needle, at)` looks for main RAM in the
 * core's heap by a string the game's EXE puts at RAM offset `at`, keeping the
 * hits whose base holds the BIOS vector, and answers the heap offset of RAM 0,
 * or minus the number of hits while there is not exactly one. `b`/`h`/`w` read
 * a byte/half/word. `card2(url)` writes a memory card into slot 2: pcsx keeps
 * the two cards' 128 KB back to back, so it is the formatted card that follows
 * another. `steer(x, y)` flies Kids!'s pointer there and answers where it
 * stopped.
 */
export const PSX_RAM = `(function () {
  if (window.__psx) return true;
  var VECTOR = ${JSON.stringify(BIOS_VECTOR)};
  var K = ${JSON.stringify(KIDS)};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var heap = function () { return EJS_emulator.Module.HEAPU8; };
  var P = window.__psx = { base: -1 };
  P.find = function (text, at) {
    var H = heap(), needle = [], hits = [];
    for (var i = 0; i < text.length; i++) needle.push(text.charCodeAt(i));
    for (var o = H.indexOf(needle[0]); o >= 0; o = H.indexOf(needle[0], o + 1)) {
      var k = 1;
      while (k < needle.length && H[o + k] === needle[k]) k++;
      if (k < needle.length) continue;
      var base = o - at, v = 0;
      while (v < VECTOR.length && H[base + 0x80 + v] === VECTOR[v]) v++;
      if (v === VECTOR.length) hits.push(base);
    }
    if (hits.length === 1) P.base = hits[0];
    return hits.length === 1 ? hits[0] : -hits.length;
  };
  P.b = function (a) { return heap()[P.base + a]; };
  P.h = function (a) { return P.b(a) | (P.b(a + 1) << 8); };
  P.w = function (a) { return (P.h(a) | (P.h(a + 2) << 16)) >>> 0; };
  P.card2 = async function (url) {
    var bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    var H = heap(), formatted = function (o) { return H[o] === 0x4d && H[o + 1] === 0x43 && H[o + 127] === 0x0e; };
    for (var o = H.indexOf(0x4d); o >= 0 && o + 0x40000 <= H.length; o = H.indexOf(0x4d, o + 1)) {
      if (formatted(o) && formatted(o + 0x20000)) { H.set(bytes, o + 0x20000); return o + 0x20000; }
    }
    return -1;
  };
  P.pointer = function () { return { x: Math.round(P.w(K.pointerX) / K.pointerScale), y: Math.round(P.w(K.pointerY) / K.pointerScale) }; };
  P.steer = async function (tx, ty, ms) {
    var gm = EJS_emulator.gameManager, held = {}, t0 = Date.now(), p;
    function hold(i, on) { if (!!held[i] === !!on) return; held[i] = !!on; gm.simulateInput(0, i, on ? 1 : 0); }
    while (Date.now() - t0 < (ms || 6000)) {
      p = P.pointer();
      if (Math.abs(p.x - tx) <= 2 && Math.abs(p.y - ty) <= 2) break;
      hold(6, p.x > tx + 2); hold(7, p.x < tx - 2); hold(4, p.y > ty + 2); hold(5, p.y < ty - 2);
      await sleep(16);
    }
    for (var k in held) hold(Number(k), false);
    await sleep(100);
    return P.pointer();
  };
  return true;
})()`;
