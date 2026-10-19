// The console-side music plan and effect voices: lib/ps2/runtime-sound.ts
// against a stub of AthenaEnv's `Sound` and QuickJS's `std`, with
// `__PS2_BGM__` as build.ts writes it.
//
// The port names a stage's music after its boss and loads only its own nine
// tracks, so a game whose bosses are its own (gs: geekstar, Daltonius) asked
// for tracks nothing answered and played both stages in silence. The disc now
// carries only the tracks its stages play and says which one stands in.

import { assertEquals } from "@std/assert";
import { createAthenaSound, SFX_VOICES } from "../lib/ps2/runtime-sound.ts";

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

// ------------------------------------------------------------ effects ----
//
// A wave going down on the PS2 asked for an explosion per enemy, each on a
// voice of its own at full volume, and the SPU2 summed and clipped them. The
// runtime now holds one effect to the browser's rules: one strike a frame,
// and no more than SFX_VOICES of it sounding.

/**
 * audsrv as ps2sdk and AthenaEnv have it: 24 channels, the lowest free one
 * from findChannel (-1 when none is), a sounding channel refusing a new
 * sample, and `playing(ch)` true only for the sample that channel is on.
 */
function fakeAudsrv(options: { canAsk?: boolean } = {}) {
  const on: (string | null)[] = new Array(24).fill(null);
  /** Every play the game asked audsrv for, refused or not. */
  const asked: { key: string; ch: number }[] = [];
  /** The ones that started. */
  const started: string[] = [];
  const Sound = {
    setVolume() {},
    findChannel: () => on.indexOf(null),
    Sfx: (path: string) => {
      const key = path.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
      const sfx: Record<string, unknown> = {
        volume: 100,
        play(ch: number) {
          asked.push({ key, ch });
          if (ch >= 0 && ch < 24 && on[ch] === null) {
            on[ch] = key;
            started.push(key);
          }
          return ch;
        },
      };
      if (options.canAsk !== false) {
        sfx.playing = (ch: number) => on[ch] === key;
      }
      return sfx;
    },
    Stream: () => ({
      play() {},
      pause() {},
      playing: () => false,
      rewind() {},
      free() {},
    }),
  };
  return {
    Sound,
    std: { open: () => ({ close() {} }) },
    on,
    asked,
    started,
    /** Every voice sounding `key` runs out. */
    end(key: string) {
      for (let ch = 0; ch < 24; ch++) if (on[ch] === key) on[ch] = null;
    },
  };
}

function withEffects(
  audsrv: ReturnType<typeof fakeAudsrv>,
  body: (sound: ReturnType<typeof createAthenaSound>) => void,
): void {
  withGlobals({
    Sound: audsrv.Sound,
    std: audsrv.std,
    __PS2_SFX__: undefined,
    __PS2_BGM__: undefined,
  }, () => {
    const sound = createAthenaSound();
    for (const key of ["se_explosion", "se_damage", "se_shoot"]) {
      sound.loadSfx(key, `assets/sounds/${key}.wav`);
    }
    body(sound);
  });
}

Deno.test("a wave going down in one frame is one explosion, not twelve", () => {
  const audsrv = fakeAudsrv();
  withEffects(audsrv, (sound) => {
    for (let i = 0; i < 12; i++) sound.playSound("se_explosion", 0.175);
    sound.playSfx("se_damage");
    sound.pump();
    sound.playSound("se_explosion", 0.175);
  });
  assertEquals(audsrv.started, ["se_explosion", "se_damage", "se_explosion"]);
  assertEquals(audsrv.asked.map((a) => a.ch), [0, 1, 2]);
});

Deno.test("no more than SFX_VOICES of one effect sound at once", () => {
  const audsrv = fakeAudsrv();
  withEffects(audsrv, (sound) => {
    for (let frame = 0; frame < 10; frame++) {
      sound.playSfx("se_explosion");
      sound.playSfx("se_shoot");
      sound.pump();
    }
    const sounding = (key: string) => audsrv.on.filter((k) => k === key);
    assertEquals(sounding("se_explosion").length, SFX_VOICES);
    // Each effect has a cap of its own.
    assertEquals(sounding("se_shoot").length, SFX_VOICES);
    // Once they ring out, it strikes again.
    audsrv.end("se_explosion");
    sound.playSfx("se_explosion");
    assertEquals(sounding("se_explosion").length, 1);
  });
  // The strikes over the cap never reached audsrv.
  assertEquals(
    audsrv.asked.filter((a) => a.key === "se_explosion").length,
    SFX_VOICES + 1,
  );
});

Deno.test("with every voice sounding, a strike is dropped, not forced onto channel 0", () => {
  const audsrv = fakeAudsrv();
  audsrv.on.fill("voice_ko");
  withEffects(audsrv, (sound) => sound.playSfx("se_explosion"));
  assertEquals(audsrv.asked, []);
});

Deno.test("an AthenaEnv that cannot say what is playing still gets a strike a frame", () => {
  const audsrv = fakeAudsrv({ canAsk: false });
  withEffects(audsrv, (sound) => {
    for (let frame = 0; frame < 6; frame++) {
      sound.playSfx("se_explosion");
      sound.playSfx("se_explosion");
      sound.pump();
    }
  });
  assertEquals(audsrv.started.length, 6);
});
