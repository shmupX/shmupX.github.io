// The parity testdrive's 64DD pane: the page code that drives Dezaemon 3D
// (the English cartridge, the 64DD IPL and a disk build:ddd wrote, booted in
// static/n64dd/play.html's mupen64plus-next) from power-on into a project's
// first stage by RAM signals alone, never by timings — the menus take a press
// only once they have settled, and a press on the wrong screen leads into the
// editor or a demo (FORMAT-N64.md "The launcher's player").
//
// RDRAM sits in the core's heap as host-order 32-bit words, so the console's
// byte A is heap byte (A & 0x7FFFFF) ^ 3 past the RAM's base. The base is
// found by the cartridge's boot code, which the IPL copies from ROM 0x1000 to
// the entry point the header names, and held to the two words libultra's boot
// leaves at 0x80000308 (osRomBase) and 0x80000318 (osMemSize, 8 MB with the
// Expansion Pak the 64DD needs). The menu byte is the translation's readme's
// ("800C4C87 … the Game Start menu", 0xF); everything else was watched in this
// core on a gs rush built on deza1.NDD.

export const N64DD = {
  /**
   * u8: the current page — 7 the shell's (the logos, the cartridge's logo
   * title, the root menu, the editor's demo), 15 GAME SELECT, 2 the game
   * engine's (the title's flight, a project's title and its stages).
   */
  menu: 0x800c4c87,
  /**
   * s16 x, s16 y: the menu pointer (its hot spot) — parked at 160, 120 from
   * power-on through the logo title, at 160, 72 on GAME when the root menu
   * comes up.
   */
  pointer: 0x800c4c88,
  /**
   * u16 (the word's low half): the item under the pointer — 0 none, 1 GAME
   * on the root menu, 6 USER GAME (where GAME SELECT's pointer starts, though
   * until the pointer moves it can read 0 or the root menu's 1 there), 10 + n
   * the list's row n. Rewritten during the frame, so a read can catch 0.
   */
  item: 0x8005d978,
  /**
   * u32: the 30 Hz clock effects are read against — counting on the title
   * from 0 (at 920 the title gives way to the editor's demo), frozen through
   * the menus, back to 0 when a stage starts.
   */
  clock: 0x801c8384,
  /** u8: P1's stock — 3 at the start, one off per death. */
  lives: 0x8023648d,
  /**
   * s16: the ship, x 0 at the centre (about ±220 at the edges, + right), y
   * 173 at the start (up is less). Two objects carry it a step apart; this is
   * the one that is set from the stage's first frame.
   */
  shipX: 0x80237050,
  shipY: 0x80237054,
} as const;

/**
 * GAME SELECT's list: a row's pointer position and its item number. Four
 * rows show; DST, the RAM area's own project, is the first, the pressed
 * projects follow in directory order.
 */
export function listRow(row: number) {
  return { x: 105, y: Math.round(115 + 20.7 * row), item: 10 + row };
}

/**
 * What finds RDRAM in the heap: the cartridge's first 64 bytes of boot code
 * (ROM 0x1000) as host-order words, and where the IPL puts them.
 */
export function rdramNeedle(rom: Uint8Array): { bytes: number[]; at: number } {
  const entry = ((rom[8] << 24) | (rom[9] << 16) | (rom[10] << 8) | rom[11]) >>>
    0;
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 4) {
    const o = 0x1000 + i;
    bytes.push(rom[o + 3], rom[o + 2], rom[o + 1], rom[o]);
  }
  return { bytes, at: entry & 0x7fffff };
}

/** play.html's own SAVE DISK button, off the recording. */
export const N64DD_BARE = `(function () {
  function add() {
    var style = document.createElement("style");
    style.textContent = "#save-disk{display:none!important}";
    document.head.appendChild(style);
  }
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
})()`;

/**
 * Page code: `window.__dd`. `find()` answers RDRAM's heap offset, or minus
 * the number of candidates while there is not exactly one. `menu`/`item`/
 * `clock`/`pointer` read the addresses above. `title()` is true on either of
 * the title's two screens while START is still safe there — the flight (the
 * engine's page, its clock running) and the cartridge's logo title that
 * START on the flight leads to (the shell's page, the pointer still parked),
 * where START is the root menu; `rootMenu()` once that menu's pointer rests
 * on GAME. `step(idx, pressIf, done, ms)`
 * answers true at once when `done()` is seen, otherwise taps RetroPad `idx`
 * if `pressIf()` is seen and watches for `done()` for `ms` — "seen" being
 * true at any poll within a short window, as `item` flickers. `steer(x, y,
 * item, ms)` flies GAME SELECT's pointer there with the d-pad until the item
 * under it reads `item`, and answers where it stopped.
 */
export function n64ddRam(needle: { bytes: number[]; at: number }): string {
  return `(function (N, A) {
  if (window.__dd) return true;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var heap = function () { return EJS_emulator.Module.HEAPU8; };
  var S = window.__dd = { base: -1, A: A };
  S.find = function () {
    var H = heap(), hits = [], n0 = N.bytes[0];
    for (var o = H.indexOf(n0); o >= 0; o = H.indexOf(n0, o + 1)) {
      var k = 1;
      while (k < N.bytes.length && H[o + k] === N.bytes[k]) k++;
      if (k < N.bytes.length) continue;
      S.base = o - N.at;
      if (S.u32(0x80000308) === 0xb0000000 && S.u32(0x80000318) === 0x800000) hits.push(S.base);
    }
    S.base = hits.length === 1 ? hits[0] : -1;
    return hits.length === 1 ? hits[0] : -hits.length;
  };
  S.b = function (a) { return heap()[S.base + ((a & 0x7fffff) ^ 3)]; };
  S.u32 = function (a) { var H = heap(), o = S.base + (a & 0x7ffffc); return (H[o] | (H[o + 1] << 8) | (H[o + 2] << 16) | (H[o + 3] << 24)) >>> 0; };
  S.menu = function () { return S.b(A.menu); };
  S.item = function () { return S.u32(A.item) & 0xffff; };
  S.clock = function () { return S.u32(A.clock); };
  S.pointer = function () { var v = S.u32(A.pointer); return { x: v >> 16, y: (v << 16) >> 16 }; };
  S.title = function () {
    if (S.clock() >= 820) return false;
    if (S.menu() === 2) return true;
    var p = S.pointer();
    return S.menu() === 7 && S.item() === 0 && p.x === 160 && p.y === 120;
  };
  S.rootMenu = function () { return S.menu() === 7 && S.item() === 1; };
  S.seen = async function (test, ms) {
    var t0 = Date.now();
    do { if (test()) return true; await sleep(16); } while (Date.now() - t0 < ms);
    return false;
  };
  S.press = async function (idx, ms) {
    var gm = EJS_emulator.gameManager;
    gm.simulateInput(0, idx, 1);
    await sleep(ms || 120);
    gm.simulateInput(0, idx, 0);
    return true;
  };
  S.step = async function (idx, pressIf, done, ms) {
    if (await S.seen(done, 250)) return true;
    if (await S.seen(pressIf, 250)) await S.press(idx);
    return await S.seen(done, ms);
  };
  S.steer = async function (tx, ty, item, ms) {
    var gm = EJS_emulator.gameManager, held = {}, t0 = Date.now();
    function hold(i, on) { if (!!held[i] === !!on) return; held[i] = !!on; gm.simulateInput(0, i, on ? 1 : 0); }
    var p;
    while (Date.now() - t0 < (ms || 6000)) {
      p = S.pointer();
      var near = Math.abs(p.x - tx) <= 2 && Math.abs(p.y - ty) <= 2;
      if (near && await S.seen(function () { return S.item() === item; }, 100)) break;
      hold(6, p.x > tx + 1); hold(7, p.x < tx - 1); hold(4, p.y > ty + 1); hold(5, p.y < ty - 1);
      await sleep(16);
    }
    for (var k in held) hold(Number(k), false);
    await sleep(100);
    p = S.pointer();
    return { x: p.x, y: p.y, item: (await S.seen(function () { return S.item() === item; }, 150)) ? item : S.item() };
  };
  return true;
})(${JSON.stringify(needle)}, ${JSON.stringify(N64DD)})`;
}
