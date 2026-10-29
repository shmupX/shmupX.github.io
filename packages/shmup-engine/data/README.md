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
  points, root pitch, fine tune, PCM format, envelope, pan and level. This is
  the verbose reference; the runtime ships the same 590 layers packed into
  `src/audio/tone-bank-table.js` (regenerate with `deno task tonebank:table`),
  and `src/audio/tone-bank.js` cuts the real Saturn timbres out of a
  user-supplied SNDPAC.BIN. Three things it took measurement to settle, all
  shown in FORMAT.md: 16-bit samples are BIG-endian, every loop runs to the last
  sample (so reverse and ping-pong bake down to a plain forward loop), and the
  base rate is 14,842 Hz rather than 44,100.
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
- `music-editor-names.json` — what the native music editor 音まろ calls and
  shows things: key letters, control labels, the instrument palette's groups,
  which disc file each sample song is, and nulls where the game has no name.
  Text only. See "音まろ, the native music editor" below.

Not in this directory, but the same kind of thing: the ポリ吉 3D part library
(`MDLDT_01–56.CMP`, 224 SGL meshes with three colour tables each) is decoded by
`src/model/decode-mdldt.js` and shipped as
`static/editor/dezaemon/mesh-library.json` at the repo root rather than as a
file here (decision 2026-09-02): like the tables above it is derived from the
disc's binaries and committed, but it is the first one big enough — 626 KB of
geometry — to be served to the browser instead of bundled into the engine, and
the level editor's Model Viewer needs it in production where Deploy has no disc
to rebuild it from. `deno task deza:meshlib` regenerates it from a disc image in
`dev-fixtures/`.

## 音まろ, the native music editor

`music-editor-names.json` records what Dezaemon 2's music editor shows and calls
things, so the web music maker can label its 60 instruments, 9 bands, 4 grooves,
5 moods, 12 keys and 73 sample songs. It was read off the Saturn disc on
2026-10-28 (plan spike S4): the overlay `S_EDIT.CMP`, its sprite file
`SPR_SND.CMP` and its help file `HL_MUSIC.CMP`. The SH-2 code was read by hand.
Every offset in the JSON's `meta.offsets` is into the decompressed `S_EDIT`,
which loads at `0x06064000`.

The disc art was rendered only as private reference. To look at it again:

```
deno task deza:disc get S_EDIT.CMP --disc "dev-fixtures/Saturn/Dezaemon 2 (Japan)" --out dev-fixtures/.cache/music-reference/S_EDIT.bin
```

Then cut sprites out with the table described below. Renders go to the
gitignored `dev-fixtures/.cache/music-reference/` and are never committed. The
web music maker draws its own original icons.

### The headline: 音まろ names nothing

The editor prints no name for any instrument, band, groove, mood or sample song.
`S_EDIT` holds no Shift-JIS text at all, and every one of those things is a
picture. So the JSON's `instruments`, `bands`, `grooves`, `chords` and
`sampleSongs` hold `null` for every entry. That is the finding, not a gap to
fill in later. The only words on the screen are:

- the key letters;
- the help strip, which shows one line of text for the control under the cursor.

The `*Icons` and `chordFaces` fields are our own plain-English descriptions of
the native pictures. They are not names the game uses, and they are `null` where
a picture is ambiguous.

### What the screen is made of

`SPR_SND` holds 321 sprites. The first 512 bytes are a 256-colour palette in
big-endian RGB555. The sprite table sits in `S_EDIT` at `+0xFD00`, with 8-byte
entries of `{u16 w, u16 h, u16 vramAddr/8, u16 vdp1Size}`. A sprite's pixels are
8bpp at `SPR_SND + 0x200 + (vramAddr − 0x2000) × 8`. The table ends on the
file's last byte, which checks the layout.

| Element             | Sprites                                                                                                                  | Driven by           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| The staff           | a treble-clef staff in three pieces (#97-#99)                                                                            | —                   |
| A note on the staff | #228 + its voice byte: the instrument's icon on a transparent ground                                                     | voice 0-59          |
| A tied step         | #20, a wavy line                                                                                                         | voice bit 7         |
| Instrument palette  | 4 buttons showing #108 + instrument (lit) or #168 + instrument (dark), plus a group number 1-15 drawn with digit sprites | group index 0-14    |
| Band                | one 32×24 picture, #63 + ctrl0                                                                                           | ctrl0 0-8           |
| Mood                | one face, #42 + (ctrl2 & 0x7F)                                                                                           | ctrl2 bits 1-3      |
| Key                 | a letter #89-#95 (A-G), plus `#` (#101) for a sharp                                                                      | ctrl3 0-11          |
| Bass toggle         | #35, a bass guitar on a staff, shown while the bit is set                                                                | ctrl2 bit 7         |
| Echo                | an 8-step meter, #0-#7, one sprite per level                                                                             | header byte 2       |
| Tempo               | a walking figure (#81, slower) and a running figure (#82, faster); stops at 0 and 31                                     | header byte 3       |
| Measure bar         | 32 strips of 1-32 red cells (#288-#319)                                                                                  | the current measure |
| Transport           | rewind, fast-forward, play, stop (#36-#39), and repeat one measure (#52)                                                 | —                   |
| Editing             | undo, redo, the copy and erase buttons, EXIT (#33/#34), and a pointing-hand cursor (#102/#103)                           | —                   |

Notes on the table:

- **Staff notes.** Each note is its instrument's icon. The plan's "a held note
  is a wavy tail" is how the console draws a tie.
- **Palette groups.** The palette pages through **15 groups of 4**. Group _g_
  holds instruments 4(_g_−1) to 4(_g_−1)+3; the JSON's `instrumentGroups` lists
  them. Group 1 is four keyboards. Group 9 is the four waveforms (instruments
  32-35).
- **Pattern.** How the pattern (ctrl1) is drawn was not traced.

The help strip comes from `HL_MUSIC.CMP`. That file is a `.CMP` whose payload is
35 separately compressed text panels of 256×16 at 4bpp. Their offset and length
table is in `S_EDIT` at `+0x15A04`, and the kernel LZSS decodes them one at a
time. That table is why the older reading of the `HL_*` files saw "drift" after
the first panel.

The 35 lines say what each control does. They cover:

- the option menu, undo, closing sound settings, and EXIT;
- picking the BGM and the SE set to edit, and the sound output;
- switching songs, and copying the song, a measure or one note;
- erasing the song, and turning every shown note into one instrument (the
  brush);
- erasing, lengthening and picking a note's instrument, giving notes 強弱
  (dynamics), and switching the instrument group;
- switching track and range, and setting the loop start and end;
- picking the measure, the echo and the tempo;
- play, stop, the previous and next measure, and repeating one measure;
- five accompaniment controls.

The JSON's `controlLabels` keeps the nouns. The five accompaniment lines name
them リズム, リズムパターン, 伴奏の雰囲気 ("the accompaniment's mood"),
ベースの種類 ("bass type") and 伴奏の音の高低 ("the accompaniment's pitch"). The
text was read by eye from a 12 px font. The full transcription is kept with the
private renders, not here.

### Proven in code

- **Instrument _k_'s icon is icon _k_.** The staff draws a note as sprite 228 +
  voice byte (`+0x4C98`). The tone bank agrees independently:
  - icons 32-35 are square, saw, sine and triangle waves, and voices 32-35 are
    the only four with noise 0.00 in `bgm-voices.json`;
  - icons 48-51 are cymbals, and voices 48-51 are the four noisiest (0.92-0.96).
- **Keys:** ctrl3 0-11 = A, A#, B, C, C#, D, D#, E, F, F#, G, G#. These come
  from the letter and sharp tables at `+0x13584` and `+0x13590`. So ctrl3 = 3,
  the value every new measure gets, is **C**. That answers the "chord root at
  ctrl3 = 3" half of spike S5.
- **Mood:** the face is (ctrl2 & 0x7F) >> 1, 0-4. The step code read here moves
  it by 2 and ORs bit 7 back in, so it writes only even values. An odd ctrl2
  (bit 0, seen in 533 cart measures) would draw the "odd" sprites #43-#51
  instead of a face. Which 音まろ action, if any, writes bit 0 is still unknown.
- **Bass toggle:** one button flips ctrl2 bit 7 and the visibility of sprite #35
  together (`+0x20D0`).
- **Band:** the picture is #63 + ctrl0. Band 0 is a metronome, which fits the
  plan's "bank 0 = drums only". Stepping down from 0 wraps to 8.
- **Clearing a song** (`+0x0690`) zeroes the slot and then:
  - writes the header `00 1F 03 0F`;
  - gives all 32 measures `00 00 80 03`.

  That is byte-for-byte `emptySong()` in `src/write/game-to-save.js`, so spike
  S3's default for a new song is what the console does.
- **Sample songs.** The song index (`0x06079CE0`) runs 0-96 and wraps:
  - 0-23 are the save's own 24 slots;
  - 24-96 load `M_DATA01`-`M_DATA73.BIN`, so SS-25 is `M_DATA01`.

  The 79-entry table at `+0x561C` that spike S4 was pointed at is **file
  names**, stored `M_DATA79` down to `M_DATA01`, not song names. Entries 74-79
  cannot be reached, and those files are not on the disc. The JSON's
  `sampleSongFiles` keeps the mapping. How the song number is drawn was not
  traced.

### Not proven

- **Which help line belongs to which button** is matched by wording, not traced
  through the hit boxes. The match is clean for リズム → band, 伴奏の雰囲気 →
  the faces and 伴奏の音の高低 → the key letters. It is weaker for ベースの種類
  → ctrl2 bit 7. That button is the one accompaniment control left over, and its
  picture is a bass guitar, so it is a strong lead for spike S2 but not a proof.
- **Dynamics.** 音色に強弱を付けます means 音まろ can give notes dynamics. Where
  that lives in the song bytes is not known yet.
- **Where things sit on the screen.** No running console was observed: the
  Mednafen pass was skipped. The layout above comes from the sprite set, the
  help lines and the code, not from a screenshot.
- **Nine icons and three band pictures** are left `null` in the descriptions
  because the picture is ambiguous at 16×16 or 32×24.
