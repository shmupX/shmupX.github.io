// The console-side music plan: lib/ps2/runtime-sound.ts against a stub of
// AthenaEnv's `Sound` and QuickJS's `std`, with `__PS2_BGM__` as build.ts
// writes it.
//
// The port names a stage's music after its boss and loads only its own nine
// tracks, so a game whose bosses are its own (gs: geekstar, Daltonius) asked
// for tracks nothing answered and played both stages in silence. The disc now
// carries only the tracks its stages play and says which one stands in.

import { assertEquals } from "@std/assert";
import { createAthenaSound } from "../lib/ps2/runtime-sound.ts";

type Globals = Record<string, unknown>;

/** Run `body` with these globals set, putting the old ones back after. */
function withGlobals(set: Globals, body: () => void): void {
  const g = globalThis as unknown as Globals;
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, g[k]]));
  Object.assign(g, set);
  try {
    body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  }
}

/** A disc holding `files`, and a log of what the game opened and probed. */
function fakeDisc(files: string[]) {
  const opened: string[] = [];
  const probed: string[] = [];
  const Sound = {
    setVolume() {},
    findChannel: () => 0,
    Sfx: () => ({ play() {} }),
    Stream: (path: string) => {
      opened.push(path);
      return {
        play() {},
        pause() {},
        playing: () => true,
        rewind() {},
        free() {},
      };
    },
  };
  const std = {
    open: (path: string) => {
      probed.push(path);
      return files.includes(path) ? { close() {} } : null;
    },
  };
  return { Sound, std, opened, probed };
}

const PORT_TRACKS = [
  "adventure_bgm",
  "boss_bison_bgm",
  "boss_barlog_bgm",
  "boss_sagat_bgm",
  "boss_vega_bgm",
  "boss_goki_bgm",
  "boss_fang_bgm",
  "bgm_continue",
  "bgm_gameover",
];

Deno.test("a boss with no track of its own plays the fallback", () => {
  const disc = fakeDisc([
    "assets/sounds/adventure_bgm.wav",
    "assets/sounds/boss_fang_bgm.wav",
  ]);
  withGlobals({
    Sound: disc.Sound,
    std: disc.std,
    __PS2_BGM__: {
      tracks: [
        "adventure_bgm",
        "bgm_continue",
        "bgm_gameover",
        "boss_fang_bgm",
      ],
      alias: {
        boss_geekstar_bgm: "boss_fang_bgm",
        boss_Daltonius_bgm: "boss_fang_bgm",
      },
    },
  }, () => {
    const sound = createAthenaSound();
    for (const key of PORT_TRACKS) {
      sound.loadStream(key, `assets/sounds/${key}.ogg`);
    }
    sound.playBgm("adventure_bgm");
    sound.playBgm("boss_geekstar_bgm");
    sound.playBgm("boss_Daltonius_bgm");
    // A track the build left off is never asked for: no cdfs miss.
    sound.playBgm("boss_bison_bgm");
  });
  assertEquals(disc.opened, [
    "assets/sounds/adventure_bgm.wav",
    "assets/sounds/boss_fang_bgm.wav",
    "assets/sounds/boss_fang_bgm.wav",
  ]);
  assertEquals(
    disc.probed.filter((p) => p.includes("bison")),
    [],
    "probed for a track the disc does not carry",
  );
});

Deno.test("a boss's own track plays though the port never loads it", () => {
  const disc = fakeDisc(["assets/sounds/boss_Daltonius_bgm.wav"]);
  withGlobals({
    Sound: disc.Sound,
    std: disc.std,
    __PS2_BGM__: { tracks: ["boss_Daltonius_bgm"], alias: {} },
  }, () => {
    createAthenaSound().playBgm("boss_Daltonius_bgm");
  });
  assertEquals(disc.opened, ["assets/sounds/boss_Daltonius_bgm.wav"]);
});

Deno.test("without a plan, the port's own tracks play as they always did", () => {
  const disc = fakeDisc(["assets/sounds/boss_bison_bgm.wav"]);
  withGlobals(
    { Sound: disc.Sound, std: disc.std, __PS2_BGM__: undefined },
    () => {
      const sound = createAthenaSound();
      for (const key of PORT_TRACKS) {
        sound.loadStream(key, `assets/sounds/${key}.ogg`);
      }
      sound.playBgm("boss_bison_bgm");
      sound.playBgm("boss_geekstar_bgm");
    },
  );
  assertEquals(disc.opened, ["assets/sounds/boss_bison_bgm.wav"]);
});
