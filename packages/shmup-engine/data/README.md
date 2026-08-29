# Engine-fixed data extracted from the Dezaemon 2 binaries

Reverse-engineered constants a faithful runtime needs but no .sav carries — they
live in the game's own ROM/overlays (see FORMAT.md for the traces):

- `boss-move-scripts.json` — the 32 boss movement scripts (GAME.CMP
  +0x252D4..+0x25A18): arrays of 10-byte steps
  `[duration, heading, turnRate, speed, flags]`. Heading 65536 = full circle, 0
  = down-screen; flags&3 == 0 terminates. A copy is embedded in the 2028-ai game
  bundle's `DEZA_BOSS_SCRIPTS`.
- `bgm-accompaniment.json` — the kernel ROM auto-accompaniment pattern table
  (0KERNEL.BIN +0x1B490, live 0x0601F490): 1260 rows x 16 step bytes with their
  {bank, pattern, channel} coordinates. A measure's control bytes pick
  `row = ctrl0*140 + (ctrl1*5 + ((ctrl2&0x7F)>>1))*7 + channel`.
- `bgm-instruments.json` — the 116-instrument tone bank map: per layer the
  sample offset INTO SNDPAC.BIN (not shipped here — it is disc content), loop
  points, root pitch, fine tune, PCM format, envelope, pan and level. Enough for
  a runtime to cut real Saturn timbres out of a user-supplied SNDPAC.BIN.
- `appearance-scripts.json` — the 256-entry appearance pointer table's behavior
  scripts (GAME.CMP +0x220BC..+0x24E52): per appearance id, the 10-byte rows
  `{duration, angle/offset, angularVel/delta, amplitude+flags,
  flagsWord}`
  that drive a zako's built-in entry motion, scroll riding and fire gating
  (flags bit4 = never fires). Sprite size/frames do NOT live here — they come
  from the placement-id band. This file is the verbose reference; the runtime
  ships the same 1,206 rows compactly from `src/decode/appearance-table.js`,
  which the mapper attaches to each imported enemy as `dezaemon.entry` and the
  2028-ai runtime interprets.
