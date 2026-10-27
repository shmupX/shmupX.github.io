# Ramsie: the Saturn against the web, stage 0

Built from `panes/saturn.survey.json` and `panes/web.survey.json` with the roster of `rush.json`. The Saturn is read on its kept clock (600 samples inside 60.1 kept seconds of a 218 s wall run); the web is one take (622 samples, 62.1 s). A record's first appearance is compared by scroll position after the web's 240 px gate lead, with 16 px of tolerance; a bullet kind is what fired it and what it is drawn with.

**Verdict: FAIL** — 9 finding(s), listed last.

## The runs

| | Saturn | Web |
| --- | --- | --- |
| Source | cart | import |
| Seconds | 60.1 kept of 218 wall | 62.1 |
| Samples | 600 | 622 |
| Scroll | 39 → 2686 | 2 → 2797 |
| Scroll px/s | 44.3 (42.5–45.0) | 45.0 |
| Live objects (max) | 91 with hp (152 slots) | 49 |
| Enemy bullets seen | 72 | 174 |

- Saturn: at the rewinds 30 logged birth(s) were objects carried over and 4 spawn(s) the sampler missed were added from the samples
- web: the web survey keeps the ship's shoot mode, not its projectiles

## Records

First seen = the first birth under the record's placement id (seconds on the side's clock / scroll px). Δ = web − Saturn scroll; after lead = Δ + 240. Bullets = enemy bullets attributed to the record per 1,000 scroll px of the side's run (a big shot shared among the letters that fire the same record). Life = mean seconds a spawn stayed on the field: the Saturn's on its kept clock until the object has left the 320×224 frame and stopped (the engine parks what has exited just past the edge), the web's until the runtime removed it; a life still running at the last sample is counted to there. Rows in order of first appearance on the web's scroll axis.

| Id | Letter | Name | Rec | Fire | Saturn first | Web first | Δ | After lead | Bullets S / W | Life S / W | Art S / W | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 130 | C | deza0_02 | 2 | type 0 / 119 | 6.8 s / 340 | 2.1 s / 97 | -243 | -3 | 0.0 / 1.4 | 1.5 / 1.8 | sprite 75 / 4 (deza0_02_0.gif …) | ok |
| 208 | W (ground) | deza0_52 | 52 | type 0 / 119 | 17.1 s / 787 | 5.0 s / 227 | -560 | -320 | 0.0 / 6.1 | 0.8 / 6.6 | sprite 267 / deza0_52_0.gif, deza0_52_1.gif | **FAIL** first seen -320 px after the 240 px lead |
| 209 | X | deza0_53 | 53 | type 0 / 119 | 9.8 s / 468 | 5.0 s / 227 | -241 | -1 | 1.9 / 6.8 | 4.0 / 7.1 | sprite 269 / deza0_53_0.gif, deza0_53_1.gif | ok |
| 176 | L | deza0_32 | 32 | type 0 / 119 | 16.7 s / 769 | 11.7 s / 529 | -240 | 0 | 1.1 / 2.1 | 2.7 / 3.6 | sprite 195 / 4 (deza0_32_0.gif …) | ok |
| 182 | R | deza0_38 | 38 | type 3 / 59 → rec 1 | 17.4 s / 801 | 12.4 s / 561 | -240 | 0 | 3.0 / 3.6 | 4.2 / 5.8 | sprite 219 / 4 (deza0_38_0.gif …) | ok |
| 135 | F | deza0_07 | 7 | type 3 / 59 → rec 3 | 21.8 s / 995 | 16.7 s / 754 | -241 | -1 | 3.0 / 5.7 | 33.1 / 9.4 | sprite 95 / 4 (deza0_06_0.gif …) | ok |
| 163 | J | deza0_27 | 27 | type 0 / 119 | 24.0 s / 1091 | 18.8 s / 848 | -243 | -3 | 0.0 / 0.0 | 5.7 / 4.4 | sprite 175 / 4 (deza0_27_0.gif …) | ok |
| 164 | K | deza0_28 | 28 | type 0 / 119 | 24.0 s / 1091 | 18.8 s / 848 | -243 | -3 | 0.0 / 0.0 | 4.4 / 9.8 | sprite 179 / 4 (deza0_28_0.gif …) | ok |
| 224 | Z | deza0_56 | 56 | type 3 / 39 → rec 24 (no-fire bit) | 25.4 s / 1152 | 20.2 s / 912 | -240 | 0 | 0.4 / 0.0 | 2.2 / 3.2 | sprite 275 / deza0_56_0.gif | ok |
| 134 | E | deza0_06 | 6 | type 0 / 119 | 26.6 s / 1203 | 21.3 s / 961 | -242 | -2 | 0.0 / 0.0 | 0.8 / 2.1 | sprite 91 / 4 (deza0_06_0.gif …) | ok |
| 128 | A | deza0_00 | 0 | — | 36.6 s / 1632 | 30.9 s / 1393 | -239 | +1 | 0.0 / 0.0 | 6.3 / 9.4 | sprite 67 / 4 (deza0_00_0.gif …) | ok |
| 129 | B | deza0_01 | 1 | type 0 / 59 | 36.6 s / 1632 | 30.9 s / 1393 | -239 | +1 | 1.5 / 0.0 | 2.7 / 3.5 | sprite 71 / 4 (deza0_00_0.gif …) | ok; key 129 is also R's big shots (record 1): births within 12 px of a live R counted as shots |
| 162 | I | deza0_26 | 26 | type 0 / 119 | 43.1 s / 1923 | 37.3 s / 1681 | -242 | -2 | 0.4 / 0.0 | 15.8 / 2.8 | sprite 171 / 4 (deza0_26_0.gif …) | ok |
| 132 | D | deza0_04 | 4 | type 3 / 11 → rec 13 | 43.8 s / 1955 | 38.0 s / 1713 | -242 | -2 | 3.4 / 16.5 | 1.1 / 5.1 | sprite 83 / 4 (deza0_02_0.gif …) | ok |
| 183 | S | deza0_39 | 39 | type 0 / 119 | 49.1 s / 2193 | 43.4 s / 1955 | -238 | +2 | 0.0 / 0.0 | 2.8 / 5.2 | sprite 223 / 4 (deza0_39_0.gif …) | ok |
| 210 | Y | deza0_54 | 54 | type 0 / 119 | 49.1 s / 2193 | 43.4 s / 1955 | -238 | +2 | 1.1 / 1.8 | 3.5 / 5.7 | sprite 271 / deza0_53_0.gif, deza0_53_1.gif | ok |
| 192 | U | deza0_48 | 48 | type 3 / 3 → rec 5 | 54.4 s / 2433 | 48.7 s / 2194 | -239 | +1 | 5.7 / 11.8 | 1.3 / 2.3 | sprite 259 / deza0_48_1.gif, deza0_48_0.gif | ok |
| 193 | V | deza0_49 | 49 | type 3 / 3 → rec 5 | 54.4 s / 2433 | 48.7 s / 2194 | -239 | +1 | 5.7 / 6.4 | 1.6 / 1.6 | sprite 261 / deza0_49_1.gif, deza0_49_0.gif | ok |
| 184 | T | deza0_40 | 40 | type 0 / 119 | — | 59.4 s / 2676 | — | — | 0.0 / 0.0 | — / 2.5 | — / 3 (deza0_40_0.gif …) | beyond the Saturn's run |
| 142 | G | deza0_14 | 14 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 143 | H | deza0_15 | 15 | type 0 / 3 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 177 | M | deza0_33 | 33 | type 2 / 29 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 178 | N | deza0_34 | 34 | type 2 / 29 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 179 | O | deza0_35 | 35 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 180 | P | deza0_36 | 36 | type 0 / 59 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |
| 181 | Q | deza0_37 | 37 | type 0 / 119 | — | — | — | — | 0.0 / 0.0 | — / — | — / — | not seen on either side |

Big-shot records (what the type-3 shooters build their shots from):

- record 13 (key 141, character 119) fired by D
- record 3 (key 131, character 79) fired by F
- record 1 (key 129, character 71) fired by R — the key of a placed record too
- record 5 (key 133, character 87) fired by U/V
- record 24 (key 160, character 163) fired by Z

## Bullet kinds

| Kind | Drawn as | Saturn | Web | Fired by | Note |
| --- | --- | --- | --- | --- | --- |
| type 0 | dezaBullet0 | 16 | 51 | Saturn X 5, B 4, Y 3, L 3, I 1; web X 19, W 17, L 6, Y 5, C 4 | both sides |
| big shot (record 5) | normalProjectile | 0 | 51 | U/V (web: U 33, V 18) | web only |
| big shot (record 13) | normalProjectile | 0 | 46 | D | web only |
| big shot (record 5) | record 5 cells | 30 | 0 | U/V | Saturn only |
| big shot (record 3) | normalProjectile | 0 | 16 | F | web only |
| big shot (record 1) | normalProjectile | 0 | 10 | R | web only; key 129 is also a placed record's; shots told from spawns by proximity |
| big shot (record 13) | record 13 cells | 9 | 0 | D | Saturn only |
| big shot (record 1) | record 1 cells | 8 | 0 | R | Saturn only; key 129 is also a placed record's; shots told from spawns by proximity |
| big shot (record 3) | record 3 cells | 8 | 0 | F | Saturn only |
| big shot (record 24) | record 24 cells | 1 | 0 | Z | fewer than 2 births; not judged |

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
| normal/speed_normal | 0.0 | 25.6 |
| 3way/speed_normal | 25.6 | 50.8 |
| big/speed_normal | 50.8 | 62.1 |

## Items (web)

16 item births — 3way 8, big 4, dezaSp 2, barrier 2 — 8 of them landing on the spot of the one before (a death-word drop arriving twice). The Saturn survey does not name items.

## Verdict

**FAIL** — 9 finding(s):

- W: first seen -320 px after the 240 px lead
- bullet kind "big shot (record 5) drawn as normalProjectile" on the web only (51 births)
- bullet kind "big shot (record 13) drawn as normalProjectile" on the web only (46 births)
- bullet kind "big shot (record 5) drawn as record 5 cells" on the Saturn only (30 births)
- bullet kind "big shot (record 3) drawn as normalProjectile" on the web only (16 births)
- bullet kind "big shot (record 1) drawn as normalProjectile" on the web only (10 births)
- bullet kind "big shot (record 13) drawn as record 13 cells" on the Saturn only (9 births)
- bullet kind "big shot (record 1) drawn as record 1 cells" on the Saturn only (8 births)
- bullet kind "big shot (record 3) drawn as record 3 cells" on the Saturn only (8 births)

Not judged:

- T: beyond the Saturn's run
- bullet kind "big shot (record 24) drawn as record 24 cells": fewer than 2 births; not judged
