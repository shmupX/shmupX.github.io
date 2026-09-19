---
name: debug-game
description: Drive the game one frame at a time — pause it, step frames, read what is on screen, screenshot the exact frame, and press pad buttons or keys — through the shmupx_debug_* MCP tools, against a paused browser the player is holding open with `deno task game:debug`. Use whenever someone asks to debug, step, pause, inspect or screenshot the running game, asks whether a character, boss, bullet or background is actually drawing or moving in the real runtime, asks what a button does, or says something like "step to the boss and show me a frame of it".
---

# Driving the paused game

`deno task game:debug` boots the game with a probe that owns
`requestAnimationFrame`, taps through the title and the story, and pauses on the
first frame of the stage. The debug state lives in that **page** — `window.__dbg`
— not in the task and not in you, so the nine `shmupx_debug_*` tools are just
DevTools calls against it. Nobody hands a session object to anybody; the port is
the whole handle. All nine take an optional `port`, defaulting to 9223.

Paused is the point. A running game has moved on a hundred frames by the time
you have read one screenshot, so everything below assumes the game is frozen and
that *you* are the clock.

## The shape of the job

1. **Check there is a session.** `shmupx_debug_status {}`. If it comes back
   `No debug browser is listening on DevTools port 9223` (nothing on the port)
   or `has no debug probe` (a browser, but not that one), there is
   nothing to drive. **Say so and ask the player to run `deno task game:debug`
   in a terminal and leave it running.** Do not start it yourself: it is a
   long-lived interactive process that owns the level server and the Chromium
   child and holds them only while it is in the foreground, so launching it from
   a tool call kills the session the moment the call returns — and it takes
   ~3 minutes to walk to the stage, every time.
   If the player answers that a **window is already open with the game in it**
   while you still see nothing on the port, they are on a build from before the
   headed-profile fix: Chrome 136+ declines a debugging port on the default
   profile without declining anything else, so the window is real and the port
   was never opened. The task now runs on `build/debug-profile/<port>/` for that
   reason; ask them to pull and restart it.
2. **Confirm where it is.** `status` reports `scenes`. At the stage that is
   `["PhaserGameScene"]`. PhaserGameScene is *also* active underneath the story,
   so the test is that `PhaserAdvScene` and `PhaserTitleScene` are **absent**.
   Also read `paused` (should be true) and `lastError` (a page exception the
   probe swallowed on some earlier frame — it explains a world that stopped
   moving).
3. **Look before you move.** `shmupx_debug_inspect {}` — active scenes,
   `displayObjects`, the player's position, and `visibleFrames`: a count per
   visible frame name. That census is the cheap answer to "is this thing on
   screen", and it is the answer for character art specifically (see the rules).
   It costs one round trip; run it after every step rather than guessing.
4. **Step.** `shmupx_debug_step { frames: 60 }`. Frames, not seconds. It pauses
   first and leaves the game paused; `frames` is 1..3600.
5. **Poll for the moment you want.** Alternate `step` with `inspect` or a small
   `shmupx_debug_eval` until the condition is true — the boss exists, the frame
   name changed, hp dropped, a bullet appeared.
6. **Capture that frame.** `shmupx_debug_screenshot { path: "<absolute>.png" }`.
   The result carries the probe's `frame` number, so the picture is pinned to a
   frame rather than to a moment.
7. **Press, then step to see the effect.**
   `shmupx_debug_press { buttons: ["a"], frames: 2 }` or
   `shmupx_debug_keys { keys: ["enter"], frames: 2 }`. Both pause, hold across
   `frames` ticks, release, and leave the game paused. The effect of a press is
   almost never visible on the frame the press ended on — step a few more and
   inspect again.
8. **Hand it back.** `shmupx_debug_resume {}` when you are done. Nothing else
   releases the pause — step, press and keys all pause first — and the player is
   looking at that same page.

The loop, in one line: **status → step → inspect/screenshot → press → step**.

## Rules that are easy to get wrong

- **Stepping is frames, not seconds.** 60 frames is one second; one step is one
  Phaser tick and moves `game.loop.time` by exactly 17ms however long the pause
  lasted. Something that happens "about half a second later" is 30 steps away.
  The ship autofires every ~23 frames and the boss acts on a 60-frame interval, so
  a 5-frame step is usually too small to show anything and reads as "nothing
  happened".
- **A one-frame press can read as the button doing nothing.** Much of the
  runtime looks for a JustDown edge — `Phaser.Input.Keyboard.JustDown` on the
  keyboard, and on the pad a per-tick rising edge against the previous tick's
  sample — and a button that was down for a single tick can fall between those
  reads. `frames` defaults to 2 for that reason; leave it there, and if a press
  still looks ignored try 3 or 4 before concluding the input is broken. Holding
  longer does **not** repeat: the pad edge is rising-only, so `frames: 30` still
  fires a bomb once.
- **The pad cannot get through the title or the story boxes.** Those read the
  keyboard, not `navigator.getGamepads()`; use `shmupx_debug_keys` with `enter`
  or `space` there. `deno task game:debug` already walked past both, so this only
  comes up after a death, a stage clear, or a resume that ran long enough to
  loop back — which is why step 2 reads `scenes` first. And the story is a
  typewriter with **no skip**: a press completes the line it is on, so walking
  back to the stage by hand is minutes of `keys` calls. Restarting the task is
  usually faster; tell the player that rather than hammering Enter.
- **A character's frames live in the level's `game_asset` texture.** There is no
  texture named after the character, so `textures.exists("myBoss")` is false for
  every character ever made and proves nothing. Ask `inspect`'s `visibleFrames`
  for frame names, or read `bossSprite.frame.name`.
- **A frame name counted twice is usually the sprite and its shadow.**
  `createShadow` adds a second sprite on the *same* frame, tinted black and
  flipped under the real one, so a lone boss idle frame shows up as `2` in
  `visibleFrames`. That is one boss, not two.
- **Screenshot on a condition, never on a timer.** A boss fight is over in a few
  seconds of real time, so "resume, wait, capture" lands on the results screen.
  Poll and capture: the frame you want exists for ~9 frames and you can sit on
  it forever. Two captures without a step in between are byte-for-byte the same
  picture — the `frame` in the result tells you whether you actually moved.
- **Screenshots are the game's own 256x480.** The viewport is overridden to the
  game's size before it boots (asking Chrome for a 256-wide *window* does not
  work — it clamps to 500 and the page then scales the game down to fit), so the
  PNG is 1:1 rather than a scaled guess, and small enough to just look at. The
  result's `width` and `height` are the proof: anything other than `256 x 480`
  is a scaled render of the game rather than the game's own pixels, and the file
  itself gives no sign of it. `path` is required and should be absolute: a relative path resolves
  against the MCP server's working directory, which is wherever the client
  started it and not necessarily the repo. Write under the repo's `build/`,
  which is gitignored (the task's own `c` command writes to
  `build/debug-shots/<timestamp>/`).
- **`shmupx_debug_eval` is arbitrary JS in the player's own browser.** Use it to
  read what the other tools do not expose, and **do not mutate the game behind
  the player's back.** Setting `bossHp = 1` to reach a death animation quietly
  invalidates everything they are staring at, and the only undo is another
  three-minute restart. If a poke really is the shortest path, say what you would
  run and ask first.
- **An eval result has to survive JSON.** The call is `Runtime.evaluate` with
  `returnByValue`, so a Phaser sprite, a DOM node, a function or anything cyclic
  comes back empty or is refused outright. Return the properties you want, or
  wrap it in `JSON.parse(JSON.stringify(x))`. An expression whose value is
  `undefined` also comes back empty and looks like a failure — always return
  something. Promises are awaited for you.
- **There is no axes tool.** The nine tools are `status`, `inspect`, `step`,
  `pause`, `resume`, `press`, `keys`, `screenshot`, `eval` — nothing else. The
  D-pad names in `press` (`up`, `down`, `left`, `right`) are how you move; if you
  genuinely need the analog stick, it is `window.__dbg.setAxes([x, y])` through
  `eval`, and the game deadzones it at 0.5.
- **The player's terminal and your tools are the same session.** They may be
  typing `s` and `i` while you work. If a frame counter jumps between two of
  your calls, they moved it — re-read `status` instead of assuming your own step
  misfired.
- **One call at a time.** Nothing serializes these tools: the server answers
  requests as they arrive and every call is its own DevTools connection to the
  one page, so two in flight together interleave on the same `paused` flag,
  frame counter and pad. Fired as a batch, a `press` and a `pause` come back
  each holding the other's state and a `resume` can land before a `step` that
  re-pauses. Send one, read its answer, then send the next.

## What the input actually does

Worth knowing before you press something and misread the result:

- **There is no fire button.** The ship autofires: `shootTimer` ticks up every
  frame and a shot leaves every `shootInterval` frames (23 by default, less with
  the speed powerup). To see a shot, just step.
- **Every face button and both top shoulders fire the bomb** — `a`, `b`, `x`,
  `y`, `l`, `r` all map to the one `sp` edge. It is a limited resource, so a
  press changes the run's state, not just its pixels.
- `l`/`r` held also hold the **charge**; `lt`/`rt` held widen the **OPTION**
  ring; `start` is `enter`; `rs` opens the editor. `up`/`down`/`left`/`right`
  are held, not edges, and move the ship 3px per frame — so `frames: 2` moves it
  6px, and visible movement wants 20+.

## Handles worth knowing in `eval`

- `window.__dbg` — the probe: `frame`, `paused`, `queue.length`, `lastError`,
  `status()`, `inspect()`, `setAxes()`.
- `window.__PHASER_4_GAME__` — the game. `.loop.time`,
  `.scene.getScene("PhaserGameScene")`.
- On PhaserGameScene: `bossActive`, `bossEntering`, `bossSprite`, `bossName`,
  `bossHp` / `bossMaxHp`, `bossInterval`, `players`, `enemies`, `playerBullets`,
  `enemyBullets`, `items`, `recipe.bossData`. The boss is pushed into
  `enemies` too, so that count includes it.
- `bossSprite.getData("frames")` is the frame list the runtime hand-flips with
  `setFrame()` on a millisecond timer. Bosses carry **no** Phaser animation, so
  `bossSprite.anims` is empty and `bossSprite.frame.name` is the only truth
  about which frame is drawing.

## Worked example

> "step to the boss, show me it mid-animation, then show me what the bomb does"

```
shmupx_debug_status {}
  → { paused: true, frame: 11043, scenes: ["PhaserGameScene"], lastError: null }
```

At the stage, frozen. `bossRush` is on by default (the task's `--no-boss-rush`
turns it off), so the boss is near — but "near" is still hundreds of frames.
Step in chunks and poll, rather than stepping 1 frame 300 times:

```
shmupx_debug_step { frames: 60 }
shmupx_debug_eval { expression:
  "(function (s) { var b = s && s.bossSprite; return { active: !!(s && s.bossActive), entering: !!(s && s.bossEntering), name: s && s.bossName, hp: s && s.bossHp, y: b ? Math.round(b.y) : null, frame: b ? b.frame.name : null, frames: b ? b.getData('frames') : null }; })(window.__PHASER_4_GAME__.scene.getScene('PhaserGameScene'))" }
  → { active: false, entering: false, name: "", hp: 0, y: null, frame: null }
```

Repeat that pair until `active` is true, then keep going until `entering` is
false and `y` has settled — the boss enters from `y: -50` and its art is halfway
off the top of the screen on the way in, which is not the picture anyone wanted.
Now pick the frame. `frames` from that eval is the flip list; the flip is a
millisecond timer against a 150ms period, so at 17ms a step each art frame
holds for about 9 of them:

```
shmupx_debug_step { frames: 5 }        # then re-read `frame` above, and repeat
shmupx_debug_screenshot { path: "<repo>/build/debug-shots/boss-idle1.png" }
  → { path: ".../boss-idle1.png", bytes: 8214, frame: 11512, width: 256, height: 480 }
```

Then the bomb. Read the world first, so "what changed" is a comparison and not a
memory:

```
shmupx_debug_inspect {}                          # displayObjects, visibleFrames before
shmupx_debug_press { buttons: ["a"], frames: 2 } # every face button is the bomb
shmupx_debug_step { frames: 12 }                 # give it time to actually exist
shmupx_debug_inspect {}                          # new frame names, displayObjects up
shmupx_debug_screenshot { path: "<repo>/build/debug-shots/bomb.png" }
```

(`<repo>` is the checkout's own absolute path — a relative one lands in the MCP
server's working directory instead.) If `visibleFrames` is identical across
those two inspects, suspect the press before you suspect the bomb: re-run it
with `frames: 4`, and check the press's own `pad` listed the button you asked
for. That status is read while the buttons are still down, so a working press
answers with `pad: [0]` for `["a"]` and an **empty** `pad` is the press itself
never landing — the buttons are released before the call returns, so a `status`
call afterwards is empty either way and proves nothing.

Finally, give the game back to the player:

```
shmupx_debug_resume {}
```
