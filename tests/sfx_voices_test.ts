// One-shot effects from a few standing voices, not a new sound per call.
//
// An Android export of the cloud game "rando" stuttered. GameScene.playSound
// played every effect through Phaser's sound.play(key), which builds a whole
// sound (gain, mute and panner nodes, listeners) per call and destroys it when
// it ends, and the hit loop calls it per shot per enemy per 120 Hz step:
// rando's piercing shot raking stage 1's stacked wave asked for 86 se_damage
// in a quarter second, 14 of them in one step, and 200+ copies of the 0.94 s
// sample were alive at once. The runtime (game.bundle.js, a vendored artifact
// patched by hand — README) now keeps a few voices per key, re-strikes the
// oldest when all are sounding, and drops a strike of the same key inside one
// rendered frame.

import { assert, assertEquals } from "@std/assert";

const BUNDLE = "static/games/2028-ai/game.bundle.js";
const read = async (p: string) =>
  (await Deno.readTextFile(new URL(`../${p}`, import.meta.url)))
    .replaceAll("\r\n", "\n");

/** One top-level function of the bundle's IIFE, by name, as source text. */
function functionSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert(start >= 0, `no ${name} in ${BUNDLE}`);
  const end = js.indexOf("\n  }\n", start);
  assert(end > start, `${name} does not close`);
  return js.slice(start, end + 4);
}

/** One method of a class in the bundle, by name, as source text. */
function methodSource(js: string, name: string, after: string): string {
  const from = js.indexOf(after);
  assert(from >= 0, `no ${after} in ${BUNDLE}`);
  const start = js.indexOf(`\n    ${name}(`, from);
  assert(start >= 0, `no ${name}() after ${after}`);
  const end = js.indexOf("\n    }\n", start);
  assert(end > start, `${name}() does not close`);
  return js.slice(start, end + 6);
}

class FakeSound {
  isPlaying = false;
  isPaused = false;
  pendingRemove = false;
  strikes = 0;
  volume = -1;
  constructor(public key: string, public manager: unknown) {}
  play(config: { volume: number }) {
    this.isPlaying = true;
    this.strikes++;
    this.volume = config.volume;
    return true;
  }
}

class FakeManager {
  sounds: FakeSound[] = [];
  add(key: string) {
    const s = new FakeSound(key, this);
    this.sounds.push(s);
    return s;
  }
}

type Voices = {
  due: (key: string, now: number) => boolean;
  play: (sound: FakeManager, key: string, vol: number, now: number) => void;
  /** playSound's own order: the gap, then a voice. */
  strike: (sound: FakeManager, key: string, now: number) => void;
};

async function voices(): Promise<Voices> {
  const js = await read(BUNDLE);
  for (const line of ["var SFX_VOICES = 4;", "var SFX_MIN_GAP_MS = 16;"]) {
    assert(js.includes(`\n  ${line}\n`), `missing ${line}`);
  }
  return new Function(
    "var SFX_VOICES = 4; var SFX_MIN_GAP_MS = 16; var sfxVoices = {};" +
      functionSource(js, "sfxStrikeDue") +
      functionSource(js, "playSfxVoice") +
      `
      return {
        due: sfxStrikeDue,
        play: playSfxVoice,
        strike: function (sound, key, now) {
          if (sfxStrikeDue(key, now)) playSfxVoice(sound, key, 0.15, now);
        },
      };`,
  )() as Voices;
}

Deno.test("the stage 1 burst stands up four voices, not two hundred sounds", async () => {
  const v = await voices();
  const mgr = new FakeManager();
  // 86 se_damage in 250 ms, bunched 14 to a step as the hit loop asks.
  let asked = 0;
  for (let t = 0; asked < 86; t += 8.333) {
    for (let i = 0; i < 14 && asked < 86; i++, asked++) {
      v.strike(mgr, "se_damage", t);
    }
  }
  assertEquals(mgr.sounds.length, 4);
  const struck = mgr.sounds.reduce((n, s) => n + s.strikes, 0);
  // At most one strike per 16 ms frame: 7 steps of 8.3 ms make 4 frames.
  assert(struck <= 4, `${struck} strikes`);
  assert(struck >= 3, `${struck} strikes`);
});

Deno.test("a strike re-uses a voice that has finished, and re-strikes the oldest when none has", async () => {
  const v = await voices();
  const mgr = new FakeManager();
  v.play(mgr, "se_explosion", 0.2, 0);
  v.play(mgr, "se_explosion", 0.2, 100);
  assertEquals(mgr.sounds.length, 2);
  // The first finished: it plays the next one.
  mgr.sounds[0].isPlaying = false;
  v.play(mgr, "se_explosion", 0.3, 200);
  assertEquals(mgr.sounds.length, 2);
  assertEquals(mgr.sounds[0].strikes, 2);
  assertEquals(mgr.sounds[0].volume, 0.3);
  // All four sounding: the oldest is struck again (the one from 100 ms).
  v.play(mgr, "se_explosion", 0.2, 300);
  v.play(mgr, "se_explosion", 0.2, 400);
  assertEquals(mgr.sounds.length, 4);
  v.play(mgr, "se_explosion", 0.2, 500);
  assertEquals(mgr.sounds.length, 4);
  assertEquals(mgr.sounds[1].strikes, 2);
  // A paused voice (the pause panel's) is left paused while another is free.
  mgr.sounds.forEach((s) => (s.isPlaying = false));
  mgr.sounds[0].isPaused = true;
  v.play(mgr, "se_explosion", 0.2, 600);
  assertEquals(mgr.sounds[0].strikes, 2);
  // Keys keep their own voices.
  v.play(mgr, "se_damage", 0.2, 600);
  assertEquals(mgr.sounds.filter((s) => s.key === "se_damage").length, 1);
});

Deno.test("a voice removed from the manager is replaced, never played again", async () => {
  const v = await voices();
  const mgr = new FakeManager();
  v.play(mgr, "se_damage", 0.2, 0);
  const gone = mgr.sounds[0];
  gone.isPlaying = false;
  gone.pendingRemove = true; // sound.removeByKey / removeAll
  v.play(mgr, "se_damage", 0.2, 50);
  assertEquals(gone.strikes, 1);
  assertEquals(mgr.sounds.length, 2);
  // So is one the game's sound manager does not own (a game made again).
  const other = new FakeManager();
  v.play(other, "se_damage", 0.2, 100);
  assertEquals(other.sounds.length, 1);
});

Deno.test("one strike per key per frame, the Dezaemon tone bank's included", async () => {
  const v = await voices();
  assertEquals(v.due("se_shoot", 1000), true);
  assertEquals(v.due("se_shoot", 1010), false);
  assertEquals(v.due("se_damage", 1010), true);
  assertEquals(v.due("se_shoot", 1016), true);
  // GameScene.playSound takes the gap before either road out, and plays a
  // sample through a voice, never through sound.play(key).
  const js = await read(BUNDLE);
  const play = methodSource(
    js,
    "playSound",
    "\n  var PhaserGameScene = class",
  );
  const gap = play.indexOf("if (!sfxStrikeDue(key, now)) return;");
  const deza = play.indexOf("playDezaemonSfx(this, deza)");
  assert(gap > 0 && deza > gap, "the tone bank is not held to the gap");
  assert(play.includes("playSfxVoice(this.sound, key, vol, now)"));
  assert(!play.includes("this.sound.play("), "a sound per call");
  assert(!play.includes(".add(key).play("), "a sound per call");
});
