// The shipped ポリ吉 part library, static/editor/dezaemon/mesh-library.json.
//
// This file is committed (built from a disc image by `deno task deza:meshlib`)
// and served to the model viewer, so the test needs no disc: it checks the
// artifact itself is the whole library and still decodes.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { dirname, fromFileUrl, resolve } from "@std/path";
import {
  LIBRARY_MESH_COUNT,
  libraryIndex,
  meshBounds,
  meshLibraryFromJson,
  placeholderMesh,
} from "../packages/shmup-engine/src/model/mesh-library.js";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const PATH = resolve(ROOT, "static/editor/dezaemon/mesh-library.json");

interface Mesh {
  source: string;
  family: number;
  meshIndex: number;
  vertices: Float32Array;
  polygons: Uint16Array;
  colorSets: Uint16Array[];
}

Deno.test("mesh-library.json is the complete 224-mesh part library", async () => {
  const library = meshLibraryFromJson(
    JSON.parse(await Deno.readTextFile(PATH)),
  );
  assertStrictEquals(library.source, "mdldt");
  assertStrictEquals(library.meshes.length, LIBRARY_MESH_COUNT);
  let vertices = 0;
  let polygons = 0;
  (library.meshes as Mesh[]).forEach((mesh, i) => {
    assertStrictEquals(mesh.source, "mdldt", `mesh ${i} is a placeholder`);
    assertStrictEquals(libraryIndex(mesh.family, mesh.meshIndex), i);
    const count = mesh.vertices.length / 3;
    vertices += count;
    polygons += mesh.polygons.length / 4;
    for (const v of mesh.polygons) {
      assert(v < count, `mesh ${i} indexes past its vertices`);
    }
    assertStrictEquals(mesh.colorSets.length, 3);
    for (const set of mesh.colorSets) {
      assertStrictEquals(set.length, mesh.polygons.length / 4);
    }
  });
  assertStrictEquals(vertices, 14345);
  assertStrictEquals(polygons, 15216);
  // family 5 index 0: the +-20.5 cube in its three colour sets
  const cube = library.meshes[libraryIndex(5, 0)];
  assertEquals(meshBounds(cube).max, [20.5, 20.5, 20.5]);
  assertEquals(Array.from(cube.colorSets[0]), [15, 15, 15, 15, 15, 15]);
  assertEquals(Array.from(cube.colorSets[1]), [
    0x03e0,
    0x001f,
    0x7c00,
    0x001f,
    0x03ff,
    0x7c00,
  ]);
  assertEquals(Array.from(cube.colorSets[2]), [
    0x5294,
    0x5294,
    0x5294,
    0x5294,
    0x5294,
    0x5294,
  ]);
  // family 4: every plate is 70 tall and 10 deep
  for (let i = 0; i < 36; i++) {
    const b = meshBounds(library.meshes[libraryIndex(4, i)]);
    assert(Math.abs(b.max[1] - b.min[1] - 70) < 0.01);
    assert(Math.abs(b.max[2] - b.min[2] - 10) < 0.01);
  }
});

// The engine draws placeholders whenever this file has not loaded, so a
// placeholder that is the wrong SOLID (a prism where the disc has a pyramid, a
// cone or a frustum) is a silent wrong answer. Bounding boxes alone do not
// catch it — a square pyramid and a square prism share theirs — so compare the
// count of DISTINCT vertex positions too, which is what separates a solid that
// closes to an apex from one that does not.
Deno.test("every family-5 placeholder is the same solid as the disc's", async () => {
  const library = meshLibraryFromJson(
    JSON.parse(await Deno.readTextFile(PATH)),
  );
  const distinct = (mesh: Mesh) => {
    const seen = new Set<string>();
    for (let i = 0; i < mesh.vertices.length; i += 3) {
      seen.add(
        [0, 1, 2].map((k) =>
          (Math.round(mesh.vertices[i + k] * 32) / 32).toFixed(2)
        )
          .join(),
      );
    }
    return seen.size;
  };
  for (let i = 0; i < 12; i++) {
    const real = library.meshes[libraryIndex(5, i)] as Mesh;
    const stand = placeholderMesh(5, i) as Mesh;
    assertStrictEquals(
      distinct(stand),
      distinct(real),
      `family 5 mesh ${i}: placeholder has ${
        distinct(stand)
      } distinct vertices, the disc mesh ${distinct(real)}`,
    );
    const a = meshBounds(real), b = meshBounds(stand);
    for (let k = 0; k < 3; k++) {
      assert(
        Math.abs(a.min[k] - b.min[k]) < 1.5,
        `family 5 mesh ${i}: min axis ${k}`,
      );
      assert(
        Math.abs(a.max[k] - b.max[k]) < 1.5,
        `family 5 mesh ${i}: max axis ${k}`,
      );
    }
  }
});
