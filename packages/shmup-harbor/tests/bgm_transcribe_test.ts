// lib/bgm-transcribe.ts, piece by piece and end to end.
//
// The end-to-end case is a melody ffmpeg synthesises at a known tempo: four
// notes round and round at 120 BPM, a quarter each, over a quiet noise floor
// so the spectrum has a realistic envelope to whiten against. What comes back
// must be those pitch bytes four steps apart at tempo index 19 — and every
// slot must decode, through the engine's own decodeSong, to the events the
// transcriber meant.

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
} from "@std/assert";
import {
  analyseOnsets,
  autocorrelate,
  buildStepGrid,
  type Cell,
  decodeAudio,
  type DecodedAudio,
  detectDrums,
  downsampleCells,
  encodeSlots,
  ffmpegPath,
  hannWindow,
  makeFft,
  midiToHz,
  onsetAgreement,
  planSlots,
  type SongEvent,
  STEPS_PER_BEAT,
  transcribe,
} from "../lib/bgm-transcribe.ts";
import {
  buildDezaemonBgm,
  foldMidiToPitch,
  SONG_STEPS,
  tempoIndexForStepSeconds,
} from "@shmupx/shmup-engine";
import { decodeSong } from "../../shmup-engine/src/decode/decode-song.js";

// ── FFT ─────────────────────────────────────────────────────────────────────

Deno.test("bgm-transcribe: the radix-2 FFT matches a direct DFT", () => {
  for (const n of [16, 64, 256]) {
    const fft = makeFft(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    for (let i = 0; i < n; i++) {
      re[i] = rand();
      im[i] = rand();
    }
    const want = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
        si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
      }
      want[2 * k] = sr;
      want[2 * k + 1] = si;
    }
    fft(re, im);
    for (let k = 0; k < n; k++) {
      assertAlmostEquals(re[k], want[2 * k], 1e-9, `N=${n} re[${k}]`);
      assertAlmostEquals(im[k], want[2 * k + 1], 1e-9, `N=${n} im[${k}]`);
    }
  }
});

Deno.test("bgm-transcribe: a Hann-windowed sine lands in its bin", () => {
  const n = 1024;
  const fft = makeFft(n);
  const win = hannWindow(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bin = 100;
  for (let i = 0; i < n; i++) {
    re[i] = Math.sin((2 * Math.PI * bin * i) / n) * win[i];
  }
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) {
    if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k;
  }
  assertEquals(best, bin);
  // 4|X|/n reads a full-scale sine as 1.
  assertAlmostEquals((4 * Math.hypot(re[bin], im[bin])) / n, 1, 1e-6);
});

Deno.test("bgm-transcribe: autocorrelation finds a period", () => {
  const x = new Float64Array(2000);
  for (let i = 0; i < x.length; i += 37) x[i] = 1;
  const acf = autocorrelate(x, 0, x.length, 100);
  let best = 10;
  for (let lag = 10; lag <= 100; lag++) if (acf[lag] > acf[best]) best = lag;
  assertEquals(best, 37);
});

Deno.test("bgm-transcribe: frame 0 is not an onset", () => {
  const sr = 22050;
  const samples = new Float32Array(sr);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  const onsets = analyseOnsets({
    samples,
    sampleRate: sr,
    peak: 1,
    duration: 1,
  });
  assertEquals(onsets.flux[0], 0);
  assertEquals(onsets.lowFlux[0], 0);
  assertEquals(onsets.highFlux[0], 0);
  // A steady tone has no onsets at all: before the fix frame 0 alone carried
  // the whole log spectrum, tens of units.
  let most = 0;
  for (let f = 0; f < onsets.flux.length; f++) {
    most = Math.max(most, onsets.flux[f]);
  }
  assert(most < 0.5, `flux peaks at ${most}`);
});

// ── Pitch and tempo arithmetic ──────────────────────────────────────────────

Deno.test("bgm-transcribe: pitches fold into the cart's C2..Bb6 as bytes", () => {
  assertEquals(foldMidiToPitch(36), 1); // C2
  assertEquals(foldMidiToPitch(94), 59); // Bb6
  assertEquals(foldMidiToPitch(24), 1); // C1 → C2
  assertEquals(foldMidiToPitch(35), 12); // B1 → B2
  assertEquals(foldMidiToPitch(95), 48); // B6 → B5
  assertEquals(foldMidiToPitch(108), 49); // C8 → C6
  assertAlmostEquals(midiToHz(69), 440, 1e-9);
  assertAlmostEquals(midiToHz(57), 220, 1e-9);
});

Deno.test("bgm-transcribe: the tempo index follows the beat", () => {
  // 120 BPM → 0.125 s sixteenths → divisor 30 → index 19, exactly.
  assertEquals(tempoIndexForStepSeconds(0.125), 19);
  // The survey's sections.
  assertEquals(tempoIndexForStepSeconds(60 / 114.7 / 4), 18);
  assertEquals(tempoIndexForStepSeconds(60 / 86 / 4), 9);
  assertEquals(tempoIndexForStepSeconds(60 / 80 / 4), 7);
  // planSlots reads the same off a grid of beats.
  const beats = Float64Array.from({ length: 200 }, (_, i) => i * (60 / 114.7));
  const grid = buildStepGrid(beats, beats[199]);
  const plans = planSlots(grid);
  assertEquals(plans[0].tempoIndex, 18);
  assertEquals(plans[0].grid, 1);
  assertAlmostEquals(plans[0].sourceStepSeconds, 60 / 114.7 / 4, 1e-9);
  // An eighth grid asks for twice the step.
  assertEquals(
    planSlots(grid, { grid: 8 })[0].tempoIndex,
    tempoIndexForStepSeconds((2 * 60) / 114.7 / 4),
  );
});

/** Beats at a run of constant periods: [count, period] segments. */
function beatsAt(...segments: [number, number][]): Float64Array {
  const times: number[] = [];
  let t = 0;
  for (const [count, period] of segments) {
    for (let i = 0; i < count; i++, t += period) times.push(t);
  }
  return Float64Array.from(times);
}

function gridOf(beats: Float64Array) {
  return buildStepGrid(beats, beats[beats.length - 1]);
}

function assertContiguousOnBeats(
  plans: ReturnType<typeof planSlots>,
  steps: number,
) {
  for (let i = 0; i < plans.length; i++) {
    assertEquals(plans[i].startStep % STEPS_PER_BEAT, 0, `slot ${i} start`);
    if (i > 0) {
      assertEquals(
        plans[i].startStep,
        plans[i - 1].startStep + plans[i - 1].stepCount,
        `slot ${i} follows ${i - 1}`,
      );
    }
    // Every cut slot is whole measures; only the song's last may not be.
    if (i + 1 < plans.length) {
      assert(
        plans[i].stepCount >= 16,
        `slot ${i} is ${plans[i].stepCount} steps`,
      );
      assertEquals(plans[i].stepCount % 16, 0, `slot ${i} whole measures`);
    }
  }
  assertEquals(plans.reduce((n, p) => n + p.stepCount, 0), steps);
}

Deno.test("bgm-transcribe: slots start on beats and cut at a tempo change", () => {
  // 200 beats at 120 BPM, then 200 at 80 BPM.
  const grid = gridOf(beatsAt([200, 0.5], [200, 0.75]));
  assertEquals(grid.firstTrackedBeat, 0);
  const plans = planSlots(grid);
  assertContiguousOnBeats(plans, grid.steps);
  // Slot 0 is full; slot 1 is cut at beat 200 (step 800), where 80 BPM begins.
  assertEquals(plans[0].stepCount, SONG_STEPS);
  assertEquals(plans[0].tempoIndex, 19);
  assertEquals(plans[1].startStep, SONG_STEPS);
  assertEquals(plans[1].stepCount, 800 - SONG_STEPS);
  assertEquals(plans[1].tempoIndex, 19);
  assertEquals(plans[2].startStep, 800);
  assertEquals(plans[2].tempoIndex, 7);
  assertEquals(plans[2].stepCount, SONG_STEPS);
});

Deno.test("bgm-transcribe: a change twenty beats into a slot is cut there, both ways", () => {
  for (
    const [a, b, idxA, idxB] of [
      [0.5, 0.75, 19, 7],
      [0.75, 0.5, 7, 19],
    ] as const
  ) {
    const grid = gridOf(beatsAt([148, a], [100, b]));
    const plans = planSlots(grid);
    assertContiguousOnBeats(plans, grid.steps);
    assertEquals(plans[0].startStep, 0);
    assertEquals(plans[0].stepCount, SONG_STEPS);
    assertEquals(plans[0].tempoIndex, idxA);
    // Twenty beats of the old tempo, then the cut — on the change itself.
    assertEquals(plans[1].startStep, SONG_STEPS);
    assertEquals(plans[1].stepCount, 80);
    assertEquals(plans[1].tempoIndex, idxA);
    assertEquals(plans[2].startStep, SONG_STEPS + 80);
    assertEquals(plans[2].tempoIndex, idxB);
    // No micro-slot after the cut: the next slot is the remaining music.
    assertEquals(
      plans.length,
      3,
      `${a}→${b}: ${plans.map((p) => p.stepCount)}`,
    );
  }
});

Deno.test("bgm-transcribe: a twenty-beat intro at another tempo gets its own slot", () => {
  const grid = gridOf(beatsAt([20, 0.75], [200, 0.5]));
  const plans = planSlots(grid);
  assertContiguousOnBeats(plans, grid.steps);
  assertEquals(plans[0].startStep, 0);
  assertEquals(plans[0].stepCount, 80);
  assertEquals(plans[0].tempoIndex, 7);
  assertEquals(plans[1].startStep, 80);
  assertEquals(plans[1].stepCount, SONG_STEPS);
  assertEquals(plans[1].tempoIndex, 19);
});

Deno.test("bgm-transcribe: a cut off the measure grid snaps to whole measures and keeps the index honest", () => {
  // 150 beats at 120, so the change (step 600) is 88 steps into slot 1.
  const grid = gridOf(beatsAt([150, 0.5], [100, 0.75]));
  const plans = planSlots(grid);
  assertContiguousOnBeats(plans, grid.steps);
  const cut = plans[1].startStep + plans[1].stepCount;
  assertEquals((cut - plans[1].startStep) % 16, 0);
  assert(
    Math.abs(cut - 600) <= 8,
    `cut ${cut} is within half a measure of 600`,
  );
  // The slot's tempo comes from its own steps, not the displaced ones.
  assertEquals(plans[1].tempoIndex, 19);
  assertAlmostEquals(plans[1].sourceStepSeconds, 0.125, 1e-9);
  assertEquals(plans[2].startStep, cut);
  assertEquals(plans[2].tempoIndex, 7);
  assertAlmostEquals(plans[2].sourceStepSeconds, 0.1875, 1e-9);
  // ... and the loop end is exactly the content: no dead measure.
  const slots = encodeSlots([[], [], [], []], plans, grid);
  assertEquals((slots[1].loopEnd + 1) * 16, Math.floor(plans[1].stepCount));
  assertAlmostEquals(
    slots[1].playSeconds,
    plans[1].stepCount * slots[1].stepSeconds,
    1e-9,
  );
});

Deno.test("bgm-transcribe: a section between two indices keeps one index slot to slot", () => {
  // A step at the exact log midpoint of indices 26 and 27, then a hair longer.
  const mid = Math.sqrt((22 / 240) * (23 / 240));
  const grid = gridOf(beatsAt([128, 4 * mid], [200, 4 * mid * 1.002]));
  const plans = planSlots(grid);
  assert(plans.length >= 2);
  assertEquals(plans[1].tempoIndex, plans[0].tempoIndex);
  assert(plans[0].tempoIndex === 26 || plans[0].tempoIndex === 27);
  // A real change still moves the index.
  const change = planSlots(gridOf(beatsAt([128, 0.5], [128, 0.75])));
  assertEquals(change[0].tempoIndex, 19);
  assertEquals(change[1].tempoIndex, 7);
});

Deno.test("bgm-transcribe: a slot with a tie on step 0 strikes, and short slots loop early", () => {
  const beats = Float64Array.from({ length: 40 }, (_, i) => i * 0.5);
  const grid = buildStepGrid(beats, 20);
  const line: (Cell | null)[] = new Array(grid.steps).fill(null);
  for (let s = 0; s < grid.steps; s++) {
    line[s] = { note: 25, instrument: 13, tie: s > 0 };
  }
  const plans = planSlots(grid);
  assertEquals(plans.length, 1);
  const slots = encodeSlots([line, [], [], []], plans, grid);
  assertEquals(slots[0].parts[0].length, 1);
  assertEquals(slots[0].parts[0][0].len, grid.steps);
  assertEquals(slots[0].loopEnd, Math.ceil(grid.steps / 16) - 1);
  assert(slots[0].loopEnd < 31);
});

Deno.test("bgm-transcribe: eighths keep the on-grid strike, and a kick over a hat", () => {
  const c = (note: number, tie = false): Cell => ({ note, instrument: 1, tie });
  // A held note then a strike inside the pair: the note changes.
  const line: (Cell | null)[] = [
    c(10),
    c(10, true),
    null,
    c(12),
    c(14, true),
    c(14, true),
    c(16),
    null,
  ];
  assertEquals(downsampleCells(line, 2), [c(10), c(12), c(14, true), c(16)]);
  // Two strikes in one pair: the first (on the grid) stays.
  assertEquals(downsampleCells([c(25), c(27)], 2), [c(25)]);
  // A tie then a strike: the strike.
  assertEquals(downsampleCells([c(25, true), c(27)], 2), [c(27)]);
  // Drums rank kick > snare > hat whatever the order inside the pair.
  const K: Cell = { note: 3, instrument: 41, tie: false };
  const S: Cell = { note: 25, instrument: 40, tie: false };
  const H: Cell = { note: 50, instrument: 48, tie: false };
  const rank = [41, 40, 48];
  const prefer = (a: Cell, b: Cell) =>
    rank.indexOf(b.instrument) < rank.indexOf(a.instrument) ? b : a;
  assertEquals(downsampleCells([K, H, S, H], 2, prefer), [K, S]);
  assertEquals(downsampleCells([H, K, H, S], 2, prefer), [K, S]);
  // Through encodeSlots at an eighth grid the drum part keeps no hat.
  const beats = Float64Array.from({ length: 65 }, (_, i) => i * 0.5);
  const grid = buildStepGrid(beats, 32);
  const drums: (Cell | null)[] = [];
  for (let s = 0; s < grid.steps; s++) drums.push([K, H, S, H][s % 4]);
  const slots = encodeSlots(
    [[], [], [], drums],
    planSlots(grid, { grid: 8 }),
    grid,
  );
  const instruments = new Set(slots[0].parts[3].map((e) => e.instrument));
  assertEquals([...instruments].sort(), [40, 41]);
});

Deno.test("bgm-transcribe: onset agreement is one-to-one within the tolerance", () => {
  const truth = [1, 2, 3, 4];
  const found = [1.05, 2.5, 3.01, 3.02, 4];
  const r = onsetAgreement(truth, found, 0.07);
  assertEquals(r.recall, 3 / 4);
  assertEquals(r.precision, 3 / 5);
});

// ── Drums on a synthetic track ──────────────────────────────────────────────

Deno.test("bgm-transcribe: low bursts are kicks, noise bursts are hats", () => {
  const sr = 22050;
  const seconds = 12;
  const samples = new Float32Array(sr * seconds);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  // A kick on every beat (0.5 s), a hat on every off-beat eighth.
  for (let beat = 0; beat < seconds * 2; beat++) {
    const at = Math.round(beat * 0.5 * sr);
    for (let i = 0; i < 0.08 * sr; i++) {
      samples[at + i] += 0.9 * Math.exp(-i / (0.02 * sr)) *
        Math.sin((2 * Math.PI * 70 * i) / sr);
    }
    const hat = at + Math.round(0.25 * sr);
    for (let i = 0; i < 0.04 * sr && hat + i < samples.length; i++) {
      samples[hat + i] += 0.5 * Math.exp(-i / (0.01 * sr)) * rand();
    }
  }
  const audio: DecodedAudio = {
    samples,
    sampleRate: sr,
    peak: 1,
    duration: seconds,
  };
  const onsets = analyseOnsets(audio);
  const beats = Float64Array.from({ length: seconds * 2 }, (_, i) => i * 0.5);
  const grid = buildStepGrid(beats, seconds);
  const drums = detectDrums(onsets, grid);
  let kicksOnBeat = 0;
  let kicksOff = 0;
  let hatsOnOff = 0;
  let hatsElsewhere = 0;
  for (let s = 0; s < grid.steps; s++) {
    const d = drums[s];
    const phase = s % STEPS_PER_BEAT;
    if (d.kick) phase === 0 ? kicksOnBeat++ : kicksOff++;
    if (d.hat || d.snare) phase === 2 ? hatsOnOff++ : hatsElsewhere++;
  }
  assert(kicksOnBeat >= seconds * 2 - 2, `kicks on the beat: ${kicksOnBeat}`);
  assertEquals(kicksOff, 0);
  assert(hatsOnOff >= seconds * 2 - 3, `hats on the off-beat: ${hatsOnOff}`);
  assert(hatsElsewhere <= 1, `stray hats: ${hatsElsewhere}`);
});

// ── ffmpeg ──────────────────────────────────────────────────────────────────

Deno.test("bgm-transcribe: a missing ffmpeg is named, with the way out", async () => {
  await assertRejects(
    () => decodeAudio("nothing.wav", { ffmpeg: "/nonexistent/bin/ffmpeg" }),
    Error,
    "ffmpeg not found at /nonexistent/bin/ffmpeg; install it or pass --ffmpeg",
  );
});

const FFMPEG = ffmpegPath();
let haveFfmpeg = false;
try {
  haveFfmpeg = (await new Deno.Command(FFMPEG, {
    args: ["-version"],
    stdout: "null",
    stderr: "null",
  }).output()).success;
} catch {
  haveFfmpeg = false;
}
if (!haveFfmpeg) {
  console.log("  (bgm-transcribe: ffmpeg melody test skipped — no ffmpeg)");
}

/** C4 E4 G4 C5, a quarter each at 120 BPM: pitch bytes 25 29 32 37. */
const MELODY_HZ = [261.63, 329.63, 391.995, 523.25];
const MELODY_BYTES = [25, 29, 32, 37];
const CLIP_SECONDS = 24;

async function synthMelody(dir: string): Promise<string> {
  const path = `${dir}/melody.wav`;
  const f = `if(lt(mod(t,2),0.5),${MELODY_HZ[0]},if(lt(mod(t,2),1),${
    MELODY_HZ[1]
  },if(lt(mod(t,2),1.5),${MELODY_HZ[2]},${MELODY_HZ[3]})))`;
  const expr = `0.8*exp(-3*mod(t,0.5))*sin(2*PI*t*${f})`;
  const graph = `aevalsrc='${expr}':s=22050:d=${CLIP_SECONDS}[m];` +
    `anoisesrc=r=22050:a=0.002:c=white:d=${CLIP_SECONDS}:seed=1[n];` +
    `[m][n]amix=inputs=2:normalize=0[out]`;
  const out = await new Deno.Command(FFMPEG, {
    args: [
      "-v",
      "error",
      "-y",
      "-filter_complex",
      graph,
      "-map",
      "[out]",
      "-ac",
      "1",
      "-ar",
      "22050",
      path,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return path;
}

Deno.test({
  name:
    "bgm-transcribe: an ffmpeg melody at 120 BPM comes back as its pitch bytes at index 19",
  ignore: !haveFfmpeg,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "bgm-transcribe-" });
    try {
      const wav = await synthMelody(dir);
      const result = await transcribe(wav, { verify: true, ffmpeg: FFMPEG });

      // Tempo: one section at 120 BPM.
      assertEquals(result.tempo.sections.length, 1);
      assertAlmostEquals(result.tempo.sections[0].bpm, 120, 1);
      assertEquals(result.grid, 16);
      assertEquals(result.slots.length, 1);
      const slot = result.slots[0];
      assertEquals(slot.tempoIndex, 19);
      assertEquals(slot.loopEnd < 31, true, "a 24 s clip does not fill a slot");

      // The lead: the four bytes round and round, each on a beat.
      const lead = slot.parts[0].slice().sort((a, b) => a.step - b.step);
      assert(lead.length >= 44, `lead events: ${lead.length}`);
      const phases = [0, 0, 0, 0];
      for (const e of lead) phases[e.step % STEPS_PER_BEAT]++;
      const onBeat = Math.max(...phases);
      assert(
        onBeat >= 0.95 * lead.length,
        `strikes on one beat phase: ${phases}`,
      );
      let follows = 0;
      for (let i = 1; i < lead.length; i++) {
        const prev = MELODY_BYTES.indexOf(lead[i - 1].note);
        const want = MELODY_BYTES[(prev + 1) % 4];
        if (prev >= 0 && lead[i].note === want) follows++;
      }
      assert(
        follows >= 0.95 * (lead.length - 1),
        `melody order kept: ${follows}/${lead.length - 1}`,
      );
      for (const e of lead) {
        assert(e.len >= 1 && e.len <= STEPS_PER_BEAT, `len ${e.len}`);
      }
      assert(
        lead.filter((e) => e.len === STEPS_PER_BEAT).length >=
          0.8 * lead.length,
        "notes held a beat",
      );

      // Nothing below the melody, and no spurious inner voice.
      assertEquals(slot.parts[1].length, 0, "bass");
      assert(slot.parts[2].length <= 2, `pad events: ${slot.parts[2].length}`);
      assertEquals(slot.parts[0][0].instrument, 13);

      // The engine reads back exactly what was meant.
      assertDecodesTo(slot.bytes, slot.parts, slot.tempoIndex, slot.loopEnd);
      const bgm = result.dezaemonBgm as {
        songs: Record<string, string>;
        sequence: number[];
      };
      assertEquals(bgm.sequence, [0]);
      const back = Uint8Array.from(
        atob(bgm.songs["0"]),
        (c) => c.charCodeAt(0),
      );
      assertEquals(back, slot.bytes);

      // The offline check agrees with itself on a clean signal.
      assert(result.verification !== null);
      assert(
        result.verification.chromaMean > 0.85,
        `chroma ${result.verification.chromaMean}`,
      );
      assert(
        result.verification.onsetF > 0.85,
        `onset F ${result.verification.onsetF}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── The engine reads back what was written ──────────────────────────────────

function assertDecodesTo(
  bytes: Uint8Array,
  parts: SongEvent[][],
  tempoIndex: number,
  loopEnd: number,
) {
  const song = decodeSong(bytes);
  assertEquals(song.tempoIndex, tempoIndex);
  assertEquals(song.loopStart, 0);
  assertEquals(song.loopEnd, loopEnd);
  for (let p = 0; p < 4; p++) {
    const want = (parts[p] ?? []).slice().sort((a, b) => a.step - b.step).map((
      e,
    ) => ({
      step: e.step,
      note: e.note,
      instrument: e.instrument,
      len: e.len,
    }));
    const got = song.events[p].map((e: SongEvent) => ({
      step: e.step,
      note: e.note,
      instrument: e.instrument,
      len: e.len,
    }));
    assertEquals(got, want, `part ${p}`);
  }
}

Deno.test("bgm-transcribe: every slot decodes to the events meant, through decodeSong", () => {
  // Two slots: 160 beats of 0.5 s, so slot 1 is short; four busy parts.
  const beats = Float64Array.from({ length: 161 }, (_, i) => i * 0.5);
  const grid = buildStepGrid(beats, 80);
  const lines: (Cell | null)[][] = [0, 1, 2, 3].map(() =>
    new Array(grid.steps).fill(null)
  );
  for (let s = 0; s < grid.steps; s++) {
    // Lead: a new note every 3 steps, held with ties.
    lines[0][s] = {
      note: 20 + (Math.floor(s / 3) % 12),
      instrument: 13,
      tie: s % 3 !== 0,
    };
    // Bass: on beats, two steps long.
    if (s % 4 === 0) {
      lines[1][s] = { note: 1 + (s % 7), instrument: 18, tie: false };
    }
    if (s % 4 === 1) {
      lines[1][s] = { note: 1 + ((s - 1) % 7), instrument: 18, tie: true };
    }
    // Pad: long held chords re-struck every 32 steps.
    lines[2][s] = {
      note: 30 + (Math.floor(s / 32) % 5),
      instrument: 23,
      tie: s % 32 !== 0,
    };
    // Drums: kick, hat, snare, hat.
    const d = s % 4;
    lines[3][s] = d === 0
      ? { note: 3, instrument: 41, tie: false }
      : d === 2
      ? { note: 25, instrument: 40, tie: false }
      : { note: 50, instrument: 48, tie: false };
  }
  const plans = planSlots(grid);
  assertEquals(plans.length, 2);
  const slots = encodeSlots(lines, plans, grid, { echo: 2 });
  for (const slot of slots) {
    assertEquals(slot.bytes.length, 4228);
    assertDecodesTo(slot.bytes, slot.parts, slot.tempoIndex, slot.loopEnd);
    assertEquals(decodeSong(slot.bytes).echoLevel, 2);
    // A tie crossing the slot boundary was struck afresh at step 0.
    for (const part of slot.parts) {
      for (const e of part) assert(e.step >= 0 && e.step < SONG_STEPS);
    }
  }
  assertEquals(slots[0].loopEnd, 31);
  assert(slots[1].loopEnd < 31);
  // And through buildDezaemonBgm, back again.
  const bgm = buildDezaemonBgm({
    songs: slots.map((s) => s.bytes),
    stageCount: 5,
  }) as unknown as {
    songs: Record<string, string>;
    stages: number[][];
    sequence: number[];
    tempos: Record<string, number>;
  };
  assertEquals(bgm.sequence, [0, 1]);
  assertEquals(bgm.stages.length, 5);
  for (let i = 0; i < slots.length; i++) {
    const back = Uint8Array.from(
      atob(bgm.songs[String(i)]),
      (c) => c.charCodeAt(0),
    );
    assertEquals(back, slots[i].bytes);
    assertAlmostEquals(bgm.tempos[String(i)], slots[i].stepSeconds, 1e-12);
  }
});
