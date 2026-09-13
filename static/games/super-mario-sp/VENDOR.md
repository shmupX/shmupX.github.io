# The emulator in this folder

`emulatorjs/` is [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) **4.2.3**
and its snes9x core, copied from `https://cdn.emulatorjs.org/4.2.3/data/` by
`deno task super-mario-sp:vendor`.

| file | bytes | sha256 |
| --- | --- | --- |
| `loader.js` | 7,594 | `69e0903bf1e2f62ced78895e7e511fa26e11316f7eb734925c35e919ba1287b2` |
| `emulator.min.js` | 426,343 | `6aec3fd7bb2721255801b0a6af02e47e78b05e28a1822b1f213aacbd348abaee` |
| `emulator.min.css` | 25,630 | `16406c60b2dc3b04ae9b115e308613e6f567a0cc7068e21d9d0c1e5030fb395e` |
| `compression/extract7z.js` | 280,155 | `4ac9933b995a516cb6b3ca4027db860278372a20c21c405d93ceb1998498853a` |
| `cores/reports/snes9x.json` | 120 | `dc7ac963eb7935a7ac78956235ac0b8912ec785c57026336825aa2ed8031b3ad` |
| `cores/snes9x-legacy-wasm.data` | 1,092,437 | `7d427a575cefad98ff400493fa1d7e892da63fe7bab68979babd9cea0bfaaf3b` |
| `cores/snes9x-wasm.data` | 1,093,765 | `eaa0bcfce67673809886e50387a80a616b719502175db64c090d04c9d75958ee` |

## Why each file

`loader.js` is what `index.html` loads; it pulls the rest. The core `.data`
files are **7z archives** (they begin `37 7a bc af`), which is why
`compression/extract7z.js` is here. `cores/reports/snes9x.json` is fetched
*before* the core and decides which one: its `options.defaultWebGL2` is unset,
so the **`-legacy`** build is what actually loads, and the non-legacy one is
only reached if a player turns WebGL2 on in EmulatorJS's own settings. Both
ship, so that switch does not 404.

Deliberately absent: `version.json` (only fetched on localhost, by
`checkForUpdates`), `localization/*` (suppressed by `EJS_disableAutoLang`),
`extractzip.js` and `libunrar` (only for zipped ROMs — ours is raw), and
`src/*.js` + `socket.io` (debug and netplay, both off).

## Pinned, never "stable"

`emulator.min.js` checks each core's `build.json` against its own `ejs_version`
and hard-errors on a mismatch, so the loader and the core have to move together.
A floating `stable` would eventually fetch a core this loader refuses.

## Licensing

EmulatorJS is **GPL-3.0**; its full text is in `EMULATORJS-LICENSE.txt` beside
these files and inside the eShop archive, because that is where it has to travel.
Corresponding source: <https://github.com/EmulatorJS/EmulatorJS> at v4.2.3.

The **snes9x** core carries Snes9x's own licence, which permits free use but
**forbids commercial distribution**. This repo's own `LICENSE` is MIT and does
not cover either of them — they are aggregated here, not relicensed.

## Why vendored at all

Every other console in this project is an opt-in download: `static/emu-sw.js`
mirrors a core's paths from the cmg origin on request, and the repo ships no
emulator of its own. Two things make this the exception. The ROM beside it is
ours, so the game is only a game if it plays on sight; and an eShop `web` game
is installed by unzipping it into Cache Storage, which only works offline if the
core is inside the folder.

It cannot live at `/snes/` instead: that prefix is in `emu-sw.js`'s `MIRRORABLE`
list, so once a player installs the Super Famicom core every `/snes/*` request is
answered from an origin that has never heard of this file. `/games/` is outside
`MIRRORABLE`, which is what makes the game folder the only safe home.
