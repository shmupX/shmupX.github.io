// The flat mod.js surface the editor binds as window.Dezaemon. Every other
// test imports src/ directly, so a forgotten re-export (or an esbuild
// collision rename) would only show up in the browser — this catches it.
import { assert, assertStrictEquals } from "@std/assert";
import * as engine from "../mod.js";

const EXPECTED = [
  // sec7
  "decodeModels",
  "FAMILY_FILE_RANGES",
  "FAMILY_MESH_COUNTS",
  "SHAPE_FAMILIES",
  // colour
  "rgb555ToHex",
  "rgb555ToRgb",
  // library
  "buildMeshLibrary",
  "decodeMdldt",
  "decompressCmp",
  "libraryIndex",
  "mdldtFileFor",
  "meshFor",
  "meshLibraryFromJson",
  "placeholderLibrary",
  "serializeMeshLibrary",
  // model -> triangles
  "allocFrame",
  "buildModelMesh",
  "buildSwatchTable",
  "composeTransform",
  "LIGHT_VIEW",
  "modelStats",
  "orbitCamera",
  "packMesh2D",
  "projectModel",
  "ROT_ORDERS",
  "saturnLightView",
  "SHADE_FLOOR",
  "SHADE_LEVELS",
  "shadeRgb555",
  "shadeRow",
  "SWATCH_LAYOUT",
  "swatchCell",
  "swatchRgb",
  "swatchUV",
  "tintRgb555",
  "wireframeSegments",
];

// The Super Famicom half. Namespaced where the Saturn surface already owns the
// bare name (SFC_SRAM_SIZE, SFC_CHECK_STRING), which is the whole reason only a
// chosen few of src/sfc/ are flattened — see the block at the end of mod.js.
const EXPECTED_SFC = [
  "composeSfcCover",
  "isSfcSav",
  "parseSfcSav",
  "pickSfcCoverWindow",
  "SFC_ACCEPTED_SIZES",
  "SFC_CHECK_STRING",
  "SFC_COVER_H",
  "SFC_COVER_W",
  "SFC_SRAM_SIZE",
  "summarizeSfcSav",
];

Deno.test("mod.js exports the model surface", () => {
  for (const name of EXPECTED) {
    assert(name in engine, `missing export ${name}`);
  }
  assertStrictEquals(typeof engine.buildModelMesh, "function");
  assertStrictEquals(engine.FAMILY_MESH_COUNTS.length, 6);
  assertStrictEquals(engine.rgb555ToHex(0x7fff), 0xffffff);
  assertStrictEquals(engine.shadeRow(0), 16);
});

Deno.test("mod.js exports the Super Famicom surface", () => {
  for (const name of EXPECTED_SFC) {
    assert(name in engine, `missing export ${name}`);
  }
  assertStrictEquals(engine.SFC_SRAM_SIZE, 0x20000);
  assertStrictEquals(engine.SFC_CHECK_STRING, "T.TABATA");
  assertStrictEquals(engine.SFC_COVER_W, 256);
  assertStrictEquals(engine.SFC_COVER_H, 480);
  // The Saturn cover's own constants are untouched by the SFC ones beside them.
  assertStrictEquals(engine.COVER_W, 256);
  assertStrictEquals(engine.COVER_H, 480);
  assertStrictEquals(engine.isSfcSav(new Uint8Array(16)), false);
});
