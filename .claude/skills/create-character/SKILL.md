---
name: create-character
description: Create a playable shmupX character — clone an existing one's attributes (e.g. dezaBoss0) and swap in any frame from any sprite or atlas for its animations, its projectiles or its stage-end backdrop, then preview it in the real game and publish it. Use whenever someone asks for a new character, boss or enemy, asks to reskin or re-arm an existing one, asks to change a boss's bullets or its stage-end background, or says something like "a character that mirrors dezaBoss0 with hadouken as its main projectile".
---

# Creating a shmupX character

A character is a boss-shaped record in the shared catalog: animations, four
projectile slots, a Dezaemon trailer, and hp/score/interval/shadow fields. The
`shmupx-character` MCP server (`mcp/server.ts`, registered in `.mcp.json`)
reads that catalog, repacks art, and writes new characters back.

## The shape of the job

1. **Find the clone source.** `shmupx_list_characters`, then
   `shmupx_get_character` on the one being mirrored. Its `referencedFrames`
   and `textureKey` tell you what art it carries.
2. **Find the art.** `shmupx_list_atlases` (there are ~400; pass `match` to
   filter) then `shmupx_list_frames` on the one you want.
   **Always list the frames — never guess a frame name.** They frequently do
   not match the atlas name: the `hadouken` atlas's two frames are
   `atlas_s0` and `hadouken1`, and `bg-great-hall`'s only frame is also called
   `atlas_s0`. A frame is referenced as `"<atlas>/<frame>"`.
3. **Build it.** `shmupx_create_character` with `cloneFrom` and the swaps. It
   writes nothing by default — read the result back to the player.
4. **Show it.** `shmupx_preview_character` takes the same arguments, serves
   the real runtime with that character as the boss, and returns a `playUrl`.
   Offer this before publishing; it is the only way to actually see the thing.
5. **Publish, on a yes.** Re-run `shmupx_create_character` with `apply: true`.
6. **Put it in a level**, if asked: `shmupx_place_character` replaces a cloud
   level's `boss<N>`. Dry-run first — it edits somebody else's level — and keep
   the result's `replaced` record, which is the only way back.

## Rules that are easy to get wrong

- **The main projectile is `bulletDataA`, not `bulletData`.** Use the
  `mainProjectile` argument and let the server place it. A record that carries
  `dezaemon.boss` arms the Dezaemon engine, whose weapon resolver reads
  `bossProjDataA/B/C` and never the unsuffixed slot — so writing `bulletData`
  changes nothing visible and looks like the tool silently failed.
- **Two frames make a flicker, not an animation.** Bullets carry no Phaser
  animation; the runtime hand-flips the `texture` list with `setFrame()`.
  A pair like `["hadouken/atlas_s0", "hadouken/hadouken1"]` is the idiom.
  `frameRate` on the slot sets the flip speed.
- **Never publish with a non-empty `unresolved`.** That list is frame names
  the record mentions that no source could supply. The runtime filters unknown
  frames out silently and falls back to stock art, so this is a bug that
  reports itself nowhere. `apply: true` refuses in that case — do not work
  around it by dropping the check; supply the art or drop the field.
- **A placed record is renamed to the level's spelling.** `shmupx_place_character`
  does this for you, and it is not optional: the level loader's repair pass tests
  each animation's first frame against the level's atlas *exactly*, with none of
  the runtime's `.gif`/`.png` forgiveness, and reverts the whole record to the
  base game's boss on a miss. The symptom is a boss that silently renders as
  2028.Ai's Bison. Check `renamed` in the result to see what moved.
- **The catalog is shared and open-write.** Every write lands where spriteX,
  the Pixel Editor and the level editor can see it. Show the dry run, get a
  yes, then apply. Publishing over an existing name replaces it.
- **Art that is not in the catalog** goes in as `{file: "dev-fixtures/x.png"}`.
  `dev-fixtures/` is gitignored by design — it is the repo's local-only art
  drop — so tell the player to put the file there rather than trying to find
  it elsewhere, and never substitute a similarly-named asset for one that is
  missing.

## Stage-end backdrops

`stageBgEnd` on a character replaces the shipped `stage_end0..4` art that
rises behind the boss. Pass any frame reference and the server packs that art
into the character's own atlas, which is what makes it resolvable at the
moment the runtime measures it.

`stageBgEndAlpha` (0..1) draws it translucent, so the backdrop lies over the
starfield instead of hiding it — `0.45` is the value the `dezaBoss0` example
uses. On its own, with no `stageBgEnd` beside it, it makes the *shipped*
backdrop translucent. In the record this becomes
`stageBgEnd: {frame, alpha}`; the runtime also accepts `opacity` as a synonym.

Three things to tell a player asking for this:

- It applies to levels **without** Dezaemon scenery. A cart whose stage has
  its own scrolling scenery (`dezaBg`) never shows a stage-end backdrop at
  all, so the field is inert there.
- The art is drawn at its own size from the top-left and scrolled down, so
  tall art reveals for longer. The reveal stops at `y >= 42` or after 214px.
- Art that is named but does not resolve falls back to the shipped backdrop
  **opaque**, alpha and all — a half-applied spec reads as a rendering bug.

## Worked example

> "a character that mirrors the attributes of dezaBoss0, main projectile set
> to hadouken"

```
shmupx_get_character  { name: "dezaBoss0" }
shmupx_list_frames    { atlas: "hadouken" }        → atlas_s0, hadouken1
shmupx_preview_character {
  name: "hadoukenBoss", cloneFrom: "dezaBoss0",
  mainProjectile: ["hadouken/atlas_s0", "hadouken/hadouken1"],
  stageBgEnd: "bg-great-hall/atlas_s0", stageBgEndAlpha: 0.45
}
```

Then, once the player has seen it:

```
shmupx_create_character { ...the same arguments, apply: true }
```
