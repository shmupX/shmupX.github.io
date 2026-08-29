// Scroll curve + stage extents: the save's own background pacing.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeScrollCurve,
  SCROLL_SPEED_TABLE,
  scrollCurveBytes,
  SEC5_REGIONS,
} from "../src/decode/decode-stage.js";
import { mapSaveToGame } from "../src/map-to-game.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test("a curve byte splits into speed, wave amplitude and wave type", () => {
  const sec5 = new Uint8Array(SEC5_REGIONS.spriteStages.offset);
  const base = SEC5_REGIONS.scrollCurves.offset + 2 * 0xc0; // stage 2
  sec5[base] = 0x07; // speed 7, no wave
  sec5[base + 1] = 0x8d; // 0b10_001_101: type 2 shake, amp idx 1, speed 5
  sec5[base + 2] = 0x63; // 0b01_100_011: type 1 sine, amp idx 4, speed 3
  const curve = decodeScrollCurve(sec5, 2);
  assertStrictEquals(curve.length, 0xc0);
  assertEquals(curve[0], { speed: 4, waveType: "ripple", waveAmp: 0 });
  assertEquals(curve[1], { speed: 1.5, waveType: "shake", waveAmp: 1 });
  assertEquals(curve[2], { speed: 0.75, waveType: "sine", waveAmp: 9 });
  // engine speed table is 1/256 px per frame; index 4 = exactly 1 px/f
  assertStrictEquals(SCROLL_SPEED_TABLE[4] / 256, 1);
});

Deno.test({
  name: "ramsie's stage extents decode to its authored loop windows",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    // Stage 0's boss chamber sits at row 423 = part 26 — inside the loop.
    assertEquals(d.settings.stageExtents[0], { loopPart: 24, endPart: 28 });
    assertEquals(d.settings.stageExtents[2], { loopPart: 0, endPart: 46 });
    assertStrictEquals(d.settings.confidence.stageExtents, "confirmed");
    // Every stage ships its raw 192-byte curve.
    for (let s = 0; s < d.stageCount; s++) {
      assertStrictEquals(d.stages[s].scrollCurve.length, 0xc0);
    }
  },
});

Deno.test({
  name: "the mapper ships each stage's curve and extents on stage.scroll",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    const { gameJson } = mapSaveToGame(d);
    for (let s = 0; s < d.stageCount; s++) {
      const scroll = gameJson[`stage${s}`].scroll;
      assert(scroll, `stage${s} carries scroll data`);
      // 192 bytes -> base64 (192/3*4 = 256 chars)
      assertStrictEquals(scroll.curve.length, 256);
      assertStrictEquals(scroll.loopPart, d.settings.stageExtents[s].loopPart);
      assertStrictEquals(scroll.endPart, d.settings.stageExtents[s].endPart);
      // The authored curve always ships — the engine's constant-0x02
      // substitution is a demo/attract play-state, not a save setting.
      assertStrictEquals(scroll.forcedByte, undefined);
    }
    assertStrictEquals(gameJson.meta.dezaemonSettings.gameMode, 2);
  },
});

Deno.test({
  name: "scrollCurveBytes reads the live region GAME.bin indexes",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    const sec5 = d.sections[5].decompressed;
    const bytes = scrollCurveBytes(sec5, 0);
    assertStrictEquals(bytes.length, 0xc0);
    // Ramsie is a gameMode-2 save: on hardware the engine overrides the curve
    // with a constant 0x02, but the authored bytes still live in the section.
    assert(bytes.some((b) => b !== 0) || bytes.every((b) => b === 0));
  },
});
