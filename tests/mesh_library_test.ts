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
  polygonNormals,
} from "../packages/shmup-engine/src/model/mesh-library.js";
import {
  allocFrame,
  buildModelMesh,
  orbitCamera,
  projectModel,
} from "../packages/shmup-engine/src/model/model-mesh.js";

const ROOT = resolve(dirname(fromFileUrl(import.meta.url)), "..");
const PATH = resolve(ROOT, "static/editor/dezaemon/mesh-library.json");

interface Mesh {
  source: string;
  family: number;
  meshIndex: number;
  vertices: Float32Array;
  polygons: Uint16Array;
  normals: Float32Array;
  dualPlane: Uint8Array;
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

// The disc's normals and its dual-plane flags are the two things the JSON form
// used to drop, and both are invisible in a bounds check: a recomputed normal
// still has unit length, and a lost flag just quietly culls a face. Pin them
// on the shipped artifact, which is what production actually loads.
Deno.test("mesh-library.json carries the disc's own normals and dual-plane flags", async () => {
  const library = meshLibraryFromJson(
    JSON.parse(await Deno.readTextFile(PATH)),
  );
  const meshes = library.meshes as Mesh[];
  let flagged = 0;
  const flaggedMeshes: number[] = [];
  let differsFromRecompute = 0;
  meshes.forEach((mesh, i) => {
    const polygons = mesh.polygons.length / 4;
    assertStrictEquals(mesh.normals.length, polygons * 3);
    assertStrictEquals(mesh.dualPlane.length, polygons);
    const count = mesh.dualPlane.reduce((a, b) => a + b, 0);
    if (count) {
      flagged += count;
      flaggedMeshes.push(i);
    }
    const recomputed = polygonNormals(mesh.vertices, mesh.polygons);
    for (let q = 0; q < polygons; q++) {
      const len = Math.hypot(
        mesh.normals[q * 3],
        mesh.normals[q * 3 + 1],
        mesh.normals[q * 3 + 2],
      );
      // stored, quantized to 1/4096 — never zero, which a recompute can be
      assert(
        Math.abs(len - 1) < 1e-3,
        `mesh ${i} polygon ${q} normal length ${len}`,
      );
      const d = Math.max(
        Math.abs(mesh.normals[q * 3] - recomputed[q * 3]),
        Math.abs(mesh.normals[q * 3 + 1] - recomputed[q * 3 + 1]),
        Math.abs(mesh.normals[q * 3 + 2] - recomputed[q * 3 + 2]),
      );
      if (d > 1e-2) differsFromRecompute++;
    }
  });
  // 44 polygons across exactly two meshes (see src/model/decode-mdldt.js)
  assertStrictEquals(flagged, 44);
  assertEquals(flaggedMeshes, [148, 171]);
  assertStrictEquals(libraryIndex(3, 8), 148);
  assertStrictEquals(libraryIndex(3, 31), 171);
  assertStrictEquals(meshes[148].dualPlane.reduce((a, b) => a + b, 0), 32);
  assertStrictEquals(meshes[171].dualPlane.reduce((a, b) => a + b, 0), 12);
  // and these really are the disc's normals, not a recompute: deriving them
  // from this file's own (1/256-quantized) vertices moves 1,478 of the 15,216
  // by more than 1/100. If that count collapses towards zero the build has
  // silently gone back to deriving normals from the winding.
  assert(
    differsFromRecompute > 1200,
    `only ${differsFromRecompute} normals differ from a recompute — are they stored?`,
  );
});

// Every buildModelMesh test in the engine package uses placeholders, so until
// this test nothing rendered the artifact the viewer actually fetches. It runs
// all 224 meshes through the real path: no disc needed, so it runs in CI.
Deno.test("every mesh in the shipped library renders through buildModelMesh", async () => {
  const library = meshLibraryFromJson(
    JSON.parse(await Deno.readTextFile(PATH)),
  );
  let triangles = 0;
  for (let i = 0; i < LIBRARY_MESH_COUNT; i++) {
    const mesh = library.meshes[i] as Mesh;
    const built = buildModelMesh({
      color: 0x7fff,
      parts: [{
        shape: (mesh.family << 12) | mesh.meshIndex,
        shapeFamily: mesh.family,
        meshIndex: mesh.meshIndex,
        colorSet: 0,
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        mirrored: false,
      }],
    }, { library });
    assertStrictEquals(
      built.placeholder,
      false,
      `mesh ${i} fell back to a placeholder`,
    );
    assertStrictEquals(built.polyCount, mesh.polygons.length / 4);
    triangles += built.triCount;
    for (const v of built.positions) {
      assert(Number.isFinite(v), `mesh ${i} position`);
    }
    for (const v of built.normals) {
      assert(Number.isFinite(v), `mesh ${i} normal`);
    }
    for (const p of built.polyOf) {
      assert(p < built.polyCount, `mesh ${i} polyOf`);
    }
  }
  // the whole library, as counted straight off the disc in decode-mdldt.test.js
  assertStrictEquals(triangles, 27124);
});

// A high-polygon, two-sided mesh through the whole per-frame path. F3:8 is an
// open dome: its 32 dual-plane polygons only ever showed their front face
// while the flag was being dropped, which cost it a third of its visible
// triangles per view (72.1 against 108.6 over the sweep below).
Deno.test("the open dome F3:8 projects, shows its two-sided faces, and sorts far to near", async () => {
  const library = meshLibraryFromJson(
    JSON.parse(await Deno.readTextFile(PATH)),
  );
  const mesh = buildModelMesh({
    parts: [{
      shape: 0x3008,
      shapeFamily: 3,
      meshIndex: 8,
      colorSet: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      mirrored: false,
    }],
  }, { library });
  assertStrictEquals(
    mesh.twoSided.reduce((a: number, b: number) => a + b, 0),
    64,
  );

  const frame = allocFrame(mesh);
  const everVisible = new Set<number>();
  let twoSidedSeen = 0;
  for (let yaw = 0; yaw < 360; yaw += 10) {
    for (let pitch = -75; pitch <= 75; pitch += 25) {
      const cam = orbitCamera({
        yaw,
        pitch,
        distance: 200,
        target: mesh.bounds.center,
      });
      const n = projectModel(mesh, cam, frame);
      assert(n > 0, `nothing visible at yaw ${yaw} pitch ${pitch}`);
      for (let r = 0; r < n; r++) {
        const t = frame.order[r];
        everVisible.add(t);
        if (mesh.twoSided[t]) twoSidedSeen++;
        // painter order: far to near, no exceptions
        if (r > 0) {
          assert(
            frame.depth[frame.order[r - 1]] >= frame.depth[t],
            `order broke at yaw ${yaw} pitch ${pitch} rank ${r}`,
          );
        }
      }
    }
  }
  // with the flag honoured, no triangle of this mesh is unreachable
  assertStrictEquals(everVisible.size, mesh.triCount);
  assert(twoSidedSeen > 0, "the dual-plane faces never appeared");
});
