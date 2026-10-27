# Weapon-system parity: the web runtime and the consoles

What each Dezaemon this repo exports to lets a player fire and pick up,
what the web runtime (2028-ai) and the PS2 port do today, and what it would
take to let an author hand out **any Dezaemon weapon as an item drop** and
have it mean the same thing on every target that can carry it. Written
2026-10-26 from the FORMAT documents, the writers, the runtime bundle and
a decode of the Ramsie cart; the Saturn-side gaps it leans on are itemised
in [README-Parity.md](README-Parity.md) §4.

Two words used throughout: a **loadout** is the Saturn's 2-byte preset
(MAIN, SUB, CHARGE, BOMB) of which a cart holds four and a ship starts on
one; an **item slot** is one of the Saturn's eight settings bytes, each
naming an effect type and a movement, which a death word or a placed
pickup refers to by number.

## 1. The web runtime today

Two weapon layers run at once on an import.

**The stock 2028.Ai layer** is always on: `playerData.shootNormal /
shootBig / shoot3way` picked by `p.shootMode` (`normal`, `big`, `3way`),
`shootSpeed` (`speed_high` = interval × 0.6), a 4-second `barrier`, the SP
gauge that every kill feeds and the cut-in special it fires. Autofire runs
at `shootNormal.interval` (Duke's 23 ticks). On an import this layer is the
declared stand-in for the SUB weapon.

**The Dezaemon kit** (`dezaKit(scene)`: `meta.dezaemonSettings` on a cart,
`DEZA_CROSSOVER_KIT` — one preset, MAIN 1 / OPTION A / CHARGE 1 / no bomb —
on a web game in MOD or with `?dezaWeapons=1`) implements, with the traced
tables and cadences:

| Family | Values | State |
| --- | --- | --- |
| MAIN | 1 VULCAN A, 2 VULCAN B, 3 MISSILE, 4 HOMING, 5 SHADOW, 6 WAVE, 7 BOUND | implemented (`fireDezaMain`); homing links drawn as a trail; a boss never bounces the WAVE ball |
| SUB | 1 H-MISSILE, 2 S-MISSILE, 3 G-MISSILE, 4 RF-LASER | **not implemented** — the stock autofire stands in |
| SUB | 5 OPTION A, 6 OPTION B, 7 OPTION C | implemented (`updateDezaPods`); A's ring widening on its own key |
| CHARGE | 1 CANNON, 2 LASER, 3 FIRE | implemented, on its own input (SHIFT / shoulder) since the ship autofires |
| BOMB | 1-7 + variant → behaviours 1-8 | implemented, drawn as Graphics shapes; stock 3, seed untraced |

The level every table indexes is the OPTION count (0-4,
`dezaShotLevel`), the power level (0-7) is kept in `dezaPower` and read by
nothing (and seeded as `min(4, initialPower)` where the cap is 7). The
loadout index is taken once from `meta.dezaemonSettings.startLoadout[i]`
when it is unset and never changes afterwards. Every sprite-drawn MAIN
shot, pod and CHARGE 1/3 shot is drawn with
`playerBulletFrames(pd.shootNormal)` — Duke's bolt; CHARGE 2's laser,
MAIN 5's column and the homing tails are rectangles in a shared Graphics
layer, and bombs are shapes. The cart's own weapon art (global bank refs
48-93) is not extracted at all: `extractGlobalArt` reads refs 0-47
(ships), 94-101 (icons), 102-131 (blasts) and 132-143 (bullets), and the
`GLOBAL_WEAPON_SLOTS` map in `decode-sprites.js` is the cart writer's
painting map, used on export to put a web game's shot frames into those
refs.

**The item pipeline** is a name string end to end. A grid cell's last
digit (`enemylist` `"C1"`) or a death-word slot becomes `enemy.itemName`
through one table in two copies (`ITEM_TYPE_DROPS` in `decode-stage.js`,
`DROP_BY_TYPE` in `deathWordItemName`):

| Saturn item type | Digit | Web name | `collectItem` on an import |
| --- | --- | --- | --- |
| 0-3 weapon change → preset 0-3 | 2 | `3way` | stock `shootMode = "3way"`; **the loadout does not change** |
| 4 barrier (persists across respawns) | 9 | `barrier` | 4-second barrier sprite |
| 5 bomb stock +1 (cap 99) | 5 | `dezaSp` | `dezaBombStock + 1` when a bomb is armed, else SP gauge +34 |
| 6 score bonus (`+0x24` value) | 4 | `dezaScore` | score += `dezaemonItems.score` |
| 7 power-up = +1 OPTION | 1 | `big` | `dezaOptions + 1` (capped) **and** stock `shootMode = "big"` |
| 8 speed-up = +1 POWER | 3 | `speed_high` | `dezaPower + 1` (capped, unread) **and** stock interval × 0.6 |

So four distinct weapon changes arrive as one name, three distinct slots
of one type cannot be told apart except by icon, digits 6/7/8 are unused,
every drop falls at 1 px per tick (the three Saturn movements are decoded
and ignored), a standalone pickup (placement `0xE8-0xEF`) is hung on the
nearest enemy of its column, the stock `big` and `3way` pickups reset
`shootSpeed` so a Saturn speed-up is undone by the next power-up or weapon
change, and a death-word item is dropped **twice**: the importer bakes it
into the wave cell's digit (`decode-stage.js` `deathDrop`, cycling slot 9
per placement at import) and the runtime runs the death word again at the
kill with its own per-kill counter (`runDeathWord`), so Ramsie's record 6
drops two items at one spot where the engine's single global counter drops
one. Icons do travel: `dezaemonItems.icons[slot]` and `iconByDrop`, with
the F/S/R/B emblem recognition for art the cart writer painted. Ramsie's
own slot table has no score slot (type 6), so its `dezaScore` row never
fires on this cart.

**The record schema** (`packages/shmup-engine/src/game-schema.js`)
validates `playerData`'s shot blocks and cell digits 0-9 and nothing about
items, loadouts or `meta.dezaemonSettings`; the editor's ITEM picker offers
digits 1 F, 2 S, 3 R and 9 B only (no score, bomb, weapon change or
speed-up) and has **no ARMS or loadout UI**: `loadouts`, `startLoadout`,
`initialPower`, `maxOptions` appear nowhere in `static/editor/`. The
`.sav` writer (`game-to-save.js` `encodeSettings`) writes an import's item
slots raw but is never given its ship blocks, loadouts or score-item
index (the function accepts all three; its one caller passes none), so a
re-exported Ramsie goes out with `DEFAULT_SHIP_BLOCK` (preset 0, power
1/4, options 1/2, autofire 5 frames), `DEFAULT_LOADOUTS` (VULCAN A /
H-MISSILE / CANNON / RED and three more) and a 10,000-point score item in
place of its own 100,000.

## 2. The PS2 port today

`jsr:@easierbycode/svelte-ps2` 1.1.1 (`ps2-sp`), bundled by
`lib/ps2/runtime-entry.ts`, has the stock model only: digits 1/2/3/9 with
hardcoded `powerupBig/powerup3way/speedupItem/barrierItem` frames,
`shootMode` normal/big/3way, `shootSpeed` as a 15-step interval bonus, a
600-step barrier, 3.5 px per step bullets, `big` piercing by hp; digits
4/5 drop nothing; no bomb, charge, pods, loadouts, item icons from the
record, or score item. The harbor's runtime patches add Dezaemon zako
entry scripts and the fire pulse, boss slots and stage 2, god mode and
contact rules — nothing for player weapons or items. The exporter passes
neither `meta.dezaemonSettings` nor `dezaemonItems` to the disc.

## 3. Each console's player weapon system

### Saturn Dezaemon 2 (the reference)

Four loadout presets (MAIN 0-7, SUB 0-7, CHARGE 0-3, BOMB 0-7 + variant;
editor names from KUMITATE's ARMS page), a 4-byte ship block per player
(start preset, POWER init/cap 0-7, OPTION init/cap 0-4, autofire index),
eight item slots of nine effect types with three movements, one score-item
value, three global bullet configs. The buttons: A = MAIN + charge, B =
SUB, C = bomb, R = rapid for both. Traced: MAIN 1-7, CHARGE 1-3, OPTION
A/B/C, the bomb dispatcher and powers, the item effects and movements, the
shot art per MAIN weapon. Not traced: SUB 1-4's handlers, the weapon-change
handler's side effects, the barrier's rule, the bomb-stock and spare-ship
seeds, the velocity table's values, ship byte +3's high nibble, and which
effect-art ref each of the 7×5 levels draws (README-Parity.md T2, T3, T5,
T6, T7, T8).

### Super Famicom Dezaemon

Nothing authored. The configuration words hold title type, mouse speed,
edit BGM, a BGM patch and the key config; the ship sheet's shots (chips
47-53), enemy bullets (24-45), items and explosions are the ROM's art
through OBJ palettes 5/6 and rows 20/21; a 4-step speed stat exists in RAM
(`$19D4 & 3`) with no identified item; the one item field is a **drop
bit** per enemy entry whose kind cycles through the ROM's sequence
`$82:EB7D` (contents undocumented); the plain shot's damage is untraced
(the writer guesses 25 per hit). No bomb, charge, option, barrier or
loadout exists in the save.

### PS1 Dezaemon Kids!

Two three-byte ship records in CONFIG (`+0x09..+0x0E`) whose first two
bytes select, per the editor, **eight shot types and eight bomb types in
three colours** — unnamed, no play-mode reader found; byte 2 masked to two
bits is read. The ship's shot is four 16×16 frames the save supplies (SHIP
words 12-15), its bomb an 8×2 strip (16-31). Standard shots hit for
4608..9728 (5120 plain), lasers 384/512 per contact frame, against per-class
hp tables. Items: an **ITEM LIST of six fixed kinds** — POWER UP, SPEED
UP, BOMB UP, 1UP, small and big bonus — named per enemy record (byte 3
bits 5-7), icons at SHIP words 160-165. No weapon change, barrier or
option.

### PS1 Dezaemon+ (Select 100)

A seven-slot **ITEM TABLE** of effect ids 1..11 through `0x8007DC54`:
1-6 set **weapon 0-5**, 7 bomb, 8 score bonus, 9 power up, 10 speed up,
11 option; slot 0's id also seeds the starting weapon. A charge-time byte
(0..5 → (5−v)·45+40 frames) — a hold-to-charge weapon exists. Four power
levels (2×24, 3×20, 4×16, 5×14 damage per volley). One drop bit per enemy
definition; the item that appears comes from the table. Which weapon
behaves how is untraced (only the handler table's address is known), and
the per-definition drop bit's slot choice is undocumented. This is the one
console besides the Saturn whose save can **select a weapon by item**.

### Nintendo 64 Dezaemon 3D (64DD)

A GAM loadout byte: `shotPower` 0-2, `laserPower` 0-2, `bombs` 0-3; a
shield with its own models; seven CBL item entries — `shot`, `laser`,
`bomb`, `shield`, `oneUp`, `bonus1`, `bonus2` — named per enemy entry at
byte `0x43`; two enemy shot sprites and two lasers game-wide. All of it
"likely" (from the translation's format notes), nothing traced from the
cartridge; booted evidence: the HUD's stock ship/bomb icons, a repaired
sample GAM with three bombs and a shield, a one-hit enemy that dropped its
item.

### PS2 port

See §2: the web's stock model (normal / big / 3way, speed, barrier), four
power-ups by digit, no Dezaemon weapons.

## 4. What each writer carries today

| Writer | Loadouts / ship | Items and drops |
| --- | --- | --- |
| Saturn `game-to-save.js` | **always** `DEFAULT_LOADOUTS` and `DEFAULT_SHIP_BLOCK` (an import's own are never passed to `encodeSettings`) | an import's 8 slots raw, else `DEFAULT_ITEM_TYPES = [7,7,7,6,5,4,1,2]` (F/S/R as power-ups told apart by icon, score, bomb, barrier, weapon change to presets 1 and 2); digit → first slot of that type; one record per (letter, digit) |
| SFC `sfc-write.js` | none exist | every non-zero digit → the one drop bit; kind = the ROM's cycle |
| Kids! `kids-write.js` | ship record bytes kept from ANGEL WING's template | `KIDS_ITEM_FOR_DROP {1:1, 2:1, 3:2, 9:3}` (F/S → POWER UP, R → SPEED UP, B → BOMB UP); digits 4 and 5 drop nothing; 1UP and the two bonuses have their icons painted but are never named by a record |
| Dezaemon+ `plus-write.js` | `PLUS_ITEM_TABLE` fixed (weapon 5, option, power up, weapon 1, speed up, weapon 2, bomb — all enabled); charge time 2 | **`dropsItem` is never passed**: no exported enemy drops anything |
| 64DD `project-write.js` | GAM loadout byte left to the template / cartridge; shield models empty on a template-less disk | `N64_DROP_ITEMS {1:0, 2:0, 3:0, 4:5, 5:2, 9:3}` (shot, bonus1, bomb, shield); laser, 1UP, bonus2 unreachable |
| PS2 `build:ps2` | the port's own `playerData` weapons | digits 1/2/3/9 as the stock four; 4/5 nothing |

## 5. Which weapons are consistent between which consoles

"Same" means the same traced behaviour; "similar" means the concept exists
with its own untraced behaviour; "—" means the format has no such thing.

| Concept | Saturn | Web | PS2 | SFC | Kids! | Dezaemon+ | 64DD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vulcan / spread (MAIN 1) | yes | same | similar (`3way`) | ROM shot only | similar (shots 4608..9728) | similar (2-5 bullets by power) | similar (`shot`, power 0-2) |
| Twin parallel (MAIN 2) | yes | same | — | — | ? | ? | — |
| Missile, lobbed (MAIN 3) | yes | same | — | — | ? | similar (rocket / missile arrows on the sheet) | — |
| Homing chains (MAIN 4) | yes | same (trail) | — | — | ? | ? | — |
| Column / laser (MAIN 5, CHARGE 2) | yes | same | — | — | similar (contact lasers) | ? | similar (`laser`, power 0-2) |
| Wave ball, bound pair (MAIN 6, 7) | yes | same | — | — | — | ? | — |
| H/S/G-MISSILE, RF-LASER (SUB 1-4) | yes (untraced) | **missing** | — | — | ? | ? (weapons 0-5 unnamed) | — |
| Option pods A/B/C (SUB 5-7) | yes | same | — | — | — | similar (`option` item) | — |
| Charge shot (CHARGE 1-3) | yes | same | — | — | — | similar (charge time byte) | — |
| Bomb by type (7 + variant) | yes | same (shapes) | — | — | similar (8 types, 3 colours, unnamed) | similar (one bomb) | similar (bombs 0-3) |
| Power-up (+1 option / shot level) | yes | same | similar (`big`) | ROM cycle | similar (POWER UP) | similar (power up, 4 levels) | similar (`shot` item) |
| Speed-up (+1 power / speed) | yes | POWER unread; stock interval × 0.6 | similar (`speed_high`) | RAM stat, item unknown | similar (SPEED UP) | similar (speed up) | — |
| Bomb stock +1 | yes | same | — | — | similar (BOMB UP) | similar (bomb) | similar (`bomb`) |
| Barrier / shield | yes (persistent) | timed 4 s | 600 steps | — | — (B → BOMB UP) | — | similar (`shield`) |
| Score bonus | yes | same | — | ? | similar (two values) | same table | similar (bonus1/2) |
| 1UP | — | — | — | ? | yes | — | yes |
| Weapon-change item | yes (preset 0-3) | **inert for the loadout** (the stock layer switches to 3-way) | — | — | — | similar (set weapon 0-5 directly) | — |
| Loadout presets | 4 | read, never switched | — | — | ship record bytes (8 shot / 8 bomb types) | starting weapon = table slot 0 | GAM loadout byte |

Read across a row: a weapon that is "same" on Saturn and web and "—"
everywhere else (twin, missile, homing, wave/bound, pods, charge, the
Saturn bomb types) can be carried to the web and nowhere else; a concept
that is "similar" on Kids!, Dezaemon+ or the 64DD can be *approximated*
there by picking the nearest native item; the Super Famicom carries none
of it and chooses its own item kinds.

## 6. Any Dezaemon weapon as an item drop: what it takes

The goal, stated as the author's experience: in the editor, pick a cell's
drop (or a death word's slot) and choose "weapon change → preset 2", or
"give HOMING", or "OPTION B", and have the pickup do that on the web, on
the PS2, on a Saturn cart, and the nearest thing the other consoles have.
Layer by layer:

### 6.1 A weapon vocabulary

The Saturn's fourteen weapons (MAIN 1-7 and SUB 1-7; 0 is OFF on both
rows) plus its three charges and eight bombs are the best-traced set —
SUB 1-4 excepted, see §3 — so they are the canonical ids: `main:1..7`,
`sub:1..7`, `charge:1..3`, `bomb:1..7(+variant)`. Every other target gets
a mapping table from those ids to what it has (§5), with three outcomes
per id: exact, nearest native, or absent (the writer warns and drops the
pickup's weapon effect, keeping its other effect if any). The table lives
in one module (`packages/shmup-engine/src/weapons.js`) that the editor,
the importer, the runtime and the writers all read, so the names never
drift again the way MAIN and SUB did.

### 6.2 The record

- `playerData.loadouts[4]` and `playerData.ships[2]` (start preset,
  power/option init and cap, autofire) as first-class fields — today they
  exist only inside `meta.dezaemonSettings` on an import and nowhere on a
  web-authored game.
- `items[8]`: `{ type, movement, preset?, weapon?, icon }` — the Saturn's
  slot table generalised so a slot can name a preset (type 0-3) **or** a
  single weapon id (a new type the Saturn writer turns into "the preset
  that differs from the current one by that weapon", when it can build one
  within four presets).
- Drops refer to **slots**, not digits: a cell carries a slot index 1-8 (or
  9 = cycling), a death word the same. The grid digit stays as the
  compatibility spelling for web games (1 F, 2 S, 3 R, 9 B map onto slots
  of a default table) and `game-schema.js` validates both.
- `dezaemonItems` / `meta.dezaemonSettings` become views of these fields
  for records that pre-date them.

### 6.3 The editor

An ARMS panel (four presets × MAIN/SUB/CHARGE/BOMB dropdowns with the
Saturn's names and the per-target "carries as" note from the vocabulary),
a SHIP panel (start preset, power and option init/cap, autofire), an ITEM
SLOTS editor (eight slots: type, movement, preset or weapon, icon), and a
drop picker that lists the slots by name and icon. The cloud save and
PLAY recipe carry the new fields; CONSOLE export rows show per target what
each slot becomes.

### 6.4 The importer

Already carries the item slots raw and the ships and loadouts as decoded
fields (their raw bytes are decoded and dropped on the way into
`meta.dezaemonSettings`); keep the raw bytes, stop collapsing slot types
to six digits (emit slot indices), carry slot movement, extract the weapon
art refs 48-93 and the big-shot records (README-Parity.md P2, P3), and
stop baking the cycling slot into the cell so it is resolved once, at kill
time.

### 6.5 The web runtime

1. Pickup by slot: `dropItem(slotIndex)` / `collectItem(slot)` with the
   slot's type driving the effect; weapon change switches
   `dezaLoadoutIndex` and runs the engine's rebuild (pods, charge gauge,
   homing chains — T3 says exactly what); a single-weapon slot swaps one
   field of the live preset.
2. SUB 1-4 (T2), the three item movements, the persistent barrier (T6),
   the power→speed table (T7), autofire from the ship block, per-tap caps
   and a held-fire input (the rapid button), stock seeds from their bytes
   (T5).
3. Art: MAIN/SUB/CHARGE/pod/bomb sprites from refs 48-93 (T8 for the
   per-level effect frames), item icons from the slots.
4. The stock layer off for imports: no `shootMode` carriers, no 3-way
   stand-in, no SP cut-in when a bomb is armed, the stock four power-ups
   only for web games that ask for them.
5. The crossover kit for web games grows from one preset to the four the
   record names, so a web-authored game can use the same drops.

### 6.6 The PS2 port

The port has none of the kit. Two routes: port the Dezaemon kit into
`svelte-ps2` (MAIN 1-7 first — the tables are small and the scene already
runs the zako scripts at 120 steps/s — then bombs, charge, pods, SUB when
traced), reading the same `playerData.loadouts` / `items` fields; or
declare the PS2 a "nearest native" target in the vocabulary (its four
power-ups) until that lands. Either way `build:ps2` must start passing
`dezaemonItems`, the loadouts and `dezaemonBullets` to the disc (the zako
patch reads `recipe.dezaemonBullets`, but level.json ships only the grid,
the enemy and boss tables, so that path is dead on the console; `meta`
already survives as far as the build step) and the port's item spawner
must take a slot, not a digit.

### 6.7 The console writers

- **Saturn**: pass the record's `ships`, `loadouts` and score-item index to
  `encodeSettings` — it already accepts all three and its one caller passes
  none, so today's defaults silently replace them, the one change that
  already costs a re-exported Ramsie its weapons; the slots already go out
  1:1 for an import; the weapon refs 48-93 are already painted, but from
  the level's shot frames or procedural art — painting the cart's own
  needs the importer to extract them first (6.4). Exact for everything in
  the vocabulary by construction.
- **Dezaemon+**: build the ITEM TABLE from the record's slots (weapons 0-5
  for the nearest of the vocabulary's MAIN ids once T-Plus — which weapon
  is which — is traced; power, speed, option, bomb, score as themselves),
  set slot 0 to the start weapon, and **pass `dropsItem`** per definition.
  Which table slot a drop takes is undocumented (a trace of the drop
  handler, or two flagged definitions played in Mednafen, settles it).
- **Kids!**: the six ITEM LIST kinds are fixed (power, speed, bomb, 1UP,
  two bonuses): power-up, speed-up and bomb stock map to their nearest
  native kinds, and the score digit can map to the two bonus items (ids 5
  and 6 are addressable today and the drop map never emits them — add
  digit 4 → 5/6 and digit 5 → 3, the same one-table change as Dezaemon+'s
  drop bit); weapon changes and barriers to the nearest or nothing; trace
  the ship record's first two bytes (eight shot / eight bomb types) so a
  loadout's MAIN and BOMB can at least pick the nearest native shot and
  bomb once.
- **64DD**: write the GAM loadout byte (shot/laser power, bombs) from the
  start preset and map slots onto shot/laser/bomb/shield/1UP/bonus1/bonus2;
  the laser, 1UP and bonus2 entries exist in CBL but no drop digit maps to
  them today.
- **SFC**: nothing to write; the drop bit stays, and the export notes say
  the item kind is the ROM's.

### 6.8 Feasibility by weapon concept

| Concept | Web | PS2 | Saturn cart | Dezaemon+ | Kids! | 64DD | SFC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Weapon-change / preset pickup | needs 6.5.1 | needs 6.6 | exact (6.7) | nearest native weapon 0-5 (after trace) | ship record bytes only (after trace) | loadout byte only | — |
| MAIN 1-7 as a drop | after 6.5.1 | after the kit port | exact | nearest of six | nearest shot type (after trace) | shot or laser | — |
| SUB 1-4 as a drop | after T2 | after T2 + port | exact | ? | — | — | — |
| OPTION A/B/C | after 6.5.1 | after port | exact | `option` item | — | — | — |
| CHARGE 1-3 | after 6.5.1 | after port | exact | charge time only | — | — | — |
| Bomb type | after 6.5.1 | after port | exact | one bomb | bomb type byte (after trace) | bombs 0-3 | — |
| Power-up / speed-up / bomb stock / score / barrier | partly now | power, speed and barrier now (digits 1/3/9); no bomb stock or score | exact | nearest native (power up / speed up / bomb / score), behaviour untraced; barrier — | nearest native (POWER UP / SPEED UP / BOMB UP / bonuses), behaviour untraced; barrier — | nearest native (shot / bomb / bonus1-2 / shield); no speed-up | drop bit |

### 6.9 Order of work

1. Saturn writer passes ships/loadouts/score index (a day, if the raw
   bytes are carried through `map-to-game.js` — `decode-settings.js`
   already supplies them for the ship blocks and loadouts, and the score
   index is `sec5[+0x24] & 7`, today reduced to its value; re-encoding
   from the mapped fields instead would lose ship byte +0's upper bits and
   byte +3's untraced high nibble).
2. Vocabulary module + record fields + schema; importer emits slots.
3. Runtime pickup by slot, weapon change, item movements, barrier, the
   stock layer off for imports.
4. Editor ARMS / SHIP / ITEM SLOTS / drop picker.
5. Traces T2, T3, T5-T8; SUB 1-4 and the ship rules in the runtime.
6. Dezaemon+ item table and drop bit; Kids! ship record trace; 64DD
   loadout byte.
7. PS2 kit port (MAIN first) or the declared nearest-native mapping.

Each step is checked with the Ramsie survey (README-Parity.md Phase 0):
the pickup sequence on stage 0 — the weapon changes from record 6's
cycling kills, record 48's barrier, record 49's power-up — must leave the
web ship and the Saturn ship on the same preset with the same counts.
