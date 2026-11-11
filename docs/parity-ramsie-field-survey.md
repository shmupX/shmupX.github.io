# Ramsie: the Saturn against the web, stage 0

Built from `panes/web.survey.json` with the roster of `rush.json`, against a SAVED READING of the Saturn — run 1, the cart surveyed 2026-10-26 (ramsie-sav-full), transcribed from the tables of docs/parity-ramsie-survey.md: seconds to 0.1, a record's lives as their mean, no spawn counts, and positions only where README-Parity.md quotes one — not a Saturn run of this one: the Saturn pane plays the original cart whatever the web does, so the reading stands until the cart is surveyed again. It was read on the Saturn's kept clock (600 samples inside 60.1 kept seconds of a 218 s wall run); the web is one take (613 samples, 61.9 s). A record's first appearance is compared by scroll position after the web's 0 px gate lead, with 16 px of tolerance; a bullet kind is what fired it and what it is drawn with.

**Verdict: FAIL** — 1 finding(s), listed last.

## The runs

| | Saturn | Web |
| --- | --- | --- |
| Source | cart (saved reading) | import |
| Seconds | 60.1 kept of 218 wall | 61.9 |
| Samples | 600 | 613 |
| Scroll | 39 → 2686 | 3 → 2751 |
| Scroll px/s | 44.3 (42.5–45.0) | 44.4 |
| Live objects (max) | 91 with hp (152 slots) | 31 |
| Enemy bullets seen | 72 | 77 |

- Saturn: at the rewinds 30 logged birth(s) were objects carried over and 4 spawn(s) the sampler missed were added from the samples
- web: the web survey keeps the ship's shoot mode, not its projectiles

## Records

First seen = the first birth under the record's placement id (seconds on the side's clock / scroll px). Δ = web − Saturn scroll; after lead = Δ + 0. Bullets = enemy bullets attributed to the record per 1,000 scroll px of the side's run (a big shot shared among the letters that fire the same record). Life = mean seconds a spawn stayed on the field: the Saturn's on its kept clock until the object has left the 320×224 frame and stopped (the engine parks what has exited just past the edge), the web's until the runtime removed it; a life still running at the last sample is counted to there. Rows in order of first appearance on the web's scroll axis.

| Id | Letter | Name | Rec | Fire | Saturn first | Web first | Δ | After lead | Bullets S / W | Life S / W | Art S / W | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 130 | C | deza0_02 | 2 | type 0 / 119 | 6.8 s / 340 | 7.4 s / 337 | -3 | -3 | 0.0 / 0.0 | 1.5 / 0.9 | sprite 75 / 4 (deza0_02_0.gif …) | ok |
| 208 | AA (ground) | deza0_52 | 52 | type 0 / 119 | 17.1 s / 787 | 10.3 s / 467 | -320 | -320 | 0.0 / 0.7 | 0.8 / 2.7 | sprite 267 / deza0_52_0.gif, deza0_52_1.gif | **FAIL** first seen -320 px after the 0 px lead |
| 209 | AB | deza0_53 | 53 | type 0 / 119 | 9.8 s / 468 | 10.3 s / 467 | -1 | -1 | 1.9 / 2.2 | 4.0 / 4.0 | sprite 269 / deza0_53_0.gif, deza0_53_1.gif | ok |
| 176 | P | deza0_32 | 32 | type 0 / 119 | 16.7 s / 769 | 17.9 s / 772 | 3 | +3 | 1.1 / 0.4 | 2.7 / 2.2 | sprite 195 / 4 (deza0_32_0.gif …) | ok |
| 182 | V | deza0_38 | 38 | type 3 / 59 → rec 1 | 17.4 s / 801 | 18.6 s / 803 | 2 | +2 | 3.0 / 2.2 | 4.2 / 2.9 | sprite 219 / 3 (deza0_38_0.gif …) | ok |
| 135 | H | deza0_07 | 7 | type 3 / 59 → rec 3 | 21.8 s / 995 | 22.8 s / 992 | -3 | -3 | 3.0 / 2.9 | 33.1 / 4.7 | sprite 95 / 4 (deza0_06_0.gif …) | ok |
| 163 | N | deza0_27 | 27 | type 0 / 119 | 24.0 s / 1091 | 25.0 s / 1091 | 0 | 0 | 0.0 / 0.0 | 5.7 / 2.2 | sprite 175 / 4 (deza0_27_0.gif …) | ok |
| 164 | O | deza0_28 | 28 | type 0 / 119 | 24.0 s / 1091 | 25.0 s / 1091 | 0 | 0 | 0.0 / 0.0 | 4.4 / 2.7 | sprite 179 / 4 (deza0_28_0.gif …) | ok |
| 224 | AD | deza0_56 | 56 | type 3 / 29 → rec 24 (no-fire bit) | 25.4 s / 1152 | 26.4 s / 1154 | 2 | +2 | 0.4 / 0.4 | 2.2 / 2.4 | sprite 275 / deza0_56_0.gif | ok |
| 134 | G | deza0_06 | 6 | type 0 / 119 | 26.6 s / 1203 | 27.5 s / 1204 | 1 | +1 | 0.0 / 0.0 | 0.8 / 1.3 | sprite 91 / 4 (deza0_06_0.gif …) | ok |
| 128 | A | deza0_00 | 0 | — | 36.6 s / 1632 | 37.1 s / 1636 | 4 | +4 | 0.0 / 0.0 | 6.3 / 6.5 | sprite 67 / 4 (deza0_00_0.gif …) | ok |
| 129 | B | deza0_01 | 1 | type 0 / 59 | 36.6 s / 1632 | 37.1 s / 1636 | 4 | +4 | 1.5 / 0.0 | 2.7 / 2.7 | sprite 71 / 4 (deza0_00_0.gif …) | ok; key 129 is also V's big shots (record 1): births within 12 px of a live V counted as shots |
| 162 | M | deza0_26 | 26 | type 0 / 119 | 43.1 s / 1923 | 43.5 s / 1923 | 0 | 0 | 0.4 / 0.0 | 15.8 / 2.3 | sprite 171 / 4 (deza0_26_0.gif …) | ok |
| 132 | E | deza0_04 | 4 | type 3 / 11 → rec 13 | 43.8 s / 1955 | 44.2 s / 1954 | -1 | -1 | 3.4 / 7.3 | 1.1 / 2.2 | sprite 83 / 4 (deza0_02_0.gif …) | ok |
| 183 | W | deza0_39 | 39 | type 0 / 119 | 49.1 s / 2193 | 49.5 s / 2193 | 0 | 0 | 0.0 / 0.0 | 2.8 / 2.7 | sprite 223 / 4 (deza0_39_0.gif …) | ok |
| 210 | AC | deza0_54 | 54 | type 0 / 119 | 49.1 s / 2193 | 49.5 s / 2193 | 0 | 0 | 1.1 / 0.7 | 3.5 / 3.2 | sprite 271 / deza0_53_0.gif, deza0_53_1.gif | ok |
| 192 | Y | deza0_48 | 48 | type 3 / 3 → rec 5 | 54.4 s / 2433 | 54.9 s / 2436 | 3 | +3 | 5.7 / 4.4 | 1.3 / 1.2 | sprite 259 / deza0_48_0.gif, deza0_48_1.gif | ok |
| 193 | Z | deza0_49 | 49 | type 3 / 3 → rec 5 | 54.4 s / 2433 | 54.9 s / 2436 | 3 | +3 | 5.7 / 6.9 | 1.6 / 1.6 | sprite 261 / deza0_49_0.gif, deza0_49_1.gif | ok |
| 131 | D | deza0_03 | 3 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | no cell places it: H's big shots, counted under the bullet kinds |
| 133 | F | deza0_05 | 5 | type 0 / 29 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | no cell places it: Y/Z's big shots, counted under the bullet kinds |
| 141 | I | deza0_13 | 13 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | no cell places it: E's big shots, counted under the bullet kinds |
| 142 | J | deza0_14 | 14 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 143 | K | deza0_15 | 15 | type 0 / 3 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 160 | L | deza0_24 | 24 | type 0 / 59 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | no cell places it: AD's big shots, counted under the bullet kinds |
| 177 | Q | deza0_33 | 33 | type 2 / 29 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 178 | R | deza0_34 | 34 | type 2 / 29 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 179 | S | deza0_35 | 35 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 180 | T | deza0_36 | 36 | type 0 / 59 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 181 | U | deza0_37 | 37 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 184 | X | deza0_40 | 40 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |

Big-shot records (what the type-3 shooters build their shots from):

- record 13 (key 141, character 119) fired by E
- record 3 (key 131, character 79) fired by H
- record 1 (key 129, character 71) fired by V — the key of a placed record too
- record 5 (key 133, character 87) fired by Y/Z
- record 24 (key 160, character 163) fired by AD

## Bullet kinds

| Kind | Drawn as | Saturn | Web | Fired by | Note |
| --- | --- | --- | --- | --- | --- |
| big shot (record 5) | record 5 cells | 30 | 31 | Y/Z (web: Z 19, Y 12) | both sides |
| big shot (record 13) | record 13 cells | 9 | 20 | E | both sides |
| type 0 | dezaBullet0 | 16 | 11 | Saturn AB 5, B 4, AC 3, P 3, M 1; web AB 6, AA 2, AC 2, P 1 | both sides |
| big shot (record 3) | record 3 cells | 8 | 8 | H | both sides |
| big shot (record 1) | record 1 cells | 8 | 6 | V | key 129 is also a placed record's; shots told from spawns by proximity |
| big shot (record 24) | record 24 cells | 1 | 1 | AD | fewer than 2 births; not judged |

## Ground starts and exits

What the surveys say about the two rules still unread in the engine (README-Parity.md, T21). A ground record's first logged position on each side, in the engine's scroll coordinate (0 at the entry edge of a vertical game's screen, 224 at the exit edge), beside where its own map row stood at that scroll: `− row` is the offset the object keeps from the terrain it is painted on. Gate = the scroll at which the walker reaches the row. The web's coordinate is read only on a Saturn field, where its pixels are the engine's.

| Letter | Rec | Band | Row | Gate | Saturn first: scroll / at / row at / − row | Web first: scroll / at / row at / − row |
| --- | --- | --- | --- | --- | --- | --- |
| AA | 52 | 5 (32x64) | 46 | 464 | 787 / 283 / 275 / +8 | 467 / -37 / -45 / +8 |

Where the Saturn's spawns stopped after leaving the frame (the engine parks an object just past its own bound):

| Band | Edge | Spawns | Stopped at |
| --- | --- | --- | --- |
| 5 (32x64) | exit edge | 1 | 315.0 |

## The ship

Saturn: objects born in player 1's shot slots and the pod slots.

| Art | Slots | Attack | Births | First s | Last s |
| --- | --- | --- | --- | --- | --- |
| sprite 15 | 4-33 | 6656 | 11 | 1.4 | 33.8 |
| sprite 21 | 68, 69 | 13312 | 4 | 1.4 | 33.8 |
| sprite 25 | 68 | 15360 | 1 | 31.5 | 31.5 |
| sprite 26 | 64, 65, 66, 67, 69 | 256 | 5 | 31.6 | 31.7 |
| sprite 18 | 4-33 | 320 | 8 | 31.7 | 32.0 |
| sprite 19 | 4-33 | 448, 0 | 4 | 34.5 | 34.7 |
| sprite 27 | 4-33 | 8960 | 12 | 40.1 | 42.8 |

Web: the ship's shoot mode over the run (its projectiles are not surveyed; `playerData` draws them as normal bigProjectile_*, big bigProjectile*, 3way hadoken*).

| Mode | From s | To s |
| --- | --- | --- |
| normal/speed_normal | 0.0 | 29.9 |
| 3way/speed_normal | 29.9 | 53.5 |
| big/speed_normal | 53.5 | 61.9 |

## Items (web)

12 item births — 3way 8, big 2, dezaSp 2 — 6 of them landing on the spot of the one before (a death-word drop arriving twice). The Saturn survey does not name items.

## Verdict

**FAIL** — 1 finding(s):

- AA: first seen -320 px after the 0 px lead

Not judged:

- bullet kind "big shot (record 24) drawn as record 24 cells": fewer than 2 births; not judged
