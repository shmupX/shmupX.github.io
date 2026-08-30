// The tone bank: the instrument map's SNDPAC offsets and loop points.
//
// The table itself (src/audio/tone-bank-table.js) ships with the package, so
// its shape is checked unconditionally. Anything that needs actual samples is
// gated on a local SNDPAC.BIN — see _fixtures.js; the bank is disc content and
// never ships here.

import { assert, assertEquals } from "@std/assert";
import {
  cutLayer,
  INSTRUMENT_COUNT,
  instrumentAt,
  LAYER_COUNT,
  layerAt,
  LOOP_ALTERNATE,
  LOOP_FORWARD,
  LOOP_OFF,
  LOOP_REVERSE,
  pickLayers,
  playbackRate,
  SCSP_BASE_RATE,
  toFloat32,
  uniqueSlices,
} from "../src/audio/tone-bank.js";
import { hasSoundBank, loadSoundBank } from "./_fixtures.js";

Deno.test("the tone bank table has the traced shape", () => {
  assertEquals(INSTRUMENT_COUNT, 116);
  assertEquals(LAYER_COUNT, 590);
  let layers = 0;
  for (let i = 0; i < INSTRUMENT_COUNT; i++) {
    const inst = instrumentAt(i);
    assertEquals(inst.firstLayer, layers, `instrument ${i} layer offset`);
    assert(inst.layerCount > 0, `instrument ${i} has no layers`);
    layers += inst.layerCount;
  }
  assertEquals(layers, LAYER_COUNT);
});

Deno.test("every layer is an 8- or 16-bit slice with a tail loop", () => {
  for (let i = 0; i < LAYER_COUNT; i++) {
    const l = layerAt(i);
    assert(l.format === 8 || l.format === 16, `layer ${i} format ${l.format}`);
    assert(l.lengthSamples > 0, `layer ${i} is empty`);
    if (l.loopMode !== LOOP_OFF) {
      assert(
        l.loopStart >= 0 && l.loopStart < l.lengthSamples,
        `layer ${i} loopStart ${l.loopStart} outside 0..${l.lengthSamples}`,
      );
    }
  }
});

Deno.test("a note-on picks every layer whose range contains it", () => {
  // Instrument 0 is two detune pairs split at note 59 — four layers, of which
  // a note-on strikes the two that share its range. Taking only the first
  // would lose the chorus.
  const low = pickLayers(0, 30);
  assertEquals(low.length, 2);
  assertEquals(low.map((l) => l.fineTune), [-10, 10]);
  assertEquals(low.map((l) => l.noteHi), [58, 58]);
  const high = pickLayers(0, 100);
  assertEquals(high.length, 2);
  assertEquals(high.map((l) => l.noteLo), [59, 59]);
  // Instrument 4's lowest layer starts at note 55; a note below every range
  // still sounds, on the first layer, rather than falling silent.
  assertEquals(pickLayers(4, 0).length, 1);
});

Deno.test("playbackRate follows the driver's pitch formula", () => {
  const layer = layerAt(0);
  // Sounding the root note plays back at 1x, bar the layer's fine tune.
  const atRoot = playbackRate(layer, layer.rootPitch);
  assertEquals(atRoot, Math.pow(2, layer.fineTune / 256 / 12));
  // An octave up is exactly double.
  const octave = playbackRate(layer, layer.rootPitch + 12);
  assert(Math.abs(octave / atRoot - 2) < 1e-12);
  // Transpose adds semitones on top.
  assertEquals(
    playbackRate(layer, layer.rootPitch, 3),
    playbackRate(layer, layer.rootPitch + 3),
  );
});

Deno.test("the base rate makes every loop a whole number of cycles", () => {
  // How SCSP_BASE_RATE was derived, kept as a test so a future edit to it has
  // to answer for itself: a looped instrument sample loops on a period
  // boundary, so at the right rate the cycle count comes out integral.
  const cases = [];
  const seen = new Set();
  for (let i = 0; i < LAYER_COUNT; i++) {
    const l = layerAt(i);
    if (l.loopMode !== LOOP_FORWARD) continue;
    const key = l.offset + ":" + l.loopStart;
    if (seen.has(key)) continue;
    seen.add(key);
    const loopLen = l.lengthSamples - l.loopStart;
    if (loopLen < 20 || loopLen > 2000) continue;
    cases.push({ loopLen, rootPitch: l.rootPitch });
  }
  assertEquals(cases.length, 34);
  const cycles = (rate) =>
    cases
      .map((c) => c.loopLen * 440 * Math.pow(2, (c.rootPitch - 88) / 12) / rate)
      .filter((k) => k >= 0.5);
  const whole = (rate) =>
    cycles(rate).filter((k) =>
      Math.abs(k - Math.round(k)) / Math.round(k) < 0.02
    )
      .length;
  assert(
    whole(SCSP_BASE_RATE) >= 30,
    `${SCSP_BASE_RATE} Hz leaves only ${
      whole(SCSP_BASE_RATE)
    } of 34 loops on a cycle boundary`,
  );
  // The rate this was first, wrongly, assumed to be. It fits nothing.
  assertEquals(whole(44100), 0);
  // And the octave is pinned by the loops that come out at a single cycle.
  assert(
    cycles(SCSP_BASE_RATE).filter((k) => Math.abs(k - 1) < 0.05).length >= 5,
    "no loop is a single cycle, so the octave is not pinned",
  );
});

Deno.test("the 590 layers share 85 distinct sample cuts", () => {
  const slices = uniqueSlices();
  assertEquals(slices.length, 85);
  assertEquals(
    slices.reduce((n, s) => n + s.layerIndexes.length, 0),
    LAYER_COUNT,
  );
});

const gated = { ignore: !hasSoundBank() };

Deno.test("every layer cuts inside SNDPAC.BIN", gated, () => {
  const bank = loadSoundBank();
  for (let i = 0; i < LAYER_COUNT; i++) {
    const cut = cutLayer(bank, layerAt(i));
    assert(cut, `layer ${i} points outside the ${bank.length}-byte bank`);
    assertEquals(cut.sampleRate, SCSP_BASE_RATE);
    assertEquals(cut.loopEnd, cut.pcm.length, `layer ${i} loops to its end`);
  }
});

Deno.test("16-bit samples are decoded big-endian", gated, () => {
  const bank = loadSoundBank();
  // A wrong endianness turns a smooth waveform into noise. Measuring the mean
  // absolute first difference of both readings separates them by 4-8x, which
  // is how the format was established in the first place.
  const meanStep = (pcm) => {
    let sum = 0;
    for (let i = 1; i < pcm.length; i++) sum += Math.abs(pcm[i] - pcm[i - 1]);
    return sum / Math.max(1, pcm.length - 1);
  };
  let checked = 0;
  for (let i = 0; i < LAYER_COUNT && checked < 20; i++) {
    const layer = layerAt(i);
    if (layer.format !== 16) continue;
    const be = cutLayer(bank, layer).pcm;
    const le = new Int16Array(be.length);
    for (let s = 0; s < le.length; s++) {
      const at = layer.offset + s * 2;
      le[s] = (bank[at + 1] << 8) | bank[at];
    }
    // Skip the few genuinely noisy percussion cuts, where neither reading is
    // smooth; on everything else big-endian must win clearly.
    if (meanStep(be) > 15000) continue;
    assert(
      meanStep(be) * 2 < meanStep(le),
      `layer ${i}: BE step ${meanStep(be).toFixed(0)} vs LE ${
        meanStep(le).toFixed(0)
      }`,
    );
    checked++;
  }
  assert(checked >= 10, `only ${checked} layers were smooth enough to compare`);
});

Deno.test("reverse and alternating loops are baked forward", gated, () => {
  const bank = loadSoundBank();
  let reverses = 0;
  let alternates = 0;
  for (let i = 0; i < LAYER_COUNT; i++) {
    const layer = layerAt(i);
    const cut = cutLayer(bank, layer);
    if (layer.loopMode === LOOP_REVERSE) {
      reverses++;
      // Same samples, loop region flipped: length is untouched.
      assertEquals(cut.pcm.length, layer.lengthSamples);
      assertEquals(
        cut.pcm[layer.loopStart],
        readRaw(bank, layer, layer.lengthSamples - 1),
      );
    } else if (layer.loopMode === LOOP_ALTERNATE) {
      alternates++;
      const mirror = layer.lengthSamples - layer.loopStart - 2;
      assertEquals(cut.pcm.length, layer.lengthSamples + Math.max(0, mirror));
      if (mirror > 0) {
        // The mirror starts one in from the end, so no sample plays twice.
        assertEquals(
          cut.pcm[layer.lengthSamples],
          readRaw(bank, layer, layer.lengthSamples - 2),
        );
      }
    }
  }
  assertEquals(reverses, 34);
  assertEquals(alternates, 37);
});

function readRaw(bank, layer, index) {
  if (layer.format === 16) {
    const at = layer.offset + index * 2;
    return (bank[at] << 24 >> 16) | bank[at + 1];
  }
  return ((bank[layer.offset + index] << 24) >> 24) * 256;
}

Deno.test("toFloat32 normalises into [-1, 1)", gated, () => {
  const cut = cutLayer(loadSoundBank(), layerAt(0));
  const floats = toFloat32(cut.pcm);
  assertEquals(floats.length, cut.pcm.length);
  for (const v of floats) assert(v >= -1 && v < 1, `sample ${v} out of range`);
});
