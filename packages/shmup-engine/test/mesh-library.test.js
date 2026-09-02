// The ポリ吉 part-library index and the placeholder primitives.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  FAMILY_MESH_COUNTS,
  SHAPE_FAMILIES,
} from "../src/decode/decode-model.js";
import {
  boxMesh,
  COLOR_SETS,
  cylinderMesh,
  FAMILY_OFFSETS,
  familyForFile,
  familyOfLibraryIndex,
  hexPrismMesh,
  LIBRARY_MESH_COUNT,
  libraryIndex,
  mdldtFileFor,
  mdldtFileName,
  meshBounds,
  meshFor,
  meshLibraryFromJson,
  placeholderLibrary,
  placeholderMesh,
  polygonNormals,
  serializeMeshLibrary,
  sphereMesh,
  wedgeMesh,
} from "../src/model/mesh-library.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

Deno.test("the family slices tile the 224-mesh library exactly", () => {
  assertStrictEquals(FAMILY_MESH_COUNTS.reduce((a, b) => a + b, 0), 224);
  assertStrictEquals(LIBRARY_MESH_COUNT, 224);
  assertEquals(FAMILY_OFFSETS, [0, 32, 104, 140, 176, 212]);
  assertStrictEquals(libraryIndex(0, 0), 0);
  assertStrictEquals(libraryIndex(5, 11), 223);
  assertStrictEquals(libraryIndex(5, 12), -1);
  assertStrictEquals(libraryIndex(6, 0), -1);
  assertStrictEquals(libraryIndex(1, 71), 103);
  for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
    const { family, meshIndex } = familyOfLibraryIndex(i);
    assertStrictEquals(libraryIndex(family, meshIndex), i);
  }
});

Deno.test("mdldtFileFor maps a mesh to its MDLDT file, four meshes per file", () => {
  assertEquals(mdldtFileFor(5, 0), { file: 54, meshInFile: 0 });
  assertEquals(mdldtFileFor(5, 5), { file: 55, meshInFile: 1 });
  assertEquals(mdldtFileFor(4, 34), { file: 53, meshInFile: 2 });
  assertEquals(mdldtFileFor(0, 31), { file: 8, meshInFile: 3 });
  assertEquals(mdldtFileFor(1, 0), { file: 9, meshInFile: 0 });
  assertStrictEquals(mdldtFileFor(5, 12), null);
  assertEquals(familyForFile(54), { family: 5, firstMeshIndex: 0 });
  assertEquals(familyForFile(26), { family: 1, firstMeshIndex: 68 });
  assertStrictEquals(familyForFile(57), null);
  assertStrictEquals(mdldtFileName(7), "MDLDT_07.CMP");
  // every file lands in exactly one family and the files cover 1..56
  let files = 0;
  for (let f = 1; f <= 56; f++) if (familyForFile(f)) files++;
  assertStrictEquals(files, 56);
});

Deno.test("placeholder primitives match the disc catalogue's vertex and polygon counts", () => {
  const counts = (m) => [m.vertices.length / 3, m.polygons.length / 4];
  assertEquals(counts(boxMesh(20.5, 20.5, 20.5)), [8, 6]);
  assertEquals(counts(sphereMesh(27.5, 9, 10)), [92, 100]);
  assertEquals(counts(wedgeMesh(27.5, 27.5, -15.88, 31.76)), [6, 5]);
  assertEquals(counts(hexPrismMesh(27.5, 27.5)), [12, 10]);
  assertStrictEquals(counts(cylinderMesh(27.5, 27.5, 16))[0], 32);
  // family 5 index 0 is the +-20.5 cube; index 5 (mucha-kucha's 0x5005) is the
  // triangular PYRAMID, not a prism — page 5 is five solids at full height and
  // then the same five closed to an apex or tapered, which
  // tests/mesh_library_test.ts pins against the shipped library.
  const cube = placeholderMesh(5, 0);
  assertEquals(meshBounds(cube).max.map((v) => +v.toFixed(2)), [
    20.5,
    20.5,
    20.5,
  ]);
  const pyramid = placeholderMesh(5, 5);
  assertEquals(counts(pyramid), [4, 4]);
  assert(near(meshBounds(pyramid).max[1], 20));
  assert(near(meshBounds(pyramid).min[1], -20));
  // and index 7 is a square frustum, which keeps both rings
  assertEquals(counts(placeholderMesh(5, 7)), [8, 6]);
  // family 4 plates are 43 x 70 x 10
  const plate = placeholderMesh(4, 3);
  const b = meshBounds(plate);
  assert(
    near(b.max[0] - b.min[0], 42.68) && near(b.max[1] - b.min[1], 70) &&
      near(b.max[2] - b.min[2], 10),
  );
});

Deno.test("every placeholder polygon faces outward with a unit SGL normal", () => {
  const lib = placeholderLibrary();
  assertStrictEquals(lib.meshes.length, LIBRARY_MESH_COUNT);
  assertStrictEquals(lib.source, "placeholder");
  for (const mesh of lib.meshes) {
    assertStrictEquals(mesh.colorSets.length, COLOR_SETS);
    const polys = mesh.polygons.length / 4;
    for (let q = 0; q < polys; q++) {
      const n = [
        mesh.normals[q * 3],
        mesh.normals[q * 3 + 1],
        mesh.normals[q * 3 + 2],
      ];
      assert(near(Math.hypot(...n), 1));
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 4; k++) {
        const v = mesh.polygons[q * 4 + k];
        assert(v < mesh.vertices.length / 3);
        cx += mesh.vertices[v * 3];
        cy += mesh.vertices[v * 3 + 1];
        cz += mesh.vertices[v * 3 + 2];
      }
      assert(
        n[0] * cx + n[1] * cy + n[2] * cz > 0,
        `inward polygon ${q} in ${mesh.family}/${mesh.meshIndex}`,
      );
    }
  }
});

Deno.test("polygonNormals follows the Saturn's left-handed rule", () => {
  // The disc's cube: top face v = 0,1,2,3 over +Y with these vertices stores
  // normal (0, 1, 0), which is cross(v2 - v0, v1 - v0), not the right-hand rule.
  const v = [
    20.5,
    20.5,
    20.5,
    -20.5,
    20.5,
    20.5,
    -20.5,
    20.5,
    -20.5,
    20.5,
    20.5,
    -20.5,
  ];
  const n = polygonNormals(
    Float32Array.from(v),
    Uint16Array.from([0, 1, 2, 3]),
  );
  assertEquals(Array.from(n).map((x) => +x.toFixed(3)), [0, 1, 0]);
});

Deno.test("meshFor resolves a part through a library and falls back to a placeholder", () => {
  const lib = placeholderLibrary();
  const part = { shapeFamily: 5, meshIndex: 1, colorSet: 0 };
  assertStrictEquals(meshFor(lib, part), lib.meshes[213]);
  const outside = meshFor(lib, { shapeFamily: 5, meshIndex: 99, colorSet: 0 });
  assertStrictEquals(outside.source, "placeholder");
  assertStrictEquals(meshFor(null, part).source, "placeholder");
  assertStrictEquals(SHAPE_FAMILIES, 6);
});

Deno.test("a library survives the JSON round trip", () => {
  const lib = placeholderLibrary();
  const json = JSON.parse(JSON.stringify(serializeMeshLibrary(lib)));
  const back = meshLibraryFromJson(json);
  assertStrictEquals(back.meshes.length, LIBRARY_MESH_COUNT);
  for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
    const a = lib.meshes[i], b = back.meshes[i];
    assertStrictEquals(b.family, a.family);
    assertStrictEquals(b.meshIndex, a.meshIndex);
    assertEquals(Array.from(b.polygons), Array.from(a.polygons));
    for (let k = 0; k < a.vertices.length; k++) {
      assert(near(a.vertices[k], b.vertices[k], 1 / 256));
    }
    for (let s = 0; s < COLOR_SETS; s++) {
      assertEquals(Array.from(b.colorSets[s]), Array.from(a.colorSets[s]));
    }
    for (let k = 0; k < a.normals.length; k++) {
      assert(near(a.normals[k], b.normals[k], 0.02));
    }
  }
});
