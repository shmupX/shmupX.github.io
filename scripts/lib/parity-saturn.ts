// The parity testdrive's Saturn pane: the player page — EmulatorJS's yabause
// with no backup cartridge, booting a Dezaemon 2 disc that carries the game as
// its boot image (deno task disc:inject) — and the page code that drives it
// from power-on into the game's first stage by RAM signals alone, never by
// timings: yabause's boot takes anything from 20 to 45 seconds.
//
// Every address is HWRAM, which the core keeps in its heap as little-endian
// 16-bit words — the console's byte A is heap byte (A - 0x06000000) ^ 1 past
// the RAM's base. The menu's are traced in packages/shmup-engine/FORMAT.md
// ("SGM_INIT.CMP, the boot image"); the play engine's arrays under "Axes and
// angles"; the lives byte and the in-play bits were watched in this core.

export const EJS_CDN = "https://cdn.emulatorjs.org/stable/data/";

export const SATURN = {
  /** Where every overlay unpacks: D2MENU, then GAME. */
  overlay: 0x06064000,
  /** u8: 1 once D2MENU's cold entry has run (its patched store, disc-inject.js). */
  workFlag: 0x06056980,
  /** u16: the title's menu state; 0 takes no click, START makes it 1. */
  menuState: 0x0606C0C4,
  /** s8: the hovered menu item; PLAY → U is 3. */
  hover: 0x0606C0E2,
  /** u16: the menu pointer. */
  pointerX: 0x060577A6,
  pointerY: 0x0605778E,
  /** u8: bit0 game running, bit1 P1 in play, bit7 the attract demo. */
  playState: 0x060840C8,
  /** u8: P1's stock — 2 at the start, one off per death, the third ends it. */
  lives: 0x06084354,
  /** u32 per object slot, px << 7; the ship is slot 2. */
  shipX: 0x06090040 + 2 * 4,
  shipY: 0x0608D400 + 2 * 4,
} as const;

/** The no-cartridge dialog's はい (the pointer starts between it and いいえ). */
export const DIALOG_YES = { x: 116, y: 127 };
/** PLAY → U on the title. */
export const PLAY_U = { x: 135, y: 174, hover: 3 };

/** The player page, at the pane's size. */
export function saturnPage(opts: {
  disc: string;
  bios: string;
  width: number;
  height: number;
}): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Dezaemon 2</title>
<style>html,body{margin:0;background:#000;overflow:hidden}#display{width:${opts.width}px;height:${opts.height}px}</style>
</head><body><div id="display"></div>
<script>
window.EJS_player = "#display";
window.EJS_core = "segaSaturn";
window.EJS_gameUrl = ${JSON.stringify(opts.disc)};
window.EJS_gameName = "Dezaemon 2";
window.EJS_biosUrl = ${JSON.stringify(opts.bios)};
window.EJS_pathtodata = ${JSON.stringify(EJS_CDN)};
window.EJS_startOnLoaded = true;
window.EJS_disableDatabases = true;
</script>
<script src="${EJS_CDN}loader.js"></script>
</body></html>`;
}

/**
 * Page code: `window.__sat`. `find()` looks for HWRAM in the core's heap by
 * GFS's version string, which 0KERNEL.BIN carries at 0x0600A00C — stored
 * there with each 16-bit pair swapped — and answers the heap offset of
 * 0x06000000, or minus the number of hits while there is not exactly one.
 * `b`/`w` read a byte/word, `press` taps a RetroPad button, and
 * `steer(x, y, hover)` flies the menu pointer there — until the hovered item
 * reads `hover`, when one is given — and answers where it stopped.
 */
export const SATURN_RAM = `(function () {
  if (window.__sat) return true;
  var A = ${JSON.stringify(SATURN)};
  var text = "GFS_SGL Version 2.11 1996-03-21", needle = [];
  for (var i = 0; i + 1 < text.length; i += 2) needle.push(text.charCodeAt(i + 1), text.charCodeAt(i));
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var S = window.__sat = { base: -1, A: A };
  S.find = function () {
    var H = EJS_emulator.Module.HEAPU8, hits = [], n0 = needle[0];
    for (var o = H.indexOf(n0); o >= 0; o = H.indexOf(n0, o + 1)) {
      var k = 1;
      while (k < needle.length && H[o + k] === needle[k]) k++;
      if (k === needle.length) hits.push(o - 0xA00C);
    }
    if (hits.length === 1) S.base = hits[0];
    return hits.length === 1 ? hits[0] : -hits.length;
  };
  S.b = function (a) { return EJS_emulator.Module.HEAPU8[S.base + ((a - 0x06000000) ^ 1)]; };
  S.w = function (a) { return (S.b(a) << 8) | S.b(a + 1); };
  S.press = async function (idx, ms) {
    var gm = EJS_emulator.gameManager;
    gm.simulateInput(0, idx, 1);
    await sleep(ms || 150);
    gm.simulateInput(0, idx, 0);
    return true;
  };
  S.steer = async function (tx, ty, hover, ms) {
    var gm = EJS_emulator.gameManager, held = {}, t0 = Date.now();
    function hold(i, on) { if (!!held[i] === !!on) return; held[i] = !!on; gm.simulateInput(0, i, on ? 1 : 0); }
    var x, y, h;
    while (Date.now() - t0 < (ms || 6000)) {
      x = S.w(A.pointerX); y = S.w(A.pointerY); h = (S.b(A.hover) << 24) >> 24;
      var near = Math.abs(x - tx) <= 2 && Math.abs(y - ty) <= 2;
      if (hover == null ? near : (h === hover && Math.abs(x - tx) <= 4 && Math.abs(y - ty) <= 4)) break;
      hold(6, x > tx + 2); hold(7, x < tx - 2); hold(4, y > ty + 2); hold(5, y < ty - 2);
      await sleep(16);
    }
    for (var k in held) hold(Number(k), false);
    await sleep(100);
    return { x: S.w(A.pointerX), y: S.w(A.pointerY), hover: (S.b(A.hover) << 24) >> 24 };
  };
  return true;
})()`;
