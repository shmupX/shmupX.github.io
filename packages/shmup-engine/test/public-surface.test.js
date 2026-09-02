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
  "modelStats",
  "orbitCamera",
  "packMesh2D",
  "projectModel",
  "ROT_ORDERS",
  "SWATCH_LAYOUT",
  "swatchCell",
  "swatchRgb",
  "swatchUV",
  "tintRgb555",
  "wireframeSegments",
];

Deno.test("mod.js exports the model surface", () => {
  for (const name of EXPECTED) {
    assert(name in engine, `missing export ${name}`);
  }
  assertStrictEquals(typeof engine.buildModelMesh, "function");
  assertStrictEquals(engine.FAMILY_MESH_COUNTS.length, 6);
  assertStrictEquals(engine.rgb555ToHex(0x7fff), 0xffffff);
});
