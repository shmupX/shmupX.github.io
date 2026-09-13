// sec7 encoder: models back into the ポリ吉 section, and round trips.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeModels,
  MAX_PARTS,
  MODEL_SLOTS,
  SEC7_MAGIC,
} from "../src/decode/decode-model.js";
import {
  encodeModels,
  encodeRotation,
  encodeShapeWord,
  NEUTRAL_COLOR,
  SEC7_SIZE,
} from "../src/write/encode-model.js";
import { SECTION_SIZES } from "../src/decompress.js";
import { hasDevFixtures, loadDevFixture } from "./_fixtures.js";

function part(over = {}) {
  return {
    shape: 0x5005,
    shapeFamily: 5,
    shapeVariant: 5,
    colorSet: 0,
    meshIndex: 5,
    position: { x: 12, y: -20, z: 4 },
    rotation: { x: 0, y: 18, z: 342 },
    scale: { x: 1, y: -1, z: 0.36 },
    mirrored: true,
    ...over,
  };
}

Deno.test("an encoded section is exactly the raw sec7 size", () => {
  assertStrictEquals(SEC7_SIZE, SECTION_SIZES[7]);
  assertStrictEquals(SEC7_SIZE, 5828);
  assertStrictEquals(encodeModels(null).length, SEC7_SIZE);
});

Deno.test("no models writes the all-zero section, not an empty magic", () => {
  // The Saturn leaves sec7 zeroed when the 3D editor was never opened, and
  // decodeModels reads a missing magic as exactly that.
  for (const empty of [null, undefined, [], { models: [] }]) {
    const bytes = encodeModels(empty);
    assertStrictEquals(bytes.length, SEC7_SIZE);
    assert(
      bytes.every((b) => b === 0),
      `${JSON.stringify(empty)} wrote a non-zero byte`,
    );
    assertStrictEquals(decodeModels(bytes), null);
  }
});

Deno.test("every field of a part survives decode(encode(x))", () => {
  const models = [{
    slot: 3,
    color: 0x4210,
    parts: [
      part(),
      part({ shape: 0x0000, shapeFamily: 0, meshIndex: 0, colorSet: 0 }),
    ],
  }];
  const bytes = encodeModels(models);
  assertStrictEquals(
    (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0,
    SEC7_MAGIC,
  );
  const back = decodeModels(bytes);
  assertStrictEquals(back.models.length, 1);
  const m = back.models[0];
  assertStrictEquals(m.slot, 3);
  assertStrictEquals(m.color, 0x4210);
  assertStrictEquals(m.parts.length, 2);
  const p = m.parts[0];
  assertStrictEquals(p.shape, 0x5005);
  assertStrictEquals(p.shapeFamily, 5);
  assertStrictEquals(p.colorSet, 0);
  assertStrictEquals(p.meshIndex, 5);
  assertEquals(p.position, { x: 12, y: -20, z: 4 });
  assertStrictEquals(p.scale.x, 1);
  assertStrictEquals(p.scale.y, -1);
  assertStrictEquals(p.mirrored, true);
  // 0.36 is not on the 16.16 grid (0.36 * 65536 = 23592.96), so it comes back
  // rounded to the nearest representable scale. A value DECODED from a save is
  // always on the grid already, which is why the corpus round trip below is
  // exact — this is the quantum an author hits, not drift in the encoder.
  assert(Math.abs(p.scale.z - 0.36) <= 1 / 65536);
  // rotations come back through the u16 circle, so allow its one-unit quantum
  assert(Math.abs(p.rotation.y - 18) < 360 / 65536);
  assert(Math.abs(p.rotation.z - 342) < 360 / 65536);
});

Deno.test("the model colour word is written unmasked", () => {
  // 119 of the corpus's 564 models set bit 15. Masking it to RGB555 here
  // would silently rewrite a fifth of the library; the RENDERER masks, the
  // file does not.
  const bytes = encodeModels([{ slot: 0, color: 0xf39c, parts: [part()] }]);
  assertStrictEquals(decodeModels(bytes).models[0].color, 0xf39c);
  // and a model with no colour at all gets the neutral tint
  const neutral = encodeModels([{ slot: 0, parts: [part()] }]);
  assertStrictEquals(decodeModels(neutral).models[0].color, NEUTRAL_COLOR);
  assertStrictEquals(NEUTRAL_COLOR, 0x7fff);
});

Deno.test("the shape word comes from `shape`, or from the decoded halves", () => {
  assertStrictEquals(encodeShapeWord({ shape: 0x5200 }), 0x5200);
  // no `shape`: family bits 12-15, colour set 8-11, mesh index 0-7
  assertStrictEquals(
    encodeShapeWord({ shapeFamily: 3, colorSet: 2, meshIndex: 31 }),
    0x321f,
  );
  assertStrictEquals(
    encodeShapeWord({ shapeFamily: 0, colorSet: 0, meshIndex: 0 }),
    0,
  );
  // `shape` wins, because it is the only field that keeps bits the engine's
  // own masks would drop
  assertStrictEquals(
    encodeShapeWord({ shape: 0x5005, shapeFamily: 1, meshIndex: 2 }),
    0x5005,
  );
});

Deno.test("rotations wrap rather than clamp", () => {
  assertStrictEquals(encodeRotation(0), 0);
  assertStrictEquals(encodeRotation(360), 0);
  assertStrictEquals(encodeRotation(180), 32768);
  // -90 and 270 are the same rotation
  assertStrictEquals(encodeRotation(-90), encodeRotation(270));
  assertStrictEquals(encodeRotation(-90), 49152);
  assertStrictEquals(encodeRotation(720 + 18), encodeRotation(18));
  assertStrictEquals(encodeRotation(NaN), 0);
});

Deno.test("a slot the format cannot hold is skipped, with a warning", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const bytes = encodeModels([
    { slot: 99, parts: [part()] }, //             outside 0-15
    { slot: 1, parts: [] }, //                    no parts
    { slot: 2, parts: [part()] }, //              fine
    { slot: 2, parts: [part(), part()] }, //      slot already taken
  ], { warn });
  const back = decodeModels(bytes);
  assertStrictEquals(back.models.length, 1);
  assertStrictEquals(back.models[0].slot, 2);
  assertStrictEquals(warnings.length, 3);
  assert(warnings[0].includes("99"));
  assert(warnings[1].includes("no parts"));
  assert(warnings[2].includes("already holds"));
});

Deno.test("a tenth part is dropped, because the slot holds nine", () => {
  const warnings = [];
  const parts = [];
  for (let i = 0; i < 12; i++) parts.push(part({ shape: 0x5000 + i }));
  const back = decodeModels(
    encodeModels([{ slot: 0, parts }], { warn: (m) => warnings.push(m) }),
  );
  assertStrictEquals(back.models[0].parts.length, MAX_PARTS);
  assertStrictEquals(back.models[0].parts[8].shape, 0x5008);
  assertStrictEquals(warnings.length, 1);
  assert(warnings[0].includes("12 parts"));
});

Deno.test("models without slots take the free ones in order", () => {
  const back = decodeModels(encodeModels([
    { parts: [part()] },
    { parts: [part()] },
    { slot: 0, parts: [part()] }, // 0 is taken by the first
  ]));
  assertEquals(back.models.map((m) => m.slot), [0, 1]);
});

Deno.test("every slot can be filled", () => {
  const models = [];
  for (let s = 0; s < MODEL_SLOTS; s++) {
    models.push({
      slot: s,
      color: 0x7fff,
      parts: [part({ shape: 0x5000 + s })],
    });
  }
  const back = decodeModels(encodeModels(models));
  assertStrictEquals(back.models.length, MODEL_SLOTS);
  assertEquals(
    back.models.map((m) => m.parts[0].shape),
    models.map((m) => m.parts[0].shape),
  );
});

Deno.test("the pad words and the trailing residual are written as zero", () => {
  const bytes = encodeModels([{ slot: 0, color: 0x7fff, parts: [part()] }]);
  const base = 4;
  // part 0's two pads, +0x02 and +0x16 — zero in all 3,165 corpus parts
  assertStrictEquals(bytes[base + 4 + 0x02], 0);
  assertStrictEquals(bytes[base + 4 + 0x03], 0);
  assertStrictEquals(bytes[base + 4 + 0x16], 0);
  assertStrictEquals(bytes[base + 4 + 0x17], 0);
  // the 576 bytes after the slot table
  for (let i = 4 + MODEL_SLOTS * 328; i < SEC7_SIZE; i++) {
    assertStrictEquals(bytes[i], 0, `residual byte ${i}`);
  }
});

// --- The corpus -------------------------------------------------------------

const DAIOH = "Dezaemon 2 (DAIOH).sav";

Deno.test({
  name: "DAIOH's six models survive decode -> encode -> decode unchanged",
  ignore: !hasDevFixtures(DAIOH),
  async fn() {
    const { data } = await normalize(loadDevFixture(DAIOH));
    const save = bup.parse(data).find((s) => s.payload);
    const decoded = decodeSave(save.payload.buffer);
    assertStrictEquals(decoded.models.models.length, 6);
    const again = decodeModels(encodeModels(decoded.models));
    assertEquals(again, decoded.models);
    // and the section it produces is the right size to hand the writer
    assertStrictEquals(encodeModels(decoded.models).length, SECTION_SIZES[7]);
  },
});
