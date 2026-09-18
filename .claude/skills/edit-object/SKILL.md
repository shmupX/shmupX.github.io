---
name: edit-object
description: Edit an existing shmupX character from a spoken or loosely worded request — "make the second boss bulkier", "the pyramid, redder", "boss 2 should hit harder", "show me the last boss" — by resolving the phrase to a catalog object with shmupx_list_objects, then turning the aggression / silhouette / palette dials with shmupx_update_object and returning a PNG preview. Use whenever someone refers to a boss, enemy or character by position or description instead of by id, asks to make one bigger, smaller, more or less aggressive, a different colour, or asks to see what one looks like as a sprite. For building a NEW character out of other art, use create-character instead.
---

# Editing a shmupX object by phrase

The `shmupx-character` MCP server (`mcp/server.ts`, registered in `.mcp.json`)
carries four tools that address the catalog's characters the way a person
speaks about them, for sessions — a watch, a voice bridge — that cannot dictate
an id. Every object is still a `characters/<id>` record with its art at
`atlases/<textureKey>`; these tools only change how you reach it and what you
turn.

## The shape of the job

1. **Resolve the phrase.** `shmupx_list_objects { query }` with the part of the
   sentence that names the thing: `"the second boss"`, `"boss 2"`, `"the last
   boss"`, `"the pyramid"`. Read `resolved`. If it is null and `candidates` has
   several entries, ask which one — never pick for the player. If `candidates`
   is empty, read `explanation`: _"third: 0 (present: first, second, fourth,
   fifth…)"_ means there is no third boss, and the answer is to say so.
   - Ordinals count the way the list counts: a numbered boss is its stage plus
     one (**the second boss is `dezaBoss1`**), the unnumbered ones follow after
     the highest stage, and a missing stage is nobody. Read `ordinalWord` off
     the list and you can speak it straight back.
   - `"boss 2"`, `"stage 2"` and `"level 2"` all mean the second; `"slot 2"`
     is the zero-based key. A spoken id wins over counting — _"deza boss 1"_
     is `dezaBoss1`, and in a level, _"boss 1"_ is the slot `boss1`.
   - A name beats a role word: _"akuma's bullets"_ resolves to `akuma` with
     `hints: ["projectile"]` — that is your cue for `scope: "projectiles"`.
   - `"the second boss of Daioh P!"` → pass `level: "Daioh P!"`, the exact key
     under `/levels`, spaces and punctuation included (a miss lists the keys).
     The slots come back as `boss0..bossN`, each with `character` naming the
     catalog entry to edit and `inCatalog` saying whether it exists there. A
     level's copy is edited by editing that character and placing it again with
     `shmupx_place_character`; a slot with `inCatalog: false` (2028.Ai's own
     `bison`) cannot be edited this way — say so.
2. **Read it before changing it.** `shmupx_get_object { id }`. `dials` holds
   the numbers each dial would move and, crucially, whether the runtime would
   notice: `aggression.intervalRead` is true only for a stock zako, and
   `aggression.shotsRead` is false for a Dezaemon zako. `palette.colors` is
   what the sprite is made of, so _"redder"_ can be judged against it.
   `missingFrames` non-empty means the record names art its atlas lacks; an
   edit will refuse to write until that is fixed with `shmupx_create_character`.
3. **Turn the dials, dry.** `shmupx_update_object { id, ...dials }` with no
   `apply`. It answers with `changes` (field, before, after), `art.transformed`
   (the frames touched), `atlas.write` (in place / new / untouched), `warnings`
   for anything it left alone, and a `png_base64` of the result. Describe the
   change in the player's words and show the picture.
4. **Apply on a yes.** The same call with `apply: true`. In a hands-free
   session the yes is the imperative itself — _"make it bulkier"_ is a request
   to make it bulkier — and nothing persists between utterances without a
   write, so apply then; prefer `saveAs` when the player has not said where it
   should land and the original is somebody else's.
5. **Show it.** `shmupx_preview_object { id }` is the picture of what is in
   the catalog now — the frame the runtime spawns it with — and is what a watch
   or a bridge should be shown after a write. `state: "attack"`,
   `"projectile"` or `"backdrop"` pick other art.

## Spoken degrees to dial values

| the player says                               | dial                                      |
| --------------------------------------------- | ----------------------------------------- |
| bulkier, bigger, chunkier, beefier            | `silhouette: 0.5`                         |
| leaner, smaller, slimmer                      | `silhouette: -0.5`                        |
| more aggressive, hits harder, faster shots    | `aggression: 0.5`                         |
| calmer, gentler, weaker shots                 | `aggression: -0.5`                        |
| redder / make it red / blue / gold …          | `palette: { toward: "red" }`              |
| a hint of red, slightly warmer                | `palette: { toward: "red", amount: 0.4 }` |
| paler, whiter / darker, blacker / greyer      | `palette: { toward: "white" }` etc.       |
| darker / lighter (tone only)                  | `palette: { lightness: -0.3 }` / `0.3`    |
| duller, washed out / more colourful, vivid    | `palette: { saturation: -0.5 }` / `0.5`   |
| shift the colours, different palette          | `palette: { hue: 120 }`                   |

Scale the magnitude by the adverb: _a bit_, _slightly_, _a touch_ → 0.25;
nothing said → 0.5; _much_, _way_, _a lot_ → 1. **Cap values yourself**: the
tool's schema rejects anything outside -1..1 (hue outside ±360) rather than
clamping it. The dials are arithmetic on the current values, so _"more"_ said
twice compounds — read `changes` back rather than assuming.

Colours are `#rgb`, `#rrggbb`, or one of: red, orange, yellow, lime, green,
teal, cyan, blue, navy, purple, violet, magenta, pink, brown, gold, white,
black, grey, silver.

## Rules that are easy to get wrong

- **`scope` defaults to `body`.** _"Make the boss red"_ recolours the boss,
  not its bullets or the backdrop behind it. _"Make its shots green"_ is
  `scope: "projectiles"`; the preview then shows the main projectile. A
  Dezaemon zako's shots are drawn from the level's bullet bank, so that scope
  changes nothing visible on one — the result warns.
- **Aggression only moves what the runtime reads.** Every slot's `damage`
  scales for everyone. `speed` scales for everyone but a Dezaemon zako. Only a
  stock zako's `interval` is a cadence the runtime reads — a boss fires on its
  pattern script's clock and a Dezaemon zako on the cart's fire table — so
  those intervals are left alone and `warnings` says so. Tell the player a boss
  fires harder and faster shots, not more often. A boss with no projectile
  slot (`dezaBoss1`) has nothing the dial can move, and the result says that
  too; the fix is a slot via `shmupx_create_character`. _"Tougher"_ is
  `stats: { hp: N }`, set exactly — read the current hp from
  `shmupx_get_object` first. `stats.interval` on anything but a stock zako is
  written but warned about: it changes nothing in play.
- **Silhouette resamples pixels.** 1 + 0.5s: +1 is half again as big, -1 is
  half size, nearest-neighbour so it stays pixel art. Non-integer factors make
  some pixels wider than others; that is the trade for a spoken size. The
  hitbox follows the frame, so a bulkier boss is also easier to hit. A Dezaemon
  boss's turret parts keep their size (the runtime anchors them at fixed
  offsets); `art.partsKeptAtSize` lists them.
- **What a write touches.** Numbers only → the record alone. Pixels on a
  character with its own atlas → that atlas rewritten in place, every frame
  kept under its existing key, conditionally on the ETag it was read with (a
  raced write is refused: read again and redo). Pixels on a character whose
  art lives in a shared atlas (`dukeNukem` → `duke_atlas`) → the shared sheet
  is never touched; the edited frames go to a new `atlases/<id>`. An apply with
  nothing changed writes nothing.
- **`saveAs` must be a new name.** The tool refuses the object's own name and
  any name that already exists, so a copy can never overwrite somebody's
  character. Pick a name WITHOUT the boss's stage number — `bulkyRed`, not
  `dezaBoss1_bulky` — or the copy also becomes "the second boss" and the
  phrase turns ambiguous from then on.
- **The catalog is shared and open-write.** Say what will change before
  applying, and reach for `saveAs` when in doubt.
- **Never apply with a non-empty `unresolved`.** The server refuses anyway;
  do not route around it by dropping the fields that name the art.
- **Two tools with similar names do different things.**
  `shmupx_preview_object` renders one frame as a PNG from the catalog's own
  atlas. `shmupx_preview_character` builds a level and serves the real runtime
  at a URL. A watch wants the first; a person at a desk who asks to _play_ it
  wants the second.

## Worked examples

> "make the second boss bulkier"

```
shmupx_list_objects  { query: "the second boss" }          → resolved.id = "dezaBoss1"
shmupx_update_object { id: "dezaBoss1", silhouette: 0.5 }  → 64x128 → 80x160, png of the result
shmupx_update_object { id: "dezaBoss1", silhouette: 0.5, apply: true }
```

> "the pyramid, a bit redder and much more aggressive"

```
shmupx_list_objects  { query: "the pyramid" }              → "pyramid"
shmupx_get_object    { id: "pyramid" }                     → two projectile slots, colours; intervalRead false
shmupx_update_object { id: "pyramid", palette: { toward: "red", amount: 0.4 }, aggression: 1 }
```

The result moves both slots' speed and damage, leaves `interval: 250` alone
and says why in `warnings`.

> "the second boss of Daioh P! — what does it look like?"

```
shmupx_list_objects   { level: "Daioh P!", query: "the second boss" }  → boss1, character "dezaBoss1", inCatalog true
shmupx_preview_object { id: "dezaBoss1" }
```

> "the third boss"

```
shmupx_list_objects { query: "the third boss" }
→ resolved null, candidates [], explanation "boss: 8; third: 0 (present: first, second, fourth, fifth, sixth, seventh, eighth, ninth)"
```

Tell the player there is no third boss, and name the ones there are.
