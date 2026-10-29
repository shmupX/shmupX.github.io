// What 音まろ actually writes, counted straight off the bytes.
//
// The music maker may only author values the console's editor can reach, and
// it must carry everything else through untouched. This census is where those
// two lists come from. It walks the raw slots itself — no decoder, no writer —
// so it is an independent oracle for the song model's tests.
//
// The presets and SMP_BGM are fixed disc content, so their counts are pinned
// exactly. The cart collection grows, so for carts only the invariants that
// hold across every save are asserted and the rest is logged.
//
// Definitions (the census and song-view.js share them):
//   onset      voice bit 7 clear and pitch 1..59
//   tie        voice bit 7 set
//   bend       a tie whose pitch byte is not the held note's onset pitch
//   orphan tie a tie with no note sounding (after a rest or at the top)
//   rest voice a step that is neither, with a non-zero voice byte
//   ff measure a measure whose four control bytes are all 0xFF

import { assert, assertEquals } from "@std/assert";
import { emptySong } from "../src/write/game-to-save.js";
import {
  cartSaves,
  hasCartCorpus,
  hasPresetCorpus,
  hasSmpBgm,
  presetSongs,
  requireCorpus,
  skipCorpus,
  slotsOf,
  smpBgmSlots,
} from "./_song-corpus.js";

const SONG_HEADER = 4;
const MEASURE_SIZE = 132;
const PART_BLOCK = 32;

function census(songs) {
  const c = {
    songs: songs.length,
    silent: 0,
    ties: 0,
    bends: 0,
    orphanTies: 0,
    restVoice: 0,
    restVoiceIsLastInstrument: 0,
    pitchAbove59: 0,
    ffMeasures: 0,
    controlOutOfRange: 0,
    ctrl2Bit0: 0,
    onsetInstMax: 0,
    loopAbove31: 0,
    loopReversed: 0,
    echoMax: 0,
    tempoMax: 0,
  };
  for (const b of songs) {
    let sounding = false;
    c.loopAbove31 += b[0] > 31 || b[1] > 31 ? 1 : 0;
    c.loopReversed += b[1] < b[0] ? 1 : 0;
    c.echoMax = Math.max(c.echoMax, b[2]);
    c.tempoMax = Math.max(c.tempoMax, b[3]);
    for (let m = 0; m < 32; m++) {
      const at = SONG_HEADER + m * MEASURE_SIZE;
      const [c0, c1, c2, c3] = b.subarray(at, at + 4);
      if (c0 === 0xff && c1 === 0xff && c2 === 0xff && c3 === 0xff) {
        c.ffMeasures++;
        continue;
      }
      if (c0 > 8 || c1 > 3 || ((c2 & 0x7f) >> 1) > 4 || c3 > 11) {
        c.controlOutOfRange++;
      }
      if (c2 & 1) c.ctrl2Bit0++;
    }
    for (let p = 0; p < 4; p++) {
      let held = 0;
      let lastInst = -1;
      for (let m = 0; m < 32; m++) {
        const base = SONG_HEADER + m * MEASURE_SIZE + 4 + p * PART_BLOCK;
        for (let st = 0; st < 16; st++) {
          const v = b[base + st];
          const q = b[base + 16 + st];
          if (v & 0x80) {
            c.ties++;
            if (!held) c.orphanTies++;
            else if (q !== held) c.bends++;
          } else if (q >= 1 && q <= 59) {
            sounding = true;
            held = q;
            lastInst = v;
            c.onsetInstMax = Math.max(c.onsetInstMax, v);
          } else {
            held = 0;
            if (q > 59) c.pitchAbove59++;
            if (v !== 0) {
              c.restVoice++;
              if (v === lastInst) c.restVoiceIsLastInstrument++;
            }
          }
        }
      }
    }
    if (!sounding) c.silent++;
  }
  return c;
}

Deno.test({
  name: "census: the 73 preset songs, pinned",
  ignore: skipCorpus(hasPresetCorpus()),
  fn() {
    requireCorpus(hasPresetCorpus(), "M_DATA01-73.BIN");
    const c = census(presetSongs().map((p) => p.bytes));
    console.log("presets", JSON.stringify(c));
    assertEquals(c, {
      songs: 73,
      silent: 0,
      ties: 26924,
      bends: 305,
      orphanTies: 20,
      restVoice: 1531,
      restVoiceIsLastInstrument: 1362,
      pitchAbove59: 14,
      ffMeasures: 2,
      controlOutOfRange: 0,
      ctrl2Bit0: 0,
      onsetInstMax: 59,
      loopAbove31: 0,
      loopReversed: 0,
      echoMax: 7,
      tempoMax: 25,
    });
  },
});

Deno.test({
  name: "census: SMP_BGM, the New Game bank — twelve of its slots are emptySong() exactly",
  ignore: skipCorpus(hasSmpBgm()),
  fn() {
    requireCorpus(hasSmpBgm(), "SMP_BGM.BIN");
    const slots = smpBgmSlots();
    const empty = emptySong();
    const pristine = slots
      .map((s, i) => (s.every((v, k) => v === empty[k]) ? i : -1))
      .filter((i) => i >= 0);
    assertEquals(pristine, [5, 6, 7, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    const c = census(slots);
    console.log("smp_bgm", JSON.stringify(c));
    assertEquals(c.silent, 12);
    assertEquals(c.controlOutOfRange, 0);
    assertEquals(c.onsetInstMax <= 59, true);
  },
});

Deno.test({
  name: "census: every cart — onsets use instruments 0-59, headers and tables stay in range",
  ignore: skipCorpus(hasCartCorpus()),
  fn() {
    requireCorpus(hasCartCorpus(), "dev-fixtures/Saturn/*.sav");
    const carts = cartSaves();
    const c = census(carts.flatMap((cart) => slotsOf(cart.sec6)));
    console.log(`carts (${carts.length} saves)`, JSON.stringify(c));
    // The invariants the song model's NATIVE ranges are taken from.
    assertEquals(c.onsetInstMax, 59, "composed parts use instruments 0-59");
    assertEquals(c.loopAbove31, 0, "loop bytes are measures 0-31");
    assertEquals(c.loopReversed, 0, "loop end is never before loop start");
    assert(c.echoMax <= 7, `echo ${c.echoMax}`);
    assert(c.tempoMax <= 31, `tempo ${c.tempoMax}`);
    for (const cart of carts) {
      assert(
        cart.bgmTable.every((v) => v >= 0 && v <= 23),
        `${cart.file}: BGM table ${cart.bgmTable}`,
      );
      assert(
        cart.sfxSet >= 1 && cart.sfxSet <= 3,
        `${cart.file}: sfx set ${cart.sfxSet}`,
      );
    }
    // controlOutOfRange, ctrl2Bit0, bends, orphan ties and rest voices are
    // what the model must carry untouched: logged above, never authored.
  },
});
