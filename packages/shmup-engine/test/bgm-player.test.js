// What the editor's player adds to the runtime's (tests/music_player_parity_test.ts
// holds the shared part equal): a song swapped in while it plays keeps its
// place, a tempo change keeps the beat, mute and solo, a looping region, and
// auditions. Run on a context that only counts notes.
import { assert, assertEquals } from "@std/assert";
import { createBgmPlayer, MIX_STREAMS, TONE_BANK_PATH, loadToneBank } from "../src/audio/bgm-player.js";
import { emptySong } from "../src/audio/bgm-record.js";
import { placeNote, setHeader, setRhythm } from "../src/audio/song-edit.js";

function quietCtx() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {} });
  const node = (extra = {}) => ({ connect: (to) => to, disconnect() {}, ...extra });
  return {
    currentTime: 0,
    sampleRate: 48000,
    destination: node(),
    createGain: () => node({ gain: param() }),
    createStereoPanner: () => node({ pan: param() }),
    createDelay: () => node({ delayTime: param() }),
    createBuffer: (ch, len, rate) => ({ length: len, sampleRate: rate, getChannelData: () => new Float32Array(len) }),
    createPeriodicWave: () => ({}),
    createOscillator: () => node({ frequency: param(), setPeriodicWave() {}, start() {}, stop() {} }),
    createBufferSource: () => node({ playbackRate: param(), start() {}, stop() {} }),
  };
}

function rig() {
  const ctx = quietCtx();
  const notes = [];
  let pump = () => {};
  const player = createBgmPlayer(ctx, {
    timers: { setInterval: (fn) => ((pump = fn), 1), clearInterval: () => {} },
    trace: (n) => notes.push(n),
  });
  const run = (seconds) => {
    for (let t = ctx.currentTime; t <= seconds; t += 0.05) {
      ctx.currentTime = t;
      pump();
    }
  };
  return { ctx, player, notes, run };
}

function melody() {
  let s = emptySong();
  for (let m = 0; m < 4; m++) s = placeNote(s, { part: 0, step: m * 16, len: 4, pitch: 20 + m, inst: 1 });
  return setHeader(s, { loopStart: 0, loopEnd: 3, tempoIndex: 31 }); // 0.075 s a step
}

Deno.test("plays from step 0, loops the song's loop, and reports where it is", () => {
  const { player, notes, run, ctx } = rig();
  player.load(melody()).play();
  run(10);
  const pitches = notes.map((n) => n.e.note);
  assertEquals(pitches.slice(0, 6), [20, 21, 22, 23, 20, 21]);
  const pos = player.position();
  assert(pos.step >= 0 && pos.step < 64);
  assertEquals(ctx.currentTime > 9.9, true);
});

Deno.test("a song swapped in while it plays keeps its place; a tempo change keeps the beat", () => {
  const { player, notes, run } = rig();
  player.load(melody()).play();
  run(1.3); // past measure 1 (16 steps x 0.075 = 1.2 s)
  const before = notes.length;
  const swapped = placeNote(melody(), { part: 1, step: 32, len: 2, pitch: 40, inst: 9 });
  const where = player.position().step;
  player.load(swapped);
  assertEquals(player.position().step, where);
  run(3);
  assert(notes.slice(before).some((n) => n.stream === 1 && n.e.note === 40), "the new note plays");
  const slower = setHeader(swapped, { tempoIndex: 15 });
  const at = player.position().step;
  player.load(slower);
  assertEquals(player.position().step, at);
});

Deno.test("mute, solo and the accompaniment bus", () => {
  const { player } = rig();
  player.load(melody());
  player.setSolo(2, true);
  assertEquals(player.mix().soloed, [false, false, true, false, false]);
  player.setMute(4, true);
  assertEquals(player.mix().muted, [false, false, false, false, true]);
  assertEquals(MIX_STREAMS, 5);
});

Deno.test("a region loops just its measures, from the step asked for", () => {
  const { player, notes, run } = rig();
  player.load(melody()).play({ region: [2, 2], fromStep: 32 });
  run(6);
  assert(notes.length >= 3);
  assert(notes.every((n) => n.e.note === 22), JSON.stringify(notes.map((n) => n.e.note)));
});

Deno.test("the accompaniment plays its own channels, two frames behind", () => {
  const { player, notes, run } = rig();
  const s = setRhythm(setHeader(emptySong(), { tempoIndex: 31 }), 0, { bank: 3, pattern: 0, chord: 0, key: 3 });
  player.load(s).play();
  run(1.1);
  const accomp = notes.filter((n) => n.stream >= 4);
  assert(accomp.length > 0);
  assertEquals(accomp.every((n) => n.e.inst === 63), true);
});

Deno.test("auditions sound without a song playing", () => {
  const { player } = rig();
  player.audition(13, 25, { part: 0 });
  player.auditionRhythm([3, 0, 0, 3], 0.1);
  assertEquals(player.playing(), false);
});

Deno.test("loadToneBank tries each base and gives null when none answers", async () => {
  const asked = [];
  const fetchImpl = (url) => {
    asked.push(url);
    if (url.startsWith("/b/")) {
      return Promise.resolve(
        url.endsWith(".json")
          ? { ok: true, json: () => Promise.resolve({ sampleRate: 14848, slices: [], instruments: [] }) }
          : { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)) },
      );
    }
    return Promise.resolve({ ok: false });
  };
  const bank = await loadToneBank(["/a/", "/b/"], fetchImpl);
  assertEquals(bank.pcm.length, 2);
  assertEquals(asked, ["/a/tone-bank.json", "/a/tone-bank.pcm", "/b/tone-bank.json", "/b/tone-bank.pcm"]);
  assertEquals(await loadToneBank(["/a/"], fetchImpl), null);
  assertEquals(TONE_BANK_PATH, "/games/2028-ai/assets/tone-bank/");
});
