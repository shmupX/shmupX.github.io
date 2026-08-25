// Boss record (the enemy block's 0x40 trailer) — engine-traced decode.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeBossTrailer,
  readBossTrailer,
} from "../src/decode/decode-boss.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

Deno.test("an untouched (all-zero) trailer decodes to null", () => {
  assertStrictEquals(decodeBossTrailer(new Uint8Array(0x40)), null);
});

Deno.test({
  name: "ramsie stage 0's boss record decodes to the engine-verified values",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    const b = readBossTrailer(decoded.sections[5].decompressed, 0);
    assertStrictEquals(b.sizeClass, 2);
    assertStrictEquals(b.hpStages, 4);
    assertStrictEquals(b.hp, 4608000);
    assertStrictEquals(b.score, 20000);
    assertStrictEquals(b.rotate, false);
    // HP band 1 cycles patterns 0,0,1,1; the last band pins pattern 3
    assertEquals(b.playlist[0], [0, 0, 1, 1]);
    assertEquals(b.playlist[3], [3, 3, 3, 3]);
    // pattern 0: two one-shot turret parts flanking the boss low, plus the
    // full-width special attack above it
    const p0 = b.patterns[0];
    assertStrictEquals(p0.moveScript, 0);
    assertStrictEquals(p0.moveSpeed, 2);
    assertStrictEquals(p0.fireTickFrames, 60);
    assertEquals(
      p0.firePoints.map((f) => [f.dx, f.dy, f.type]),
      [[-32, 28, 4], [30, 28, 4], [0, -25, 5]],
    );
    // record = the art band's first record + piece (group 3 = records 32-47)
    assertEquals(p0.firePoints[0].spawn, {
      group: "zako32x32",
      piece: 14,
      record: 46,
      oneShot: true,
    });
    assertEquals(p0.firePoints[1].spawn, {
      group: "zako32x32",
      piece: 13,
      record: 45,
      oneShot: true,
    });
  },
});

Deno.test({
  name: "every placed boss carries a decoded behavior record",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const decoded = await decodedFixture("ramsie.sav");
    assertStrictEquals(decoded.bosses.length, 5);
    for (const b of decoded.bosses) {
      assert(b.behavior, `stage ${b.stage} has a boss record`);
      // the trailer's own class matches the placement id's
      assertStrictEquals(b.behavior.sizeClass, b.sizeClass);
      assertStrictEquals(b.behavior.patterns.length, 4);
    }
  },
});
