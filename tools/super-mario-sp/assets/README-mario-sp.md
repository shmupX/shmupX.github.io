# mario-sp — Super Mario Land (5velte-ph4ser)

A port of the [phaser3-typescript Super Mario Land remake](https://github.com/digitsensitive/phaser3-typescript)
to [5velte-ph4ser](https://github.com/easierbycode/svelte-phaser) — Svelte 5 + Phaser 4.

A remake of the original 1989 Game Boy game for educational purposes.
The rights remain with Nintendo.

## Run

```sh
npm install
npm run dev
```

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move | ← / → / ↓ | D-pad or left stick |
| Jump | SPACE | Ⓐ (FACEBTN_BOTTOM) |
| Run | C | Ⓧ (FACEBTN_LEFT) |
| Start | S | Start |
| Fullscreen | F | Home / PS button |

## Gamepad support

[`src/lib/gamepad.svelte.ts`](src/lib/gamepad.svelte.ts) is an optimized port of the original
`gamepad-support.ts`. Instead of dispatching synthetic keyboard events at the canvas, it
polls the Gamepad API once per Phaser game step (via `onGameEvent('step')` from
svelte-phaser) and exposes held/edge state (`isDown()` / `justPressed()`) that the game
objects read directly, alongside connection state as Svelte 5 runes for the UI. Input from
all connected pads is merged, and the left analog stick doubles as the d-pad.

Button defaults live in [`public/codemonkey.json`](public/codemonkey.json):

```json
"FACEBTN_LEFT":   { "action": "run",  "key": "C" },
"FACEBTN_BOTTOM": { "action": "jump", "key": "SPACE" }
```

Each entry maps a standard-mapping gamepad button to a game action, with an optional
keyboard equivalent. Both `FACEBTN_*` and `FACE_*` names are accepted, as is the
shorthand string form (`"FACE_BOTTOM": "jump"`). Entries omitted from the file keep
their defaults.
# mario-sp
