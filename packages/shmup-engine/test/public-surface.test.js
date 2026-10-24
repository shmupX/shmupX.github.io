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

// The Nintendo 64 half: the one-call export the editor's N64 row runs, the
// file name, the two donor-disk helpers, prefixed where the bare name would
// read as general, and the xdelta3 applier for the translation patch.
const EXPECTED_N64 = [
  "applyVcdiff",
  "buildN64ProjectFromLevel",
  "dddFileName",
  "DDD_IMAGE_BYTES",
  "exportLevelToDdd",
  "isDddImage",
  "n64ImageFormat",
  "n64ProjectName",
  "n64ReadProjects",
  "n64TemplateFromDisk",
  "NDD_IMAGE_BYTES",
  "parseVcdiff",
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

Deno.test("mod.js exports the Nintendo 64 surface", () => {
  for (const name of EXPECTED_N64) {
    assert(name in engine, `missing export ${name}`);
  }
  assertStrictEquals(engine.DDD_IMAGE_BYTES, 64458560);
  assertStrictEquals(engine.NDD_IMAGE_BYTES, 64931840);
  assertStrictEquals(engine.n64ProjectName("my game 2"), "MYGAME2");
  assertStrictEquals(engine.n64ImageFormat(new Uint8Array(16)), null);
  assertStrictEquals(engine.dddFileName("Tiny"), "Dezaemon 3D - Tiny.ndd");
  assertStrictEquals(
    engine.dddFileName("Tiny", "ddd"),
    "Dezaemon 3D - Tiny.ddd",
  );
});

// The story: what the editor's cart exports compose in the page and hand
// every writer as `storyBackdrops` (src/story/).
Deno.test("mod.js exports the story surface", () => {
  for (
    const name of ["bitmapFontFromSheet", "storyBackdrops", "storyLogLine"]
  ) {
    assert(name in engine, `missing export ${name}`);
  }
  assertStrictEquals(
    engine.storyLogLine([], []),
    "story: the level tells none — stages open as they are",
  );
});
