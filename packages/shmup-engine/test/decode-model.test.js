// sec7 3D-model decoder: the ポリ吉 part compositions.
import { assert, assertStrictEquals } from "@std/assert";
import { normalize } from "../src/bup-source.js";
import * as bup from "../src/bup-parse.js";
import { decodeSave } from "../src/decode/index.js";
import {
  decodeModels,
  MODEL_SLOTS,
  SEC7_MAGIC,
} from "../src/decode/decode-model.js";
import { hasFixtures, loadFixture } from "./_fixtures.js";

async function decodedFixture(name) {
  const { data } = await normalize(loadFixture(name));
  const save = bup.parse(data).find((s) => s.payload);
  return decodeSave(save.payload.buffer);
}

function emptySec7() {
  // magic + 16 slots x 328 + 576 residual = 5828 (the section's raw size)
  const sec7 = new Uint8Array(4 + MODEL_SLOTS * 328 + 576);
  new DataView(sec7.buffer).setUint32(0, SEC7_MAGIC);
  return sec7;
}

Deno.test("decodeModels reads a part record's every field", () => {
  const sec7 = emptySec7();
  const v = new DataView(sec7.buffer);
  const slotBase = 4 + 3 * 328; // slot 3
  v.setUint16(slotBase, 2); // two parts
  v.setUint16(slotBase + 2, 0x6f18); // model color
  const part = slotBase + 4;
  v.setUint16(part, 0x1222); // shape
  v.setInt32(part + 0x04, -36 * 65536); // x
  v.setInt32(part + 0x08, 20 * 65536); // y
  v.setInt32(part + 0x0c, Math.round(0.5 * 65536)); // z
  v.setUint16(part + 0x10, 0x1999); // rotX ~36deg
  v.setUint16(part + 0x12, 0x8000); // rotY 180deg
  v.setUint16(part + 0x18 - 2, 0); // pad
  v.setInt32(part + 0x18, 2 * 65536); // scaleX
  v.setInt32(part + 0x1c, -1 * 65536); // scaleY mirrored
  v.setInt32(part + 0x20, 1 * 65536); // scaleZ

  const decoded = decodeModels(sec7);
  assertStrictEquals(decoded.models.length, 1);
  const model = decoded.models[0];
  assertStrictEquals(model.slot, 3);
  assertStrictEquals(model.color, 0x6f18);
  assertStrictEquals(model.parts.length, 2);
  const p = model.parts[0];
  assertStrictEquals(p.shape, 0x1222);
  assertStrictEquals(p.shapeFamily, 1);
  assertStrictEquals(p.shapeVariant, 0x222);
  assertStrictEquals(p.position.x, -36);
  assertStrictEquals(p.position.y, 20);
  assertStrictEquals(p.position.z, 0.5);
  assert(Math.abs(p.rotation.x - 36) < 0.01);
  assertStrictEquals(p.rotation.y, 180);
  assertStrictEquals(p.rotation.z, 0);
  assertStrictEquals(p.scale.x, 2);
  assertStrictEquals(p.scale.y, -1); // negative = mirror
  assertStrictEquals(p.scale.z, 1);
});

Deno.test("decodeModels rejects an uninitialized section", () => {
  const sec7 = emptySec7();
  new DataView(sec7.buffer).setUint32(0, 0); // never opened the 3D editor
  assertStrictEquals(decodeModels(sec7), null);
});

Deno.test({
  name: "mucha-kucha's sec7 decodes to its one authored model",
  ignore: !hasFixtures("mucha-kucha.sav"),
  async fn() {
    const d = await decodedFixture("mucha-kucha.sav");
    assertStrictEquals(d.confidence.models, "confirmed");
    assertStrictEquals(d.models.models.length, 1);
    const model = d.models.models[0];
    assertStrictEquals(model.slot, 0);
    assertStrictEquals(model.parts.length, 1);
    assertStrictEquals(model.parts[0].shape, 0x5005);
    assertStrictEquals(model.parts[0].position.y, -20);
  },
});

Deno.test({
  name: "ramsie never opened the 3D editor — no models, no error",
  ignore: !hasFixtures("ramsie.sav"),
  async fn() {
    const d = await decodedFixture("ramsie.sav");
    assertStrictEquals(d.models, null);
    assertStrictEquals(d.modelError, undefined);
  },
});
