# How a save turns into a game

A Dezaemon 2 save is one big blob of numbers. This page shows, for each kind of
thing in a game, **which numbers become it and which line of code does the
turning**. Every example below is real: the bytes are from a real save, and the
outputs were produced by running the decoder.

If you want the full field-by-field reference instead, that is
[FORMAT.md](FORMAT.md). This page is the friendly tour.

## The idea

Think of a save as a **treasure chest with eight boxes inside**. Each box is
squashed flat to save room, so the first job is to un-squash it (that is
`src/decompress.js`, an old trick called LZSS). Then each box gets its own
reader in `src/decode/`.

| Box | What is inside                                                     | Who reads it                                                                                      |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 0-3 | the drawings, as numbered dots                                     | `decode-cg.js`                                                                                    |
| 4   | the paint pots (colours)                                           | `decode-cg.js`                                                                                    |
| 5   | almost everything else: levels, enemies, bosses, sprites, settings | `decode-stage.js`, `decode-enemy.js`, `decode-boss.js`, `decode-sprites.js`, `decode-settings.js` |
| 6   | the music                                                          | `decode-song.js`                                                                                  |
| 7   | the 3D shapes                                                      | `decode-model.js`                                                                                 |

**All the offsets on this page count from the start of an un-squashed box**, not
from the start of the file. To follow along yourself, see
[Try it](#try-it-yourself) at the bottom.

## 1. A colour

> Box 4 · bytes `0x2E`-`0x2F` · from `ramsie.sav`

```
03 E0   →   red 0, green 255, blue 0   (bright green)
```

Box 4 is the paint set: 16 rows of 16 pots, two bytes each. Those two bytes are
really 16 tiny on/off switches. Fifteen of them are shared out in three groups
of five — five for red, five for green, five for blue. Here every red switch is
off and every green switch is on. Five switches can count to 31, so 31 means "as
bright as green goes", and it is stretched up to 255.

```js
// decode-cg.js:63 — glue the two bytes into one number
const raw = (sec4[off] << 8) | sec4[off + 1];
// decode-cg.js:42 — stretch green's 5 bits up to 8
g: (g5 << 3) | (g5 >> 2),
```

## 2. A dot of a drawing

> Box 0 · byte `0x38` · from `ramsie.sav`

```
AD   →   paint box 10, pot 13   →   #313110 (a dark brown-green)
```

Every dot of every picture is one number from 0 to 255. Cut it in half. The top
half says **which box of crayons**, the bottom half says **which crayon in it**.
`0xAD` is 10 and 13, so: box 10, crayon 13. Then look that crayon up the way
example 1 did.

```js
// decode-cg.js:105
const color = palettes[v >> 4].colors[v & 0x0f];
```

## 3. A sprite

> Box 5 · bytes `0x5D660`-`0x5D667` · from `ramsie.sav`

```
00 02 00 03 00 04 00 05   →   a 16x16 sprite, 4 frames, using tiles 2, 3, 4, 5
```

The drawings are cut into **16x16 squares called cells**, all numbered. A sprite
does not hold any picture of its own — it just lists cell numbers, two bytes
each. This one lists four, so it is a four-frame animation, one cell per frame.
Two spare bits in each number can flip the cell like a mirror; none are set
here.

```js
// decode-sprites.js:78 — the low 10 bits are the cell number
cell: word & 0x3ff,
```

## 4. An enemy

> Box 5 · bytes `0x5A9C6`-`0x5A9D7` (18 bytes) · from `ramsie.sav`

```
04 14 0a 00 04 00 50 41 00 70 00 00 00 11 00 00 00 00
      ↑  ↑
      │  └─ byte 2 = 0x0A → toughness
      └──── byte 1 = 0x14 → points
```

Enemies do not store their health or their points directly. They store a **spot
in a list**, which is much smaller. Byte 2's last three bits are `2`, and slot 2
of the health list is 2560. Byte 1's middle bits are `1`, and slot 1 of the
points list is 100.

```js
// decode-enemy.js:212
hp: HP_TABLE[b[2] & 7],
// decode-enemy.js:214
score: SCORE_TABLE[(b[1] >> 4) & 7],
```

## 5. A boss

> Box 5 · bytes `0x5B980`-`0x5B981` · stage 3 of `ramsie.sav`

```
62 45   →   3 health bars, worth 100,000 points
```

After a stage's 60 enemies comes a 64-byte block for its boss. Byte 0's bits 4-5
are `2`, and the reader adds one, so the boss has **3** health bars. Byte 1's
bits 4-6 are `4`, and slot 4 of the boss points list is 100,000.

```js
// decode-boss.js:170
hpStages: ((t[0] >> 4) & 3) + 1,
// decode-boss.js:174
score: BOSS_SCORE_TABLE[(t[1] >> 4) & 7],
```

## 6. A background tile

> Box 5 · bytes `0x02F4`, `0x0300`, `0x030E` · stage 0 of `ramsie.sav`

```
02 78   →   tile 632
ff ff   →   nothing at all
42 78   →   tile 632, mirrored left-to-right
```

The background is a grid, two bytes per square. `FFFF` is the special "leave
this empty" word. Otherwise the low bits are the cell number and two high bits
mirror it — which is how one drawing fills both edges of a row.

```js
// decode-stage.js:53
cell: word & 0x3ff,
```

## 7. A setting: the ship's weapons

> Box 5 · bytes `0x5A794`-`0x5A795` · from `ramsie.sav`

```
21 D1   →   MAIN 2, SUB 1, CHARGE 1, BOMB 5 (+variant)
            VULCAN B · H-MISSILE · CANNON · EDIT B
```

Two bytes hold four choices, because each choice is small enough to live in a
few bits. `0x21` is `2` on top and `1` underneath; `0xD1` gives the bomb on top
and the charge underneath.

```js
// decode-settings.js:201
main: (b0 >> 4) & 7,
```

> Careful: MAIN is the **top** half of byte 0 and SUB the bottom. These two were
> the wrong way round in this codebase until 2026-09-02 — see FORMAT.md at
> settings `+0x14` for how the game's own editor settled it.

## 8. A musical note

> Box 6 · bytes `0x08` and `0x18` · from `ramsie.sav`

```
3a (instrument)  +  1e (pitch)   →   note 30 on instrument 58, held 8 steps
```

Music is a grid of steps. Each step keeps its **instrument** and its **pitch**
in two separate columns, 16 bytes apart. A `0x80` in the instrument column means
"keep holding the last note", so seven of them stretch this note over 8 steps —
about 1.13 seconds at this song's speed, sounding as F4.

```js
// decode-song.js:87
current = { step: at, note: pitch, instrument: voice, len: 1 };
```

## 9. A 3D shape

> Box 7 · bytes `0x08`-`0x09` and `0x10`-`0x13` · from `mucha-kucha.sav`

```
50 05         →   shape catalogue page 5, shape 5 = a triangular pyramid
ff ec 00 00   →   y = -20 (twenty steps below the middle)
```

A model is built from up to nine ready-made pieces. Two bytes name the piece:
the first digit picks a page of the catalogue, the last picks the shape on it.
Positions are stored multiplied by 65536 so they can hold fractions — divide by
65536 to get the real number back.

```js
// decode-model.js:95
shapeFamily: (shape >> 12) & 0xf,
```

(Not every save has models. `ramsie.sav` has none — its box 7 is missing the
`12 34 56 78` marker, so the reader returns nothing.)

## Try it yourself

Run this from the **repo root** — the import paths are relative to it:

```bash
deno eval --no-check '
import { normalize } from "./packages/shmup-engine/src/bup-source.js";
import * as bup from "./packages/shmup-engine/src/bup-parse.js";
import { decodeSave } from "./packages/shmup-engine/src/decode/index.js";
const { data } = await normalize(await Deno.readFile("packages/shmup-engine/fixtures/ramsie.sav"));
const d = decodeSave(bup.parse(data).find((s) => s.payload).payload.buffer);
const box5 = d.sections[5].decompressed;
console.log("weapons:", d.settings.loadouts[0]);
console.log("bytes:  ", box5[0x5A794].toString(16), box5[0x5A795].toString(16));
'
```

Every `d.sections[i].decompressed` is the un-squashed box, so you can check any
offset on this page by hand.

## Notes

- Line numbers drift as the code changes. The quoted line is the real anchor —
  `grep` for it if a number no longer matches.
- Some decoders are CRLF files (`decode-cg.js` among them), so patch them by
  matching text, not by line number.
- Saves are personal content and are gitignored. Put yours in `dev-fixtures/`.
- The **game disc** is a separate thing with its own reader:
  [`tools/deza-disc`](../../tools/deza-disc/README.md) lists it, un-squashes it
  and renders its screens.
